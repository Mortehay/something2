const test = require('node:test');
const assert = require('node:assert');
const { loadItemTypes, resolveDefaultWeaponId, SLOTS } = require('../src/authority/items.js');

function fakePool(rows) {
  return { query: async (sql) => { assert.match(sql, /FROM item_types/i); return { rows }; } };
}

const ROWS = [
  { id: 1, name: 'dagger', category: 'weapon', slot: 'main_hand', two_handed: false, kind: 'melee',
    damage: '8', cooldown: '0.3', reach: '80', arc_width: '0.6', range: null, projectile_speed: null,
    projectile_radius: null, pierce: null, mana_cost: '0', element: null, defense: null, resistances: null },
  { id: 2, name: 'halberd', category: 'weapon', slot: 'main_hand', two_handed: true, kind: 'melee',
    damage: '18', cooldown: '0.9', reach: '190', arc_width: '1.8', range: null, projectile_speed: null,
    projectile_radius: null, pierce: null, mana_cost: '0', element: null, defense: null, resistances: null },
  { id: 5, name: 'leather-vest', category: 'armor', slot: 'chest', two_handed: false, kind: null,
    damage: '0', cooldown: '0', reach: null, arc_width: null, range: null, projectile_speed: null,
    projectile_radius: null, pierce: null, mana_cost: '0', element: null, defense: '2', resistances: {} },
  { id: 6, name: 'arcane-ward', category: 'armor', slot: 'head', two_handed: false, kind: null,
    damage: '0', cooldown: '0', reach: null, arc_width: null, range: null, projectile_speed: null,
    projectile_radius: null, pierce: null, mana_cost: '0', element: null, defense: '1', resistances: { arcane: 0.3 } },
];

test('loadItemTypes maps weapons and armor, coercing numbers and defaulting resistances', async () => {
  const m = await loadItemTypes(fakePool(ROWS));
  assert.equal(m.size, 4);
  const dagger = m.get(1);
  assert.equal(dagger.category, 'weapon');
  assert.strictEqual(dagger.damage, 8);
  assert.strictEqual(dagger.reach, 80);
  assert.strictEqual(dagger.two_handed, false);
  assert.deepEqual(dagger.resistances, {});      // null -> {}
  const halberd = m.get(2);
  assert.strictEqual(halberd.two_handed, true);
  const vest = m.get(5);
  assert.equal(vest.category, 'armor');
  assert.equal(vest.slot, 'chest');
  assert.strictEqual(vest.defense, 2);
  const ward = m.get(6);
  assert.deepEqual(ward.resistances, { arcane: 0.3 });
});

test('resolveDefaultWeaponId returns the dagger weapon id', async () => {
  const m = await loadItemTypes(fakePool(ROWS));
  assert.equal(resolveDefaultWeaponId(m), 1);
});

test('resolveDefaultWeaponId falls back to the first WEAPON, never armor', async () => {
  const m = await loadItemTypes(fakePool(ROWS.filter((r) => r.name !== 'dagger')));
  assert.equal(resolveDefaultWeaponId(m), 2); // halberd, not leather-vest
});

test('SLOTS lists the eight paper-doll slots', () => {
  assert.deepEqual(SLOTS, ['main_hand', 'off_hand', 'head', 'chest', 'hands', 'feet', 'ring1', 'ring2']);
});

test('loadItemTypes exposes stamina_cost', async () => {
  const pool = { query: async () => ({ rows: [{
    id: 1, name: 'club', category: 'weapon', kind: 'melee',
    damage: 10, cooldown: 0.45, reach: 85, arc_width: 0.8,
    mana_cost: 0, stamina_cost: 2, resistances: {},
  }] }) };
  const types = await loadItemTypes(pool);
  assert.strictEqual(types.get(1).stamina_cost, 2);
});

test('a missing stamina_cost defaults to 0, never undefined', async () => {
  const pool = { query: async () => ({ rows: [{
    id: 1, name: 'x', category: 'weapon', kind: 'melee', damage: 1, cooldown: 1,
    reach: 10, arc_width: 1, mana_cost: 0, resistances: {},
  }] }) };
  const types = await loadItemTypes(pool);
  assert.strictEqual(types.get(1).stamina_cost, 0);
});

