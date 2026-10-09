import { NextResponse } from 'next/server';
import pg from 'pg';

export const dynamic = 'force-dynamic';
export const maxDuration = 26;

const { Pool } = pg;
const BATCH = 5000;

// Export shape. Description fields (artwork/context/meta) are what the
// product and data teams need; the vision_* tag fields are kept where the
// pipeline still populates them. vision_summary is not exported: the current
// prompt (desc-v3) never fills it.
const COLUMNS = [
  'design_key',
  's6_product_id',
  'title',
  'artist_name',
  'product_type',
  'category',
  'product_url',
  'image_url',
  'description_status',
  'artwork_description',
  'context_clause',
  'meta_description',
  'vision_subject',
  'vision_style',
  'vision_palette',
  'vision_mood',
  'vision_keywords',
  'prompt_version',
  'model_id',
  'described_at',
  'description_error',
];

let _pool = null;
function getPool() {
  if (!_pool) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
    });
  }
  return _pool;
}

// Raw tables only. The enriched_products view is NOT used: it predates the
// description pipeline and lacks columns this export needs.
// Keyset pagination on p.id (uuid) so each batch is a cheap indexed seek.
function buildSql(onlyEnriched, afterId) {
  const join = onlyEnriched ? 'INNER' : 'LEFT';
  const where = [];
  if (afterId) where.push(`p.id > $2`);
  if (onlyEnriched) where.push(`r.artwork_description IS NOT NULL AND r.artwork_description <> ''`);
  return `
    SELECT
      p.id,
      p.design_key,
      p.s6_product_id,
      p.title,
      p.artist_name,
      p.product_type,
      p.category::text          AS category,
      p.product_url,
      p.image_url,
      p.description_status::text AS description_status,
      r.artwork_description,
      r.context_clause,
      r.meta_description,
      r.vision_subject,
      r.vision_style,
      r.vision_palette,
      r.vision_mood,
      r.vision_keywords,
      r.prompt_version,
      r.model_id,
      r.created_at              AS described_at,
      p.description_error
    FROM products p
    ${join} JOIN enrichment_results r
      ON r.product_id = p.id AND r.is_current = true
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY p.id
    LIMIT $1
  `;
}

function normalize(r) {
  const { id, ...rest } = r;
  return {
    ...rest,
    described_at: r.described_at instanceof Date ? r.described_at.toISOString() : (r.described_at || ''),
  };
}

async function fetchBatch(pool, onlyEnriched, afterId) {
  const params = afterId ? [BATCH, afterId] : [BATCH];
  const { rows } = await pool.query(buildSql(onlyEnriched, afterId), params);
  return rows;
}

// GET ?format=csv|json  &onlyEnriched=true
export async function GET(request) {
  try {
    const url = new URL(request.url);
    const format = (url.searchParams.get('format') || 'csv').toLowerCase();
    const onlyEnriched = url.searchParams.get('onlyEnriched') === 'true';
    const isJson = format === 'json';

    const dateStamp = new Date().toISOString().slice(0, 10);
    const filenameBase = onlyEnriched
      ? `s6-catalog-enriched-${dateStamp}`
      : `s6-catalog-full-${dateStamp}`;

    // Run the FIRST query before any bytes go out. A schema or connection
    // problem now returns a real 500 instead of a header-only file.
    const pool = getPool();
    let batch = await fetchBatch(pool, onlyEnriched, null);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          if (isJson) controller.enqueue(encoder.encode('['));
          else controller.enqueue(encoder.encode('\uFEFF' + COLUMNS.join(',') + '\n'));

          let first = true;
          while (batch.length > 0) {
            const lastId = batch[batch.length - 1].id;
            const recs = batch.map(normalize);
            if (isJson) {
              const chunk = recs.map(r => JSON.stringify(r)).join(',\n');
              controller.enqueue(encoder.encode((first ? '\n' : ',\n') + chunk));
              first = false;
            } else {
              controller.enqueue(encoder.encode(batchToCsv(recs)));
            }
            if (batch.length < BATCH) break;
            batch = await fetchBatch(pool, onlyEnriched, lastId);
          }

          if (isJson) controller.enqueue(encoder.encode('\n]\n'));
          controller.close();
        } catch (err) {
          console.error('Export stream error:', err);
          controller.error(err);
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filenameBase}.${isJson ? 'json' : 'csv'}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('Export error:', err);
    return NextResponse.json({ error: err.message || 'Export failed' }, { status: 500 });
  }
}

function batchToCsv(records) {
  const lines = [];
  for (const r of records) {
    const row = COLUMNS.map(col => {
      const v = r[col];
      if (v === undefined || v === null) return '';
      if (Array.isArray(v)) return csvEscape(v.join('|'));
      return csvEscape(String(v));
    });
    lines.push(row.join(','));
  }
  return lines.join('\n') + '\n';
}

function csvEscape(s) {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
