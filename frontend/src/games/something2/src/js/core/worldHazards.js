// Ground a boss skill left behind (lava pools, a ring of fire, a frost field) and the delayed
// explosions riding on players (Ember Mark, Static Charge), as the renderer wants them. The same
// "separate pure remap module" shape worldTelegraphs.js uses, for the same reason: the field list
// is exactly where a new key gets silently dropped between the server frame and the draw path.
//
// The server sends both lists REPLACED every frame and omits the key when there is nothing, so a
// frame without it means "none now". Every value is filtered so nothing non-finite reaches the
// canvas (a path with a NaN coordinate is silently dropped, and can take the rest of the pass with
// it).

// { id, x, y, r, inner, element, v, ms, calm } -- calm: the ground only slows, it does not hurt.
export function hazardsFromFrame(msg) {
  const raw = msg && Array.isArray(msg.hazards) ? msg.hazards : [];
  const out = [];
  for (const h of raw) {
    if (!h) continue;
    const x = Number(h.x);
    const y = Number(h.y);
    const r = Number(h.r);
    if (![x, y, r].every(Number.isFinite) || r <= 0) continue;
    const inner = Number(h.in);
    const ms = Number(h.ms);
    out.push({
      id: h.id != null ? String(h.id) : `${x},${y}`,
      x, y, r,
      inner: Number.isFinite(inner) && inner > 0 && inner < r ? inner : 0,
      element: typeof h.el === "string" ? h.el : null,
      v: typeof h.v === "string" ? h.v : null,
      ms: Number.isFinite(ms) && ms > 0 ? ms : 0,
      calm: !!h.calm,
    });
  }
  return out;
}

// { userId, radius, ms, total, v } -- a countdown ring on a player.
export function marksFromFrame(msg) {
  const raw = msg && Array.isArray(msg.marks) ? msg.marks : [];
  const out = [];
  for (const m of raw) {
    if (!m || m.u == null) continue;
    const radius = Number(m.r);
    if (!Number.isFinite(radius) || radius <= 0) continue;
    const ms = Number(m.ms);
    const total = Number(m.total);
    out.push({
      userId: String(m.u),
      radius,
      ms: Number.isFinite(ms) && ms > 0 ? ms : 0,
      total: Number.isFinite(total) && total > 0 ? total : (Number.isFinite(ms) && ms > 0 ? ms : 1),
      v: typeof m.v === "string" ? m.v : null,
    });
  }
  return out;
}

// 0 at the start of the fuse, 1 when it goes off.
export function markProgress(mark) {
  if (!mark || !(mark.total > 0)) return 1;
  return Math.max(0, Math.min(1, 1 - mark.ms / mark.total));
}

// Hazards that have not run out yet, with their remaining time reduced by how long ago the frame
// arrived (so a pool fades on its own clock between frames rather than snapping when the next
// frame lands). `elapsedMs` is the time since the list was received.
export function hazardsAt(list, elapsedMs) {
  const dt = Math.max(0, Number(elapsedMs) || 0);
  const out = [];
  for (const h of list || []) {
    const ms = h.ms - dt;
    if (ms > 0) out.push(ms === h.ms ? h : { ...h, ms });
  }
  return out;
}
