const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

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

test('item_types carries the requirement, item level and tier columns', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  const r = await pool.query(
    `SELECT column_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_name = 'item_types'
        AND column_name IN ('req_level','req_strength','req_dexterity','req_constitution',
                            'req_intelligence','req_wisdom','req_charisma','item_level','tier')
      ORDER BY column_name`,
  );
  assert.deepStrictEqual(
    r.rows.map((row) => row.column_name),
    ['item_level', 'req_charisma', 'req_constitution', 'req_dexterity',
      'req_intelligence', 'req_level', 'req_strength', 'req_wisdom', 'tier'],
  );
  for (const row of r.rows) assert.strictEqual(row.is_nullable, 'NO', `${row.column_name} must be NOT NULL`);

  // Hand-written defaults: every pre-existing catalog row must stay equippable
  // by a level-1 character with base stats, so the requirement defaults are
  // the identity values, not the ladder's tier-1 values.
  const d = Object.fromEntries(r.rows.map((row) => [row.column_name, row.column_default]));
  assert.match(d.req_level, /^1\b/);
  assert.match(d.req_strength, /^0\b/);
  assert.match(d.item_level, /^1\b/);
  assert.match(d.tier, /^1\b/);
});

test('the requirement columns reject nonsense values', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  await assert.rejects(
    pool.query(`INSERT INTO item_types (name, category, slot, kind, damage, cooldown, defense, req_level)
                VALUES ('req-check-probe-a', 'armor', 'chest', NULL, 0, 0, 1, 0)`),
    /item_types_req_level_check/,
  );
  await assert.rejects(
    pool.query(`INSERT INTO item_types (name, category, slot, kind, damage, cooldown, defense, req_strength)
                VALUES ('req-check-probe-b', 'armor', 'chest', NULL, 0, 0, 1, -1)`),
    /item_types_req_stats_check/,
  );
});

// ---------------------------------------------------------------------------
// THE ANTI-INERTNESS GUARD. Everything below drives the gate THROUGH
// world.setEquipment / world.clearEquipment rather than through canEquip
// directly. canEquip's `req` argument is optional, so a gate that exists but
// is never handed a context would pass every canEquip-level test while being
// completely inert in the running game. These are the tests that fail if the
// thread from world.js is ever dropped.
// ---------------------------------------------------------------------------

const { World } = require('../src/authority/world.js');
const { loadItemTypes } = require('../src/authority/items.js');

async function createCharacter(pool, tag, level, stats = {}) {
  const username = `reqtest-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const u = await pool.query(
    'INSERT INTO users (username, password_hash, role) VALUES ($1, \'x\', \'player\') RETURNING id', [username],
  );
  const c = await pool.query(
    `INSERT INTO characters (user_id, slot, name, entity_type_id)
     SELECT $1, 1, $2, e.id FROM entity_types e WHERE e.name = 'Warrior' RETURNING id`,
    [u.rows[0].id, `req-char-${tag}-${process.pid}-${Date.now()}`],
  );
  const characterId = c.rows[0].id;
  await pool.query(
    `INSERT INTO player_progression (character_id, level, strength, dexterity, constitution,
                                     intelligence, wisdom, charisma)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (character_id) DO UPDATE SET level = $2, strength = $3, dexterity = $4,
       constitution = $5, intelligence = $6, wisdom = $7, charisma = $8`,
    [characterId, level, stats.strength ?? 5, stats.dexterity ?? 5, stats.constitution ?? 5,
      stats.intelligence ?? 5, stats.wisdom ?? 5, stats.charisma ?? 5],
  );
  return { userId: u.rows[0].id, characterId };
}

async function makeItemType(pool, name, extra) {
  const cols = { category: 'armor', slot: 'chest', kind: null, damage: 0, cooldown: 0, defense: 1, ...extra };
  const r = await pool.query(
    `INSERT INTO item_types (name, category, slot, kind, damage, cooldown, defense,
                             req_level, req_strength, item_level, tier)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [name, cols.category, cols.slot, cols.kind, cols.damage, cols.cooldown, cols.defense,
      cols.req_level ?? 1, cols.req_strength ?? 0, cols.item_level ?? 1, cols.tier ?? 1],
  );
  return r.rows[0].id;
}

