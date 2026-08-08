// backend/tests/gen_p4_bestiary.test.js
//
// Tests for backend/scripts/gen-p4-bestiary.js: combines Task 1's LINES/RUNGS template,
// Task 2's deriveResistances/deriveLevelBand, and Task 3's pickDropItem into 288 generated
// creatures (32 lines x 9 rungs) plus 288 matching drop rows.
const test = require('node:test');
const assert = require('node:assert');
const { generateBestiary } = require('../scripts/gen-p4-bestiary');

test('generates exactly 288 creatures, all unique names', () => {
  const { creatures } = generateBestiary();
  assert.strictEqual(creatures.length, 288);
  assert.strictEqual(new Set(creatures.map((c) => c.name)).size, 288);
});

test('every creature has all required fields with valid types', () => {
  const { creatures } = generateBestiary();
  for (const c of creatures) {
    assert.strictEqual(typeof c.name, 'string');
    assert.strictEqual(typeof c.color, 'string');
    assert.ok(/^#[0-9a-f]{6}$/i.test(c.color), `${c.name} has invalid color ${c.color}`);
    assert.strictEqual(typeof c.hp, 'number');
    assert.strictEqual(c.max_hp, c.hp);
    assert.strictEqual(typeof c.defense, 'number');
    assert.strictEqual(typeof c.resistances, 'object');
    assert.strictEqual(typeof c.prompt, 'string');
    assert.ok(c.prompt.length > 0);
    assert.strictEqual(typeof c.behavior_name, 'string'); // resolved to behavior_id at seed time, see Task 6
    assert.strictEqual(typeof c.level_min, 'number');
    assert.strictEqual(typeof c.level_max, 'number');
    assert.ok(c.level_min <= c.level_max);
  }
});

test('every creature\'s behavior_name is one of the 9 real rung profiles', () => {
  const { creatures } = generateBestiary();
  const valid = new Set(['Swarm', 'Skirmisher', 'Line', 'Ranged', 'Caster', 'Brute', 'Heavy', 'Champion', 'Apex']);
  for (const c of creatures) {
    assert.ok(valid.has(c.behavior_name), `${c.name} has invalid behavior_name ${c.behavior_name}`);
  }
});

test('generates exactly one drop row per creature, each pointing at the matching creature name', () => {
  const { creatures, drops } = generateBestiary();
  assert.strictEqual(drops.length, 288);
  const creatureNames = new Set(creatures.map((c) => c.name));
  for (const d of drops) {
    assert.ok(creatureNames.has(d.creature), `drop row references unknown creature ${d.creature}`);
  }
});

test('a Void-line creature resists all four elements partially (the allFourPartial special case)', () => {
  const { creatures } = generateBestiary();
  const voidApex = creatures.find((c) => c.name.startsWith('Void') && c.behavior_name === 'Apex');
  assert.ok(voidApex, 'expected a generated Void Apex creature');
  assert.deepEqual(Object.keys(voidApex.resistances).sort(), ['fire', 'ice', 'lightning', 'physical']);
});

test('colorFor/promptFor are not literally identical across every creature', () => {
  const { creatures } = generateBestiary();
  assert.ok(new Set(creatures.map((c) => c.color)).size > 1, 'expected more than one distinct color');
  assert.ok(new Set(creatures.map((c) => c.prompt)).size > 1, 'expected more than one distinct prompt');
});
