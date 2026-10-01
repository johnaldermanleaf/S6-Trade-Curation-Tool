/**
 * S6 Catalog — Product Description Pipeline (three-layer prose + curation metadata)
 * Reads products with description_status = 'pending', runs each image
 * through Claude vision with the brand-voice prompt, writes the three prose
 * layers AND the structured curation fields onto the product's current
 * enrichment_results row in a single pass. Tracks its own description_status.
 *
 * CLI:
 *   node lib/describe.js
 *   node lib/describe.js --continuous
 *   node lib/describe.js --batch-size=100
 *   node lib/describe.js --category=wall_art
 *   node lib/describe.js --force
 * Env: DATABASE_URL, ANTHROPIC_API_KEY
 */

import pg from 'pg';
import Anthropic from '@anthropic-ai/sdk';

const { Pool } = pg;

let _pool = null;
function getPool() {
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
    // Neon's pooler can drop a connection mid-run; without this handler an
    // 'error' event on an idle client crashes the whole process.
    _pool.on('error', (err) => {
      console.error('  (pool warning: ' + err.message + ' — continuing)');
    });
  }
  return _pool;
}

// Check out a pooled client with an 'error' listener attached, so a socket
// death mid-query rejects the awaiting query (catchable) instead of emitting
// an unhandled 'error' event that crashes the whole process.
async function getClient(pool) {
  const client = await pool.connect();
  client.on('error', (err) => {
    console.error('  (client error: ' + err.message + ' — will recover)');
  });
  return client;
}

const MODEL_ID = 'claude-haiku-4-5-20251001';
const PROMPT_VERSION = 'desc-v3-text-r3';
const COST_PER_INPUT_TOKEN  = 0.00000025;
const COST_PER_OUTPUT_TOKEN = 0.00000125;

function buildPrompt(title) {
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
'Never use any form of these words anywhere in the description: stunning, beautiful, beauty, beautifully, vibrant, unique, perfect, perfection, perfectly, gorgeous. Never use the word design or designs - this is original artwork, not a template. Do NOT use em-dashes or en-dashes (the characters \u2014 or \u2013); use periods or commas instead.\n\n' +
'2. CONTEXT CLAUSE: One short phrase (under 15 words) naming where this artwork naturally belongs - a room, a mood, a moment. ' +
'Start lowercase so it can follow the description (e.g. "at home in a calm bedroom or a quiet reading corner"). ' +
'Do NOT mention a product or material.\n\n' +
'3. META DESCRIPTION: One complete sentence, under 150 characters total including the title. Keep it short so it fits, but write only the sentence itself. Lead with the concrete subject, name the artwork title, ' +
'and close with a short invitation that is specific to THIS artwork (reference its actual subject, mood, or color). Vary how the closing sentence opens across pieces. An occasional "Discover" is fine, but do not lean on it or any single opener, and avoid generic phrases like "shop now" or "for your walls". ' +
'Do NOT use the word perfect or vibrant. Do NOT use em-dashes or en-dashes; use a period or comma instead. Do NOT mention a specific product type. End the sentence with a period. NEVER write a character count, a number of characters, or any note about length anywhere in your output. ' +
'If the title contains an artist or series name, it may appear after the descriptive subject, never before it.\n\n' +
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
'CURATION: {"subject":"...","style":"...","palette":"...","mood":"...","keywords":"..."}\n\n' +
'Title: ' + title
  );
}

async function fetchImageAsBase64(imageUrl) {
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
      if (attempt === 0) await sleep(250);
    }
  }
  throw lastErr || new Error('image fetch failed');
}

function clampMeta(s) {
  if (!s) return s;
  if (s.length <= 150) return s;
  let cut = s.slice(0, 150);
  const sp = cut.lastIndexOf(' ');
  if (sp > 100) cut = cut.slice(0, sp);
  cut = cut.replace(/[\s.,;:!?\-–—"'""'']+$/u, '').trim();
  // if trimming left a dangling sentence fragment, fall back to the last complete sentence
  const lastEnd = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'));
  if (lastEnd >= 60) cut = cut.slice(0, lastEnd + 1).trim();
  return cut;
}

// best-effort parse of the CURATION JSON block; never throws (prose is primary)
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
      vision_subject:  norm(obj.subject),
      vision_style:    norm(obj.style),
      vision_palette:  norm(obj.palette),
      vision_mood:     norm(obj.mood),
      vision_keywords: norm(obj.keywords),
    };
  } catch {
    return empty;
  }
}

