// backend/tests/p5_content.test.js
const test = require('node:test');
const assert = require('node:assert');
const { DUNGEONS, SURFACE_BIOMES } = require('../scripts/dungeon/content');

test('exactly 8 dungeons, tier clamp floors and ceilings both non-decreasing in order', () => {
  assert.equal(DUNGEONS.length, 8);
  for (let i = 1; i < DUNGEONS.length; i++) {
    assert.ok(DUNGEONS[i].tierClamp[0] >= DUNGEONS[i - 1].tierClamp[0],
      `dungeon ${i} tier floor must not drop below dungeon ${i - 1}'s`);
    assert.ok(DUNGEONS[i].tierClamp[1] >= DUNGEONS[i - 1].tierClamp[1],
      `dungeon ${i} tier ceiling must not drop below dungeon ${i - 1}'s`);
  }
  assert.ok(DUNGEONS[7].tierClamp[1] >= DUNGEONS[0].tierClamp[1] * 2,
    'deepest dungeon ceiling must clear double the entry dungeon ceiling');
});

test('every dungeon lists at least one line/biome and a portal guard creature name', () => {
  for (const d of DUNGEONS) {
    assert.ok(Array.isArray(d.lines) && d.lines.length >= 1, `${d.key} has no lines`);
    for (const l of d.lines) {
      assert.equal(typeof l.line, 'string');
      assert.equal(typeof l.biome, 'string');
    }
    assert.equal(typeof d.topology, 'string');
    assert.ok(['spine', 'hub', 'loop'].includes(d.topology), `${d.key} has unknown topology ${d.topology}`);
    assert.equal(typeof d.guardCreature, 'string');
  }
});

test('the 22 underground/abyssal lines are each assigned to exactly one dungeon', () => {
  const seen = new Set();
  for (const d of DUNGEONS) {
    for (const l of d.lines) {
      assert.ok(!seen.has(l.line), `line "${l.line}" assigned to more than one dungeon`);
      seen.add(l.line);
    }
  }
  assert.equal(seen.size, 22);
});

test('5 new surface biomes, each with a line name and primary element', () => {
  assert.equal(SURFACE_BIOMES.length, 5);
  for (const s of SURFACE_BIOMES) {
    assert.equal(typeof s.line, 'string');
    assert.equal(typeof s.biome, 'string');
    // element may be null only for a line with no primary element (none of the 5 new surface lines are null-element)
    assert.equal(typeof s.element, 'string');
  }
});
