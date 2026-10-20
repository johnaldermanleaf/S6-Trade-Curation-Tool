/**
 * backfill-orientation.mjs — label every design vertical / horizontal / square.
 *
 * Why it measures the PAPER, not the photo: Society6 product images are all
 * square (800x800 / 2000x2000), and size variants read "8x10, 11x14..." for
 * every design regardless of orientation. What does change is the print drawn
 * inside the photo — tall paper for vertical art, wide paper for horizontal.
 * We fetch a small copy of the image, find the bounding box of everything
 * that isn't the white background, and classify by its width/height ratio.
 *
 * Writes to its own table, design_orientation (created if missing). APPEND-ONLY
 * and idempotent: never truncates, skips designs already measured, safe to
 * re-run any time (e.g. after new designs are onboarded).
 *
 * Image source per design: design_formats.image_url, trying the design's formats
 * in PRIORITY order until one measures cleanly. Designs with no wall-art format
 * (e.g. pillow-only) are skipped and simply never match an orientation filter.
 *
 * Usage (from the app folder):
 *   npm install --no-save sharp                                        # one-time
 *   node --env-file=.env.local scripts/backfill-orientation.mjs --limit 50 --dry   # preview, writes nothing
 *   node --env-file=.env.local scripts/backfill-orientation.mjs                    # full run
 *   node --env-file=.env.local scripts/backfill-orientation.mjs --stats            # counts only
 * Options: --limit N   --concurrency N (default 12)   --dry   --stats
 */
import pg from 'pg';
import sharp from 'sharp';
import { pathToFileURL } from 'url';

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) : d; };
const DRY = flag('--dry');
const STATS = flag('--stats');
const LIMIT = opt('--limit', 0);
const CONCURRENCY = opt('--concurrency', 12);

// Which format's image to measure, best first.
// Posters are last: their photos are usually full-bleed (no white background),
// so they rarely measure — the script falls through to the next format.
export const PRIORITY = [
  'Art Print', 'Metal Print', 'Framed Art Print', 'Mini Art Print',
  'Framed Canvas Print', 'Canvas Print', 'Poster', 'Framed Poster',
];
// ratio = width / height of the print inside the photo.
// Observed: vertical paper ~0.80, square ~1.00, horizontal ~1.25.
const V_MAX = 0.92;
const H_MIN = 1.08;
const BG_TOL = 7; // grayscale distance from the background color that counts as product

export function classify(ratio) {
  if (!ratio || !isFinite(ratio)) return null;
  if (ratio <= V_MAX) return 'vertical';
  if (ratio >= H_MIN) return 'horizontal';
  return 'square';
}

function sized(url) {
  // Shopify CDN resizes on the fly and keeps aspect; 300px is plenty.
  const u = new URL(url.startsWith('//') ? 'https:' + url : url);
  u.searchParams.set('width', '300');
  return u.toString();
}

