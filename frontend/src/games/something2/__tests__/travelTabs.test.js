import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitTravelTabs } from '../waypointTravel.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const g = (worldName) => ({ worldId: worldName, worldName, entries: [] });

describe('travel menu tabs', () => {
  it('puts the Spire floors on their own tab, ordered by floor number', () => {
    const { main, spire } = splitTravelTabs([
      g('Blackfen Sinks'),
      g('Spire of Trials: Floor 10'),
      g('Spire of Trials: Floor 5'),
      g('Spire of Trials: Floor 30'),
      g('Vale Crossing'),
    ]);
    expect(main.map((x) => x.worldName)).toEqual(['Blackfen Sinks', 'Vale Crossing']);
    expect(spire.map((x) => x.worldName)).toEqual([
      'Spire of Trials: Floor 5', 'Spire of Trials: Floor 10', 'Spire of Trials: Floor 30',
    ]);
  });

  it('no Spire floors means no Spire tab, and bad input is harmless', () => {
    expect(splitTravelTabs([g('Vale Crossing')]).spire).toEqual([]);
    expect(splitTravelTabs(undefined)).toEqual({ main: [], spire: [] });
  });
});

describe('the popup does not reopen after a teleport', () => {
  const src = fs.readFileSync(path.join(here, '../WaypointTravel.jsx'), 'utf8');

  it('choosing a destination suppresses the arrival auto-open', () => {
    expect(src).toMatch(/suppressUntilRef\.current = Date\.now\(\) \+ \d+/);
    expect(src).toMatch(/Date\.now\(\) < suppressUntilRef\.current/);
  });

  it('arriving in another world relatches instead of counting as stepping onto a portal', () => {
    expect(src).toMatch(/worldNow !== prevWorldRef\.current/);
    expect(src).toMatch(/prevTileRef\.current = null/);
  });
});
