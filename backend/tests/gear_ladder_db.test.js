const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { World } = require('../src/authority/world.js');
const { loadItemTypes, SLOTS } = require('../src/authority/items.js');
const { generateGearLadder, upsertGearLadder } = require('../seeds/generateGearLadder.js');
const { GEAR_TIERS, GEAR_FAMILIES } = require('../seeds/data/gearLadder.js');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

async function openPool() {
  if (!DB_URL) return { unreachable: 'no TEST_DATABASE_URL / DATABASE_URL' };
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 4 });
  try { await pool.query('SELECT 1'); } catch (err) {
    await pool.end().catch(() => {});
    return { unreachable: `NO DATABASE at ${DB_URL} (${err.message})` };
  }
  return pool;
}

const PAPER_DOLL = ['main_hand', 'off_hand', 'head', 'chest', 'hands', 'feet', 'ring1', 'ring2'];

test('every one of the eight paper-doll slots has at least one equippable base item', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  const r = await pool.query(
    `SELECT slot, count(*)::int AS n
       FROM item_types
      WHERE category IN ('weapon','armor') AND slot IS NOT NULL
      GROUP BY slot`,
  );
  const bySlot = Object.fromEntries(r.rows.map((row) => [row.slot, row.n]));

  // Hand-written list, not SLOTS-derived: if someone deletes a slot from
  // items.js the list this asserts must not shrink with it.
  for (const slot of PAPER_DOLL) {
    assert.ok((bySlot[slot] || 0) >= 1, `slot ${slot} has no equippable item type`);
  }
  assert.deepStrictEqual([...SLOTS].sort(),
    ['chest', 'feet', 'hands', 'head', 'main_hand', 'off_hand', 'ring1', 'ring2']);
});

test('the ladder covers the whole level range', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  const r = await pool.query(
    'SELECT DISTINCT req_level FROM item_types WHERE tier IS NOT NULL AND req_level > 1 ORDER BY req_level',
  );
  assert.deepStrictEqual(r.rows.map((x) => x.req_level), [10, 25, 40, 55, 70, 90, 110, 130, 150]);
});

// Every generated row reached the database intact. This is the proof that the
// rows satisfy item_types' CHECK constraints: a row that violated
// weapon_fields/armor_fields/slot/req_level/tier would have aborted the
// migration, so its absence here is the failure signal.
test('all 150 generated rows are in the catalog with the generator numbers', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  const rows = generateGearLadder({ tiers: GEAR_TIERS, families: GEAR_FAMILIES });
  const names = rows.map((r) => r.name);
  const r = await pool.query(
    `SELECT name, category, slot, two_handed, kind, damage, cooldown, reach, arc_width,
            range, projectile_speed, projectile_radius, defense, value,
            tier, item_level, req_level, req_strength, req_dexterity, req_constitution,
            req_intelligence, req_wisdom, req_charisma
       FROM item_types WHERE name = ANY($1::text[])`,
    [names],
  );
  assert.strictEqual(r.rows.length, 150, 'every ladder row must exist in the catalog');

  const stored = new Map(r.rows.map((row) => [row.name, row]));
  for (const want of rows) {
    const got = stored.get(want.name);
    for (const key of Object.keys(want)) {
      const a = want[key];
      const b = got[key];
      const norm = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v);
      assert.strictEqual(norm(b), norm(a), `${want.name}.${key}: stored ${b}, generated ${a}`);
    }
  }
});

// ---------------------------------------------------------------------------
// ACCEPTANCE CRITERION 1, through the REAL equip path.
//
// A row existing is not the same as an item you can wear. canEquip's `req`
// argument is optional, and T10 shipped a gate that was inert because a column
// was missing from loadItemTypes' SELECT list while every unit test stayed
// green. So this drives world.setEquipment -- the loader, the requirement
// context read from player_progression, the player_equipment write -- and
// checks the database afterwards.
// ---------------------------------------------------------------------------

