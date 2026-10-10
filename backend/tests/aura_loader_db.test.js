// backend/tests/aura_loader_db.test.js
// The SELECT guard above checks TEXT. This proves the composed SQL parses and
// that the lateral resolves a real Champion's binding. Read-only, scratch DB.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { CREATURE_JOINED_SELECT } = require('../src/authority/server.js');
const { AURAS_LATERAL } = require('../src/services/auraEffects.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL' : false;

test('aura loader against a real database', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url, max: 1 });
  t.after(() => pool.end());
  await t.test('the composed creature SELECT parses and runs', async () => {
    const r = await pool.query(`${CREATURE_JOINED_SELECT} WHERE false`);
    const cols = r.fields.map((f) => f.name);
    assert.ok(cols.includes('aura_names') && cols.includes('aura_defs'), cols.join(','));
  });
  await t.test('a seeded Champion resolves pack_leader with its real radius', async () => {
    const r = await pool.query(
      `SELECT au.aura_defs FROM entity_types et ${AURAS_LATERAL} WHERE et.name = 'Beast Champion'`);
    assert.strictEqual(r.rows[0].aura_defs.length, 1);
    assert.strictEqual(r.rows[0].aura_defs[0].name, 'pack_leader');
    assert.strictEqual(r.rows[0].aura_defs[0].radius, 260);
  });
  await t.test('an unbound creature resolves to []', async () => {
    const r = await pool.query(`SELECT au.aura_defs FROM entity_types et ${AURAS_LATERAL} WHERE et.name = 'Wolf'`);
    assert.deepStrictEqual(r.rows[0].aura_defs, []);
  });
});
