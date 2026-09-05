import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { remotePlayerFromFrame } from '../worldPlayers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ===========================================================================
// SOMET-523. The client half of the player frame.
//
// These exist because the aura ring shipped BROKEN in exactly the way none of
// its own tests could see: the server sent `aura`, RenderSystem drew `aura`,
// and Game._onWorldState rebuilt each player from a named field list that did
// not include it. Server verified, renderer unit-tested, nothing on screen.
//
// The lesson generalises past this one field, so the second test below is a
// CROSS-FILE CONTRACT rather than another assertion about auras.
// ===========================================================================

describe('remotePlayerFromFrame', () => {
  it('carries aura through to the renderer', () => {
    const p = remotePlayerFromFrame({ id: 'u1', x: 1, y: 2, facing: 's', hp: 5, maxHp: 9, aura: 160 });
    expect(p.aura).toBe(160);
  });

  // The server OMITS the key for a player with no aura, and auraRingGeometry
  // reads it as a number -- `undefined` would be a NaN radius, which Canvas 2D
  // silently drops rather than complaining about.
  it('defaults a missing aura to 0, never undefined', () => {
    const p = remotePlayerFromFrame({ id: 'u1', x: 1, y: 2 });
    expect(p.aura).toBe(0);
    expect(Number.isFinite(p.aura)).toBe(true);
  });

  it('still carries everything the renderer already relied on', () => {
    const p = remotePlayerFromFrame({
      x: 1, y: 2, facing: 'ne', hp: 5, maxHp: 9, effects: ['burn'],
    });
    expect(p).toEqual({
      x: 1, y: 2, facing: 'ne', hp: 5, maxHp: 9, effects: ['burn'], aura: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// THE GUARD THAT WOULD HAVE CAUGHT THE ORIGINAL BUG.
//
// The server's world.js snapshot() builds each player's frame; this client
// reads it. The two lists are written in different files, in different
// languages of intent, by people looking at different problems -- and a field
// present in one and missing from the other fails SILENTLY in the direction
// that matters (server sends, client drops, nothing renders).
//
// So: read the server's snapshot() source and require that every optional
// player field it can attach is named somewhere in the client's core. This is
// a text check and therefore coarse -- it proves a field is MENTIONED, not
// that it is used correctly -- but the failure it catches is "nobody
// mentioned it at all", which is precisely the failure that shipped.
// ---------------------------------------------------------------------------
describe('server player frame -> client contract', () => {
  const worldPath = path.resolve(HERE, '../../../../../../../../backend/src/authority/world.js');

  it('every optional field snapshot() attaches is read by the client', () => {
    if (!fs.existsSync(worldPath)) {
      throw new Error(`cannot find the authority source at ${worldPath} -- `
        + 'this guard is worthless if it silently skips, so it fails instead');
    }
    const world = fs.readFileSync(worldPath, 'utf8');

    // snapshot() attaches optional fields as `out.<name> = ...`.
    const snapshot = world.slice(world.indexOf('  snapshot() {'));
    const optional = [...new Set(
      [...snapshot.matchAll(/\bout\.([a-zA-Z_][\w]*)\s*=/g)].map((m) => m[1]),
    )];
    expect(optional.length).toBeGreaterThan(0);

    const clientDir = path.resolve(HERE, '..');
    const clientSrc = fs.readdirSync(clientDir)
      .filter((f) => f.endsWith('.js'))
      .map((f) => fs.readFileSync(path.join(clientDir, f), 'utf8'))
      .join('\n');

    const missing = optional.filter((f) => !new RegExp(`\\b${f}\\b`).test(clientSrc));
    expect(missing).toEqual([]);
  });
});
