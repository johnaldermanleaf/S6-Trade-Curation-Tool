import { NextResponse } from 'next/server';
import pg from 'pg';

// Two sequential Claude calls (brief parse + curation) plus DB scoring can exceed
// the default 10s serverless limit on a cold start → 504. Raise the ceiling to
// Netlify's max for synchronous functions so cold starts still complete.
export const maxDuration = 26;

// ———————————————————————————————————————————————————————————————————————————
// Trade Curation Tool — recommendation engine (Neon-backed, per-design catalog)
//
//   1. Moodboard URL/PDF text (best-effort) is folded INTO the brief text
//   2. Claude parses the combined brief into catalog-aligned tags (hard/soft avoid)
//   3. Weighted tag-overlap scoring runs IN Postgres over the enriched catalog,
//      with color-family hard-avoid exclusion, optional Mini-Art exclusion,
//      and a per-artist pool cap
//   4. Claude curator picks the final set; a per-artist final cap is applied
//   5. Pinned URLs (resolved via design_key) are force-included
//
// One row per design (64,281). Format is a downstream concern, so the same
// artwork can never appear twice and there are no per-format match filters
// (beyond the Mini-Art exclusion toggle).
// ———————————————————————————————————————————————————————————————————————————

const W_STYLE = 3, W_PALETTE = 2, W_MOOD = 1, W_KEYWORD = 4, W_SUBJECT = 8, W_AVOID_SOFT = 8;
const POOL_CAP = 4, POOL_LIMIT = 200, FINAL_CAP = 4, FINAL_N = 50, SELECT_N = 20;
const SEED_CAP = 7;  // max Find-Similar seed URLs
const PARSE_MODEL = 'claude-haiku-4-5-20251001';
const SELECT_MODEL = 'claude-haiku-4-5-20251001';