function armWorld(itemTypes) {
  const map = { chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] };
  return new World(map, itemTypes, null, 8);
}

test('world.setEquipment refuses an item whose level requirement the character does not meet', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  const tag = `lvl-${Date.now()}`;
  const { characterId } = await createCharacter(pool, tag, 3);
  const typeId = await makeItemType(pool, `req-plate-${tag}`, { req_level: 40 });
  const ins = await pool.query(
    'INSERT INTO player_items (character_id, item_type_id, quantity) VALUES ($1,$2,1) RETURNING id',
    [characterId, typeId],
  );
  const itemId = ins.rows[0].id;

  const itemTypes = await loadItemTypes(pool);
  const world = armWorld(itemTypes);
  world.addPlayer('u-req', { x: 0, y: 0 }, {
    items: [{ id: itemId, typeId, quantity: 1 }], equipment: {},
  }, { x: 0, y: 0 }, 0, undefined, characterId);

  const r = await world.setEquipment(pool, 'u-req', itemId, 'chest');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'requires level 40');

  const eq = await pool.query('SELECT count(*)::int AS n FROM player_equipment WHERE character_id = $1', [characterId]);
  assert.strictEqual(eq.rows[0].n, 0, 'a refused equip must write nothing');
  assert.strictEqual(world.getPlayer('u-req').inv.equipment.chest, undefined,
    'a refused equip must not mutate the in-memory paper doll either');
});

// The positive half. Without this, "setEquipment refuses everything" would
// also pass the test above, and the gate could be refusing legal gear too.
test('world.setEquipment still equips an item whose requirements ARE met', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  const tag = `okeq-${Date.now()}`;
  const { characterId } = await createCharacter(pool, tag, 40);
  const typeId = await makeItemType(pool, `ok-plate-${tag}`, { req_level: 40 });
  const itemId = (await pool.query(
    'INSERT INTO player_items (character_id, item_type_id, quantity) VALUES ($1,$2,1) RETURNING id',
    [characterId, typeId],
  )).rows[0].id;

  const itemTypes = await loadItemTypes(pool);
  const world = armWorld(itemTypes);
  world.addPlayer('u-ok', { x: 0, y: 0 }, {
    items: [{ id: itemId, typeId, quantity: 1 }], equipment: {},
  }, { x: 0, y: 0 }, 0, undefined, characterId);

  const r = await world.setEquipment(pool, 'u-ok', itemId, 'chest');
  assert.deepStrictEqual(r, { ok: true });
  const eq = await pool.query('SELECT slot FROM player_equipment WHERE character_id = $1', [characterId]);
  assert.deepStrictEqual(eq.rows.map((x) => x.slot), ['chest']);
  assert.strictEqual(world.getPlayer('u-ok').mit.defense, 1, 'mitigation is recomputed on success');
});

