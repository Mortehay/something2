const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { loadItemTypes, resolveDefaultWeaponId, SLOTS } = require('../src/authority/items.js');
const { PLAYER_STAMINA_REGEN, PLAYER_MANA_REGEN } = require('../src/authority/world.js');

// Same reachability pattern as backend/tests/authority_ammo_db.test.js: skip
// (loudly) rather than fail when no database is reachable, so this suite
// still runs on a machine without Postgres — except under CI, where a skip
// is indistinguishable from a pass in the summary count and this is one of
// the few tests standing between a rebalanced/rewired migration and five
// guards below silently defending a copy instead of the catalog.
const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

async function openPool() {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 2 });
  try {
    await pool.query('SELECT 1');
    return pool;
  } catch (err) {
    await pool.end().catch(() => {});
    return { unreachable: err.message };
  }
}

function fakePool(rows) {
  return { query: async (sql) => { assert.match(sql, /FROM item_types/i); return { rows }; } };
}

const ROWS = [
  { id: 1, name: 'dagger', category: 'weapon', slot: 'main_hand', two_handed: false, kind: 'melee',
    damage: '8', cooldown: '0.3', reach: '80', arc_width: '0.6', range: null, projectile_speed: null,
    projectile_radius: null, pierce: null, mana_cost: '0', element: null, defense: null, resistances: null,
    vfx: null },
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

const { SEED_ROWS } = require('./fixtures/weapon_catalog.js');

// THE test that makes SEED_ROWS mean anything. Every guard below — the
// stamina gate, the mana gate, "every weapon with ammo_type_id points at an
// ammo row", "no weapon has both aoe_radius and pierce > 1", and "AoE
// falloff leaves a meaningful damage band" — iterates SEED_ROWS, a
// hand-transcribed fixture, not the database. Without this test, all five
// are transcription checks: they prove SEED_ROWS is internally consistent
// with itself, never that it still describes what Postgres actually serves.
// A migration that rebalances a cooldown or drops an ammo wiring, with
// nobody remembering to update SEED_ROWS, leaves every one of those tests
// green while the live catalog is inert. That shape has shipped twice
// already in this project (the stamina gate, the stale duplicated mock) —
// this closes it for the catalog fixture too.
//
// Same skip-if-unreachable discipline as authority_ammo_db.test.js,
// including its instinct of pre-checking that the thing this test leans on
// (the self-referencing ammo FK) actually exists, so the ammo-name
// comparison below can't itself go vacuous.
test('the live item_types catalog matches SEED_ROWS (name, category, kind, damage, cooldown, mana_cost, stamina_cost, pierce, projectile_radius, stackable, ammo reference, aoe_radius)', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} (${pool.unreachable}) — SEED_ROWS is UNVERIFIED against the live `
      + 'catalog on this run, which means the stamina gate, mana gate, ammo-wiring, aoe/pierce, and aoe-falloff '
      + 'guards below are only checking a hand-transcribed copy, not the real database';
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    const fk = await pool.query(
      `SELECT 1 FROM pg_constraint
        WHERE conrelid = 'item_types'::regclass AND contype = 'f'
          AND confrelid = 'item_types'::regclass`,
    );
    assert.equal(fk.rowCount, 1,
      'item_types must still have its self-referencing ammo_type_id FK — without it, comparing ammo '
      + 'references by name below would be checking nothing');

    // SEED_ROWS is deliberately weapon+ammo only ("22 weapons + 3 ammo = 25
    // rows" per its own comment) — the five guards it defends never look at
    // armor. Fetch id+name for every row (armor included) so ammo_type_id
    // can resolve to a referenced name even in the hypothetical case ammo
    // ever pointed at a non-weapon/ammo row, but restrict the comparison set
    // itself to weapon+ammo so armor rows aren't reported as false drift.
    const all = await pool.query('SELECT id, name FROM item_types');
    const r = await pool.query(
      `SELECT id, name, category, kind, damage, cooldown, mana_cost, stamina_cost,
              pierce, projectile_radius, stackable, ammo_type_id, aoe_radius
         FROM item_types
        WHERE category IN ('weapon', 'ammo')`,
    );
    assert.ok(r.rows.length > 0, 'item_types must have weapon/ammo rows for this comparison to mean anything');

    const nameById = new Map(all.rows.map((row) => [row.id, row.name]));
    const num = (v) => (v == null ? null : Number(v));
    // Compared fields only — the ones the five guards above actually read.
    // `id` is deliberately excluded: ids are not stable across environments
    // (seed order, prior migrations, manual edits), only names are.
    const FIELDS = ['category', 'kind', 'damage', 'cooldown', 'mana_cost', 'stamina_cost',
      'pierce', 'projectile_radius', 'stackable', 'ammo_type_name', 'aoe_radius'];

    function fromDbRow(row) {
      return {
        category: row.category,
        kind: row.kind,
        damage: num(row.damage),
        cooldown: num(row.cooldown),
        mana_cost: num(row.mana_cost),
        stamina_cost: num(row.stamina_cost),
        pierce: num(row.pierce),
        projectile_radius: num(row.projectile_radius),
        stackable: row.stackable,
        ammo_type_name: row.ammo_type_id == null ? null : nameById.get(row.ammo_type_id),
        aoe_radius: num(row.aoe_radius),
      };
    }
    function fromSeedRow(w) {
      return {
        category: w.category,
        kind: w.kind,
        damage: num(w.damage),
        cooldown: num(w.cooldown),
        mana_cost: num(w.mana_cost),
        stamina_cost: num(w.stamina_cost),
        pierce: num(w.pierce),
        projectile_radius: num(w.projectile_radius),
        stackable: w.stackable,
        ammo_type_name: w.ammo_type_name ?? null,
        aoe_radius: num(w.aoe_radius),
      };
    }

    const dbByName = new Map(r.rows.map((row) => [row.name, fromDbRow(row)]));
    const seedByName = new Map(SEED_ROWS.map((w) => [w.name, fromSeedRow(w)]));

    // Report BOTH directions of mismatch, not just the first one found: a
    // drifted migration can add, remove, and rebalance rows all at once, and
    // whoever reads this failure needs the whole list to fix SEED_ROWS in
    // one pass rather than one test-run-per-field.
    const problems = [];
    for (const [name, dbRow] of dbByName) {
      if (!seedByName.has(name)) {
        problems.push(`DB has item type '${name}' with no entry in SEED_ROWS — add it to SEED_ROWS`);
        continue;
      }
      const seedRow = seedByName.get(name);
      for (const field of FIELDS) {
        if (dbRow[field] !== seedRow[field]) {
          problems.push(
            `'${name}' field '${field}' drifted: DB has ${JSON.stringify(dbRow[field])}, SEED_ROWS has `
            + `${JSON.stringify(seedRow[field])} — update SEED_ROWS to match the live catalog`,
          );
        }
      }
    }
    for (const name of seedByName.keys()) {
      if (!dbByName.has(name)) {
        problems.push(`SEED_ROWS has item type '${name}' with no matching row in the DB — update SEED_ROWS `
          + '(the migration may have renamed, dropped, or never inserted it)');
      }
    }

    assert.ok(problems.length === 0,
      `SEED_ROWS has drifted from the live item_types catalog:\n${problems.join('\n')}`);
  } finally {
    await pool.end().catch(() => {});
  }
});

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
  for (const col of ['stackable', 'ammo_type_id', 'aoe_radius']) {
    assert.ok(sql.includes(col), `loadItemTypes SELECT must name ${col} — a mapped column missing from the SELECT loads as undefined, so ammo silently never depletes and AoE silently never fires`);
  }
});

test('loadItemTypes exposes ammo and aoe fields', async () => {
  const pool = { query: async () => ({ rows: [{
    id: 1, name: 'bow', category: 'weapon', kind: 'projectile',
    stackable: false, ammo_type_id: 7, aoe_radius: null,
  }] }) };
  const m = await loadItemTypes(pool);
  assert.equal(m.get(1).stackable, false);
  assert.equal(m.get(1).ammo_type_id, 7);
  assert.equal(m.get(1).aoe_radius, null);
});

// A resource gate only ever "fires" (refuses an attack) if what a weapon
// costs to swing exceeds what regenerates during its own cooldown. If
// regen * cooldown >= cost, the cooldown alone always lets the pool
// fully out-regenerate the spend before the next swing is even legal, and
// the "insufficient resource" branch becomes unreachable through legal
// play — the whole gate (and its tests, and the HUD bar) is decorative.
// This guards PLAYER_STAMINA_REGEN (backend/src/authority/world.js) and
// every seeded weapon's stamina_cost/cooldown (mirrored from the
// migrations into SEED_ROWS above) against silently regressing back into
// that state.
test('every stamina-costed weapon\'s cost exceeds what regens during its own cooldown', () => {
  for (const w of SEED_ROWS) {
    if (!(w.stamina_cost > 0)) continue;
    const regenPerSwing = PLAYER_STAMINA_REGEN * w.cooldown;
    assert.ok(
      w.stamina_cost > regenPerSwing,
      `${w.name}: cost ${w.stamina_cost} <= regen ${PLAYER_STAMINA_REGEN} x cooldown ${w.cooldown} `
      + `= ${regenPerSwing}, so the gate can never fire`,
    );
  }
});

// Mirror check for mana on staves/magic weapons. Unlike stamina, the
// browser-verified behavior is that mana genuinely gates today (measured
// recast intervals matched a pure regen-wait), and this assertion confirms
// the seeded catalog is consistent with that: every mana-costed weapon's
// cost already exceeds regen * cooldown, so — unlike stamina before this
// change — no rebalance is needed here.
test('every mana-costed weapon\'s cost exceeds what regens during its own cooldown', () => {
  for (const w of SEED_ROWS) {
    if (!(w.mana_cost > 0)) continue;
    const regenPerCast = PLAYER_MANA_REGEN * w.cooldown;
    assert.ok(
      w.mana_cost > regenPerCast,
      `${w.name}: mana cost ${w.mana_cost} <= regen ${PLAYER_MANA_REGEN} x cooldown ${w.cooldown} `
      + `= ${regenPerCast}, so the mana gate can never fire`,
    );
  }
});

test('every weapon with ammo_type_id points at an ammo row', () => {
  // Guards against a weapon wired to another weapon, which would make
  // firing consume a sword.
  for (const w of SEED_ROWS.filter((r) => r.ammo_type_id != null)) {
    const target = SEED_ROWS.find((r) => r.name === w.ammo_type_name);
    assert.ok(target, `${w.name} references a missing ammo type`);
    assert.equal(target.category, 'ammo');
  }
});

test('no weapon has both aoe_radius and pierce > 1', () => {
  for (const w of SEED_ROWS) {
    if (w.aoe_radius != null) {
      assert.ok((w.pierce ?? 1) <= 1,
        `${w.name} both detonates and pierces — impact behaviour is ambiguous`);
    }
  }
});

test('every ammo row is stackable and has no kind', () => {
  for (const a of SEED_ROWS.filter((r) => r.category === 'ammo')) {
    assert.equal(a.stackable, true);
    assert.equal(a.kind, null);
  }
});

test('AoE falloff leaves a meaningful damage band', () => {
  // Reachability, not just correctness: if a staff's radius were smaller than
  // its projectile_radius, the blast would be entirely inside the impact
  // circle and falloff would never produce a visible gradient.
  for (const w of SEED_ROWS.filter((r) => r.aoe_radius != null)) {
    assert.ok(w.aoe_radius > w.projectile_radius * 2,
      `${w.name}: aoe_radius ${w.aoe_radius} is not meaningfully larger than its projectile radius ${w.projectile_radius} — the blast adds nothing over a direct hit`);
  }
});

test('loadItemTypes carries the vfx bindings through to the weapon catalog', async () => {
  // world.attack() resolves the effect name off the weapon object it already
  // holds. Dropped here, every attack silently resolves to null and slice A
  // renders nothing while every other test stays green.
  const rows = [{ ...ROWS[0], vfx: { attack: 'sweep_arc' } }];
  const m = await loadItemTypes(fakePool(rows));
  assert.deepEqual(m.get(1).vfx, { attack: 'sweep_arc' });
});

test('a weapon with no bindings loads vfx as null, not undefined', async () => {
  const m = await loadItemTypes(fakePool([{ ...ROWS[0], vfx: null }]));
  assert.strictEqual(m.get(1).vfx, null);
});