const FORMAT_SUFFIX = {
  'Art Print': '_art-print',
  'Canvas Print': '_canvas-print',
  'Framed Art Print': '_framed-art-print',
  'Framed Canvas Print': '_framed-canvas-print',
  'Mini Art Print': '_mini-art-print',
};
function buildProductUrl(designKey, productType) {
  if (!designKey) return '';
  return 'https://society6.com/products/' + designKey + (FORMAT_SUFFIX[productType] || '_art-print');
}
// Derive design_key from a pasted society6 product URL:
// society6.com/products/<design_key>_<format>  ->  <design_key>
function designKeyFromUrl(url) {
  if (!url) return null;
  const m = (url || '').match(/\/products\/([^?\/#]+)/);
  if (!m) return null;
  let slug = m[1];
  // strip a trailing _<format> suffix
  for (const suffix of Object.values(FORMAT_SUFFIX)) {
    if (slug.endsWith(suffix)) { slug = slug.slice(0, -suffix.length); break; }
  }
  return slug || null;
}

let _pool = null;
function getPool() {
  if (!_pool) {
    _pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000,
    });
    _pool.on('error', (err) => console.warn('[pg pool] idle client error:', err.message));
  }
  return _pool;
}

const COLOR_FAMILIES = {
  orange: ['orange', 'terracotta', 'burnt orange', 'coral orange', 'amber', 'rust', 'tangerine', 'apricot'],
  brown:  ['brown', 'warm brown', 'rust-brown', 'pale brown', 'chocolate', 'mahogany', 'sienna', 'umber', 'coffee'],
  red:    ['red', 'crimson', 'scarlet', 'burgundy', 'maroon', 'brick red'],
  pink:   ['pink', 'blush', 'rose', 'magenta', 'fuchsia', 'dusty rose'],
  purple: ['purple', 'violet', 'lavender', 'plum', 'mauve', 'lilac'],
  green:  ['green', 'sage green', 'forest green', 'olive', 'emerald', 'mint', 'seafoam'],
  blue:   ['blue', 'navy', 'navy blue', 'teal', 'turquoise', 'cobalt', 'indigo', 'aqua', 'cyan'],
  yellow: ['yellow', 'golden yellow', 'mustard', 'gold', 'ochre'],
  gray:   ['gray', 'grey', 'charcoal', 'slate'],
  black:  ['black', 'onyx', 'ebony'],
};
const PALETTE_COLOR_WORDS = new Set([
  'cream','white','black','orange','gold','pink','yellow','teal','red','tan',
  'green','sage green','blue','coral','gray','grey','brown','beige','golden yellow',
  'charcoal','navy','navy blue','forest green','purple','turquoise','terracotta',
  'rust','amber','burgundy','maroon','peach','mint','seafoam','aqua','indigo',
  'cobalt','lavender','blush','sand','sandy','olive','mustard','ochre','sienna'
]);
function expandColor(term) {
  const t = (term || '').toLowerCase().trim();
  if (COLOR_FAMILIES[t]) return COLOR_FAMILIES[t];
  for (const [, members] of Object.entries(COLOR_FAMILIES)) if (members.includes(t)) return members;
  return [t];
}
function splitAvoid(hardAvoid) {
  const colorSubstrings = new Set();
  const nonColors = [];
  for (const t of hardAvoid) {
    const isColor = PALETTE_COLOR_WORDS.has(t) || COLOR_FAMILIES[t] ||
      Object.values(COLOR_FAMILIES).some(m => m.includes(t));
    if (isColor) for (const member of expandColor(t)) colorSubstrings.add(member);
    else nonColors.push(t);
  }
  return { colorSubstrings: Array.from(colorSubstrings), nonColors };
}

const CATALOG_STYLES = 'illustration, minimalist, line art, geometric, photographic, abstract, vintage, mid-century modern, geometric abstraction, watercolor, typography, watercolor illustration, minimalist illustration, vintage illustration, retro';
const CATALOG_PALETTE = 'cream, white, black, orange, gold, pink, yellow, teal, red, tan, green, sage green, blue, coral, gray, brown, beige, golden yellow, charcoal, navy, forest green, purple, turquoise, terracotta, navy blue';
const CATALOG_MOODS = 'contemplative, playful, serene, calm, whimsical, peaceful, warm, nostalgic, energetic, meditative, cheerful, joyful, retro, balanced, bold';

const lc = (arr) => Array.from(new Set((arr || []).map(s => (s || '').toLowerCase().trim()).filter(Boolean)));
const FENCE_OPEN = new RegExp('^```json?\\s*', 'i');
const FENCE_CLOSE = new RegExp('\\s*```$', 'i');
const stripFences = (s) => s.trim().replace(FENCE_OPEN, '').replace(FENCE_CLOSE, '');

// ——— Moodboard helpers (best-effort; never throw) ———————————————————————————
// Returns { text, status } where status is 'used' | 'failed' | 'empty'.
async function extractMoodboardUrl(moodboardUrl) {
  let cleanUrl = (moodboardUrl || '').trim();
  if (!cleanUrl) return { text: '', status: 'none' };
  if (!/^https?:\/\//i.test(cleanUrl)) cleanUrl = 'https://' + cleanUrl;
  try {
    new URL(cleanUrl);
    const res = await fetch(cleanUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; S6TradeCurationBot/1.0)', 'Accept': 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(5000), redirect: 'follow',
    });
    if (!res.ok) return { text: '', status: 'failed' };
    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    if (!ctype.includes('text/html') && !ctype.includes('application/xhtml')) return { text: '', status: 'failed' };
    const rawHtml = (await res.text()).slice(0, 500_000);
    const pick = (re) => { const m = rawHtml.match(re); return m ? m[1].trim() : ''; };
    const decode = (s) => s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ');
    const title = decode(pick(/<title[^>]*>([\s\S]*?)<\/title>/i));
    const metaDesc = decode(pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i));
    const ogTitle = decode(pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i));
    const ogDesc = decode(pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i));
    const ogSite = decode(pick(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i));
    const alts = [];
    const altRe = /<img[^>]+alt=["']([^"']{3,120})["']/gi;
    let am;
    while ((am = altRe.exec(rawHtml)) !== null && alts.length < 25) {
      const a = decode(am[1]).trim();
      if (a && !/^(image|photo|picture|logo|icon)$/i.test(a)) alts.push(a);
    }
    const lines = [
      ogSite && `Source: ${ogSite}`,
      (ogTitle || title) && `Title: ${ogTitle || title}`,
      (ogDesc || metaDesc) && `Description: ${ogDesc || metaDesc}`,
      alts.length && `Image captions: ${alts.join(' | ')}`,
    ].filter(Boolean);
    const extracted = lines.join('\n').slice(0, 3000);
    if (extracted.trim().length > 20) return { text: extracted, status: 'used' };
    return { text: '', status: 'empty' };
  } catch {
    return { text: '', status: 'failed' };
  }
}

// Returns { text, status } where status is 'used' | 'failed' | 'empty'.
async function extractMoodboardPdf(file) {
  if (!file || !file.size) return { text: '', status: 'none' };
  try {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('PDF timeout')), 6000));
    const work = (async () => {
      const pdfParse = (await import('pdf-parse')).default;
      const data = await pdfParse(Buffer.from(await file.arrayBuffer()));
      return (data.text || '').trim();
    })();
    const text = await Promise.race([work, timeout]);
    if (text && text.length > 20) return { text: text.slice(0, 4000), status: 'used' };
    return { text: '', status: 'empty' };
  } catch {
    return { text: '', status: 'failed' };
  }
}