test('world.clearEquipment refuses an unequip that would orphan another item, naming it', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  const tag = `dep-${Date.now()}`;
  const { characterId } = await createCharacter(pool, tag, 50);
  const plateId = await makeItemType(pool, `dep-plate-${tag}`, { req_strength: 20 });
  const helmId = await makeItemType(pool, `dep-helm-${tag}`, { slot: 'head' });
  const stoneTypeId = (await pool.query(
    `INSERT INTO item_types (name, category, slot, kind, damage, cooldown,
                             stat_bonus_stat, stat_bonus_amount)
     VALUES ($1,'stone',NULL,NULL,0,0,'strength',20) RETURNING id`,
    [`dep-stone-${tag}`],
  )).rows[0].id;

  const plate = (await pool.query('INSERT INTO player_items (character_id, item_type_id) VALUES ($1,$2) RETURNING id', [characterId, plateId])).rows[0].id;
  const helm = (await pool.query('INSERT INTO player_items (character_id, item_type_id) VALUES ($1,$2) RETURNING id', [characterId, helmId])).rows[0].id;
  const stone = (await pool.query('INSERT INTO player_items (character_id, item_type_id) VALUES ($1,$2) RETURNING id', [characterId, stoneTypeId])).rows[0].id;
  await pool.query('INSERT INTO stone_instances (player_item_id, socketed_into_id) VALUES ($1,$2)', [stone, helm]);
  await pool.query('INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1,$2,$3)', [characterId, 'chest', plate]);
  await pool.query('INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1,$2,$3)', [characterId, 'head', helm]);

  const itemTypes = await loadItemTypes(pool);
  const world = armWorld(itemTypes);
  world.addPlayer('u-dep', { x: 0, y: 0 }, {
    items: [
      { id: plate, typeId: plateId, quantity: 1 },
      { id: helm, typeId: helmId, quantity: 1, socketedStoneTypeId: stoneTypeId, socketedStoneItemId: stone },
      { id: stone, typeId: stoneTypeId, quantity: 1 },
    ],
    equipment: { chest: plate, head: helm },
  }, { x: 0, y: 0 }, 0, undefined, characterId);

  const r = await world.clearEquipment(pool, 'u-dep', 'head');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, new RegExp(`dep-plate-${tag}`));

  const still = await pool.query(
    'SELECT slot FROM player_equipment WHERE character_id = $1 ORDER BY slot', [characterId],
  );
  assert.deepStrictEqual(still.rows.map((x) => x.slot), ['chest', 'head']);
  assert.strictEqual(world.getPlayer('u-dep').inv.equipment.head, helm,
    'a refused unequip must leave the in-memory paper doll intact');
});

// The dependent item leaves first, then the one it depended on comes off
// freely. Without this, a gate that refused EVERY unequip would still satisfy
// the test above.
test('world.clearEquipment allows the unequip once nothing depends on it', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  const tag = `free-${Date.now()}`;
  const { characterId } = await createCharacter(pool, tag, 50);
  const plateId = await makeItemType(pool, `free-plate-${tag}`, { req_strength: 20 });
  const helmId = await makeItemType(pool, `free-helm-${tag}`, { slot: 'head' });
  const stoneTypeId = (await pool.query(
    `INSERT INTO item_types (name, category, slot, kind, damage, cooldown,
                             stat_bonus_stat, stat_bonus_amount)
     VALUES ($1,'stone',NULL,NULL,0,0,'strength',20) RETURNING id`,
    [`free-stone-${tag}`],
  )).rows[0].id;

  const plate = (await pool.query('INSERT INTO player_items (character_id, item_type_id) VALUES ($1,$2) RETURNING id', [characterId, plateId])).rows[0].id;
  const helm = (await pool.query('INSERT INTO player_items (character_id, item_type_id) VALUES ($1,$2) RETURNING id', [characterId, helmId])).rows[0].id;
  const stone = (await pool.query('INSERT INTO player_items (character_id, item_type_id) VALUES ($1,$2) RETURNING id', [characterId, stoneTypeId])).rows[0].id;
  await pool.query('INSERT INTO stone_instances (player_item_id, socketed_into_id) VALUES ($1,$2)', [stone, helm]);
  await pool.query('INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1,$2,$3)', [characterId, 'chest', plate]);
  await pool.query('INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1,$2,$3)', [characterId, 'head', helm]);

  const itemTypes = await loadItemTypes(pool);
  const world = armWorld(itemTypes);
  world.addPlayer('u-free', { x: 0, y: 0 }, {
    items: [
      { id: plate, typeId: plateId, quantity: 1 },
      { id: helm, typeId: helmId, quantity: 1, socketedStoneTypeId: stoneTypeId, socketedStoneItemId: stone },
      { id: stone, typeId: stoneTypeId, quantity: 1 },
    ],
    equipment: { chest: plate, head: helm },
  }, { x: 0, y: 0 }, 0, undefined, characterId);

  // The plate is the dependent one; it comes off with nothing depending on IT.
  assert.deepStrictEqual(await world.clearEquipment(pool, 'u-free', 'chest'), { ok: true });
  // Now the helm (and its stone) are free to leave too.
  assert.deepStrictEqual(await world.clearEquipment(pool, 'u-free', 'head'), { ok: true });

  const still = await pool.query('SELECT slot FROM player_equipment WHERE character_id = $1', [characterId]);
  assert.deepStrictEqual(still.rows, []);
});

