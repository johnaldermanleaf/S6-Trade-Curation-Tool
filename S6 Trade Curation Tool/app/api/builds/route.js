import { NextResponse } from 'next/server';
import { createBuild } from '../../../lib/builds';
import { sanitizeHandoffItem, buildCsvRows } from '../../../lib/handoff';

export const maxDuration = 26;

// POST /api/builds
// Body: { briefRef?, projectName?, primary[], accent[], galleryWallSets[] }
// Called by the "Send to Collection" button after a rep picks their pieces.
// Returns { id, itemCount, jsonUrl, csvUrl } — the two URLs are what the trade
// app fetches; nothing is pushed to it from here.
export async function POST(request) {
  try {
    if (!process.env.DATABASE_URL) {
      return NextResponse.json(
        { error: 'Catalog database not configured (DATABASE_URL missing).' },
        { status: 500 }
      );
    }

    const body = await request.json();
    const { briefRef, projectName, primary, accent, galleryWallSets } = body || {};

    const payload = {
      briefRef: briefRef || '',
      projectName: projectName || '',
      primary: (primary || []).map(sanitizeHandoffItem).filter(Boolean),
      accent: (accent || []).map(sanitizeHandoffItem).filter(Boolean),
      galleryWallSets: (galleryWallSets || []).map(set => ({
        setNumber: set.setNumber,
        theme: set.theme || '',
        items: (set.items || []).map(sanitizeHandoffItem).filter(Boolean),
      })),
      createdAt: new Date().toISOString(),
    };

    const designCount =
      payload.primary.length +
      payload.accent.length +
      payload.galleryWallSets.reduce((n, s) => n + s.items.length, 0);

    if (designCount === 0) {
      return NextResponse.json(
        { error: 'Nothing to send. Select at least one piece first.' },
        { status: 400 }
      );
    }

    // itemCount is CSV rows (one per available product type), which is what the
    // trade app will actually import — not the design count.
    const rowCount = buildCsvRows(payload).length;

    const id = await createBuild({
      briefRef,
      projectName,
      payload,
      itemCount: rowCount,
    });

    const base = process.env.PUBLIC_BASE_URL || new URL(request.url).origin;
    return NextResponse.json({
      id,
      designCount,
      itemCount: rowCount,
      jsonUrl: `${base}/api/builds/${id}`,
      csvUrl: `${base}/api/builds/${id}.csv`,
    });
  } catch (err) {
    console.error('Build POST error:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to save build' },
      { status: 500 }
    );
  }
}