// ——— Stage: parse the brief ————————————————————————————————————————————————
async function parseBriefWithClaude(text) {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: PARSE_MODEL, max_tokens: 1024,
    messages: [{ role: 'user', content:
`You parse interior-design art curation briefs into structured tags for a catalog search.
The catalog tags artwork with a known vocabulary — ALIGN your output to it so matching works.

CATALOG STYLE TAGS (use these spellings where they fit): ${CATALOG_STYLES}
CATALOG PALETTE TAGS (use these exact color words): ${CATALOG_PALETTE}
CATALOG MOOD TAGS: ${CATALOG_MOODS}

BRIEF (may include MOODBOARD NOTES appended at the end — treat those as supplemental inspiration; the main brief takes precedence if they conflict):
${text}

CRITICAL — distinguish two kinds of negative:
- avoidHard = things the client EXPLICITLY BANS. Language like "no orange", "NO browns or oranges at all", "nothing western". These will HARD-EXCLUDE matching artwork.
- avoidSoft = mere preferences / de-emphasis. Language like "not too rustic", "prefer blues", "less busy". These only push artwork DOWN, not out.
When unsure, use avoidSoft (soft is safer). For banned colors, name the base color (e.g. "brown", "orange") — the system expands shades automatically.

Return ONLY valid JSON, no markdown:
{
  "projectName": "", "clientName": "", "location": "",
  "projectType": "hotel|restaurant|vacation_rental|office|residential|other",
  "briefSummary": "2-3 sentences",
  "styleTags": ["catalog style words that fit"],
  "paletteTags": ["catalog COLOR words wanted — exact catalog spellings"],
  "moodTags": ["catalog mood words that fit"],
  "subjectTokens": ["3-8 concrete SINGLE-WORD subjects — ocean, dune, sailboat, palm, marsh. Prefer single words."],
  "keywords": ["12-20 specific words likely in matching artwork descriptions"],
  "avoidHard": ["explicitly BANNED colors/subjects/styles; base color only for colors. Empty if none."],
  "avoidSoft": ["de-emphasized preferences — pushed down, not excluded"],
  "galleryWall": true or false,
  "keyThemes": ["3-6 short vibe phrases"]
}`
    }]
  });
  return JSON.parse(stripFences(msg.content[0].text));
}

function parseBriefFallback(text) {
  const t = (text || '').toLowerCase();
  const has = (re) => re.test(t);
  const styleTags = [];
  if (has(/minimal/)) styleTags.push('minimalist');
  if (has(/line art|line drawing/)) styleTags.push('line art');
  if (has(/geometric/)) styleTags.push('geometric');
  if (has(/abstract/)) styleTags.push('abstract');
  if (has(/watercolor|watercolour/)) styleTags.push('watercolor');
  if (has(/mid.?century/)) styleTags.push('mid-century modern');
  if (has(/vintage|retro/)) styleTags.push('vintage');
  const paletteTags = [];
  for (const c of ['blue','navy','teal','turquoise','sage green','cream','white','pink','green','gold','gray','black']) if (t.includes(c)) paletteTags.push(c);
  return {
    projectName: '', clientName: '', location: '', projectType: 'other',
    briefSummary: `Project seeking ${styleTags.join(', ') || 'wall'} art in ${paletteTags.join(', ') || 'mixed'} tones.`,
    styleTags, paletteTags, moodTags: [], subjectTokens: [], keywords: [...styleTags, ...paletteTags],
    avoidHard: [], avoidSoft: [], galleryWall: t.includes('gallery wall'), keyThemes: styleTags.slice(0, 3),
  };
}