// Returns an array of human-readable problems; empty means the catalog is sound.
function catalogProblems(typesById) {
  const problems = [];
  for (const t of typesById.values()) {
    if (t.category !== 'weapon') continue;
    if (t.kind === 'melee') {
      if (t.reach == null || t.arc_width == null) problems.push(`${t.name}: melee needs reach+arc_width`);
      if (!(t.reach > 0)) problems.push(`${t.name}: reach must be > 0`);
      if (!(t.arc_width > 0)) problems.push(`${t.name}: arc_width must be > 0`);
    } else if (t.kind === 'projectile') {
      if (t.range == null || t.projectile_speed == null || t.projectile_radius == null) {
        problems.push(`${t.name}: projectile needs range+speed+radius`);
      }
      if (!(t.projectile_speed > 0)) problems.push(`${t.name}: projectile_speed must be > 0`);
    } else {
      problems.push(`${t.name}: weapon has no valid kind`);
    }
    if (!(t.cooldown > 0)) problems.push(`${t.name}: cooldown must be > 0`);
    if (!(t.damage > 0)) problems.push(`${t.name}: damage must be > 0`);
    if (t.stamina_cost < 0 || t.mana_cost < 0) problems.push(`${t.name}: negative resource cost`);
  }
  return problems;
}

// SEED_ROWS mirrors the migration's VALUES lists exactly — the 4 original
// weapons from 1714440016000_create_weapon_types.js (with stamina_cost
// backfilled per 1714440019000_weapon_catalog.js) plus the 18 new weapons
// from 1714440019000_weapon_catalog.js. 22 weapons total. Keep in sync with
// the migrations.
const SEED_ROWS = [
  // --- original 4, from 1714440016000 (+ stamina backfill from 1714440019000) ---
  { id: 1, name: 'dagger', category: 'weapon', kind: 'melee', damage: 8, cooldown: 0.30,
    reach: 80, arc_width: 0.6, range: null, projectile_speed: null, projectile_radius: null,
    pierce: null, mana_cost: 0, stamina_cost: 0, element: null },
  { id: 2, name: 'halberd', category: 'weapon', kind: 'melee', damage: 18, cooldown: 0.90,
    reach: 190, arc_width: 1.8, range: null, projectile_speed: null, projectile_radius: null,
    pierce: null, mana_cost: 0, stamina_cost: 8, element: null },
  { id: 3, name: 'bow', category: 'weapon', kind: 'projectile', damage: 12, cooldown: 0.60,
    reach: null, arc_width: null, range: 700, projectile_speed: 900, projectile_radius: 8,
    pierce: 1, mana_cost: 0, stamina_cost: 3, element: null },
  { id: 4, name: 'magic-bolt', category: 'weapon', kind: 'projectile', damage: 14, cooldown: 0.70,
    reach: null, arc_width: null, range: 600, projectile_speed: 700, projectile_radius: 12,
    pierce: 1, mana_cost: 15, stamina_cost: 0, element: 'arcane' },
  // --- 18 new, from 1714440019000 ---
  { id: 7, name: 'knife', category: 'weapon', kind: 'melee', damage: 6, cooldown: 0.25,
    reach: 70, arc_width: 0.5, range: null, projectile_speed: null, projectile_radius: null,
    pierce: null, mana_cost: 0, stamina_cost: 0, element: null },
  { id: 8, name: 'stick', category: 'weapon', kind: 'melee', damage: 7, cooldown: 0.35,
    reach: 90, arc_width: 0.7, range: null, projectile_speed: null, projectile_radius: null,
    pierce: null, mana_cost: 0, stamina_cost: 0, element: null },
  { id: 9, name: 'club', category: 'weapon', kind: 'melee', damage: 10, cooldown: 0.45,
    reach: 85, arc_width: 0.8, range: null, projectile_speed: null, projectile_radius: null,
    pierce: null, mana_cost: 0, stamina_cost: 2, element: null },
  { id: 10, name: 'short sword', category: 'weapon', kind: 'melee', damage: 11, cooldown: 0.45,
    reach: 100, arc_width: 0.9, range: null, projectile_speed: null, projectile_radius: null,
    pierce: null, mana_cost: 0, stamina_cost: 2, element: null },
  { id: 11, name: 'mid club', category: 'weapon', kind: 'melee', damage: 14, cooldown: 0.60,
    reach: 115, arc_width: 1.0, range: null, projectile_speed: null, projectile_radius: null,
    pierce: null, mana_cost: 0, stamina_cost: 4, element: null },
  { id: 12, name: 'long sword', category: 'weapon', kind: 'melee', damage: 15, cooldown: 0.65,
    reach: 140, arc_width: 1.2, range: null, projectile_speed: null, projectile_radius: null,
    pierce: null, mana_cost: 0, stamina_cost: 4, element: null },
  { id: 13, name: 'morning star', category: 'weapon', kind: 'melee', damage: 17, cooldown: 0.75,
    reach: 130, arc_width: 1.6, range: null, projectile_speed: null, projectile_radius: null,
    pierce: null, mana_cost: 0, stamina_cost: 6, element: null },
  { id: 14, name: 'two-handed sword', category: 'weapon', kind: 'melee', damage: 22, cooldown: 1.00,
    reach: 170, arc_width: 1.4, range: null, projectile_speed: null, projectile_radius: null,
    pierce: null, mana_cost: 0, stamina_cost: 9, element: null },
  { id: 15, name: 'scythe', category: 'weapon', kind: 'melee', damage: 20, cooldown: 0.95,
    reach: 175, arc_width: 2.0, range: null, projectile_speed: null, projectile_radius: null,
    pierce: null, mana_cost: 0, stamina_cost: 8, element: null },
  { id: 16, name: 'pike', category: 'weapon', kind: 'melee', damage: 19, cooldown: 0.85,
    reach: 200, arc_width: 0.5, range: null, projectile_speed: null, projectile_radius: null,
    pierce: null, mana_cost: 0, stamina_cost: 7, element: null },
  { id: 17, name: 'darts', category: 'weapon', kind: 'projectile', damage: 7, cooldown: 0.35,
    reach: null, arc_width: null, range: 350, projectile_speed: 800, projectile_radius: 6,
    pierce: 1, mana_cost: 0, stamina_cost: 1, element: null },
  { id: 18, name: 'sling', category: 'weapon', kind: 'projectile', damage: 8, cooldown: 0.50,
    reach: null, arc_width: null, range: 450, projectile_speed: 700, projectile_radius: 8,
    pierce: 1, mana_cost: 0, stamina_cost: 1, element: null },
  { id: 19, name: 'arbalest', category: 'weapon', kind: 'projectile', damage: 20, cooldown: 1.20,
    reach: null, arc_width: null, range: 850, projectile_speed: 1100, projectile_radius: 8,
    pierce: 2, mana_cost: 0, stamina_cost: 5, element: null },
  { id: 20, name: 'apprentice staff', category: 'weapon', kind: 'projectile', damage: 10, cooldown: 0.55,
    reach: null, arc_width: null, range: 500, projectile_speed: 650, projectile_radius: 10,
    pierce: 1, mana_cost: 8, stamina_cost: 0, element: 'arcane' },
  { id: 21, name: 'frost staff', category: 'weapon', kind: 'projectile', damage: 13, cooldown: 0.70,
    reach: null, arc_width: null, range: 620, projectile_speed: 650, projectile_radius: 12,
    pierce: 1, mana_cost: 16, stamina_cost: 0, element: 'ice' },
  { id: 22, name: 'flame staff', category: 'weapon', kind: 'projectile', damage: 16, cooldown: 0.80,
    reach: null, arc_width: null, range: 550, projectile_speed: 600, projectile_radius: 14,
    pierce: 1, mana_cost: 18, stamina_cost: 0, element: 'fire' },
  { id: 23, name: 'storm staff', category: 'weapon', kind: 'projectile', damage: 19, cooldown: 0.95,
    reach: null, arc_width: null, range: 700, projectile_speed: 1000, projectile_radius: 10,
    pierce: 1, mana_cost: 24, stamina_cost: 0, element: 'lightning' },
  { id: 24, name: 'archmage staff', category: 'weapon', kind: 'projectile', damage: 24, cooldown: 1.10,
    reach: null, arc_width: null, range: 800, projectile_speed: 850, projectile_radius: 14,
    pierce: 1, mana_cost: 32, stamina_cost: 0, element: 'arcane' },
];

