// backend/tests/minibosses_generator.test.js
// SOMET-624 (S11). Pure tests (no DB) for the GENERATED miniboss roster --
// the whole point of generating from backend/scripts/bestiary/template.js's
// LINES rather than hand-authoring is that this stays correct as LINES
// changes, so these assert the RULE, not a frozen count.
const test = require('node:test');
const assert = require('node:assert/strict');
const { LINES } = require('../scripts/bestiary/template.js');
const { STARTER_BIOMES } = require('../seeds/data/biomes.js');
const { buildMinibosses, minibossSpawnsByBiome } = require('../seeds/data/minibosses.js');

test('one base miniboss per line, plus one elite miniboss per tier-IV line', () => {
  const rows = buildMinibosses(STARTER_BIOMES);
  const tierIVLines = LINES.filter((l) => l.tier.includes('IV'));
  assert.equal(rows.length, LINES.length + tierIVLines.length);
  assert.equal(rows.filter((r) => r.name.endsWith('Elite Miniboss')).length, tierIVLines.length);
  assert.equal(rows.filter((r) => !r.name.endsWith('Elite Miniboss')).length, LINES.length);
});

test('every row is boss_tier miniboss, with a unique name', () => {
  const rows = buildMinibosses(STARTER_BIOMES);
  for (const r of rows) assert.equal(r.boss_tier, 'miniboss', r.name);
  assert.equal(new Set(rows.map((r) => r.name)).size, rows.length);
});

test('an elite variant is strictly tougher than its line\'s base variant', () => {
  const rows = buildMinibosses(STARTER_BIOMES);
  for (const line of LINES) {
    if (!line.tier.includes('IV')) continue;
    const base = rows.find((r) => r.name === `${line.name} Miniboss`);
    const elite = rows.find((r) => r.name === `${line.name} Elite Miniboss`);
    assert.ok(base && elite, line.name);
    assert.ok(elite.hp > base.hp, `${line.name}: elite hp ${elite.hp} should exceed base hp ${base.hp}`);
    assert.ok(elite.defense > base.defense, line.name);
  }
});

test('attack_element always has a value, even for a line with no element', () => {
  const rows = buildMinibosses(STARTER_BIOMES);
  const noElementLine = LINES.find((l) => l.element == null);
  assert.ok(noElementLine, 'fixture assumption: at least one LINES entry has no element');
  const row = rows.find((r) => r.name === `${noElementLine.name} Miniboss`);
  assert.equal(row.element, null);
  assert.equal(row.attack_element, 'physical');
});

test('an elemental line\'s attack_element matches its element', () => {
  const rows = buildMinibosses(STARTER_BIOMES);
  const elementalLine = LINES.find((l) => l.element != null);
  const row = rows.find((r) => r.name === `${elementalLine.name} Miniboss`);
  assert.equal(row.element, elementalLine.element);
  assert.equal(row.attack_element, elementalLine.element);
});

test('every miniboss carries a real, non-placeholder color from its biome', () => {
  const rows = buildMinibosses(STARTER_BIOMES);
  for (const r of rows) {
    const biome = STARTER_BIOMES.find((b) => b.name === r.biome);
    assert.equal(r.color, biome.color, r.name);
  }
});

test('minibossSpawnsByBiome covers exactly the biomes LINES names, each with its row count', () => {
  const rows = buildMinibosses(STARTER_BIOMES);
  const map = minibossSpawnsByBiome(rows);
  assert.equal(map.size, LINES.length);
  for (const line of LINES) {
    const names = map.get(line.biome);
    assert.ok(names, line.biome);
    const expected = line.tier.includes('IV') ? 2 : 1;
    assert.equal(names.length, expected, line.biome);
    assert.ok(names.includes(`${line.name} Miniboss`), line.biome);
  }
});

test('every LINES biome exists in STARTER_BIOMES (no orphan spawn target)', () => {
  const biomeNames = new Set(STARTER_BIOMES.map((b) => b.name));
  for (const line of LINES) assert.ok(biomeNames.has(line.biome), line.biome);
});
