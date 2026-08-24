const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

test('charm columns and the summon roster', { skip: !url ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });

  // A throwaway user + character to hang rows off. Cleaned up by id, so nothing
  // pre-existing is touched -- this file never issues an unscoped DELETE.
  //
  // HOOK ORDER MATTERS: the cleanup DELETE is registered BEFORE pool.end().
  // node:test runs `after` hooks in registration order, so ending the pool
  // first would silently no-op every cleanup after it and leak rows into
  // unrelated files.
  const stamp = Date.now();
  const u = await pool.query(
    `INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`charmtest_${stamp}`]);
  const userId = u.rows[0].id;
  t.after(() => pool.query('DELETE FROM users WHERE id = $1', [userId]));

  const ch = await pool.query(
    `INSERT INTO characters (user_id, slot, name, entity_type_id)
     SELECT $1, 1, $2, id FROM entity_types WHERE name = 'Druid' RETURNING id`,
    [userId, `charmtest_${stamp}`]);
  assert.equal(ch.rows.length, 1, 'there must be a Druid entity_type to hang a character off');
  const characterId = ch.rows[0].id;

  // One creature row of our OWN, in a world of our own, rather than borrowing a
  // seeded one: mutating shared world state from a test is how the entry world
  // gets wiped. Removed with the world in t.after.
  const wr = await pool.query(
    `INSERT INTO worlds (name, width, height, seed) VALUES ($1, 20, 20, 1) RETURNING id`,
    [`charmtest_${stamp}`]);
  const worldId = wr.rows[0].id;
  t.after(() => pool.query('DELETE FROM worlds WHERE id = $1', [worldId]));
  const cr = await pool.query(
    `INSERT INTO world_creatures (world_id, type, x, y, hp, level)
     VALUES ($1, 'Wolf', 100, 100, 40, 6) RETURNING id`, [worldId]);
  const creatureId = cr.rows[0].id;

  // LAST, after every cleanup above. node:test runs `after` hooks in
  // registration order, so a pool.end() registered earlier silently no-ops
  // every DELETE that follows it and leaks rows into unrelated files. That is
  // not hypothetical: this file did exactly that on its first run, and the
  // world/creature cleanup below is what noticed.
  t.after(() => pool.end());

  await t.test('an owner with no expiry is rejected as a permanent pet', async () => {
    await assert.rejects(
      () => pool.query(
        'UPDATE world_creatures SET charmed_by_character_id = $1 WHERE id = $2',
        [characterId, creatureId]),
      /world_creatures_charm_pair_check/);
  });

  // The deliberately-permitted other half. An orphaned expiry is inert (every
  // read keys on the owner column) and permitting it is what lets ON DELETE SET
  // NULL actually release a dead character's pets -- see the migration.
  await t.test('an expiry with no owner is permitted, because SET NULL produces one', async () => {
    await pool.query(
      `UPDATE world_creatures SET charm_expires_at = now() WHERE id = $1`, [creatureId]);
    await pool.query(
      `UPDATE world_creatures SET charm_expires_at = NULL WHERE id = $1`, [creatureId]);
  });

  await t.test('the pair together is accepted', async () => {
    await pool.query(
      `UPDATE world_creatures
          SET charmed_by_character_id = $1, charm_expires_at = now() + interval '2 minutes'
        WHERE id = $2`, [characterId, creatureId]);
    const r = await pool.query(
      'SELECT charmed_by_character_id, charm_expires_at FROM world_creatures WHERE id = $1',
      [creatureId]);
    assert.equal(r.rows[0].charmed_by_character_id, characterId);
    assert.ok(r.rows[0].charm_expires_at > new Date());
  });

  await t.test('deleting a character releases its pets rather than deleting them', async () => {
    const tmp = await pool.query(
      `INSERT INTO characters (user_id, slot, name, entity_type_id)
       SELECT $1, 2, $2, id FROM entity_types WHERE name = 'Druid' RETURNING id`,
      [userId, `charmtest2_${stamp}`]);
    await pool.query(
      `UPDATE world_creatures
          SET charmed_by_character_id = $1, charm_expires_at = now() + interval '1 minute'
        WHERE id = $2`, [tmp.rows[0].id, creatureId]);
    await pool.query('DELETE FROM characters WHERE id = $1', [tmp.rows[0].id]);
    const after = await pool.query(
      'SELECT charmed_by_character_id, charm_expires_at FROM world_creatures WHERE id = $1',
      [creatureId]);
    assert.equal(after.rows.length, 1, 'the creature must survive its charmer');
    assert.equal(after.rows[0].charmed_by_character_id, null,
      'the pet is released, not deleted, and the DELETE is not blocked by the pair check');
    // charm_expires_at is deliberately NOT asserted null: SET NULL clears the
    // referencing column only, and the constraint permits the leftover. What
    // matters is that no loader can see this row as charmed, which is the
    // assertion below.
    const live = await pool.query(
      'SELECT count(*)::int AS n FROM world_creatures WHERE id = $1 AND charmed_by_character_id IS NOT NULL',
      [creatureId]);
    assert.equal(live.rows[0].n, 0, 'and no live-pet query can still see it as charmed');
    await pool.query(
      'UPDATE world_creatures SET charm_expires_at = NULL WHERE id = $1', [creatureId]);
  });

  await t.test('an owner with no expiry cannot be written even by an UPDATE that clears only the expiry', async () => {
    await pool.query(
      `UPDATE world_creatures
          SET charmed_by_character_id = $1, charm_expires_at = now() + interval '1 minute'
        WHERE id = $2`, [characterId, creatureId]);
    await assert.rejects(
      () => pool.query(
        'UPDATE world_creatures SET charm_expires_at = NULL WHERE id = $1', [creatureId]),
      /world_creatures_charm_pair_check/,
      'a permanent pet stays unrepresentable from every direction');
    await pool.query(
      `UPDATE world_creatures SET charmed_by_character_id = NULL, charm_expires_at = NULL
        WHERE id = $1`, [creatureId]);
  });

  await t.test('the roster is a set, so re-charming the same creature adds no row', async () => {
    for (let i = 0; i < 2; i++) {
      await pool.query(
        `INSERT INTO character_summons (character_id, creature_type, level) VALUES ($1, 'Wolf', 6)
         ON CONFLICT (character_id, creature_type, level) DO NOTHING`, [characterId]);
    }
    const r = await pool.query(
      'SELECT count(*)::int AS n FROM character_summons WHERE character_id = $1', [characterId]);
    assert.equal(r.rows[0].n, 1);
  });

  await t.test('a DIFFERENT level of the same creature is a separate roster entry', async () => {
    await pool.query(
      `INSERT INTO character_summons (character_id, creature_type, level) VALUES ($1, 'Wolf', 9)
       ON CONFLICT (character_id, creature_type, level) DO NOTHING`, [characterId]);
    const r = await pool.query(
      'SELECT count(*)::int AS n FROM character_summons WHERE character_id = $1', [characterId]);
    assert.equal(r.rows[0].n, 2);
  });

  await t.test('a level below 1 is unrepresentable in the roster', async () => {
    await assert.rejects(
      () => pool.query(
        `INSERT INTO character_summons (character_id, creature_type, level) VALUES ($1, 'Wolf', 0)`,
        [characterId]),
      /character_summons_level_check/);
  });

  await t.test('deleting the character takes its roster with it', async () => {
    const before = await pool.query(
      'SELECT count(*)::int AS n FROM character_summons WHERE character_id = $1', [characterId]);
    assert.equal(before.rows[0].n, 2);
    await pool.query('DELETE FROM characters WHERE id = $1', [characterId]);
    const after = await pool.query(
      'SELECT count(*)::int AS n FROM character_summons WHERE character_id = $1', [characterId]);
    assert.equal(after.rows[0].n, 0);
  });
});
