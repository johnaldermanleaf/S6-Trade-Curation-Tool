/**
 * lib/newDesigns.js — shared server logic for the New Designs enrichment flow.
 *
 * Ports, VERBATIM in behavior, the Mac pipeline scripts:
 *   - design_key derivation ......... build_import.py / stamp.py (number strip FIRST, then longest slug)
 *   - body + meta assembly .......... stamp.py (esc, capFirst, buildMeta/finish, context drop)
 *   - copy cleanup .................. fix-copy.mjs (fixDesc, fixMeta)
 *   - vision prompts ................ lib/describe.js (flat) and describe-mockup.js (mockup)
 *   - response parsing .............. lib/describe.js (parseLayers, parseCuration, clampMeta)
 *
 * Do not "improve" the design_key derivation — it must match the keys already in Neon.
 */

import pg from 'pg';
import { META_STRIP } from './formatSeed.js';

const { Pool } = pg;

// ── DB pool (same settings as lib/describe.js) ────────────────

let _pool = null;
export function getPool() {
  if (!_pool) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 10,
      keepAlive: true,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
    });
    _pool.on('error', () => {}); // Neon pooler can drop idle clients — never crash
  }
  return _pool;
}

// ── design_key (verbatim from stamp.py) ───────────────────────

const NUM_TAIL = /[-_](?:v)?\d+$/;

export function designKey(handle, typeSlugs) {
  let h = handle.trim().toLowerCase();
  h = h.replace(NUM_TAIL, '');
  for (const slug of typeSlugs) {
    for (const sep of ['_', '-']) {
      if (h.endsWith(sep + slug)) {
        return h.slice(0, -(sep.length + slug.length));
      }
    }
  }
  return h;
}

// Sort slugs the way stamp.py does: longest first (order is load-bearing).
export function sortSlugs(slugs) {
  return [...new Set(slugs)].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
}

