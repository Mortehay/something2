import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WaypointTravel from '../WaypointTravel.jsx';

const here = path.dirname(fileURLToPath(import.meta.url));

// waypointTravel.test.js covers the rules; this evaluates the module, because
// vitest's node environment cannot mount it and a bad import path or a syntax
// error would otherwise pass every assertion there and surface only in the
// browser. Same reason PlayerWorldMap.smoke.test.js exists.
describe('WaypointTravel', () => {
  it('is a component export', () => {
    expect(typeof WaypointTravel).toBe('function');
  });

  const source = fs.readFileSync(path.join(here, '../WaypointTravel.jsx'), 'utf8');

  it('decides selectability in the testable module, not inline', () => {
    // The rules cannot be asserted through the DOM here, so they have to live
    // where they CAN be asserted. A component that re-derived "is this row
    // selectable" for itself would be a second copy of the rule, free to be
    // looser than the one waypointTravel.test.js pins -- and looser is exactly
    // the direction that matters, since the tested copy is the strict one.
    expect(source).toMatch(/buildTravelList/);
    expect(source).not.toMatch(/activated &&|\.activated ===/);
  });

  it('travels through the socket the player already holds', () => {
    // Not by entering a world itself. The server answers a travel with the same
    // `transition` frame a doorway sends and GameShell already routes that to
    // enterWorld; a second entry path here is the two-loader shape that has
    // shipped inert features in this project before.
    expect(source).toMatch(/travelToWaypoint/);
    expect(source).not.toMatch(/WorldAuthorityClient|initChunked|new WebSocket|enterWorld/);
  });

  it('is mounted where the player can reach it', () => {
    // The panel existing is not the same as the panel being on screen. SOMET-262
    // shipped a changeCharacter that nothing rendered, and this project's
    // recorded failure mode is a feature that is complete and unreachable.
    const view = fs.readFileSync(path.join(here, '../GameView.jsx'), 'utf8');
    expect(view).toMatch(/<WaypointTravel\s/);
    expect(view).toMatch(/isPlaying && <WaypointTravel/);
  });

  it('the help panel tells the player the key', () => {
    // One place describes the controls, and it is not allowed to drift from the
    // binding this component registers.
    const shell = fs.readFileSync(path.join(here, '../GameShell.jsx'), 'utf8');
    expect(shell).toMatch(/\[\['T'\]\]/);
    expect(source).toMatch(/e\.key\.toLowerCase\(\) !== 't'/);
  });
});
