const test = require('node:test');
const assert = require('node:assert');
const { buildQuestGivers } = require('../src/services/questGivers.js');

// SOMET-678. The joined frame's questGivers list: name AND art are the bound
// entity (instance binding, else the kind default), never a hardcoded table.
const defaults = new Map([['quest_giver', 'Elder Eldrin'], ['merchant', 'merchant_post']]);
const village = (over) => ({ id: 'v1', specKey: 'trailhead', questGiverX: 250, questGiverY: 350, questGiverArt: null, ...over });

test('an unbound village gets the kind default as name and art', () => {
  assert.deepStrictEqual(buildQuestGivers([village()], defaults), [
    { villageId: 'v1', villageKey: 'trailhead', x: 250, y: 350, name: 'Elder Eldrin', art: 'Elder Eldrin' },
  ]);
});

test('a bound village uses its own giver entity', () => {
  const [g] = buildQuestGivers([village({ specKey: 'blackfen', questGiverArt: 'Shadow Hunter' })], defaults);
  assert.strictEqual(g.name, 'Shadow Hunter');
  assert.strictEqual(g.art, 'Shadow Hunter');
  assert.strictEqual(g.villageKey, 'blackfen');
});

test('with no binding and no default the giver still exists, labelled generically, with no art', () => {
  const [g] = buildQuestGivers([village()], new Map());
  assert.deepStrictEqual({ name: g.name, art: g.art }, { name: 'Quest Giver', art: null });
});

test('a village without a giver post is skipped; a missing spec key is null', () => {
  const out = buildQuestGivers([village({ questGiverX: null }), village({ id: 'v2', specKey: undefined })], defaults);
  assert.deepStrictEqual(out.map((g) => [g.villageId, g.villageKey]), [['v2', null]]);
});

test('no villages list -> empty', () => {
  assert.deepStrictEqual(buildQuestGivers(undefined, defaults), []);
});

test('the joined frame calls buildQuestGivers and the hardcoded name table is gone', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/authority/server.js'), 'utf8');
  assert.match(src, /questGivers: buildQuestGivers\(entry\.villages, entry\.pointArtDefaults\)/);
  for (const n of ['Lord Thorn', 'Captain Valdor', 'Astronomer Zahir', "'Elder Eldrin'"]) {
    assert.ok(!src.includes(n), `server.js still hardcodes ${n}`);
  }
});