const { enforceEquipRequirements } = require('../src/services/equipCompliance.js');

const RESET_BASE = {
  strength: 5, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5,
};

test('a respec auto-unequips gear that no longer qualifies, leaving it in the backpack', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  const tag = `resp-${Date.now()}`;
  const { characterId } = await createCharacter(pool, tag, 60, { strength: 40 });
  const plateId = await makeItemType(pool, `resp-plate-${tag}`, { req_strength: 30 });
  const helmId = await makeItemType(pool, `resp-helm-${tag}`, { slot: 'head' });
  const plate = (await pool.query('INSERT INTO player_items (character_id, item_type_id) VALUES ($1,$2) RETURNING id', [characterId, plateId])).rows[0].id;
  const helm = (await pool.query('INSERT INTO player_items (character_id, item_type_id) VALUES ($1,$2) RETURNING id', [characterId, helmId])).rows[0].id;
  await pool.query('INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1,$2,$3)', [characterId, 'chest', plate]);
  await pool.query('INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1,$2,$3)', [characterId, 'head', helm]);

  const itemTypes = await loadItemTypes(pool);
  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');
    result = await enforceEquipRequirements(client, characterId, itemTypes, RESET_BASE, 60);
    await client.query('COMMIT');
  } finally { client.release(); }

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.unequipped.map((u) => u.slot), ['chest']);

  const eq = await pool.query('SELECT slot FROM player_equipment WHERE character_id = $1 ORDER BY slot', [characterId]);
  assert.deepStrictEqual(eq.rows.map((x) => x.slot), ['head'], 'only the illegal slot is cleared');
  const owned = await pool.query('SELECT count(*)::int AS n FROM player_items WHERE character_id = $1', [characterId]);
  assert.strictEqual(owned.rows[0].n, 2, 'nothing is deleted -- the plate is still owned');
});

// The no-op half. Without it, an implementation that cleared every slot would
// still satisfy the test above.
test('a respec that invalidates nothing clears nothing', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  const tag = `noop-${Date.now()}`;
  const { characterId } = await createCharacter(pool, tag, 60, { strength: 40 });
  const plateId = await makeItemType(pool, `noop-plate-${tag}`, { req_strength: 5 });
  const helmId = await makeItemType(pool, `noop-helm-${tag}`, { slot: 'head' });
  const plate = (await pool.query('INSERT INTO player_items (character_id, item_type_id) VALUES ($1,$2) RETURNING id', [characterId, plateId])).rows[0].id;
  const helm = (await pool.query('INSERT INTO player_items (character_id, item_type_id) VALUES ($1,$2) RETURNING id', [characterId, helmId])).rows[0].id;
  await pool.query('INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1,$2,$3)', [characterId, 'chest', plate]);
  await pool.query('INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1,$2,$3)', [characterId, 'head', helm]);

  const itemTypes = await loadItemTypes(pool);
  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');
    result = await enforceEquipRequirements(client, characterId, itemTypes, RESET_BASE, 60);
    await client.query('COMMIT');
  } finally { client.release(); }

  assert.deepStrictEqual(result, { ok: true, unequipped: [] });
  const eq = await pool.query('SELECT slot FROM player_equipment WHERE character_id = $1 ORDER BY slot', [characterId]);
  assert.deepStrictEqual(eq.rows.map((x) => x.slot), ['chest', 'head']);
});

