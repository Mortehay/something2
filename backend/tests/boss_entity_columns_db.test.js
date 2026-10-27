// SOMET-603 (S1): the boss columns and their constraints, on a real schema.
// Every write is inside a transaction that is always rolled back.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

const INSERT = `INSERT INTO entity_types
  (name, color, is_creature, attack_element, boss_tier, element, hitbox_size, xp_reward, base_damage, auras)
  VALUES ($1, '#fff', true, $2, $3, $4, $5, $6, $7, $8::jsonb)`;

async function expectCode(client, params, code, label) {
  await client.query('SAVEPOINT s');
  try {
    await client.query(INSERT, params);
    assert.fail(`${label}: expected SQLSTATE ${code}, the insert succeeded`);
  } catch (err) {
    if (err.code === 'ERR_ASSERTION') throw err;
    assert.equal(err.code, code, `${label}: ${err.message}`);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT s');
  }
}

test('entity_types carries the boss columns with their constraints', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The happy path, including an arcane attack (Abyssor) and an aura list.
    await client.query(INSERT,
      ['zzBossCols ok', 'arcane', 'world', 'arcane', 96, 3500, 42.5, '["zz_aura"]']);
    const r = await client.query(
      `SELECT boss_tier, element, hitbox_size, xp_reward, base_damage, auras, attack_element
         FROM entity_types WHERE name = 'zzBossCols ok'`);
    assert.deepEqual(r.rows[0], {
      boss_tier: 'world', element: 'arcane', hitbox_size: 96, xp_reward: 3500,
      base_damage: 42.5, auras: ['zz_aura'], attack_element: 'arcane',
    });
    // NULL everywhere is an ordinary creature and must be accepted.
    await client.query(INSERT, ['zzBossCols null', 'physical', null, null, null, null, null, null]);

    await expectCode(client, ['zzBC tier', 'physical', 'raid', null, null, null, null, null], '23514', 'unknown boss_tier');
    await expectCode(client, ['zzBC elem', 'physical', null, 'plasma', null, null, null, null], '23503', 'unknown element');
    await expectCode(client, ['zzBC hb0', 'physical', null, null, 0, null, null, null], '23514', 'hitbox 0');
    await expectCode(client, ['zzBC hb401', 'physical', null, null, 401, null, null, null], '23514', 'hitbox 401');
    await expectCode(client, ['zzBC xp', 'physical', null, null, null, -1, null, null], '23514', 'negative xp');
    await expectCode(client, ['zzBC dmg', 'physical', null, null, null, null, -1, null], '23514', 'negative damage');
    await expectCode(client, ['zzBC holy', 'holy', null, null, null, null, null, null], '23514', 'unknown attack_element');
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
