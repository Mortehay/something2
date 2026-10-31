const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { GEAR_TIERS, GEAR_FAMILIES } = require('../seeds/data/gearLadder.js');
const { QUESTS } = require('../seeds/data/questsData.js');

// Unique gear is a flat number that the ladder outgrows. Each piece must be
// STRONG around its requirement, ORDINARY about thirty levels on, and WEAK at the
// top of the ladder -- measured against the best ladder piece for the same slot.
const UNIQUE = ['power-tinders', 'warbound-circlet', 'gilded-fists', 'stormlight-mantle'];

const items = (() => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../seeds/sync/items.json'), 'utf8'));
  let found = [];
  (function walk(x) {
    if (Array.isArray(x) && x.some((r) => r && r.name === 'crude-boots')) found = x;
    else if (x && typeof x === 'object') Object.values(x).forEach(walk);
  }(data));
  return found;
})();

const bestAt = (slot, tier) => Math.max(...GEAR_FAMILIES.filter((f) => f.slot === slot)
  .map((f) => f.defense * GEAR_TIERS.find((t) => t.tier === tier).power));
const tierFor = (level) => GEAR_TIERS.filter((t) => t.req_level <= level).slice(-1)[0];

for (const name of UNIQUE) {
  const it = items.find((i) => i.name === name);

  test(`${name}: exists, is armor for its slot, and needs no stat`, () => {
    assert.ok(it, 'in the item catalog');
    assert.strictEqual(it.category, 'armor');
    assert.ok(['head', 'chest', 'hands', 'feet'].includes(it.slot));
    for (const s of ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma']) {
      assert.strictEqual(it[`req_${s}`], 0, `no ${s} requirement`);
    }
  });

  test(`${name}: strong at its requirement level`, () => {
    const best = bestAt(it.slot, tierFor(it.req_level).tier);
    assert.ok(it.defense >= 1.4 * best, `${it.defense} vs the ladder's ${best} at level ${it.req_level}`);
  });

  test(`${name}: ordinary a few dozen levels later`, () => {
    const mids = GEAR_TIERS.filter((t) => t.req_level >= it.req_level + 15 && t.req_level <= it.req_level + 45);
    assert.ok(mids.length, 'a ladder rung exists in that window');
    assert.ok(mids.some((t) => Math.abs(it.defense - bestAt(it.slot, t.tier)) / bestAt(it.slot, t.tier) <= 0.3),
      `${it.defense} is not within 30% of any rung ${mids.map((t) => t.req_level)}`);
  });

  test(`${name}: weak at the top`, () => {
    assert.ok(it.defense <= 0.4 * bestAt(it.slot, 10), `${it.defense} vs ${bestAt(it.slot, 10)}`);
  });
}

test('each unique piece is handed out by a quest at or above its requirement level, and names a real item', () => {
  for (const name of UNIQUE) {
    const it = items.find((i) => i.name === name);
    const q = QUESTS.find((x) => x.item_reward === name);
    assert.ok(q, `${name} has a quest source`);
    assert.ok(Number(q.required_level) >= it.req_level - 0, `${name}: quest level ${q.required_level} vs item level ${it.req_level}`);
  }
});

test('a quest awards at most one item, and no two quests award the same unique', () => {
  const rewards = QUESTS.map((q) => q.item_reward).filter(Boolean);
  assert.strictEqual(new Set(rewards).size, rewards.length);
});