// THE REFUSAL CONDITION IS `usedSlots > capacity`, NOT "the backpack is full".
//
// Unequipping in this schema is capacity-NEUTRAL: an equipped item is already
// a player_items row, items.js#usedSlots counts it whether it is equipped or
// not, and the panel draws it in the same grid. So a "no free slot" refusal
// could never fire -- its test would be green and vacuous, which is the
// dominant failure shape in this repo. The reachable state is a backpack that
// is ALREADY over its cap, which characters.inventory_slots permits (its CHECK
// is only > 0). That is what this sets up: cap 2, four owned rows.
test('a respec is refused while the backpack is over its carry limit, and changes nothing', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  const tag = `over-${Date.now()}`;
  const { characterId } = await createCharacter(pool, tag, 60, { strength: 40 });
  await pool.query('UPDATE characters SET inventory_slots = 2 WHERE id = $1', [characterId]);
  const plateId = await makeItemType(pool, `over-plate-${tag}`, { req_strength: 30 });
  const helmId = await makeItemType(pool, `over-helm-${tag}`, { slot: 'head' });
  const plate = (await pool.query('INSERT INTO player_items (character_id, item_type_id) VALUES ($1,$2) RETURNING id', [characterId, plateId])).rows[0].id;
  const helm = (await pool.query('INSERT INTO player_items (character_id, item_type_id) VALUES ($1,$2) RETURNING id', [characterId, helmId])).rows[0].id;
  await pool.query('INSERT INTO player_items (character_id, item_type_id) VALUES ($1,$2)', [characterId, helmId]);
  await pool.query('INSERT INTO player_items (character_id, item_type_id) VALUES ($1,$2)', [characterId, helmId]);
  await pool.query('INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1,$2,$3)', [characterId, 'chest', plate]);
  await pool.query('INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1,$2,$3)', [characterId, 'head', helm]);

  const itemTypes = await loadItemTypes(pool);
  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');
    result = await enforceEquipRequirements(client, characterId, itemTypes, RESET_BASE, 60);
    await client.query('ROLLBACK');
  } finally { client.release(); }

  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /carry limit/i);
  assert.deepStrictEqual(result.wouldUnequip.map((u) => u.slot), ['chest']);

  const eq = await pool.query('SELECT slot FROM player_equipment WHERE character_id = $1 ORDER BY slot', [characterId]);
  assert.deepStrictEqual(eq.rows.map((x) => x.slot), ['chest', 'head'], 'equipment is untouched');
  const owned = await pool.query('SELECT count(*)::int AS n FROM player_items WHERE character_id = $1', [characterId]);
  assert.strictEqual(owned.rows[0].n, 4, 'no gear is deleted');
});

// The refusal must be about being OVER the cap, not about being AT it. Exactly
// at capacity the unequip is still safe -- it moves nothing into the backpack.
// Without this, `usedSlots >= capacity` would pass the test above and lock
// every full-but-legal character out of respeccing.
test('a respec at EXACTLY the carry limit still proceeds', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  const tag = `atcap-${Date.now()}`;
  const { characterId } = await createCharacter(pool, tag, 60, { strength: 40 });
  const plateId = await makeItemType(pool, `atcap-plate-${tag}`, { req_strength: 30 });
  const helmId = await makeItemType(pool, `atcap-helm-${tag}`, { slot: 'head' });
  const plate = (await pool.query('INSERT INTO player_items (character_id, item_type_id) VALUES ($1,$2) RETURNING id', [characterId, plateId])).rows[0].id;
  const helm = (await pool.query('INSERT INTO player_items (character_id, item_type_id) VALUES ($1,$2) RETURNING id', [characterId, helmId])).rows[0].id;
  await pool.query('INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1,$2,$3)', [characterId, 'chest', plate]);
  await pool.query('INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1,$2,$3)', [characterId, 'head', helm]);
  // Two owned rows, cap of exactly two.
  await pool.query('UPDATE characters SET inventory_slots = 2 WHERE id = $1', [characterId]);

  const itemTypes = await loadItemTypes(pool);
  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');
    result = await enforceEquipRequirements(client, characterId, itemTypes, RESET_BASE, 60);
    await client.query('COMMIT');
  } finally { client.release(); }

  assert.strictEqual(result.ok, true, 'at capacity is not over capacity');
  assert.deepStrictEqual(result.unequipped.map((u) => u.slot), ['chest']);
});
