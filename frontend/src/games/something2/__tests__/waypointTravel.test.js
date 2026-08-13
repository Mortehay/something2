import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTravelList, REASON } from '../waypointTravel.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// The travel popup's rules (SOMET-293). The component itself cannot be mounted
// (vitest runs in a node environment here), so every rule lives in
// waypointTravel.js and is asserted against a payload shaped exactly like the
// one /api/player/waypoints returns.
//
// "Exactly like" is checked rather than claimed -- see the last test in this
// file. SOMET-286 shipped green and completely inert because its fixture encoded
// a shape the live loader never produced.

// The three waypoints of the real home region, in the endpoint's own field
// names. `away` is discovered, `unknown` is a place this character has seen the
// world of but never stood on -- the acceptance criterion's case.
const WAYPOINTS = [
  { id: 'wp-home', worldId: 'w1', worldName: 'Old Trailhead', x: 3250, y: 3250, name: 'Old Trailhead Commons', mapLinkId: null, activated: true, activatedAt: '2026-08-13T10:00:00Z' },
  { id: 'wp-away', worldId: 'w2', worldName: 'Windwatch Pass', x: 4050, y: 2550, name: 'Windwatch Waystone', mapLinkId: null, activated: true, activatedAt: '2026-08-13T10:05:00Z' },
  { id: 'wp-unknown', worldId: 'w3', worldName: 'Thornbriar Reach', x: 3050, y: 2650, name: 'Thornbriar Green', mapLinkId: null, activated: false, activatedAt: null },
];

// Standing dead on the Old Trailhead waypoint's tile.
const ON_HOME = { waypoints: WAYPOINTS, currentWorldId: 'w1', playerX: 3250, playerY: 3250 };

const entryOf = (result, id) =>
  result.groups.flatMap((g) => g.entries).find((e) => e.id === id);

describe('buildTravelList', () => {
  it('knows which waypoint the player is standing on', () => {
    const r = buildTravelList(ON_HOME);
    expect(r.here.id).toBe('wp-home');
    expect(r.standingOnActivated).toBe(true);
  });

  it('matches by TILE, not by exact pixel', () => {
    // A player is never on a single pixel. The tile is what the server keys on
    // (waypointTileKey), so anywhere in the 100px cell counts -- and one pixel
    // outside it does not.
    expect(buildTravelList({ ...ON_HOME, playerX: 3299, playerY: 3201 }).here.id).toBe('wp-home');
    expect(buildTravelList({ ...ON_HOME, playerX: 3300, playerY: 3250 }).here).toBe(null);
  });

  it('does not call the player "here" for a same-tile waypoint in another world', () => {
    // Tiles repeat across worlds; only the world makes the pair unique. Without
    // the world check a player would be told they are standing somewhere they
    // have never been -- and would be offered travel from it.
    const r = buildTravelList({ ...ON_HOME, currentWorldId: 'w9' });
    expect(r.here).toBe(null);
    expect(r.standingOnActivated).toBe(false);
  });

  it('lists an undiscovered waypoint, distinctly and unselectable', () => {
    // ACCEPTANCE CRITERION 4. It is in the list -- knowing a place exists and
    // has not been reached is the point of showing it -- and it can never be
    // chosen.
    const e = entryOf(buildTravelList(ON_HOME), 'wp-unknown');
    expect(e).toBeDefined();
    expect(e.activated).toBe(false);
    expect(e.selectable).toBe(false);
    expect(e.reason).toBe(REASON.NOT_DISCOVERED);
  });

  it('offers a discovered waypoint in another world', () => {
    const e = entryOf(buildTravelList(ON_HOME), 'wp-away');
    expect(e.activated).toBe(true);
    expect(e.selectable).toBe(true);
    expect(e.reason).toBe(null);
  });

  it('never offers the waypoint the player is standing on', () => {
    const e = entryOf(buildTravelList(ON_HOME), 'wp-home');
    expect(e.selectable).toBe(false);
    expect(e.reason).toBe(REASON.YOU_ARE_HERE);
  });

  it('offers nothing at all when the player is not on a waypoint', () => {
    // The travel rule itself: you may only set off from a waypoint you have lit.
    const r = buildTravelList({ ...ON_HOME, playerX: 100, playerY: 100 });
    expect(r.standingOnActivated).toBe(false);
    expect(r.groups.flatMap((g) => g.entries).some((e) => e.selectable)).toBe(false);
    expect(entryOf(r, 'wp-away').reason).toBe(REASON.NOT_ON_A_WAYPOINT);
    // ...but the undiscovered one still says the more specific thing.
    expect(entryOf(r, 'wp-unknown').reason).toBe(REASON.NOT_DISCOVERED);
  });

  it('offers nothing when the player is standing on an UNLIT waypoint', () => {
    // The client mirroring the server's rule rather than a looser version of it.
    // Live this is the window between stepping on a waypoint and the server's
    // activation write landing -- or failing.
    const unlitHome = WAYPOINTS.map((w) => (w.id === 'wp-home' ? { ...w, activated: false } : w));
    const r = buildTravelList({ ...ON_HOME, waypoints: unlitHome });
    expect(r.here.id).toBe('wp-home');
    expect(r.standingOnActivated).toBe(false);
    expect(entryOf(r, 'wp-away').selectable).toBe(false);
    expect(entryOf(r, 'wp-away').reason).toBe(REASON.NOT_ON_A_WAYPOINT);
  });

  it('groups by world and never invents a world name', () => {
    const r = buildTravelList(ON_HOME);
    expect(r.groups.map((g) => g.worldName))
      .toEqual(['Old Trailhead', 'Windwatch Pass', 'Thornbriar Reach']);
    // The endpoint withholds nothing here (a waypoint is only listed for a world
    // the character has visited or lit), but the transform must still carry the
    // name through rather than deriving one.
    expect(r.groups.map((g) => g.worldId)).toEqual(['w1', 'w2', 'w3']);
  });

  it('survives an empty or missing payload', () => {
    // The popup renders before the query resolves, and a character that has lit
    // nothing gets an empty array.
    for (const arg of [undefined, {}, { waypoints: [] }, { waypoints: null }]) {
      const r = buildTravelList(arg);
      expect(r.here).toBe(null);
      expect(r.standingOnActivated).toBe(false);
      expect(r.groups).toEqual([]);
    }
  });

  it('the fixture above is the shape the LIVE loader produces', () => {
    // SOMET-286 shipped a green, reviewed, merged feature that was inert in the
    // browser because its fixture encoded an object the live loader never
    // produced. Every field this file's payload uses is checked against the
    // object listWaypointsForCharacter actually builds -- the one function
    // behind GET /api/player/waypoints -- rather than against a second copy of
    // the shape written here.
    const service = fs.readFileSync(
      path.join(here, '../../../../../backend/src/services/waypoints.js'), 'utf8');
    const fn = service.slice(service.indexOf('async function listWaypointsForCharacter'));
    const mapping = fn.slice(fn.indexOf('return r.rows.map'), fn.indexOf('module.exports'));
    expect(mapping.length).toBeGreaterThan(0);

    for (const key of Object.keys(WAYPOINTS[0])) {
      expect(mapping, `listWaypointsForCharacter does not produce "${key}"`)
        .toMatch(new RegExp(`\\b${key}:`));
    }
    // And the other direction: a field the loader produces that this fixture
    // omits is a field the popup has never been tested against.
    const produced = [...mapping.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]);
    expect(produced.length).toBeGreaterThan(0);
    expect(produced.sort()).toEqual(Object.keys(WAYPOINTS[0]).sort());
  });
});
