'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { QUESTS } = require('../seeds/data/questsData.js');
const { xpFloor, levelForXp } = require('../src/services/playerStats.js');
const { generateSpec } = require('../scripts/dungeon/gen-p5-map-content.js');

const MAPS = path.join(__dirname, '../seeds/maps');
const specs = fs.readdirSync(MAPS).filter((n) => n.endsWith('.map.json')).map((n) => JSON.parse(fs.readFileSync(path.join(MAPS, n), 'utf8')));
const worlds = specs.flatMap((s) => s.worlds);

test('every quest village is a village a map spec really builds', () => {
  const real = new Set(worlds.map((w) => w.village && w.village.key).filter(Boolean));
  for (const q of QUESTS) assert.ok(real.has(q.village_key), `${q.key}: village_key "${q.village_key}" is not built by any map spec (${[...real].join(', ')})`);
});

test('every reach quest names a world that exists', () => {
  const names = worlds.map((w) => w.name.toLowerCase());
  for (const q of QUESTS.filter((x) => x.objective_type === 'reach')) {
    assert.ok(names.some((n) => n.startsWith(q.target_key.toLowerCase())), `${q.key}: no world name starts with "${q.target_key}"`);
  }
});

test('the quest chain is a chain: every prerequisite exists and no quest waits on a later one', () => {
  const index = new Map(QUESTS.map((q, i) => [q.key, i]));
  for (const q of QUESTS.filter((x) => x.prerequisite_key)) {
    assert.ok(index.has(q.prerequisite_key), `${q.key}: unknown prerequisite ${q.prerequisite_key}`);
    assert.ok(index.get(q.prerequisite_key) < index.get(q.key), `${q.key} waits on a quest defined after it`);
  }
});

// A reward must stay a reward, and a level gate must stay a gate: the quest XP of everything before a
// storyline quest may not carry a character to the level that quest asks for. (The first quest used to
// pay 2500 XP, level 8, and the whole storyline 80 levels' worth.)
test('the storyline cannot level a character past its own level gates', () => {
  const main = QUESTS.filter((q) => !q.is_side);
  let earned = 0;
  for (const q of main) {
    assert.ok(levelForXp(earned) <= Math.max(1, q.required_level),
      `${q.key} (level ${q.required_level}): the quests before it alone already pay ${earned} XP = level ${levelForXp(earned)}`);
    earned += q.exp_reward;
  }
});

test('the storyline reaches past level 55 (Act V, the Spire) and ends near the top of the world', () => {
  const main = QUESTS.filter((q) => !q.is_side);
  assert.ok(Math.max(...main.map((q) => q.required_level)) >= 120);
  for (const q of QUESTS.filter((x) => x.act === 5)) assert.ok(['floor', 'kill_spire', 'boss'].includes(q.objective_type), q.key);
});

test('XP rewards are a share of the level the quest asks for', () => {
  for (const q of QUESTS.filter((x) => x.exp_reward > 0)) {
    const next = xpFloor(Math.min(150, q.required_level + 1)) - xpFloor(q.required_level); // what that level costs
    assert.ok(q.exp_reward <= next * 2.5, `${q.key}: ${q.exp_reward} XP is more than 2.5 levels' worth (${next}) at level ${q.required_level}`);
  }
});

test('the quest item rewards can be worn at about the level the quest is taken', () => {
  // The rewards are ladder rings/signets named by bracket; the bracket must not be far above the quest.
  const BRACKET = { 'crude-band': 1, 'crude-signet': 1, 'iron-band': 10, 'iron-signet': 10, 'steel-band': 25, 'steel-signet': 25,
    'tempered-band': 40, 'tempered-signet': 40, 'runed-band': 55, 'runed-signet': 55, 'power-tinders': 1, 'warbound-circlet': 25,
    'gilded-fists': 40, 'stormlight-mantle': 50 };
  for (const q of QUESTS.filter((x) => x.item_reward)) {
    const req = BRACKET[q.item_reward];
    assert.ok(req !== undefined, `${q.key}: reward ${q.item_reward} is not in the known bracket table`);
    assert.ok(req <= q.required_level + 5, `${q.key} (level ${q.required_level}) gives ${q.item_reward}, which needs level ${req}`);
  }
});