// ——— Refine: interpret freeform feedback into structured hints ——————————————
// Turns "less beachy, more sophisticated" into add/avoid terms + hard/soft
// classification so the SCORING POOL shifts, not just the final prompt.
async function parseFeedbackWithClaude(feedback, brief) {
  if (!feedback || !feedback.trim()) return null;
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: PARSE_MODEL, max_tokens: 600,
    messages: [{ role: 'user', content:
`A curator is refining an art recommendation set. Interpret their feedback into structured search hints.

CURRENT BRIEF (for context):
style: ${(brief.styleTags||[]).join(', ')}; palette: ${(brief.paletteTags||[]).join(', ')}; subjects: ${(brief.subjectTokens||[]).join(', ')}

CATALOG STYLE TAGS: ${CATALOG_STYLES}
CATALOG PALETTE TAGS: ${CATALOG_PALETTE}
CATALOG MOOD TAGS: ${CATALOG_MOODS}

FEEDBACK: "${feedback}"

Translate the feedback into catalog vocabulary. Distinguish EXPLICIT bans from soft preferences:
- "no beach or water", "remove florals", "nothing dark" -> avoidHard
- "less literal", "warmer", "more elevated", "lean abstract" -> express as addStyle/addMood/addPalette/addSubjects AND/OR avoidSoft
For banned colors name the base color only (system expands shades).

Return ONLY valid JSON, no markdown:
{
  "addStyle": ["catalog style tags to ADD to what's wanted"],
  "addPalette": ["catalog color words to ADD"],
  "addMood": ["catalog mood words to ADD"],
  "addSubjects": ["single-word subjects to ADD"],
  "addKeywords": ["specific words to ADD"],
  "avoidHard": ["things to now HARD-EXCLUDE (colors as base color)"],
  "avoidSoft": ["things to de-emphasize"]
}`
    }]
  });
  try {
    const p = JSON.parse(stripFences(msg.content[0].text));
    return {
      addStyle: Array.isArray(p.addStyle) ? p.addStyle : [],
      addPalette: Array.isArray(p.addPalette) ? p.addPalette : [],
      addMood: Array.isArray(p.addMood) ? p.addMood : [],
      addSubjects: Array.isArray(p.addSubjects) ? p.addSubjects : [],
      addKeywords: Array.isArray(p.addKeywords) ? p.addKeywords : [],
      avoidHard: Array.isArray(p.avoidHard) ? p.avoidHard : [],
      avoidSoft: Array.isArray(p.avoidSoft) ? p.avoidSoft : [],
    };
  } catch { return null; }
}

// Merge feedback hints into a brief, returning a new brief object.
function applyFeedbackToBrief(brief, hints) {
  if (!hints) return brief;
  const u = (a, b) => Array.from(new Set([...(a || []), ...(b || [])]));
  return {
    ...brief,
    styleTags: u(brief.styleTags, hints.addStyle),
    paletteTags: u(brief.paletteTags, hints.addPalette),
    moodTags: u(brief.moodTags, hints.addMood),
    subjectTokens: u(brief.subjectTokens, hints.addSubjects),
    keywords: u(brief.keywords, hints.addKeywords),
    avoidHard: u(brief.avoidHard, hints.avoidHard),
    avoidSoft: u(brief.avoidSoft, hints.avoidSoft),
  };
}