// slug_for from build_new_import.py — Type name -> slug
export function slugForType(t) {
  let s = t.trim().toLowerCase().replace(/&/g, 'and');
  s = s.replace(/[\s/]+/g, '-');
  s = s.replace(/[^a-z0-9-]/g, '');
  return s.replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// ── stamp.py helpers (verbatim behavior) ──────────────────────

// html.escape(s, quote=False): & < > only, & first.
export function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function capFirst(s) {
  s = s.trim().replace(/[ .]+$/, '');
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function metaFinish(b) {
  b = b.replace(/\s+$/, '');
  while (true) {
    const core = b.replace(/[ .!?,;:]+$/, '');
    const idx = core.lastIndexOf(' ');
    if (idx !== -1) {
      const lastWord = core.slice(idx + 1);
      if (META_STRIP.has(lastWord.replace(/[^A-Za-z]/g, '').toLowerCase())) {
        b = core.slice(0, idx);
        continue;
      }
    }
    break;
  }
  b = b.replace(/[ ,;:\-]+$/, '');
  if (b && !'.!?'.includes(b[b.length - 1])) b += '.';
  return b;
}

// build_meta from stamp.py — prefix the meta with the per-type label, cap 155.
// metaLabel may be null (types added after Item 1): meta passes through unchanged.
export function buildMeta(metaLabel, meta, cap = 155) {
  meta = (meta || '').trim();
  if (!metaLabel || !meta) return meta;
  const prefix = metaLabel + ': ';
  const budget = cap - prefix.length;
  let body;
  if (meta.length <= budget) {
    body = meta;
  } else {
    const cut = meta.slice(0, budget);
    const end = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'));
    if (end >= 40) {
      body = cut.slice(0, end + 1);
    } else {
      const ci = cut.lastIndexOf(',');
      if (ci >= 40) {
        body = cut.slice(0, ci);
      } else {
        const sp = cut.lastIndexOf(' ');
        body = sp > 40 ? cut.slice(0, sp) : cut;
      }
    }
  }
  return prefix + metaFinish(body);
}

// Assemble the PDP body exactly like stamp.py:
//   <p>{artwork}{ Context.}? {format sentence}</p>
export function buildBody(artwork, context, formatSentence, dropContext) {
  const a = esc(artwork.trim());
  const c = (context || '').trim();
  const cpart = !dropContext && c ? ' ' + esc(capFirst(c)) + '.' : '';
  return `<p>${a}${cpart} ${esc(formatSentence)}</p>`;
}

// ── fix-copy.mjs (verbatim behavior) ──────────────────────────

const EMDASH = /[—–]/;

export function fixDesc(d) {
  if (!d || !EMDASH.test(d)) return d;
  let s = d.replace(/\s*[—–]\s*/g, ', ');
  s = s.replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/,\s*,/g, ', ')
    .replace(/,\s*\./g, '.')
    .replace(/^[\s,]+/, '');
  return s.trim();
}

function stripCharCount(m) {
  return m.replace(/\s*[\[\(]?\s*\d{1,4}\s+characters?\s*[\]\)]?\.?\s*$/i, '').trim();
}
function lastSentence(m) {
  const i = Math.max(m.lastIndexOf('.'), m.lastIndexOf('!'), m.lastIndexOf('?'));
  return i === -1 ? null : m.slice(0, i + 1).trim();
}
function balancedQuotes(s) { return (s.split('"').length - 1) % 2 === 0; }
function clamp150(m) {
  if (m.length <= 150) return m;
  const ls = lastSentence(m.slice(0, 150));
  return ls && ls.length >= 40 ? ls : m.slice(0, 150).trim();
}

export function fixMeta(mRaw) {
  if (!mRaw) return { value: mRaw, changed: false, kind: 'none' };
  let m = stripCharCount(mRaw.trim());
  if (/[.!?]$/.test(m)) { m = clamp150(m); return { value: m, changed: m !== mRaw, kind: 'strip' }; }
  const ls = lastSentence(m);
  if (ls && ls.length >= 40) { m = clamp150(ls); return { value: m, changed: true, kind: 'trim-sentence' }; }
  const ci = m.lastIndexOf(',');
  if (ci > 40) {
    let c = m.slice(0, ci).replace(/[\s,;:]+$/, '').trim();
    if (c.length >= 40 && balancedQuotes(c)) {
      c = clamp150(c + '.');
      return { value: c, changed: true, kind: 'trim-clause' };
    }
  }
  return { value: mRaw, changed: false, kind: 'unfixable' };
}

// clampMeta from lib/describe.js — applied at generation time.
export function clampMeta(s) {
  if (!s) return s;
  if (s.length <= 150) return s;
  let cut = s.slice(0, 150);
  const sp = cut.lastIndexOf(' ');
  if (sp > 100) cut = cut.slice(0, sp);
  cut = cut.replace(/[\s.,;:!?\-–—"'""'']+$/u, '').trim();
  const lastEnd = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'));
  if (lastEnd >= 60) cut = cut.slice(0, lastEnd + 1).trim();
  return cut;
}

// ── Vision prompts (verbatim from lib/describe.js / describe-mockup.js) ──

export const MODEL_ID = 'claude-haiku-4-5-20251001';
export const PROMPT_VERSION_FLAT = 'desc-v3-text-r3';
export const PROMPT_VERSION_MOCKUP = 'desc-v2-mockup-r3';
export const COST_PER_INPUT_TOKEN = 0.00000025;
export const COST_PER_OUTPUT_TOKEN = 0.00000125;

const PROMPT_TAIL =
'4. CURATION METADATA: Structured metadata for internal catalog filtering and search. This is NEVER shown to customers, so ignore the brand-voice word rules above for this part and just be accurate, literal, and plain. Return a JSON object with exactly these string fields: ' +
'"subject" (the main subject in 1 to 4 words), ' +
'"style" (the dominant artistic style, e.g. minimalist, watercolor, abstract, line art, vintage, photographic, illustration, typography), ' +
'"palette" (3 to 6 dominant colors, comma-separated), ' +
'"mood" (2 to 4 mood words, comma-separated), ' +
'"keywords" (8 to 12 lowercase search terms a shopper might use to find this artwork, comma-separated). ' +
'Every value is a plain string.\n\n' +
'Return ONLY this format, nothing before or after:\n' +
'ARTWORK: [2 sentences]\n' +
'CONTEXT: [phrase under 15 words]\n' +
'META: [one complete sentence ending in a period]\n' +
'CURATION: {"subject":"...","style":"...","palette":"...","mood":"...","keywords":"..."}\n\n';

export function buildFlatPrompt(title) {
  return (
'You are writing product copy for Society6, a curated marketplace of original artwork by independent artists. ' +
'You are looking at the artwork itself, not any physical product. Given the image and the title, return FOUR things.\n\n' +
'1. ARTWORK DESCRIPTION: Exactly 2 sentences describing only the artwork - its subject, colors, composition, mood, and artistic approach. ' +
'Lead with the concrete subject (e.g. "Cream wildflowers scatter across a warm tangerine ground..." not "This piece features..."). ' +
'Be specific and confident - make direct observations, do not hedge. ' +
'Some artworks, especially posters, use lettering as a central element. If the artwork contains a large, clearly legible title, headline, or short phrase that is a dominant part of the composition and you can read it with complete confidence, quote that short wording exactly in double quotes and note how the lettering looks in general terms (for example bold capitals, or flowing script). Only quote SHORT wording: a title, a name, a single word, or a brief phrase. ' +
'If the artwork instead contains a longer passage (a verse, a full quotation, a paragraph, or several lines of text), describe that text is present and its general character, but do NOT reproduce, quote, or paraphrase the full passage. ' +
'Do not state a specific typeface category such as serif or sans-serif unless it is unmistakable; otherwise describe the lettering more generally. ' +
'Stay strict about all other text: for any wording that is small, secondary, stylized, partially obscured, or that you cannot read with complete confidence, do NOT mention it, quote it, paraphrase it, or note that it exists. Never guess or approximate words. It is better to omit real text than to state text that is wrong or absent. Most artworks have no prominent lettering; describe those purely as art with no mention of text. ' +
'Do NOT mention any product, format, or material (no print, frame, canvas, pillow, etc). ' +
'MATERIAL RULE: if the artwork DEPICTS a material or texture (fur, woven fabric, knit, wool, velvet, embroidery, quilting, wood grain, leather, etc.), make unmistakable that it is part of the printed artwork, not the product: write it as a graphic or printed rendering (for example "a graphic zebra pattern evoking fur" or "a printed rendering of woven texture"). Never use wording that could imply the physical product is made of that material, or is soft, plush, or textured to the touch. This rule applies to the ARTWORK DESCRIPTION, the CONTEXT CLAUSE, and the META DESCRIPTION. ' +
'DELIVERY RULE: a sentence may DESCRIBE what the artwork depicts (material words are fine there), but must never promise a physical or tactile experience the product delivers. Never write framings like "drawn to natural textures", "embracing natural materials", "celebrates tactile forms", "invites touch", "soft to the touch", the word "tactile", or "brings texture or softness into your room". Never use "tapestry" as a metaphor (such as "a tapestry of colors"). This rule also applies to the ARTWORK DESCRIPTION, the CONTEXT CLAUSE, and the META DESCRIPTION. ' +
'Never use any form of these words anywhere in the description: stunning, beautiful, beauty, beautifully, vibrant, unique, perfect, perfection, perfectly, gorgeous. Never use the word design or designs - this is original artwork, not a template. Do NOT use em-dashes or en-dashes (the characters — or –); use periods or commas instead.\n\n' +
'2. CONTEXT CLAUSE: One short phrase (under 15 words) naming where this artwork naturally belongs - a room, a mood, a moment. ' +
'Start lowercase so it can follow the description (e.g. "at home in a calm bedroom or a quiet reading corner"). ' +
'Do NOT mention a product or material.\n\n' +
'3. META DESCRIPTION: One complete sentence, under 150 characters total including the title. Keep it short so it fits, but write only the sentence itself. Lead with the concrete subject, name the artwork title, ' +
'and close with a short invitation that is specific to THIS artwork (reference its actual subject, mood, or color). Vary how the closing sentence opens across pieces. An occasional "Discover" is fine, but do not lean on it or any single opener, and avoid generic phrases like "shop now" or "for your walls". ' +
'Do NOT use the word perfect or vibrant. Do NOT use em-dashes or en-dashes; use a period or comma instead. Do NOT mention a specific product type. End the sentence with a period. NEVER write a character count, a number of characters, or any note about length anywhere in your output. ' +
'If the title contains an artist or series name, it may appear after the descriptive subject, never before it.\n\n' +
PROMPT_TAIL +
'Title: ' + title
  );
}

export function buildMockupPrompt(title) {
  return (
'You are writing product copy for Society6, a curated marketplace of original artwork by independent artists. ' +
'The image is a product photo: this artwork is printed on a product or shown installed in a styled room. Describe ONLY the printed artwork itself, exactly as you would if it were flat art on paper. Completely ignore the product and any staging: fabric, seams, edges, corners, zippers, folds, phone-case cutouts, mat surface, frames, and any room setting such as walls, furniture, shelves, plants, rugs, lighting, windows, shadows, and background props. Describe only the art, never the object or room it sits in. Given the image and the title, return FOUR things.\n\n' +
'1. ARTWORK DESCRIPTION: Exactly 2 sentences describing only the artwork - its subject, colors, composition, mood, and artistic approach. ' +
'Lead with the concrete subject (e.g. "Cream wildflowers scatter across a warm tangerine ground..." not "This piece features..."). ' +
'Be specific and confident - make direct observations, do not hedge. ' +
'Do NOT mention any product, format, or material (no print, frame, canvas, pillow, etc). ' +
'MATERIAL RULE: if the artwork DEPICTS a material or texture (fur, woven fabric, knit, wool, velvet, embroidery, quilting, wood grain, leather, etc.), make unmistakable that it is part of the printed artwork, not the product: write it as a graphic or printed rendering (for example "a graphic zebra pattern evoking fur" or "a printed rendering of woven texture"). Never use wording that could imply the physical product is made of that material, or is soft, plush, or textured to the touch. This rule applies to the ARTWORK DESCRIPTION, the CONTEXT CLAUSE, and the META DESCRIPTION. ' +
'DELIVERY RULE: a sentence may DESCRIBE what the artwork depicts (material words are fine there), but must never promise a physical or tactile experience the product delivers. Never write framings like "drawn to natural textures", "embracing natural materials", "celebrates tactile forms", "invites touch", "soft to the touch", the word "tactile", or "brings texture or softness into your room". Never use "tapestry" as a metaphor (such as "a tapestry of colors"). This rule also applies to the ARTWORK DESCRIPTION, the CONTEXT CLAUSE, and the META DESCRIPTION. ' +
'Do NOT use any form of these words: stunning, beautiful, beauty, beautifully, vibrant, unique, perfect, perfection, perfectly, or gorgeous. Do NOT use em-dashes or en-dashes (the characters — or –); use periods or commas instead. ' +
'Do NOT use the word "design" - this is original artwork, not a template.\n\n' +
'2. CONTEXT CLAUSE: One short phrase (under 15 words) naming where this artwork naturally belongs - a room, a mood, a moment. ' +
'Start lowercase so it can follow the description (e.g. "at home in a calm bedroom or a quiet reading corner"). ' +
'Do NOT mention a product or material.\n\n' +
'3. META DESCRIPTION: One complete sentence, under 150 characters total including the title. Keep it short so it fits, but write only the sentence itself. Lead with the concrete subject, name the artwork title, ' +
'and close with a short invitation that is specific to THIS artwork (reference its actual subject, mood, or color). Vary how the closing sentence opens across pieces. An occasional "Discover" is fine, but do not lean on it or any single opener, and avoid generic phrases like "shop now" or "for your walls". ' +
'Do NOT use the word perfect. Do NOT use em-dashes or en-dashes; use a period or comma instead. Do NOT mention a specific product type. End the sentence with a period. NEVER write a character count, a number of characters, or any note about length anywhere in your output. ' +
'If the title contains an artist or series name, it may appear after the descriptive subject, never before it.\n\n' +
PROMPT_TAIL +
'Title: ' + title
  );
}

// ── Response parsing (verbatim from lib/describe.js) ──────────

function parseCuration(text) {
  const empty = { vision_subject: '', vision_style: '', vision_palette: '', vision_mood: '', vision_keywords: '' };
  const m = text.match(/CURATION:\s*([\s\S]+)$/i);
  if (!m) return empty;
  const block = m[1];
  const start = block.indexOf('{');
  const end = block.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return empty;
  try {
    const obj = JSON.parse(block.slice(start, end + 1));
    const norm = (v) => Array.isArray(v) ? v.join(', ') : (v == null ? '' : String(v).trim());
    return {
      vision_subject: norm(obj.subject),
      vision_style: norm(obj.style),
      vision_palette: norm(obj.palette),
      vision_mood: norm(obj.mood),
      vision_keywords: norm(obj.keywords),
    };
  } catch {
    return empty;
  }
}

export function parseLayers(text) {
  const a = text.match(/ARTWORK:\s*([\s\S]+?)(?=CONTEXT:|META:|CURATION:|$)/i);
  const c = text.match(/CONTEXT:\s*([\s\S]+?)(?=META:|CURATION:|$)/i);
  const m = text.match(/META:\s*([\s\S]+?)(?=CURATION:|$)/i);
  return {
    artwork_description: a ? a[1].trim() : '',
    context_clause: c ? c[1].trim() : '',
    meta_description: clampMeta(m ? m[1].trim() : ''),
    ...parseCuration(text),
  };
}

// ── Image fetch (verbatim from lib/describe.js) ───────────────

export async function fetchImageAsBase64(imageUrl) {
  const fullUrl = imageUrl.startsWith('/') ? 'https://society6.com' + imageUrl : imageUrl;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(fullUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; S6DescribeBot/1.0)', 'Accept': 'image/*' },
        signal: AbortSignal.timeout(6000),
        redirect: 'follow',
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const contentType = res.headers.get('content-type') || 'image/jpeg';
      const mediaType = contentType.split(';')[0].trim();
      const buffer = await res.arrayBuffer();
      return { base64: Buffer.from(buffer).toString('base64'), mediaType };
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await new Promise(r => setTimeout(r, 250));
    }
  }
  throw lastErr || new Error('image fetch failed');
}

// ── Brand-voice lint (for reviewing copy + new format sentences) ──

const BANNED_WORDS = /\b(gorgeous|stunning|beautiful|beauty|beautifully|vibrant|unique|perfect|perfection|perfectly)\b/gi;
const DESIGNS_WORD = /\bdesigns?\b/gi;

export function lintCopy(text, { isFormatSentence = false } = {}) {
  const warnings = [];
  if (!text || !text.trim()) return warnings;
  const banned = text.match(BANNED_WORDS);
  if (banned) warnings.push(`banned word: ${[...new Set(banned.map(w => w.toLowerCase()))].join(', ')}`);
  const designs = text.match(DESIGNS_WORD);
  if (designs) warnings.push('uses "design/designs" (say "artwork" instead)');
  if (/[—–]/.test(text)) warnings.push('contains an em-dash or en-dash (use a period or comma)');
  if (/shop now/i.test(text)) warnings.push('contains "Shop now"');
  if (isFormatSentence && /^made to order/i.test(text.trim())) {
    warnings.push('opens with "Made to order" (vary the opener)');
  }
  return warnings;
}

// ── Format-sentence config, loaded from Neon ──────────────────

export async function loadFormatConfig(pool) {
  const { rows } = await pool.query(
    `SELECT product_type, sentence, meta_label, type_slug, drop_context, flat
     FROM format_sentences ORDER BY product_type`
  );
  const byType = {};
  for (const r of rows) byType[r.product_type] = r;
  const slugs = sortSlugs(rows.map(r => r.type_slug).filter(Boolean));
  return { byType, slugs, count: rows.length };
}
