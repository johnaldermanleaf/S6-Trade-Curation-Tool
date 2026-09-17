import { NextResponse } from 'next/server';

export const maxDuration = 26;

// ———————————————————————————————————————————————————————————————————————————
// Inbound half of the handoff: "Open in Trade Curation Tool"
//
// The trade app links a rep here as  /?briefId=123  and this route fetches the
// brief server-side. The brief is NEVER passed through the URL: it would blow
// past URL limits (the "avoid" field alone runs to a few hundred words) and
// would scatter client details through browser history, referrers and logs.
//
// Contract expected from the trade app (Lisa's side to build):
//
//   GET {TRADE_APP_BASE_URL}/api/briefs/{id}
//   Header: x-trade-key: {TRADE_APP_KEY}
//   200 → {
//     projectName, projectType, budget, pieceCount, deadline,
//     style, palette, avoid, rooms, notes
//   }
//
// Creative fields only — no name, email, phone or shipping address. The
// recommender has no use for them and this app should not hold them.
// ———————————————————————————————————————————————————————————————————————————

const FIELD_LABELS = [
  ['projectName', 'Project Name'],
  ['projectType', 'Project Type'],
  ['style', 'Design Style'],
  ['palette', 'Color Palette'],
  ['avoid', 'Avoid'],
  ['rooms', 'Rooms'],
  ['pieceCount', 'Target Pieces'],
  ['budget', 'Budget'],
  ['deadline', 'Deadline'],
  ['notes', 'Notes'],
];

// Render the trade app's structured brief into the labelled block the existing
// brief parser already understands (see SAMPLE_BRIEF in app/page.jsx).
export function briefToText(brief) {
  const val = (v) => (Array.isArray(v) ? v.filter(Boolean).join(', ') : (v ?? '')).toString().trim();
  return FIELD_LABELS
    .map(([key, label]) => [label, val(brief?.[key])])
    .filter(([, v]) => v)
    .map(([label, v]) => `${label}: ${v}`)
    .join('\n');
}

export async function GET(request, { params }) {
  const id = String(params?.id || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return NextResponse.json({ error: 'Invalid brief ID' }, { status: 400 });
  }

  const base = process.env.TRADE_APP_BASE_URL;
  if (!base) {
    return NextResponse.json(
      { error: 'Trade app not configured (TRADE_APP_BASE_URL missing).' },
      { status: 503 }
    );
  }

  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/api/briefs/${encodeURIComponent(id)}`, {
      headers: {
        accept: 'application/json',
        ...(process.env.TRADE_APP_KEY ? { 'x-trade-key': process.env.TRADE_APP_KEY } : {}),
      },
      cache: 'no-store',
    });

    if (res.status === 404) {
      return NextResponse.json({ error: 'Brief not found in the trade app.' }, { status: 404 });
    }
    if (!res.ok) {
      return NextResponse.json(
        { error: `Trade app returned ${res.status}.` },
        { status: 502 }
      );
    }

    const brief = await res.json();
    const briefText = briefToText(brief);
    if (!briefText) {
      return NextResponse.json(
        { error: 'Trade app returned an empty brief.' },
        { status: 502 }
      );
    }

    return NextResponse.json({
      briefId: id,
      projectName: brief?.projectName || '',
      briefText,
      moodboardUrl: brief?.moodboardUrl || '',
    });
  } catch (err) {
    console.error('Trade brief fetch error:', err);
    return NextResponse.json(
      { error: 'Could not reach the trade app.' },
      { status: 502 }
    );
  }
}