function parseLayers(text) {
  const a = text.match(/ARTWORK:\s*([\s\S]+?)(?=CONTEXT:|META:|CURATION:|$)/i);
  const c = text.match(/CONTEXT:\s*([\s\S]+?)(?=META:|CURATION:|$)/i);
  const m = text.match(/META:\s*([\s\S]+?)(?=CURATION:|$)/i);
  return {
    artwork_description: a ? a[1].trim() : '',
    context_clause:      c ? c[1].trim() : '',
    meta_description:    clampMeta(m ? m[1].trim() : ''),
    ...parseCuration(text),
  };
}

async function describeProduct(product, anthropicClient) {
  if (!product.image_url) throw new Error('no image_url');
  const { base64, mediaType } = await fetchImageAsBase64(product.image_url);
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const message = await anthropicClient.messages.create({
        model: MODEL_ID,
        max_tokens: 700,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: buildPrompt(product.title || '') },
          ],
        }],
      });
      const inputTokens  = message.usage?.input_tokens  || 0;
      const outputTokens = message.usage?.output_tokens || 0;
      const costUsd = (inputTokens * COST_PER_INPUT_TOKEN) + (outputTokens * COST_PER_OUTPUT_TOKEN);
      const layers = parseLayers(message.content[0].text.trim());
      if (!layers.artwork_description) throw new Error('could not parse ARTWORK from response');
      return { layers, inputTokens, outputTokens, costUsd };
    } catch (e) {
      lastErr = e;
      const status = e?.status || e?.response?.status;
      const msg = (e?.message || '').toLowerCase();
      if (status === 429 || status === 529 || msg.includes('rate') || msg.includes('overload')) {
        if (attempt === 0) { await sleep(1500); continue; }
      }
      throw e;
    }
  }
  throw lastErr || new Error('description failed');
}

async function markProcessing(client, productId) {
  await client.query("UPDATE products SET description_status = 'processing', updated_at = now() WHERE id = $1", [productId]);
}

async function writeDescription(client, productId, layers, tokens) {
  const { rows } = await client.query(
    'SELECT id FROM enrichment_results WHERE product_id = $1 AND is_current = true LIMIT 1',
    [productId]
  );
  if (rows.length > 0) {
    await client.query(
      'UPDATE enrichment_results SET artwork_description = $2, context_clause = $3, meta_description = $4, ' +
      'vision_subject = $5, vision_style = $6, vision_palette = $7, vision_mood = $8, vision_keywords = $9, ' +
      'model_id = $10, prompt_version = $11 WHERE id = $1',
      [rows[0].id, layers.artwork_description, layers.context_clause, layers.meta_description,
       layers.vision_subject, layers.vision_style, layers.vision_palette, layers.vision_mood, layers.vision_keywords,
       MODEL_ID, PROMPT_VERSION]
    );
  } else {
    await client.query(
      'INSERT INTO enrichment_results (product_id, model_id, prompt_version, is_current, ' +
      'artwork_description, context_clause, meta_description, ' +
      'vision_subject, vision_style, vision_palette, vision_mood, vision_keywords, ' +
      'input_tokens, output_tokens, estimated_cost_usd) ' +
      'VALUES ($1,$2,$3,true,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
      [productId, MODEL_ID, PROMPT_VERSION,
       layers.artwork_description, layers.context_clause, layers.meta_description,
       layers.vision_subject, layers.vision_style, layers.vision_palette, layers.vision_mood, layers.vision_keywords,
       tokens.inputTokens, tokens.outputTokens, tokens.costUsd]
    );
  }
  await client.query(
    "UPDATE products SET description_status = 'described', description_attempts = description_attempts + 1, description_error = null, updated_at = now() WHERE id = $1",
    [productId]
  );
}

async function markFailed(client, productId, errorMessage) {
  await client.query(
    "UPDATE products SET description_status = 'failed', description_attempts = description_attempts + 1, description_error = $2, updated_at = now() WHERE id = $1",
    [productId, errorMessage.slice(0, 500)]
  );
}

async function runWithConcurrency(items, limit, worker) {
  let next = 0;
  async function pump() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, pump));
}

