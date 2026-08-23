const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { ownedCharacter } = require('../src/services/characters');

// TEST_DATABASE_URL first: an unset variable would silently point these at the
// SHARED dev database, which this suite inserts into.
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL });

test.after(async () => { await pool.end(); });

test('characters carry an inventory_slots capacity defaulting to 48', async () => {
  const col = await pool.query(
    `SELECT column_default, is_nullable, data_type
       FROM information_schema.columns
      WHERE table_name = 'characters' AND column_name = 'inventory_slots'`,
  );
  assert.strictEqual(col.rowCount, 1, 'characters.inventory_slots must exist');
  assert.strictEqual(col.rows[0].is_nullable, 'NO');
  assert.match(String(col.rows[0].column_default), /48/);
});

test('ownedCharacter resolves the capacity, and only for the owning user', async () => {
  const u = await pool.query(
    `INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`cap_test_${Date.now()}`],
  );
  const userId = u.rows[0].id;
  const et = await pool.query(`SELECT id FROM entity_types WHERE is_playable = true LIMIT 1`);
  const c = await pool.query(
    `INSERT INTO characters (user_id, name, entity_type_id, slot) VALUES ($1,'CapTest',$2,1) RETURNING id`,
    [userId, et.rows[0].id],
  );
  const characterId = c.rows[0].id;
  try {
    const mine = await ownedCharacter(pool, userId, characterId);
    assert.strictEqual(mine.inventorySlots, 48);
    assert.strictEqual(await ownedCharacter(pool, userId + 999999, characterId), null);
  } finally {
    await pool.query('DELETE FROM characters WHERE id = $1', [characterId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  }
});

test('the capacity column refuses a non-positive value', async () => {
  const u = await pool.query(
    `INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`cap_chk_${Date.now()}`],
  );
  const userId = u.rows[0].id;
  const et = await pool.query(`SELECT id FROM entity_types WHERE is_playable = true LIMIT 1`);
  try {
    await assert.rejects(
      pool.query(
        `INSERT INTO characters (user_id, name, entity_type_id, slot, inventory_slots)
         VALUES ($1,'CapZero',$2,2,0)`,
        [userId, et.rows[0].id],
      ),
      // The CONSTRAINT name, not a bare column mention: "column
      // inventory_slots does not exist" also matches /inventory_slots/, so a
      // looser pattern passes green on a database where the migration never
      // ran — the exact vacuous shape this suite exists to avoid.
      /characters_inventory_slots_positive/,
    );
  } finally {
    await pool.query('DELETE FROM characters WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  }
});
