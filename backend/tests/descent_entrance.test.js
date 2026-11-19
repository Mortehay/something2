'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 66 of the 165 worlds (the whole Descent: Catacombs, Underdeep, Ossuary Depths, Emberhive, Frozen
// Vaults, Crystal Foundry, Umbral Gate, Abyss and the Reach / Frontier worlds) had no way in from
// the entry world. The spec now carries the portal, and a migration puts the same one into databases
// that already exist.

test('the p5-descent spec links its first room to the Vale Crossing hub', () => {
  const spec = require('../seeds/maps/p5-descent.map.json');
  const { DESCENT_ENTRANCE } = require('../scripts/dungeon/gen-p5-map-content.js');
  const link = spec.links.find((l) => l.to_name === 'Vale Crossing');
  assert.ok(link, 'no link to Vale Crossing');
  assert.equal(link.kind, 'portal');
  assert.equal(link.to_name, 'Vale Crossing');
  const entry = spec.worlds.find((w) => w.key === link.from);
  assert.equal(entry.name, 'The Catacombs: Entry');
  assert.deepEqual([link.from_x, link.from_y, link.to_x, link.to_y],
    [DESCENT_ENTRANCE.from_x, DESCENT_ENTRANCE.from_y, DESCENT_ENTRANCE.to_x, DESCENT_ENTRANCE.to_y]);
});

test('the entrance does not sit on a tile another portal of the hub or the first room already uses', () => {
  const spec = require('../seeds/maps/p5-descent.map.json');
  const link = spec.links.find((l) => l.to_name === 'Vale Crossing');
  const fromTiles = spec.links.filter((l) => l.kind === 'portal' && l.from === link.from).map((l) => `${l.from_x},${l.from_y}`);
  assert.equal(new Set(fromTiles).size, fromTiles.length, 'two portals share a source tile in the first room');
  // Vale Crossing's other pads: the Spire at (5850,4350), the boss arenas at (5450,5250).
  const hub = new Set(['5850,4350', '5450,5250']);
  assert.equal(hub.has(`${link.to_x},${link.to_y}`), false);
});

test('the migration carries the same portal as the spec', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '../migrations/1714440895776_descent_entrance.js'), 'utf8');
  const { DESCENT_ENTRANCE: d } = require('../scripts/dungeon/gen-p5-map-content.js');
  assert.ok(src.includes(`['The Catacombs: Entry', ${d.from_x}, ${d.from_y}, 'Vale Crossing', ${d.to_x}, ${d.to_y}]`),
    'migration PORTALS differ from DESCENT_ENTRANCE');
});

test('the generated spec file still equals the generator output (no hand edits)', () => {
  const { generateSpec } = require('../scripts/dungeon/gen-p5-map-content.js');
  const actual = require('node:fs').readFileSync(path.join(__dirname, '../seeds/maps/p5-descent.map.json'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(actual, JSON.stringify(generateSpec(), null, 2) + '\n');
});
