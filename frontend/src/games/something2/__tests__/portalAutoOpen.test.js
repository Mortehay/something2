// Auto-opening the travel popup on arrival (SOMET-300).
//
// The rule lives in a pure helper for the reason waypointTravel.js and
// playerWorldMap.js both do: vitest runs in a node environment in this project,
// so the component cannot be rendered in a test at all. A rule kept inside the
// effect is a rule with no test.
import { describe, it, expect } from 'vitest';
import { shouldAutoOpen, portalTileOf } from '../portalAutoOpen.js';

const WORLD = 'w1';
// The Old Trailhead portal: (3250,3250) is tile row 32, col 32.
const PORTAL = { worldId: WORLD, x: 3250, y: 3250 };

describe('portalTileOf', () => {
  it('keys row-first, the order the authority and waypointTravel both use', () => {
    // If this were transposed the popup would open on a mirrored tile and only
    // ever be caught on a non-square map -- the exact bug SOMET-292 records
    // having shipped between two helpers that were each internally consistent.
    expect(portalTileOf({ x: 3250, y: 1050 })).toBe('10,32');
  });

  it('is null for a missing point rather than "NaN,NaN"', () => {
    expect(portalTileOf(null)).toBe(null);
    expect(portalTileOf({ x: null, y: 10 })).toBe(null);
  });
});

describe('shouldAutoOpen', () => {
  const base = { portal: PORTAL, worldId: WORLD, isOpen: false };

  it('opens when the player steps onto the portal tile', () => {
    expect(shouldAutoOpen({ ...base, prevTile: '32,31', tile: '32,32' })).toBe(true);
  });

  it('does NOT reopen while the player stays on the tile', () => {
    // The latch, and the whole point. Without it the popup reopens on every
    // poll for as long as the player stands there -- unclosable.
    expect(shouldAutoOpen({ ...base, prevTile: '32,32', tile: '32,32' })).toBe(false);
  });

  it('opens again after stepping off and back on', () => {
    expect(shouldAutoOpen({ ...base, prevTile: '32,32', tile: '32,31' })).toBe(false);
    expect(shouldAutoOpen({ ...base, prevTile: '32,31', tile: '32,32' })).toBe(true);
  });

  it('does not fire while the popup is already open', () => {
    // Re-firing would fight a player who is mid-selection.
    expect(shouldAutoOpen({ ...base, isOpen: true, prevTile: '32,31', tile: '32,32' })).toBe(false);
  });

  it('never opens in a world with no portal -- 86 of ~90 have none', () => {
    expect(shouldAutoOpen({ ...base, portal: null, prevTile: '32,31', tile: '32,32' })).toBe(false);
  });

  it('does not open on a portal belonging to a different world', () => {
    // Two worlds can hold a portal on the same tile; matching on the tile alone
    // would pop the panel in the wrong place.
    expect(shouldAutoOpen({ ...base, worldId: 'w2', prevTile: '32,31', tile: '32,32' })).toBe(false);
  });

  it('does not open on the first reading, before a previous tile is known', () => {
    // prevTile null means "we have not seen this player move yet" -- typically
    // the frame right after a join. Resuming ON the portal must not fire a modal
    // before the player has touched a key; the arrival-bounce guard on the server
    // treats the same situation the same way.
    expect(shouldAutoOpen({ ...base, prevTile: null, tile: '32,32' })).toBe(false);
  });

  it('does not open when the player is nowhere yet', () => {
    expect(shouldAutoOpen({ ...base, prevTile: '32,31', tile: null })).toBe(false);
  });
});
