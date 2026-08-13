// backend/tests/gen_p4_bestiary.test.js
//
// Tests for backend/scripts/gen-p4-bestiary.js: combines Task 1's LINES/RUNGS template,
// Task 2's deriveResistances/deriveLevelBand, and Task 3's pickDropItem into 288 generated
// creatures (32 lines x 9 rungs) plus 288 matching drop rows.
const test = require('node:test');
const assert = require('node:assert');
const { generateBestiary, BEHAVIOR_OVERRIDES } = require('../scripts/gen-p4-bestiary');
const { LINES, RUNGS } = require('../scripts/bestiary/template');
// The legal BEHAVIOUR PROFILE names (Line/Skittish/Guard/...), not to be
// confused with CHASE_STYLES (charge/skittish/...) -- a different
// enumeration axis, sourced from the one place profile names are authored so
// this file does not become a sixth hardcoded list of them.
const { CREATURE_BEHAVIORS } = require('../seeds/data/creatureBehaviors');

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

// SOMET-290 fix round 4: this used to be "behavior_name is one of the 9 rung
// names", a membership check that BEHAVIOR_OVERRIDES was specifically
// authored to violate (Skittish is not a rung name) -- so widening that set
// to include 'Skittish' would have made the test accept ANY creature
// carrying ANY behaviour, including one a future override typo'd or an
// override that applied somewhere nobody authorized. The actual invariant
// the generator implements is narrower and is asserted here directly, per
// creature: behavior_name is that creature's OWN rung name, unless its name
// is a BEHAVIOR_OVERRIDES key, in which case it is EXACTLY that override's
// value -- nothing else. Rung names are derived from LINES x RUNGS (the same
// template the generator itself reads), not re-listed as a literal here.
test('every creature\'s behavior_name is its rung name, or its BEHAVIOR_OVERRIDES value if overridden -- nothing else', () => {
  const { creatures } = generateBestiary();
  const rungByCreatureName = new Map();
  LINES.forEach((line) => {
    RUNGS.forEach((rung) => {
      rungByCreatureName.set(`${line.name} ${rung.name}`, rung.name);
    });
  });
  for (const c of creatures) {
    const rungName = rungByCreatureName.get(c.name);
    assert.ok(rungName, `${c.name} is not a LINES x RUNGS product name at all`);
    const overridden = Object.prototype.hasOwnProperty.call(BEHAVIOR_OVERRIDES, c.name);
    const expected = overridden ? BEHAVIOR_OVERRIDES[c.name] : rungName;
    assert.strictEqual(c.behavior_name, expected,
      `${c.name} has behavior_name ${c.behavior_name}, expected ${expected} `
      + `(${overridden ? 'its BEHAVIOR_OVERRIDES value' : 'its own rung name -- not overridden'})`);
  }
});

// The other half of BEHAVIOR_OVERRIDES' correctness: a key that does not
// match any generated creature is a silent no-op (the override never
// applies to anything, and the test above cannot see a mismatch that never
// happens), and a value that is not a real behaviour profile would resolve
// to nothing at seed time. Legal profile names come from the seed catalog
// itself, not a new literal list.
test('every BEHAVIOR_OVERRIDES entry targets a real creature with a real behaviour profile', () => {
  const { creatures } = generateBestiary();
  const creatureNames = new Set(creatures.map((c) => c.name));
  const legalBehaviorNames = new Set(CREATURE_BEHAVIORS.map((b) => b.name));
  for (const [name, behaviorName] of Object.entries(BEHAVIOR_OVERRIDES)) {
    assert.ok(creatureNames.has(name),
      `BEHAVIOR_OVERRIDES key "${name}" matches no generated creature -- a misspelled key is a `
      + 'silent no-op');
    assert.ok(legalBehaviorNames.has(behaviorName),
      `BEHAVIOR_OVERRIDES["${name}"] = "${behaviorName}" is not a real behaviour profile in `
      + 'seeds/data/creatureBehaviors.js');
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
