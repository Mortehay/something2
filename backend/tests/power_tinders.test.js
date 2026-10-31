const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { GEAR_TIERS, GEAR_FAMILIES } = require('../seeds/data/gearLadder.js');
const { QUESTS } = require('../seeds/data/questsData.js');

const items = (() => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../seeds/sync/items.json'), 'utf8'));
  let found = [];
  (function walk(x) {
    if (Array.isArray(x) && x.some((r) => r && r.name === 'crude-boots')) found = x;
    else if (x && typeof x === 'object') Object.values(x).forEach(walk);
  }(data));
  return found;
})();
const tinders = items.find((i) => i.name === 'power-tinders');

// What the ladder's best feet piece gives at each rung (greaves are the heaviest feet family).
const feetFamilies = GEAR_FAMILIES.filter((f) => f.slot === 'feet');
const bestFeetAt = (tier) => Math.max(...feetFamilies.map((f) => f.defense * GEAR_TIERS.find((t) => t.tier === tier).power));

test('power-tinders exist as feet armor anyone can put on at level 1', () => {
  assert.ok(tinders, 'power-tinders is in the item catalog');
  assert.strictEqual(tinders.category, 'armor');
  assert.strictEqual(tinders.slot, 'feet');
  assert.strictEqual(tinders.req_level, 1);
  for (const s of ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma']) {
    assert.strictEqual(tinders[`req_${s}`], 0, `no ${s} requirement`);
  }
});

test('strong at the start: well above anything else a new character can wear', () => {
  assert.ok(tinders.defense >= 3 * bestFeetAt(1), `${tinders.defense} vs the tier-1 best ${bestFeetAt(1)}`);
  assert.ok(tinders.defense > bestFeetAt(3), 'still ahead of steel gear at level 25');
});

test('ordinary in the middle of the game: on par with the ladder around level 40', () => {
  const mid = bestFeetAt(4);
  assert.ok(Math.abs(tinders.defense - mid) / mid < 0.25, `${tinders.defense} vs tempered ${mid}`);
});

test('weak at the end: a fraction of the top rung', () => {
  const top = bestFeetAt(10);
  assert.ok(tinders.defense <= top * 0.25, `${tinders.defense} vs mythic ${top}`);
  assert.ok(tinders.defense < bestFeetAt(6), 'already behind obsidian gear');
});

test('the first quest hands them out, and the reward names a real item', () => {
  const q = QUESTS.find((x) => x.key === 'act1_core_whisper');
  assert.strictEqual(q.item_reward, 'power-tinders');
  assert.ok(items.some((i) => i.name === q.item_reward));
});