test('the seeded catalog has no structurally broken weapon', async () => {
  const pool = { query: async () => ({ rows: SEED_ROWS }) };
  const types = await loadItemTypes(pool);
  assert.deepStrictEqual(catalogProblems(types), []);
});

test('the integrity check actually catches a broken row', () => {
  const broken = new Map([[1, {
    id: 1, name: 'bad-axe', category: 'weapon', kind: 'melee',
    damage: 5, cooldown: 0.5, reach: null, arc_width: null,
    mana_cost: 0, stamina_cost: 0,
  }]]);
  const problems = catalogProblems(broken);
  assert.ok(problems.length > 0, 'a melee weapon with no reach must be reported');
  assert.match(problems[0], /bad-axe/);
});

// The mock pool ignores the SQL string, so the tests above would still pass if
// stamina_cost were dropped from the SELECT — verified: doing so left the whole
// suite green while every weapon would load with cost 0 against a real DB,
// silently disabling the stamina gate. Assert on the query text itself.
test('loadItemTypes actually SELECTs every column it maps', async () => {
  let sql = '';
  const pool = { query: async (q) => { sql = q; return { rows: [] }; } };
  await loadItemTypes(pool);
  for (const col of [
    'stamina_cost', 'mana_cost', 'damage', 'cooldown', 'reach', 'arc_width',
    'range', 'projectile_speed', 'projectile_radius', 'pierce', 'element',
    'defense', 'resistances', 'category', 'slot', 'two_handed', 'kind',
  ]) {
    assert.ok(new RegExp(`\\b${col}\\b`).test(sql), `SELECT must name ${col}`);
  }
});
