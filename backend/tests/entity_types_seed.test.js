// Legacy creature remapping (SOMET-250 Task 5): Wolf/Skeleton/Bat/Slime predate the 32-line
// taxonomy and are folded into it here, each landing on the Line rung of its assigned line.
// Resistance value (0.55) and hp/defense (30/3) are read directly from the shipped
// backend/scripts/bestiary/derive.js (PRIMARY_VALUE.Line) and template.js (RUNGS[Line]) --
// not the stale 0.4 example in the task brief.
const test = require('node:test');
const assert = require('node:assert');
const { HOSTILE_CREATURES } = require('../seeds/data/entityTypes');

test('Wolf is retuned to the Beast/Meadow Line-rung template (hp 30, def 3, no resistance)', () => {
  const wolf = HOSTILE_CREATURES.find((c) => c.name === 'Wolf');
  assert.deepEqual([wolf.hp, wolf.max_hp, wolf.defense], [30, 30, 3]);
  assert.deepEqual(wolf.resistances, {});
});

test('Skeleton is retuned to the Undead/Catacombs Line-rung template (hp 30, def 3, ice .55)', () => {
  const skeleton = HOSTILE_CREATURES.find((c) => c.name === 'Skeleton');
  assert.deepEqual([skeleton.hp, skeleton.max_hp, skeleton.defense], [30, 30, 3]);
  assert.deepEqual(skeleton.resistances, { ice: 0.55 });
});

test('Bat is retuned to the Fungal/Fungal Deep Line-rung template (hp 30, def 3, lightning .55)', () => {
  const bat = HOSTILE_CREATURES.find((c) => c.name === 'Bat');
  assert.deepEqual([bat.hp, bat.max_hp, bat.defense], [30, 30, 3]);
  assert.deepEqual(bat.resistances, { lightning: 0.55 });
});

test('Slime is retuned to the Desert/Arid Dunes Line-rung template (hp 30, def 3, fire .55)', () => {
  const slime = HOSTILE_CREATURES.find((c) => c.name === 'Slime');
  assert.deepEqual([slime.hp, slime.max_hp, slime.defense], [30, 30, 3]);
  assert.deepEqual(slime.resistances, { fire: 0.55 });
});

test('all four legacy creatures carry a behavior_name of Line (matching their new rung)', () => {
  for (const name of ['Wolf', 'Skeleton', 'Bat', 'Slime']) {
    const c = HOSTILE_CREATURES.find((x) => x.name === name);
    assert.strictEqual(c.behavior_name, 'Line');
  }
});
