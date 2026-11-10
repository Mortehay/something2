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

import { snapshotBuffs } from './buffAuras.js';

// What a remote player carries into the renderer: everything the server sent, plus
// the defaults below. A new server field needs no edit here (it is spread through);
// worldPlayers.test.js holds the contract that NO field is ever dropped.
export function remotePlayerFromFrame(p) {
  return {
    // The frame is SPREAD first, so a field the server adds reaches the renderer
    // without anyone remembering to name it here (the original bug: a named list
    // dropped `aura` and the ring never drew). The entries below are only the
    // fields that need a default or a coercion -- the server OMITS a key when it
    // has nothing to say, and the renderer reads these as numbers.
    ...p,
    effects: p.effects || null,
    // Defaulted to 0 rather than null: auraRingGeometry reads it as a number,
    // and the server OMITS the key entirely for a player with no aura.
    aura: p.aura || 0,
    className: p.className || null,
    appearanceVariant: Number(p.appearanceVariant) || 1,
    // The +N of the weapon in hand; the server omits it below +1. Drives the aura.
    enchant: Number(p.enchant) || 0,
    // Active buffs (character buff auras). The server omits the key for a player
    // with none, so absent means [] -- each frame REPLACES the list.
    buffs: snapshotBuffs(p.buffs),
  };
}