// ——— Stage: weighted scoring in Postgres ——————————————————————————————————
async function scorePool(brief, excludeMini, prevTitles = [], productTypes = []) {
  const hard = splitAvoid(lc(brief.avoidHard));
  const params = [
    lc(brief.styleTags), lc(brief.paletteTags), lc(brief.moodTags), lc(brief.keywords),
    lc(brief.subjectTokens), lc(brief.avoidSoft), POOL_CAP, POOL_LIMIT,
    hard.colorSubstrings, hard.nonColors,
    (prevTitles || []).map(t => (t || '').toLowerCase().trim()).filter(Boolean),
    (productTypes || []).filter(Boolean),
  ];
  const sql = `
  WITH base AS (
    SELECT p.id, p.s6_product_id, p.title, p.artist_name, p.artist_handle,
      p.product_type, p.image_url, p.product_url, p.design_key,
      e.vision_subject, e.vision_style, e.vision_palette, e.vision_mood,
      lower(concat_ws(' ', e.vision_summary, e.vision_subject, e.vision_style,
        e.vision_palette, e.vision_mood, e.vision_keywords, e.artwork_description)) AS blob,
      regexp_split_to_array(lower(coalesce(e.vision_style,'')),   '\\s*,\\s*') AS style_tags,
      regexp_split_to_array(lower(coalesce(e.vision_palette,'')), '\\s*,\\s*') AS palette_tags,
      regexp_split_to_array(lower(coalesce(e.vision_mood,'')),    '\\s*,\\s*') AS mood_tags
    FROM products p
    JOIN enrichment_results e ON e.product_id = p.id AND e.is_current = true
    WHERE p.description_status = 'described'
      AND ($11::text[] = '{}' OR lower(p.title) <> ALL($11::text[]))
      -- Only designs actually available in at least one selected product type
      -- (real availability from design_formats, not the single imported type).
      AND ($12::text[] = '{}' OR EXISTS (
            SELECT 1 FROM design_formats df
            WHERE df.design_key = p.design_key AND df.product_type = ANY($12::text[])))
  ),
  filtered AS (
    SELECT * FROM base
    WHERE NOT EXISTS (SELECT 1 FROM unnest($9::text[]) c, unnest(palette_tags) pt WHERE c <> '' AND pt LIKE '%'||c||'%')
      AND NOT EXISTS (SELECT 1 FROM unnest($10::text[]) n WHERE n <> '' AND (palette_tags @> ARRAY[n] OR blob LIKE '%'||n||'%'))
  ),
  scored AS (
    SELECT *,
      ${W_STYLE}   * cardinality(ARRAY(SELECT unnest(style_tags)   INTERSECT SELECT unnest($1::text[]))) +
      ${W_PALETTE} * cardinality(ARRAY(SELECT unnest(palette_tags) INTERSECT SELECT unnest($2::text[]))) +
      ${W_MOOD}    * cardinality(ARRAY(SELECT unnest(mood_tags)    INTERSECT SELECT unnest($3::text[]))) +
      ${W_KEYWORD} * (SELECT count(*) FROM unnest($4::text[]) k WHERE k <> '' AND blob LIKE '%'||k||'%') +
      ${W_SUBJECT} * (SELECT count(*) FROM unnest($5::text[]) s WHERE s <> '' AND (lower(vision_subject) LIKE '%'||s||'%' OR blob LIKE '%'||s||'%')) -
      ${W_AVOID_SOFT} * (SELECT count(*) FROM unnest($6::text[]) a WHERE a <> '' AND (palette_tags @> ARRAY[a] OR blob LIKE '%'||a||'%'))
      AS score
    FROM filtered
  ),
  ranked AS (
    SELECT *, row_number() OVER (PARTITION BY artist_name ORDER BY score DESC, s6_product_id) AS artist_rn
    FROM scored WHERE score > 0
  )
  SELECT s6_product_id, title, artist_name, artist_handle, product_type, design_key,
         image_url, product_url, vision_subject, vision_style, vision_palette, vision_mood, score,
         (SELECT json_agg(json_build_object('type', df.product_type, 'url', df.url, 'image_url', df.image_url)
                          ORDER BY df.product_type)
            FROM design_formats df
            WHERE df.design_key = ranked.design_key
              AND ($12::text[] = '{}' OR df.product_type = ANY($12::text[]))) AS available_formats
  FROM ranked WHERE artist_rn <= $7
  ORDER BY score DESC, s6_product_id LIMIT $8`;
  const res = await getPool().query(sql, params);
  return res.rows;
}

// Fetch specific designs by design_key (for pinned items), bypassing scoring.
// Pass productTypes (may be empty = all offered) to attach available_formats for
// rendering; omit it (Find-Similar seeds) to skip that work.
async function fetchByDesignKeys(keys, productTypes = null) {
  if (!keys.length) return [];
  const withFormats = Array.isArray(productTypes);
  const sql = `
    SELECT p.s6_product_id, p.title, p.artist_name, p.artist_handle, p.product_type,
           p.design_key, p.image_url, p.product_url,
           e.vision_subject, e.vision_style, e.vision_palette, e.vision_mood
           ${withFormats ? `,
           (SELECT json_agg(json_build_object('type', df.product_type, 'url', df.url, 'image_url', df.image_url)
                            ORDER BY df.product_type)
              FROM design_formats df
              WHERE df.design_key = p.design_key
                AND ($2::text[] = '{}' OR df.product_type = ANY($2::text[]))) AS available_formats` : ''}
    FROM products p
    JOIN enrichment_results e ON e.product_id = p.id AND e.is_current = true
    WHERE p.design_key = ANY($1::text[])`;
  const res = await getPool().query(sql, withFormats ? [keys, productTypes.filter(Boolean)] : [keys]);
  return res.rows;
}

// ——— Stage: Claude curator pick ————————————————————————————————————————————
async function selectWithClaude(candidates, brief) {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const list = candidates.slice(0, 150).map((r, i) =>
    `${i}|${r.title}|by ${r.artist_name}|subj:${r.vision_subject}|style:${r.vision_style}|palette:${r.vision_palette}`).join('\n');
  const avoidAll = [...(brief.avoidHard||[]), ...(brief.avoidSoft||[])];
  const msg = await client.messages.create({
    model: SELECT_MODEL, max_tokens: 3000,
    messages: [{ role: 'user', content:
`You are an expert art curator for Society6's trade program, choosing wall art for a client.

CLIENT BRIEF:
${brief.briefSummary || ''}
Project: ${brief.projectName || 'Trade Client'} (${brief.projectType || 'commercial'})
Wants — style: ${(brief.styleTags||[]).join(', ')}; palette: ${(brief.paletteTags||[]).join(', ')}; subjects: ${(brief.subjectTokens||[]).join(', ')}
Avoid: ${avoidAll.join(', ') || 'nothing specified'}

CANDIDATES (index|title|artist|subject|style|palette):
${list}

Pick the ${SELECT_N} that form the most coherent curated set for this space. Favor breadth across artists.
Reject anything whose SUBJECT clashes with the brief even if colors match. Honor the avoid list strictly.

Return ONLY a JSON array, no markdown:
[{"index": 0, "reason": "one specific sentence on why it fits"}]`
    }]
  });
  return JSON.parse(stripFences(msg.content[0].text));
}

