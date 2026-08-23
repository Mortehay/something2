// backend/tests/passive_tree_spec.test.js
//
// Guards the AUTHORED half of the tree (backend/seeds/data/passiveTree.js).
// The generator test next door guards the expansion; this one guards the
// input, because a template pool that is empty for some (kind, sector, ring)
// combination makes the generator crash or silently reuse the wrong archetype,
// and neither failure names the data file that caused it.
const test = require('node:test');
const assert = require('node:assert');
const {
  PASSIVE_TREE_SPEC, SECTORS, LAYOUT, TEMPLATES, KEYSTONES, START_NODES,
  GRANT_TYPES, RULE_KEYS,
} = require('../seeds/data/passiveTree.js');
const { ELEMENTS } = require('../src/authority/damage.js');

// Hand-written, on purpose. Importing the same list the data file uses would
// make every assertion below a tautology.
const SECTOR_KEYS = ['wisdom', 'intelligence', 'dexterity', 'strength', 'constitution', 'charisma'];
const CLASS_NAMES = ['Monk', 'Mage', 'Archer', 'Warrior', 'Cultist', 'Druid'];

test('six sectors, in the clockwise order the spec diagram draws', () => {
  assert.deepStrictEqual(SECTORS.map((s) => s.key), SECTOR_KEYS);
  assert.deepStrictEqual(SECTORS.map((s) => s.className), CLASS_NAMES);
  // -90 is straight up on a canvas; each sector is the next 60 degrees clockwise.
  assert.deepStrictEqual(SECTORS.map((s, i) => LAYOUT.sectorAxisDeg0 + i * 60),
    [-90, -30, 30, 90, 150, 210]);
});

test('ring geometry multiplies out to the specced per-ring composition', () => {
  assert.deepStrictEqual(
    [1, 2, 3].map((r) => {
      const g = LAYOUT.rings[r];
      return [g.rows * g.cols, g.minor + g.notable + g.keystone];
    }),
    [[68, 68], [116, 116], [111, 111]],
  );
  assert.deepStrictEqual([1, 2, 3].map((r) => LAYOUT.rings[r].keystone), [0, 2, 3]);
});

// 40, not the 38 the plan's prose said: the plan's own authored template list
// carries 4 core + 12 sector minors and 24 notables. Spec §5.1 asks for "~40
// archetype templates", so 40 is the correct number and 38 was the typo. The
// count is pinned anyway, because a template silently dropped in a merge
// shrinks a pool and re-labels every node that pool served.
test('40 archetype templates, none of them a keystone', () => {
  assert.strictEqual(TEMPLATES.length, 40);
  assert.strictEqual(TEMPLATES.filter((t) => t.kind === 'minor').length, 16);
  assert.strictEqual(TEMPLATES.filter((t) => t.kind === 'notable').length, 24);
  assert.strictEqual(TEMPLATES.some((t) => t.kind === 'keystone'), false);
  assert.strictEqual(new Set(TEMPLATES.map((t) => t.key)).size, 40);
});

test('every (kind, sector, ring) combination the generator will ask for has a pool', () => {
  const empty = [];
  for (const sector of SECTOR_KEYS) {
    for (const ring of [1, 2, 3]) {
      for (const kind of ['minor', 'notable']) {
        const pool = TEMPLATES.filter((t) => t.kind === kind
          && (t.sectors === '*' ? sector !== 'core' : t.sectors.includes(sector))
          && t.rings.includes(ring));
        if (pool.length === 0) empty.push(`${kind}/${sector}/ring${ring}`);
      }
    }
  }
  const corePool = TEMPLATES.filter((t) => t.kind === 'minor'
    && t.sectors !== '*' && t.sectors.includes('core') && t.rings.includes(0));
  if (corePool.length === 0) empty.push('minor/core/ring0');
  assert.deepStrictEqual(empty, []);
});

test('exactly five keystones per sector, all keys unique across the tree', () => {
  assert.deepStrictEqual(Object.keys(KEYSTONES).sort(), [...SECTOR_KEYS].sort());
  for (const sector of SECTOR_KEYS) {
    assert.strictEqual(KEYSTONES[sector].length, 5, `${sector} keystone count`);
  }
  const all = SECTOR_KEYS.flatMap((s) => KEYSTONES[s].map((k) => k.key));
  assert.strictEqual(all.length, 30);
  assert.strictEqual(new Set(all).size, 30);
});

test('the two keystones the spec names by hand exist and grant what it says', () => {
  const bloodPact = KEYSTONES.constitution.find((k) => k.key === 'ks_con_blood_pact');
  assert.deepStrictEqual(bloodPact.grants,
    [{ type: 'rule', rule: 'lifeCostMultiplier', value: 0.75 }]);
  const beastBond = KEYSTONES.charisma.find((k) => k.key === 'ks_cha_beast_bond');
  assert.deepStrictEqual(beastBond.grants,
    [{ type: 'rule', rule: 'treeCharmBonus', value: 5 }]);
});

test('one start node per sector, each naming a distinct class', () => {
  assert.strictEqual(START_NODES.length, 6);
  assert.deepStrictEqual(START_NODES.map((n) => n.sector), SECTOR_KEYS);
  assert.deepStrictEqual(START_NODES.map((n) => n.start_class), CLASS_NAMES);
});

test('the element vocabulary is the authority\'s, not a second copy that can drift', () => {
  assert.deepStrictEqual(GRANT_TYPES.damage.element, ELEMENTS);
  assert.deepStrictEqual(GRANT_TYPES.resist.element, ELEMENTS);
});

test('every rule key names the module that consumes it and how duplicates combine', () => {
  assert.deepStrictEqual(Object.keys(RULE_KEYS).sort(),
    ['cooldownFloor', 'lifeCostMultiplier', 'regenLifeShare', 'treeCharmBonus']);
  for (const [key, def] of Object.entries(RULE_KEYS)) {
    assert.ok(['sum', 'product', 'min'].includes(def.combine), `${key}.combine`);
    assert.ok(typeof def.consumer === 'string' && def.consumer.length > 0, `${key}.consumer`);
  }
  assert.strictEqual(RULE_KEYS.lifeCostMultiplier.combine, 'product');
  assert.strictEqual(RULE_KEYS.treeCharmBonus.combine, 'sum');
  assert.strictEqual(RULE_KEYS.cooldownFloor.combine, 'min');
});

test('PASSIVE_TREE_SPEC is the single bundle the generator takes', () => {
  assert.deepStrictEqual(Object.keys(PASSIVE_TREE_SPEC).sort(),
    ['keystones', 'layout', 'sectors', 'startNodes', 'templates']);
});
