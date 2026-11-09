const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const be = require('../src/services/spriteEta.js');

const FE = path.join(__dirname, '../../frontend/src/games/something2/spriteEta.js');
const ALL = ['idle', 'walk', 'attack', 'cast', 'damage', 'death', 'use'];
const FIXTURES = [
  { actions: ALL, directions: ['s', 'e', 'n'], frames: 4, secondsPerCell: 32, qualityChecks: false },
  { actions: ['walk'], directions: ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'], frames: 6, secondsPerCell: 32, qualityChecks: true, measuredRedrawSeconds: 988 },
  { actions: ALL, directions: ['s', 'e', 'n'], frames: 4, secondsPerCell: 60, qualityChecks: true, measuredRedrawSeconds: 7751 },
  { actions: ['idle', 'walk'], directions: ['s', 'e', 'n', 'w', 'nw', 'sw'], frames: 4, secondsPerCell: 32, qualityChecks: false },
  { actions: ['idle', 'walk', 'attack'], directions: ['s', 'e', 'n'], frames: 4, secondsPerCell: 37.5, qualityChecks: true },
  { actions: ['idle'], directions: ['s'], frames: 1, secondsPerCell: 32, qualityChecks: false },
];

test('frontend ETA mirror matches the backend model on every fixture', async () => {
  const fe = await import(pathToFileURL(FE).href);
  for (const f of FIXTURES) {
    assert.deepEqual(fe.boxSeconds(f), be.boxSeconds(f), JSON.stringify(f));
    assert.equal(fe.cellsOf(f), be.cellsOf(f));
    assert.equal(fe.renderedFacings(f.directions), be.renderedFacings(f.directions));
  }
});