export async function runDescriptionBatch(options = {}) {
  const { batchSize = 50, concurrency = 6, category = null, force = false, continuous = false } = options;
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set.');
  const pool = getPool();
  const anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const totals = { processed: 0, succeeded: 0, failed: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  // Recover any rows left in 'processing' by a previous crash/disconnect.
  const reset = await pool.query("UPDATE products SET description_status = 'pending' WHERE description_status = 'processing'");
  if (reset.rowCount > 0) console.log('  Reset ' + reset.rowCount + ' stale processing rows back to pending.');
  let keepGoing = true;
  let dbRetries = 0;
  while (keepGoing) {
   try {
const statusValues = ['pending', 'failed'];
    const categoryClause = category ? 'AND category = $3::product_category' : '';
    const queryParams = category ? [batchSize, statusValues, category] : [batchSize, statusValues];
    const { rows: products } = await pool.query(
      'SELECT id, s6_product_id, title, image_url FROM products WHERE description_status = ANY($2::description_status[]) AND image_url IS NOT NULL AND image_url <> \'\' ' + categoryClause + ' ORDER BY created_at ASC LIMIT $1',
      queryParams
    );
    if (products.length === 0) { console.log('  No more pending products to describe.'); break; }
    dbRetries = 0;
    console.log('\n  Describing batch of ' + products.length + ' products...');
    const client = await getClient(pool);
    try { await Promise.all(products.map(p => markProcessing(client, p.id))); }
    finally { client.release(); }
    const batchStats = { processed: 0, succeeded: 0, failed: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    await runWithConcurrency(products, concurrency, async (product) => {
      const dbClient = await getClient(pool);
      try {
        const { layers, inputTokens, outputTokens, costUsd } = await describeProduct(product, anthropicClient);
        await writeDescription(dbClient, product.id, layers, { inputTokens, outputTokens, costUsd });
        batchStats.succeeded++;
        batchStats.inputTokens += inputTokens;
        batchStats.outputTokens += outputTokens;
        batchStats.costUsd += costUsd;
        process.stdout.write('\r  ' + (batchStats.succeeded + batchStats.failed) + '/' + products.length + ' | cost so far: $' + (totals.costUsd + batchStats.costUsd).toFixed(4));
      } catch (err) {
        await markFailed(dbClient, product.id, err.message);
        batchStats.failed++;
        console.error('\n  Failed: ' + product.title + ' — ' + err.message);
      } finally {
        batchStats.processed++;
        dbClient.release();
      }
    });
    for (const key of Object.keys(totals)) totals[key] += batchStats[key];
    console.log('\n  Batch done: ' + batchStats.succeeded + ' described, ' + batchStats.failed + ' failed | $' + batchStats.costUsd.toFixed(4));
    keepGoing = continuous && products.length === batchSize;
    if (keepGoing) await sleep(500);
   } catch (batchErr) {
    // A DB connection drop (or similar transient error) bubbled up mid-batch.
    // Reset any rows we left in 'processing', back off, and retry the loop
    // instead of crashing. Anything already 'described' stays saved.
    dbRetries++;
    const wait = Math.min(30000, 3000 * dbRetries);
    console.error('\n  (batch error: ' + batchErr.message + ') — recovering in ' + (wait/1000) + 's [retry ' + dbRetries + ']');
    try {
      await pool.query("UPDATE products SET description_status = 'pending' WHERE description_status = 'processing'");
    } catch (_) { /* if even this fails, the next start-of-run reset will catch it */ }
    if (dbRetries >= 10) { console.error('  Too many consecutive DB errors; stopping. Re-run the same command to resume.'); break; }
    await sleep(wait);
   }
  }
  console.log('\n  Description run complete.');
  console.log('   Described:  ' + totals.succeeded.toLocaleString());
  console.log('   Failed:     ' + totals.failed.toLocaleString());
  console.log('   Total cost: $' + totals.costUsd.toFixed(4));
  return totals;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

if (process.argv[1] === decodeURIComponent(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes('--' + name);
  const opt  = (name, def) => {
    const arg = args.find(a => a.startsWith('--' + name + '='));
    return arg ? arg.split('=')[1] : def;
  };
  const options = {
    batchSize:   parseInt(opt('batch-size', '50'), 10),
    concurrency: parseInt(opt('concurrency', '6'), 10),
    category:    opt('category', null),
    force:       flag('force'),
    continuous:  flag('continuous'),
  };
  console.log('\n  S6 Description Pipeline');
  console.log('   batch-size:  ' + options.batchSize);
  console.log('   concurrency: ' + options.concurrency);
  console.log('   category:    ' + (options.category || 'all'));
  console.log('   continuous:  ' + options.continuous);
  console.log('   force:       ' + options.force);
  runDescriptionBatch(options).then(() => process.exit(0)).catch(err => { console.error('\nPipeline failed:', err.message); process.exit(1); });
}