export async function measure(url) {
  const res = await fetch(sized(url), { headers: { 'User-Agent': 'Mozilla/5.0 (S6 orientation backfill)' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const { data, info } = await sharp(buf).flatten({ background: '#ffffff' }).greyscale().raw()
    .toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = info;
  // Background = median of the four corner pixels (white for prints, cream for
  // posters). Anything differing from it by more than BG_TOL is the product.
  const corners = [data[0], data[W - 1], data[(H - 1) * W], data[H * W - 1]].sort((a, b) => a - b);
  const bg = (corners[1] + corners[2]) / 2;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      if (Math.abs(data[row + x] - bg) > BG_TOL) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error('blank image');
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  // A box touching the photo's edges means a full-bleed/lifestyle photo, not a
  // product-on-plain-background shot — the ratio would be meaningless, so reject.
  if (x0 <= 1 || y0 <= 1 || x1 >= W - 2 || y1 >= H - 2) throw new Error('product touches photo edge (lifestyle/full-bleed shot)');
  return { ratio: Math.round((w / h) * 1000) / 1000, orientation: classify(w / h) };
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error('ERROR: DATABASE_URL not set (use --env-file=.env.local)'); process.exit(1); }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 4 });

  await pool.query(`CREATE TABLE IF NOT EXISTS design_orientation (
      design_key   text PRIMARY KEY,
      orientation  text NOT NULL CHECK (orientation IN ('vertical','horizontal','square')),
      ratio        real,
      source_type  text,
      image_url    text,
      measured_at  timestamptz NOT NULL DEFAULT now()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS design_orientation_orientation_idx ON design_orientation (orientation)`);

  if (STATS) {
    const { rows } = await pool.query(`SELECT orientation, count(*)::int n FROM design_orientation GROUP BY 1 ORDER BY 1`);
    const { rows: [t] } = await pool.query(`SELECT count(DISTINCT design_key)::int n FROM design_formats WHERE product_type = ANY($1)`, [PRIORITY]);
    console.table(rows); console.log('designs with a wall-art format:', t.n);
    await pool.end(); return;
  }

  // One row per not-yet-measured design, with its candidate images in PRIORITY order.
  const { rows: todo } = await pool.query(`
    SELECT df.design_key,
           array_agg(df.product_type ORDER BY array_position($1::text[], df.product_type)) AS types,
           array_agg(df.image_url    ORDER BY array_position($1::text[], df.product_type)) AS images
    FROM design_formats df
    WHERE df.product_type = ANY($1) AND coalesce(df.image_url,'') <> ''
      AND NOT EXISTS (SELECT 1 FROM design_orientation o WHERE o.design_key = df.design_key)
    GROUP BY df.design_key
    ORDER BY df.design_key
    ${LIMIT ? 'LIMIT ' + Number(LIMIT) : ''}`, [PRIORITY]);
  console.log(`${todo.length} designs to measure${DRY ? ' (dry run — nothing will be written)' : ''}`);

  const counts = { vertical: 0, horizontal: 0, square: 0, failed: 0 };
  const failures = [];
  let done = 0, i = 0;
  const pending = [];

  async function flush() {
    if (DRY || pending.length === 0) { pending.length = 0; return; }
    const batch = pending.splice(0);
    const vals = [], params = [];
    batch.forEach((r, k) => {
      vals.push(`($${k * 5 + 1},$${k * 5 + 2},$${k * 5 + 3},$${k * 5 + 4},$${k * 5 + 5})`);
      params.push(r.design_key, r.orientation, r.ratio, r.source_type, r.image_url);
    });
    await pool.query(`INSERT INTO design_orientation (design_key, orientation, ratio, source_type, image_url)
      VALUES ${vals.join(',')} ON CONFLICT (design_key) DO NOTHING`, params);
  }

  async function worker() {
    while (i < todo.length) {
      const row = todo[i++];
      let ok = false, lastErr = '';
      for (let k = 0; k < row.images.length && !ok; k++) {
        try {
          const m = await measure(row.images[k]);
          counts[m.orientation]++; ok = true;
          pending.push({ design_key: row.design_key, orientation: m.orientation, ratio: m.ratio, source_type: row.types[k], image_url: row.images[k] });
          if (DRY && done < 60) console.log(m.orientation.padEnd(10), String(m.ratio).padEnd(6), row.types[k].padEnd(20), row.design_key);
        } catch (e) { lastErr = `${row.types[k]}: ${e.message}`; }
      }
      if (!ok) { counts.failed++; failures.push(`${row.design_key}\t${lastErr}`); }
      done++;
      if (pending.length >= 200) await flush();
      if (done % 1000 === 0) console.log(`  ${done}/${todo.length}`, JSON.stringify(counts));
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await flush();

  console.log('done:', JSON.stringify(counts));
  if (failures.length) {
    console.log(`${failures.length} failed (left unlabeled; re-run retries them). First 10:`);
    failures.slice(0, 10).forEach(f => console.log('  ' + f));
  }
  await pool.end();
}

// Run main() only when executed directly (lets tests import measure()).
if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e); process.exit(1); });
