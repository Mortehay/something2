// The player-facing noun is "Portal" (SOMET-300).
//
// A SOURCE-TEXT test, in the same idiom playerWorldMap.test.js and
// WaypointTravel.smoke.test.js already use for this component: vitest runs in a
// node environment here, so neither file can be rendered, and the copy is the
// only part of this change a player can see.
//
// The rename is USER-FACING ONLY. `waypoints`/`character_waypoints`, the service
// module, the query key, the API route and every identifier keep their names --
// renaming them would touch every file in the feature to change nothing a player
// experiences, and would break the route the server serves. So these assertions
// deliberately scope to the strings inside quotes and JSX text, not to the file.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, '..', p), 'utf8');

// Text a player reads: the JSX between tags, and single-quoted strings that are
// rendered. Comments are excluded -- they are for the next engineer and may
// legitimately go on saying "waypoint" about the table.
function playerVisibleStrings(src) {
  return src
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');
}

describe('travel popup copy', () => {
  const src = playerVisibleStrings(read('WaypointTravel.jsx'));

  it('tells the player to stand on a PORTAL', () => {
    expect(src).toMatch(/stand on a portal/i);
    expect(src).not.toMatch(/'stand on a waypoint'/);
  });

  it('offers portals to choose from', () => {
    expect(src).toMatch(/Choose a portal you have lit/i);
  });

  it('names portals in the empty state -- the case a new player hits first', () => {
    expect(src).toMatch(/not found any portals yet/i);
  });

  it('announces a discovery as a Portal', () => {
    expect(src).toMatch(/Portal discovered/);
    expect(src).not.toMatch(/`Waypoint discovered/);
  });
});

describe('world map legend', () => {
  const src = playerVisibleStrings(read('PlayerWorldMap.jsx'));

  it('points the player at portals, not waypoints', () => {
    // The legend is the one place outside the popup that tells a player how
    // travel works at all.
    expect(src).toMatch(/portals you have lit/i);
    expect(src).not.toMatch(/waypoints you have lit/i);
  });
});
