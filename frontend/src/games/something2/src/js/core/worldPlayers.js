// SOMET-523. Turning a server player frame into the shape the renderer reads.
//
// WHY THIS IS ITS OWN MODULE. Game._onWorldState rebuilds each remote player
// from an EXPLICIT field list rather than spreading the frame. That is a
// deliberate choice -- it keeps the render objects small and stops unrelated
// server fields leaking into the draw path -- but it has one sharp edge: a
// field the server sends and the list does not name is DROPPED SILENTLY.
//
// That edge drew blood. The aura ring shipped with the server sending `aura`,
// RenderSystem drawing `aura`, and this list not naming it. Every unit test
// passed (the geometry helper was tested against hand-made objects), the
// server was verified to send the field, and nothing was drawn on screen.
// Pulling the mapping out here makes the field list a thing a test can hold.

// The fields a remote player carries into the renderer. Adding a field the
// server sends means adding it HERE and to the list in worldPlayers.test.js.
export function remotePlayerFromFrame(p) {
  return {
    x: p.x,
    y: p.y,
    facing: p.facing,
    hp: p.hp,
    maxHp: p.maxHp,
    effects: p.effects || null,
    // Defaulted to 0 rather than null: auraRingGeometry reads it as a number,
    // and the server OMITS the key entirely for a player with no aura.
    aura: p.aura || 0,
  };
}