async function createCharacter(pool, tag, level) {
  const username = `gearladder-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const u = await pool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player') RETURNING id", [username],
  );
  const c = await pool.query(
    `INSERT INTO characters (user_id, slot, name, entity_type_id)
     SELECT $1, 1, $2, e.id FROM entity_types e WHERE e.name = 'Warrior' RETURNING id`,
    [u.rows[0].id, `gear-char-${tag}-${process.pid}-${Date.now()}`],
  );
  const characterId = c.rows[0].id;
  // Only `level` is written. The six stat columns stay at the class-base
  // snapshot of 5 -- progression_migration.test.js asserts every character in
  // the database still carries base 5 on all six (shared contract 6.1), so
  // writing 40 STR here would turn an unrelated file red.
  await pool.query(
    `INSERT INTO player_progression (character_id, level) VALUES ($1,$2)
     ON CONFLICT (character_id) DO UPDATE SET level = $2`,
    [characterId, level],
  );
  return { userId: u.rows[0].id, characterId };
}

function armWorld(itemTypes) {
  const map = { chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] };
  return new World(map, itemTypes, null, 8);
}

test('a level-1 character fills all eight paper-doll slots through world.setEquipment', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  const tag = `t1set-${Date.now()}`;
  const { characterId } = await createCharacter(pool, tag, 1);

  // One tier-1 item per slot, named explicitly rather than queried, so a
  // ladder that silently stopped producing (say) rings fails here.
  const wanted = [
    ['crude-blade', 'main_hand'],
    ['crude-buckler', 'off_hand'],
    ['crude-helm', 'head'],
    ['crude-plate', 'chest'],
    ['crude-gauntlets', 'hands'],
    ['crude-greaves', 'feet'],
    ['crude-band', 'ring1'],
    ['crude-signet', 'ring2'],
  ];
  assert.deepStrictEqual(wanted.map((w) => w[1]), PAPER_DOLL, 'the set must cover every slot exactly once');

  const itemTypes = await loadItemTypes(pool);
  const byName = new Map([...itemTypes.values()].map((ty) => [ty.name, ty]));
  const items = [];
  const ids = new Map();
  for (const [name] of wanted) {
    const type = byName.get(name);
    assert.ok(type, `${name} is missing from the catalog`);
    const ins = await pool.query(
      'INSERT INTO player_items (character_id, item_type_id, quantity) VALUES ($1,$2,1) RETURNING id',
      [characterId, type.id],
    );
    ids.set(name, ins.rows[0].id);
    items.push({ id: ins.rows[0].id, typeId: type.id, quantity: 1 });
  }

  const world = armWorld(itemTypes);
  world.addPlayer('u-gear', { x: 0, y: 0 }, { items, equipment: {} }, { x: 0, y: 0 }, 0, undefined, characterId);

  for (const [name, slot] of wanted) {
    const res = await world.setEquipment(pool, 'u-gear', ids.get(name), slot);
    assert.deepStrictEqual(res, { ok: true }, `${name} -> ${slot}: ${res.reason}`);
  }

  // The database, not the in-memory doll: the write is the part that proves
  // the equip actually happened.
  const eq = await pool.query(
    'SELECT slot FROM player_equipment WHERE character_id = $1 ORDER BY slot', [characterId],
  );
  assert.deepStrictEqual(eq.rows.map((x) => x.slot), [...PAPER_DOLL].sort());
  // Seven armor pieces: 1.5 + 1.5 + 3.0 + 1.0 + 1.2 + 0.2 + 0.2 = 8.6. The
  // blade is a weapon and contributes nothing. Hand-computed from the tier-1
  // family defenses, not read back from the catalog.
  assert.ok(Math.abs(world.getPlayer('u-gear').mit.defense - 8.6) < 1e-6,
    `mitigation was ${world.getPlayer('u-gear').mit.defense}`);
});

// The negative half. Without it, a gate that let everything through would also
// satisfy the test above, and "the ladder is reachable" would say nothing.
test('the same level-1 character is refused the tier-10 versions of those slots', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  const tag = `t10deny-${Date.now()}`;
  const { characterId } = await createCharacter(pool, tag, 1);

  const itemTypes = await loadItemTypes(pool);
  const byName = new Map([...itemTypes.values()].map((ty) => [ty.name, ty]));
  const wanted = [
    ['mythic-blade', 'main_hand'],
    ['mythic-buckler', 'off_hand'],
    ['mythic-helm', 'head'],
    ['mythic-plate', 'chest'],
    ['mythic-gauntlets', 'hands'],
    ['mythic-greaves', 'feet'],
    ['mythic-band', 'ring1'],
    ['mythic-signet', 'ring2'],
  ];
  const items = [];
  const ids = new Map();
  for (const [name] of wanted) {
    const type = byName.get(name);
    assert.ok(type, `${name} is missing from the catalog`);
    const ins = await pool.query(
      'INSERT INTO player_items (character_id, item_type_id, quantity) VALUES ($1,$2,1) RETURNING id',
      [characterId, type.id],
    );
    ids.set(name, ins.rows[0].id);
    items.push({ id: ins.rows[0].id, typeId: type.id, quantity: 1 });
  }

  const world = armWorld(itemTypes);
  world.addPlayer('u-deny', { x: 0, y: 0 }, { items, equipment: {} }, { x: 0, y: 0 }, 0, undefined, characterId);

  for (const [name, slot] of wanted) {
    const res = await world.setEquipment(pool, 'u-deny', ids.get(name), slot);
    assert.strictEqual(res.ok, false, `${name} must not be equippable at level 1`);
    assert.strictEqual(res.reason, 'requires level 150', name);
  }
  const eq = await pool.query('SELECT count(*)::int AS n FROM player_equipment WHERE character_id = $1', [characterId]);
  assert.strictEqual(eq.rows[0].n, 0, 'a refused equip must write nothing');
});

// ---------------------------------------------------------------------------
// ACCEPTANCE CRITERION 3: the 24 items that predate the ladder are untouched.
// Literal table, transcribed from the catalog before the ladder was seeded.
// ---------------------------------------------------------------------------

// name, category, slot, two_handed, kind, damage, cooldown, defense, value
const PRE_EXISTING = [
  ['apprentice staff', 'weapon', 'main_hand', false, 'projectile', 10, 0.55, null, 30],
  ['arbalest', 'weapon', 'main_hand', true, 'projectile', 20, 1.2, null, 50],
  ['arcane-ward', 'armor', 'head', false, null, 0, 0, 1, 13],
  ['archmage staff', 'weapon', 'main_hand', true, 'projectile', 24, 1.1, null, 58],
  ['bow', 'weapon', 'main_hand', false, 'projectile', 12, 0.6, null, 34],
  ['club', 'weapon', 'main_hand', false, 'melee', 10, 0.45, null, 30],
  ['dagger', 'weapon', 'main_hand', false, 'melee', 8, 0.3, null, 26],
  ['darts', 'weapon', 'main_hand', false, 'projectile', 7, 0.35, null, 24],
  ['flame staff', 'weapon', 'main_hand', false, 'projectile', 16, 0.8, null, 42],
  ['frost staff', 'weapon', 'main_hand', false, 'projectile', 15, 0.7, null, 36],
  ['halberd', 'weapon', 'main_hand', true, 'melee', 18, 0.9, null, 46],
  ['knife', 'weapon', 'main_hand', false, 'melee', 6, 0.25, null, 22],
  ['leather-vest', 'armor', 'chest', false, null, 0, 0, 2, 16],
  ['long sword', 'weapon', 'main_hand', false, 'melee', 15, 0.65, null, 40],
  ['magic-bolt', 'weapon', 'main_hand', false, 'projectile', 14, 0.7, null, 38],
  ['mid club', 'weapon', 'main_hand', false, 'melee', 14, 0.6, null, 38],
  ['morning star', 'weapon', 'main_hand', false, 'melee', 17, 0.75, null, 44],
  ['pike', 'weapon', 'main_hand', true, 'melee', 19, 0.85, null, 48],
  ['scythe', 'weapon', 'main_hand', true, 'melee', 20, 0.95, null, 50],
  ['short sword', 'weapon', 'main_hand', false, 'melee', 11, 0.45, null, 32],
  ['sling', 'weapon', 'main_hand', false, 'projectile', 8, 0.5, null, 26],
  ['stick', 'weapon', 'main_hand', false, 'melee', 7, 0.35, null, 24],
  ['storm staff', 'weapon', 'main_hand', true, 'projectile', 15, 1.1, null, 38],
  ['two-handed sword', 'weapon', 'main_hand', true, 'melee', 22, 1, null, 54],
];

test('the 24 items that predate the ladder keep their stats and stay at requirement zero', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  const r = await pool.query(
    `SELECT name, category, slot, two_handed, kind, damage, cooldown, defense, value,
            req_level, tier, item_level,
            req_strength, req_dexterity, req_constitution,
            req_intelligence, req_wisdom, req_charisma
       FROM item_types WHERE name = ANY($1::text[]) ORDER BY name`,
    [PRE_EXISTING.map((x) => x[0])],
  );
  assert.strictEqual(r.rows.length, 24, 'all 24 pre-existing items must still exist');

  const byName = new Map(r.rows.map((row) => [row.name, row]));
  for (const [name, category, slot, twoHanded, kind, damage, cooldown, defense, value] of PRE_EXISTING) {
    const got = byName.get(name);
    assert.deepStrictEqual(
      [got.category, got.slot, got.two_handed, got.kind, got.damage, got.cooldown, got.defense, got.value],
      [category, slot, twoHanded, kind, damage, cooldown, defense, value],
      name,
    );
    // The ladder must not have retroactively gated anything that used to be
    // freely wearable.
    assert.strictEqual(got.req_level, 1, `${name}.req_level`);
    assert.strictEqual(got.tier, 1, `${name}.tier`);
    assert.strictEqual(got.item_level, 1, `${name}.item_level`);
    for (const s of ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma']) {
      assert.strictEqual(got[`req_${s}`], 0, `${name}.req_${s}`);
    }
  }
});

// ---------------------------------------------------------------------------
// ACCEPTANCE CRITERION 5: re-seeding changes nothing.
// ---------------------------------------------------------------------------

test('re-running the ladder upsert inserts nothing and leaves the row count unchanged', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  const rows = generateGearLadder({ tiers: GEAR_TIERS, families: GEAR_FAMILIES });
  const before = (await pool.query('SELECT count(*)::int AS n FROM item_types')).rows[0].n;

  const first = await upsertGearLadder(pool, rows);
  assert.deepStrictEqual(first, { inserted: 0, skipped: 150 },
    'the migration already seeded these; a second run must insert nothing');

  const second = await upsertGearLadder(pool, rows);
  assert.deepStrictEqual(second, { inserted: 0, skipped: 150 });

  const after = (await pool.query('SELECT count(*)::int AS n FROM item_types')).rows[0].n;
  assert.strictEqual(after, before, 'two extra seed runs must not change the catalog size');

  // And the numbers are untouched too -- ON CONFLICT DO NOTHING, not DO UPDATE.
  const probe = await pool.query("SELECT damage, defense, value FROM item_types WHERE name = 'mythic-plate'");
  assert.strictEqual(probe.rows[0].defense, 43.5);
  assert.strictEqual(probe.rows[0].value, 3400);
});
