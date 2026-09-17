import { NextResponse } from 'next/server';
import { getBuild, BUILD_ID_RE } from '../../../../lib/builds';
import { buildCsvRows, toCsvText, csvFilename } from '../../../../lib/handoff';

export const maxDuration = 26;

// Shared-secret gate. If TRADE_HANDOFF_KEY is unset the endpoint is open —
// same posture as the rest of this prototype — but set it before pointing the
// trade app at production.
function authorized(request) {
  const expected = process.env.TRADE_HANDOFF_KEY;
  if (!expected) return true;
  const got =
    request.headers.get('x-trade-key') ||
    (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return got === expected;
}

// GET /api/builds/{id}       → JSON payload
// GET /api/builds/{id}.csv   → the exact CSV a rep would download
//
// The .csv form exists so the trade app's existing CSV importer keeps working
// unchanged: it fetches this URL instead of a human uploading a file.
export async function GET(request, { params }) {
  try {
    const raw = params?.id || '';
    const wantsCsv = raw.toLowerCase().endsWith('.csv');
    const id = wantsCsv ? raw.slice(0, -4) : raw;

    if (!BUILD_ID_RE.test(id)) {
      return NextResponse.json({ error: 'Invalid build ID' }, { status: 400 });
    }
    if (!authorized(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const row = await getBuild(id);
    if (!row) {
      return NextResponse.json({ error: 'Build not found' }, { status: 404 });
    }

    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;

    if (!wantsCsv) {
      return NextResponse.json({
        id: row.id,
        briefRef: row.brief_ref || '',
        projectName: row.project_name || '',
        itemCount: row.item_count,
        createdAt: row.created_at,
        ...payload,
      });
    }

    // '﻿' BOM matches the browser download byte-for-byte so Sheets and
    // Excel read the =IMAGE() thumbnails and any non-ASCII titles correctly.
    const csv = '﻿' + toCsvText(buildCsvRows(payload));
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv;charset=utf-8',
        'Content-Disposition': `attachment; filename="${csvFilename(row.project_name)}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('Build GET error:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to load build' },
      { status: 500 }
    );
  }
}
