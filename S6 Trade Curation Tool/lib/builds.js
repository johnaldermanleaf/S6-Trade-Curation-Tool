// ———————————————————————————————————————————————————————————————————————————
// Trade builds — persistence for the curation → trade-app handoff
//
// Stored in Neon (the same DATABASE_URL the recommender already uses), NOT in
// Netlify Blobs like the older /api/share feature. Neon is host-agnostic, so
// these survive the move off Netlify; a blob store would not.
//
// Append-only, in keeping with the catalog contract: a build is written once
// and never mutated. Re-sending a curation creates a new build id.
// ———————————————————————————————————————————————————————————————————————————

import pg from 'pg';
import { randomBytes } from 'crypto';

let _pool = null;
function getPool() {
  if (!_pool) {
    _pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
    });
  }
  return _pool;
}

export const BUILD_ID_RE = /^[A-Za-z0-9_-]{6,32}$/;

function shortId() {
  return randomBytes(9).toString('base64url'); // 12 url-safe chars
}

// Idempotent, additive — safe to call on every write. Nothing here drops or
// truncates anything.
let _ensured = false;
async function ensureTable() {
  if (_ensured) return;
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS trade_builds (
      id            TEXT PRIMARY KEY,
      brief_ref     TEXT,
      project_name  TEXT,
      payload       JSONB NOT NULL,
      item_count    INTEGER NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await getPool().query(
    `CREATE INDEX IF NOT EXISTS trade_builds_brief_ref_idx ON trade_builds (brief_ref)`
  );
  _ensured = true;
}

export async function createBuild({ briefRef, projectName, payload, itemCount }) {
  await ensureTable();
  for (let i = 0; i < 10; i++) {
    const id = shortId();
    const res = await getPool().query(
      `INSERT INTO trade_builds (id, brief_ref, project_name, payload, item_count)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [id, briefRef || null, projectName || null, JSON.stringify(payload), itemCount || 0]
    );
    if (res.rows.length) return res.rows[0].id;
  }
  throw new Error('Failed to allocate a build id');
}

export async function getBuild(id) {
  await ensureTable();
  const res = await getPool().query(
    `SELECT id, brief_ref, project_name, payload, item_count, created_at
       FROM trade_builds WHERE id = $1`,
    [id]
  );
  return res.rows[0] || null;
}
