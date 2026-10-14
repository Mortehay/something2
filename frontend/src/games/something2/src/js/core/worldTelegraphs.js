// SOMET-608 (S6). Active skill telegraphs, as the renderer wants them --
// the same "separate pure remap module" shape worldWaves.js already uses,
// and for the identical reason: this is exactly the field-list hop where
// SOMET-523's aura ring was silently dropped between the server frame and
// the draw path (Game._onWorldState in between), and putting the list
// somewhere a test can hold it is the whole point.
//
// The server sends geometry already RESOLVED -- x, y, radius -- and
// remaining `ms`, and omits the key entirely when there are no active
// telegraphs. See world.js's snapshot() for the wire shape.

// Every value the draw path needs, filtered so nothing non-finite reaches
// the canvas. Canvas 2D SILENTLY DROPS a path with non-finite coordinates
// (SOMET-488's own lesson, "Canvas marker shape drift" -- a malformed entry
// does not error, it just vanishes, and can take the rest of the pass with
// it depending on draw ordering), so this filters BEFORE the renderer ever
// sees one.
export function telegraphsFromFrame(msg) {
  const raw = msg && Array.isArray(msg.telegraphs) ? msg.telegraphs : [];
  const out = [];
  for (const t of raw) {
    if (!t) continue;
    const x = Number(t.x);
    const y = Number(t.y);
    const radius = Number(t.radius);
    if (![x, y, radius].every(Number.isFinite)) continue;
    if (radius <= 0) continue; // a zero-radius telegraph is nothing to draw
    const ms = Number(t.ms);
    const telegraphMs = Number(t.telegraphMs);
    out.push({
      creatureId: t.creatureId != null ? String(t.creatureId) : null,
      skill: typeof t.skill === 'string' ? t.skill : null,
      // SOMET-610 (S7): the vfx binding's resolved NAME (server-resolved,
      // same reason every other vfx name arrives resolved rather than as a
      // raw binding -- the client holds no creature_skills catalog). null
      // when the skill set none; the renderer keeps its own default then.
      v: typeof t.v === 'string' ? t.v : null,
      x, y, radius,
      // Remaining lifetime, for the fill progress. Clamped rather than
      // trusted -- a negative or NaN would invert or delete the draw, the
      // same guard worldWaves.js's own `ms` field already applies.
      ms: Number.isFinite(ms) && ms > 0 ? ms : 0,
      // The telegraph's ORIGINAL duration, so progress (elapsed/total) can
      // be computed without the client needing its own clock synced to the
      // moment the telegraph started -- `ms` alone only gives "how much is
      // left", not "how far along". Falls back to `ms` itself (reads as
      // "just started, nothing filled yet") if the server ever omits it,
      // rather than dividing by zero.
      telegraphMs: Number.isFinite(telegraphMs) && telegraphMs > 0 ? telegraphMs : (Number.isFinite(ms) && ms > 0 ? ms : 1),
    });
  }
  return out;
}

// The frame REPLACES the list every tick, exactly as applyWaveFrame does:
// the server re-sends every still-active telegraph, so treating a shorter
// list as a delta would leave an expired one filled on the ground forever.
export function applyTelegraphFrame(msg) {
  return telegraphsFromFrame(msg);
}
