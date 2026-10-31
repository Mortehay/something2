import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitTravelTabs, lastSpireCheckpoint } from '../waypointTravel.js';

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

describe('last Spire checkpoint', () => {
  const grp = (worldName, activated) => ({
    worldId: worldName, worldName, entries: [{ id: worldName, name: 'cp', activated, selectable: activated }],
  });
  it('is the highest lit floor, ignoring unlit ones and the rest of the world', () => {
    const last = lastSpireCheckpoint([
      grp('Spire of Trials: Floor 5', true),
      grp('Spire of Trials: Floor 30', true),
      grp('Spire of Trials: Floor 40', false),
      grp('Spire of Trials: Floor 10', true),
      grp('Vale Crossing', true),
    ]);
    expect(last.floor).toBe(30);
  });
  it('is null when no Spire checkpoint is lit', () => {
    expect(lastSpireCheckpoint([grp('Spire of Trials: Floor 5', false), grp('Vale Crossing', true)])).toBeNull();
    expect(lastSpireCheckpoint(undefined)).toBeNull();
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
