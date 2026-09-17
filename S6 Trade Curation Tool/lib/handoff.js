// ———————————————————————————————————————————————————————————————————————————
// Trade handoff — shared payload + CSV logic
//
// One implementation used by BOTH:
//   • the "Download CSV" button in app/page.jsx (client)
//   • GET /api/builds/{id}.csv (server, for Lisa's trade app)
//
// Keeping them on the same code path is the whole point: the CSV Lisa's app
// fetches is byte-identical to the one a rep downloads, by construction rather
// than by two functions being carefully kept in sync.
// ———————————————————————————————————————————————————————————————————————————

// ── Product types the collection can be offered in ──────────────────────────
// CANONICAL LIST. app/page.jsx imports these for its checkbox UI, and the CSV
// ordering below is derived from the same array. Adding an offered product type
// (e.g. when catalog ops onboards one) is a one-line change HERE and nowhere
// else — the selector, the CSV and the API stay in step automatically.
//
// `slug` = S6 URL suffix; `type` = the exact product_type value in the catalog.
export const WALL_ART_TYPES = [
  { label: 'Art Print',           slug: 'art-print',           type: 'Art Print' },
  { label: 'Framed Art Print',    slug: 'framed-art-print',    type: 'Framed Art Print' },
  { label: 'Canvas Print',        slug: 'canvas-print',        type: 'Canvas Print' },
  { label: 'Framed Canvas Print', slug: 'framed-canvas-print', type: 'Framed Canvas Print' },
  { label: 'Metal Print',         slug: 'metal-print',         type: 'Metal Print' },
  { label: 'Poster',              slug: 'poster',              type: 'Poster' },
  { label: 'Framed Poster',       slug: 'framed-poster',       type: 'Framed Poster' },
  { label: 'Mini Art Print',      slug: 'mini-art-print',      type: 'Mini Art Print' },
  { label: 'Wood Wall Art',       slug: 'wood-wall-art',       type: 'Wood Wall Art' },
  { label: 'Wall Tapestry',       slug: 'wall-tapestry',       type: 'Wall Tapestry' },
];
export const PILLOW_TYPES = [
  { label: 'Throw Pillow',                slug: 'throw-pillow',       type: 'Throw Pillow' },
  { label: 'Rectangular (Lumbar) Pillow', slug: 'rectangular-pillow', type: 'Rectangular Pillow' },
  { label: 'Shower Curtain',              slug: 'shower-curtain',     type: 'Shower Curtain' },
];
export const ALL_PRODUCT_TYPES = [...WALL_ART_TYPES, ...PILLOW_TYPES];
export const PRODUCT_TYPE_SLUGS = ALL_PRODUCT_TYPES.map(t => t.slug);
// Default: all wall art EXCEPT Mini Art Print; pillows off.
export const DEFAULT_TYPE_SLUGS = WALL_ART_TYPES
  .filter(t => t.slug !== 'mini-art-print')
  .map(t => t.slug);

// Display order for format links (wall art first, then pillows) — derived, not
// a second hand-maintained list.
const TYPE_ORDER = new Map(ALL_PRODUCT_TYPES.map((t, i) => [t.type, i]));

export const CSV_HEADERS = [
  'title',
  'product_type',
  'product_url',
  'image_url',
  'thumbnail',
  'artist',
  'style',
  'palette',
  'placement',
  'reason',
];

export function toAbsolute(u) {
  if (!u) return '';
  return u.startsWith('/') ? 'https://society6.com' + u : u;
}

// Links come from the design's REAL available formats (from design_formats via
// the API). Falls back to the item's native URL if availability is missing.
export function productLinksForItem(item) {
  if (!item) return [];
  const fmts = item.available_formats;
  if (Array.isArray(fmts) && fmts.length) {
    return [...fmts]
      .sort((a, b) => (TYPE_ORDER.get(a.type) ?? 99) - (TYPE_ORDER.get(b.type) ?? 99))
      .filter(f => f && f.url)
      .map(f => ({ label: f.type, slug: f.type, url: f.url, image: f.image_url }));
  }
  let url = item.product_url || '';
  if (url.startsWith('/')) url = 'https://society6.com' + url;
  if (!url) return [];
  return [{
    label: item.product_type || item.source_collection || 'View on Society6',
    slug: 'native',
    url,
    image: item.image_url,
  }];
}

// Everything the CSV and a downstream quote need. Deliberately wider than the
// share-page payload (which drops artist/formats), and deliberately free of
// buyer PII — contact and shipping details stay in the trade app.
export function sanitizeHandoffItem(item) {
  if (!item) return null;
  return {
    title: item.title || '',
    product_url: item.product_url || '',
    image_url: item.image_url || '',
    image_alt: item.image_alt || '',
    product_type: item.product_type || '',
    source_collection: item.source_collection || '',
    artist_name: item.artist_name || '',
    vision_style: item.vision_style || '',
    vision_palette: item.vision_palette || '',
    reason: item.reason || '',
    available_formats: Array.isArray(item.available_formats)
      ? item.available_formats
          .filter(f => f && f.url)
          .map(f => ({ type: f.type || '', url: f.url, image_url: f.image_url || '' }))
      : [],
  };
}

// Build the flat row set: one row per real available product type per item,
// in placement order (Primary → Accent → Gallery Wall sets).
export function buildCsvRows({ primary = [], accent = [], galleryWallSets = [] }) {
  const rows = [];
  const push = (item, placement) => {
    const base = {
      title: item.title || '',
      artist: item.artist_name || '',
      style: item.vision_style || '',
      palette: item.vision_palette || '',
      placement,
      reason: item.reason || '',
    };
    const rowFor = (productType, productUrl, img) => {
      const imageUrl = toAbsolute(img);
      rows.push({
        ...base,
        product_type: productType,
        product_url: productUrl,
        image_url: imageUrl,
        thumbnail: imageUrl ? `=IMAGE("${imageUrl}")` : '',
      });
    };
    const links = productLinksForItem(item);
    if (links.length === 0) rowFor('', toAbsolute(item.product_url), item.image_url);
    else for (const l of links) rowFor(l.label, l.url, l.image || item.image_url);
  };

  primary.forEach(i => push(i, 'Primary'));
  accent.forEach(i => push(i, 'Accent'));
  (galleryWallSets || []).forEach(set => {
    (set.items || []).forEach(i => push(i, `Gallery Wall #${set.setNumber}`));
  });
  return rows;
}

const escapeCell = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// CSV text WITHOUT the BOM. Callers add '﻿' when writing a file the user
// opens in Excel/Sheets; the HTTP endpoint adds it too so the bytes match.
export function toCsvText(rows) {
  return [
    CSV_HEADERS.join(','),
    ...rows.map(r => CSV_HEADERS.map(h => escapeCell(r[h])).join(',')),
  ].join('\n');
}

export function csvFilename(projectName) {
  const safe = (projectName || 'S6-Curation')
    .replace(/[^a-z0-9-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'S6-Curation';
  return `${safe}-${new Date().toISOString().slice(0, 10)}.csv`;
}
