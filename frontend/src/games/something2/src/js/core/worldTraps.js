// Archer traps on the ground, as the renderer wants them. Same shape as
// worldTelegraphs.js: the server re-sends every trap that is still down, the frame
// REPLACES the list, and anything non-finite is dropped before it can reach the canvas.
//
// Wire shape (world.js snapshot): traps: [{ k: 'bear'|'explosive'|'tar', x, y, r, ms }]

const KINDS = new Set(['bear', 'explosive', 'tar']);

export function trapsFromFrame(msg) {
  const raw = msg && Array.isArray(msg.traps) ? msg.traps : [];
  const out = [];
  for (const t of raw) {
    if (!t || !KINDS.has(t.k)) continue;
    const x = Number(t.x);
    const y = Number(t.y);
    const r = Number(t.r);
    if (![x, y, r].every(Number.isFinite) || r <= 0) continue;
    const ms = Number(t.ms);
    out.push({ kind: t.k, x, y, radius: r, ms: Number.isFinite(ms) && ms > 0 ? ms : 0 });
  }
  return out;
}

// Colour and label per kind, shared by the renderer and its test.
export const TRAP_STYLE = {
  bear: { color: '#cbd5e1', glyph: '⛓' },
  explosive: { color: '#f97316', glyph: '✹' },
  tar: { color: '#1f2937', glyph: '' },
};