function applyFinalCap(picks, poolRows) {
  const perArtist = {}, chosen = [], used = new Set();
  for (const p of picks) {
    const c = poolRows[p.index];
    if (!c) continue;
    if ((perArtist[c.artist_name] || 0) >= FINAL_CAP) continue;
    perArtist[c.artist_name] = (perArtist[c.artist_name] || 0) + 1;
    chosen.push({ ...c, reason: p.reason });
    used.add(c.s6_product_id);
    if (chosen.length >= FINAL_N) break;
  }
  for (const c of poolRows) {
    if (chosen.length >= FINAL_N) break;
    if (used.has(c.s6_product_id)) continue;
    if ((perArtist[c.artist_name] || 0) >= FINAL_CAP) continue;
    perArtist[c.artist_name] = (perArtist[c.artist_name] || 0) + 1;
    chosen.push({ ...c, reason: '' });
    used.add(c.s6_product_id);
  }
  return chosen;
}

function toCard(r) {
  return {
    ...r,
    product_handle: r.s6_product_id,
    source_collection: r.product_type || '',
    product_url: buildProductUrl(r.design_key, r.product_type),
  };
}


// ——— Find Similar: build a synthetic brief from seed product URLs ———————————
// Resolve each URL to a design_key, fetch those designs' OWN vision tags, and
// aggregate them (by frequency) into a brief the normal scorer can consume.
// No scraping — the seeds' tags are already in the catalog.
async function buildBriefFromSeeds(seedUrls) {
  const keys = Array.from(new Set(
    (seedUrls || []).slice(0, SEED_CAP).map(designKeyFromUrl).filter(Boolean)
  ));
  if (keys.length === 0) return { brief: null, seeds: [], unmatched: (seedUrls || []).length };

  const seeds = await fetchByDesignKeys(keys);
  const foundKeys = new Set(seeds.map(s => s.design_key));
  const unmatched = keys.filter(k => !foundKeys.has(k)).length;
  if (seeds.length === 0) return { brief: null, seeds: [], unmatched };

  // Split a comma-tag field into an array.
  const tags = (v) => (v || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  // Aggregate tag frequency across seeds, return most-common-first.
  const agg = (field) => {
    const counts = {};
    for (const s of seeds) for (const t of tags(s[field])) counts[t] = (counts[t] || 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([t]) => t);
  };

  const styleTags = agg('vision_style').slice(0, 8);
  const paletteTags = agg('vision_palette').slice(0, 8);
  const moodTags = agg('vision_mood').slice(0, 6);
  // vision_subject is one compact phrase per seed — collect distinct words as subject tokens.
  const subjectWords = {};
  for (const s of seeds) for (const w of (s.vision_subject || '').toLowerCase().split(/[^a-z]+/).filter(x => x.length >= 4)) {
    subjectWords[w] = (subjectWords[w] || 0) + 1;
  }
  const subjectTokens = Object.entries(subjectWords).sort((a, b) => b[1] - a[1]).map(([w]) => w).slice(0, 6);

  const brief = {
    projectName: 'Find Similar',
    clientName: '', location: '', projectType: 'other',
    briefSummary: `Artwork with a similar aesthetic to ${seeds.length} selected piece(s).`,
    styleTags, paletteTags, moodTags, subjectTokens,
    keywords: Array.from(new Set([...styleTags, ...paletteTags, ...subjectTokens])).slice(0, 20),
    avoidHard: [], avoidSoft: [],
    galleryWall: false, keyThemes: styleTags.slice(0, 3),
    parsedBy: 'find-similar',
  };
  return { brief, seeds, unmatched };
}

// Merge a text brief with a seed-derived brief (union of tag lists; text brief's
// scalar fields and avoid lists win).
function mergeBriefs(primary, seed) {
  if (!primary) return seed;
  if (!seed) return primary;
  const u = (a, b) => Array.from(new Set([...(a || []), ...(b || [])]));
  return {
    ...primary,
    styleTags: u(primary.styleTags, seed.styleTags),
    paletteTags: u(primary.paletteTags, seed.paletteTags),
    moodTags: u(primary.moodTags, seed.moodTags),
    subjectTokens: u(primary.subjectTokens, seed.subjectTokens),
    keywords: u(primary.keywords, seed.keywords),
    parsedBy: (primary.parsedBy || 'claude') + '+seeds',
  };
}

// ——— Route handler ——————————————————————————————————————————————————————————
// Keep-warm endpoint. A scheduled Netlify function pings this every few minutes so
// the container (and the Claude SDK dynamic import, the expensive part of a cold
// start) stays hot, which is what pushes a cold POST over the ~10s limit.
// NOTE (Sep 2026): the DB warm (`SELECT 1` on the pg pool) was deliberately REMOVED.
// Pinging it every 5 minutes kept Neon from ever scaling to zero, which burned
// compute 24/7 and exhausted the quota. Neon wakes in ~0.5–1s on the first real
// query, and the client's 504 auto-retry covers the rare fully-cold miss.
// `warmed.db` is kept in the response shape (always false) so existing checks parse.
export async function GET() {
  const out = { ok: true, warmed: { db: false, sdk: false } };
  try { await import('@anthropic-ai/sdk'); out.warmed.sdk = true; } catch (e) { out.sdkError = e.message; }
  return NextResponse.json(out);
}

export async function POST(request) {
  try {
    let briefText = '', moodboardUrl = '', moodboardFile = null;
    let pinnedUrls = [], excludeMini = true;
    let refineFeedback = '', prevItemTitles = [];
    let findSimilarUrls = [];
    let productTypes = [];

    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('multipart/form-data')) {
      const fd = await request.formData();
      briefText = fd.get('brief') || '';
      moodboardUrl = fd.get('moodboardUrl') || '';
      moodboardFile = fd.get('moodboard');
      try { pinnedUrls = JSON.parse(fd.get('pinnedUrls') || '[]'); } catch {}
      refineFeedback = fd.get('refineFeedback') || '';
      try { prevItemTitles = JSON.parse(fd.get('prevItemTitles') || '[]'); } catch {}
      try { findSimilarUrls = JSON.parse(fd.get('findSimilarUrls') || '[]'); } catch {}
      try { productTypes = JSON.parse(fd.get('productTypes') || '[]'); } catch {}
      const em = fd.get('excludeMini');
      if (em !== null && em !== undefined && em !== '') excludeMini = (em === 'true' || em === true);
    } else {
      const body = await request.json();
      briefText = body.brief || '';
      moodboardUrl = body.moodboardUrl || '';
      pinnedUrls = body.pinnedUrls || [];
      refineFeedback = body.refineFeedback || '';
      prevItemTitles = body.prevItemTitles || [];
      findSimilarUrls = body.findSimilarUrls || [];
      productTypes = body.productTypes || [];
      if (typeof body.excludeMini === 'boolean') excludeMini = body.excludeMini;
    }
    productTypes = (Array.isArray(productTypes) ? productTypes : []).map(t => (t || '').trim()).filter(Boolean);

    // Normalize findSimilarUrls: accept array or newline string
    if (typeof findSimilarUrls === 'string') findSimilarUrls = findSimilarUrls.split('\n');
    findSimilarUrls = (Array.isArray(findSimilarUrls) ? findSimilarUrls : []).map(u => (u || '').trim()).filter(Boolean);

    if (!process.env.DATABASE_URL) {
      return NextResponse.json({ error: 'Catalog database not configured (DATABASE_URL missing).' }, { status: 500 });
    }
    const hasBriefText = !!(briefText || '').trim();
    const hasSeeds = findSimilarUrls.length > 0;
    if (!hasBriefText && !hasSeeds) {
      return NextResponse.json({ error: 'Please provide a brief or at least one Society6 product URL to find similar art.' }, { status: 400 });
    }

    // —— Moodboard extraction (best-effort) folded into the brief ——
    const moodboard = { urlStatus: 'none', pdfStatus: 'none' };
    const [urlRes, pdfRes] = await Promise.all([
      extractMoodboardUrl(moodboardUrl),
      extractMoodboardPdf(moodboardFile),
    ]);
    moodboard.urlStatus = urlRes.status;
    moodboard.pdfStatus = pdfRes.status;
    if (urlRes.text) briefText += `\n\n--- MOODBOARD URL NOTES (supplemental; brief takes precedence) ---\n${urlRes.text}`;
    if (pdfRes.text) briefText += `\n\n--- MOODBOARD PDF NOTES (supplemental; brief takes precedence) ---\n${pdfRes.text}`;

    const hasKey = !!process.env.ANTHROPIC_API_KEY;

    // —— Parse brief text (if any) ——
    let brief = null;
    if (hasBriefText) {
      if (hasKey) {
        try { brief = await parseBriefWithClaude(briefText); brief.parsedBy = 'claude'; }
        catch (e) { console.warn('parse failed, fallback:', e.message); brief = parseBriefFallback(briefText); brief.parsedBy = 'regex-fallback'; }
      } else { brief = parseBriefFallback(briefText); brief.parsedBy = 'regex'; }
    }

    // —— Find Similar: build a seed brief and merge (or use alone) ——
    let seedResult = { brief: null, seeds: [], unmatched: 0 };
    if (hasSeeds) {
      seedResult = await buildBriefFromSeeds(findSimilarUrls);
      if (seedResult.brief) {
        brief = brief ? mergeBriefs(brief, seedResult.brief) : seedResult.brief;
      }
    }
    if (!brief) {
      return NextResponse.json({ error: 'Could not build a curation from the provided input. Check the brief or the product URLs.' }, { status: 400 });
    }

    // —— Refine: interpret feedback into hints and merge into the brief ——
    let feedbackHints = null;
    if (refineFeedback && refineFeedback.trim() && hasKey) {
      try {
        feedbackHints = await parseFeedbackWithClaude(refineFeedback, brief);
        if (feedbackHints) brief = applyFeedbackToBrief(brief, feedbackHints);
      } catch (e) { console.warn('feedback parse failed:', e.message); }
    }

    // —— Score (excluding previously-shown titles on a refine) ——
    const candidates = (await scorePool(brief, excludeMini, prevItemTitles, productTypes)).map(toCard);
    const totalScored = candidates.length;

    if (candidates.length === 0) {
      return NextResponse.json({
        brief, primary: [], accent: [], galleryWallSets: [],
        totalScored: 0, catalogSize: 64281, filteredSize: 0, moodboard,
        aiPowered: hasKey,
        note: 'No designs scored above zero for this brief. Try loosening color or subject constraints.',
      });
    }

    // —— Curate ——
    let primary = [], accent = [];
    if (hasKey) {
      try {
        const picks = await selectWithClaude(candidates, brief);
        primary = applyFinalCap(picks, candidates);
        const set = new Set(primary.map(r => r.s6_product_id));
        accent = candidates.filter(r => !set.has(r.s6_product_id)).slice(0, 15);
      } catch (e) {
        console.warn('selection failed, weighted order:', e.message);
        primary = candidates.slice(0, FINAL_N);
        accent = candidates.slice(FINAL_N, FINAL_N + 15);
      }
    } else {
      primary = candidates.slice(0, FINAL_N);
      accent = candidates.slice(FINAL_N, FINAL_N + 15);
    }

    // —— Pin seeds + explicit pins (resolve via design_key, force-include at top) ——
    // Find-Similar seeds are pinned so the pasted pieces surface in results.
    const allPinUrls = Array.from(new Set([...(pinnedUrls || []), ...findSimilarUrls]));
    let pinnedUnmatched = 0;
    if (allPinUrls.length > 0) {
      const keys = Array.from(new Set(allPinUrls.map(designKeyFromUrl).filter(Boolean)));
      if (keys.length > 0) {
        const rows = (await fetchByDesignKeys(keys, productTypes)).map(toCard);
        const foundKeys = new Set(rows.map(r => r.design_key));
        pinnedUnmatched = keys.filter(k => !foundKeys.has(k)).length;
        if (rows.length > 0) {
          const pinnedSet = new Set(rows.map(r => r.s6_product_id));
          const pinnedRows = rows.map(r => ({ ...r, pinned: true }));
          primary = [...pinnedRows, ...primary.filter(r => !pinnedSet.has(r.s6_product_id))];
        }
      }
    }

    const galleryWallSets = brief.galleryWall ? [
      { setNumber: 1, theme: (brief.keyThemes || [])[0] || 'curated', items: primary.slice(0, 6) },
      { setNumber: 2, theme: (brief.keyThemes || [])[1] || 'accent',  items: primary.slice(6, 12) },
    ] : [];

    return NextResponse.json({
      brief,
      primary: primary.slice(0, FINAL_N + allPinUrls.length),
      accent: accent.slice(0, 15),
      galleryWallSets,
      totalScored, catalogSize: 64281, filteredSize: totalScored,
      moodboard, pinnedUnmatched, excludeMini,
      findSimilar: { seedCount: seedResult.seeds.length, unmatched: seedResult.unmatched },
      feedbackApplied: feedbackHints ? refineFeedback : null,
      aiPowered: hasKey,
    });
  } catch (err) {
    console.error('Recommend error:', err);
    return NextResponse.json({ error: err.message || 'Failed to generate recommendations' }, { status: 500 });
  }
}
