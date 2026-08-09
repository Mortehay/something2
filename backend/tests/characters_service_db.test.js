const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const {
  listCharacters, listPlayableClasses, createCharacter, deleteCharacter, ownedCharacter,
  CharacterError, MAX_CHARACTERS,
} = require('../src/services/characters');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

// Fixtures are zz-prefixed and removed by name in a finally block. Deleting
// the user cascades its characters and all their state, so nothing leaks.
test('characters service', { skip: !url ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());

  const classes = await listPlayableClasses(pool);
  const warrior = classes.find((c) => c.name === 'Warrior');
  const mage = classes.find((c) => c.name === 'Mage');
  const playerType = (await pool.query("SELECT id FROM entity_types WHERE name = 'Player'")).rows[0].id;

  async function withUser(username, fn) {
    await pool.query(
      "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player') ON CONFLICT (username) DO NOTHING",
      [username]);
    const id = (await pool.query('SELECT id FROM users WHERE username = $1', [username])).rows[0].id;
    try { return await fn(id); }
    finally { await pool.query('DELETE FROM users WHERE username = $1', [username]); }
  }

  await t.test('exposes exactly the three playable classes', () => {
    assert.deepEqual(classes.map((c) => c.name).sort(), ['Mage', 'Ranger', 'Warrior']);
  });

  await t.test('creates into the lowest free slot', async () => {
    await withUser('zzSvcSlots', async (userId) => {
      const a = await createCharacter(pool, userId, 'zzSvcA', warrior.id);
      const b = await createCharacter(pool, userId, 'zzSvcB', mage.id);
      assert.deepEqual([a.slot, b.slot], [1, 2]);
      await deleteCharacter(pool, userId, a.id);
      const c = await createCharacter(pool, userId, 'zzSvcC', warrior.id);
      assert.equal(c.slot, 1, 'the freed slot is reused before slot 3');
    });
  });

  await t.test('refuses a ninth character', async () => {
    await withUser('zzSvcCap', async (userId) => {
      for (let i = 1; i <= MAX_CHARACTERS; i += 1) {
        await createCharacter(pool, userId, `zzSvcCap${i}`, warrior.id);
      }
      await assert.rejects(
        () => createCharacter(pool, userId, 'zzSvcCap9', warrior.id),
        (err) => err instanceof CharacterError && err.code === 'no_free_slot');
      const list = await listCharacters(pool, userId);
      assert.equal(list.length, 8);
    });
  });

  await t.test('two concurrent creates for the last slot yield one winner', async () => {
    await withUser('zzSvcRace', async (userId) => {
      for (let i = 1; i <= MAX_CHARACTERS - 1; i += 1) {
        await createCharacter(pool, userId, `zzSvcRace${i}`, warrior.id);
      }
      // Both target slot 8. A read-then-write implementation lets both through.
      const results = await Promise.allSettled([
        createCharacter(pool, userId, 'zzSvcRaceX', warrior.id),
        createCharacter(pool, userId, 'zzSvcRaceY', warrior.id),
      ]);
      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter((r) => r.status === 'rejected');
      assert.equal(won.length, 1, 'exactly one create may succeed');
      assert.equal(lost.length, 1);
      assert.equal(lost[0].reason.code, 'no_free_slot');
      const list = await listCharacters(pool, userId);
      assert.equal(list.length, 8, 'never nine characters');
    });
  });

  await t.test('refuses a duplicate name across accounts', async () => {
    await withUser('zzSvcNameA', async (a) => {
      await withUser('zzSvcNameB', async (b) => {
        await createCharacter(pool, a, 'zzSvcShared', warrior.id);
        await assert.rejects(
          () => createCharacter(pool, b, 'ZZSVCSHARED', warrior.id),
          (err) => err instanceof CharacterError && err.code === 'name_taken');
      });
    });
  });

  await t.test('refuses a non-playable entity type', async () => {
    await withUser('zzSvcClass', async (userId) => {
      await assert.rejects(
        () => createCharacter(pool, userId, 'zzSvcBadClass', playerType),
        (err) => err instanceof CharacterError && err.code === 'not_playable');
    });
  });

  await t.test('refuses a blank or overlong name', async () => {
    await withUser('zzSvcName', async (userId) => {
      for (const bad of ['', '   ', 'z'.repeat(33)]) {
        await assert.rejects(
          () => createCharacter(pool, userId, bad, warrior.id),
          (err) => err instanceof CharacterError && err.code === 'bad_name');
      }
    });
  });

  await t.test('a character is not owned by another account', async () => {
    await withUser('zzSvcOwnA', async (a) => {
      await withUser('zzSvcOwnB', async (b) => {
        const mine = await createCharacter(pool, a, 'zzSvcOwned', warrior.id);
        assert.ok(await ownedCharacter(pool, a, mine.id));
        assert.equal(await ownedCharacter(pool, b, mine.id), null);
        assert.equal(await deleteCharacter(pool, b, mine.id), false);
        assert.ok(await ownedCharacter(pool, a, mine.id), 'the row must survive the foreign delete');
      });
    });
  });

  await t.test('ownedCharacter rejects a non-numeric id without querying', async () => {
    await withUser('zzSvcBadId', async (userId) => {
      for (const bad of ['abc', null, undefined, {}, '1; DROP TABLE characters']) {
        assert.equal(await ownedCharacter(pool, userId, bad), null);
      }
    });
  });

  await t.test('the list carries level and class name', async () => {
    await withUser('zzSvcList', async (userId) => {
      const c = await createCharacter(pool, userId, 'zzSvcListed', mage.id);
      await pool.query(
        'INSERT INTO player_progression (character_id, level) VALUES ($1, 4)', [c.id]);
      const [row] = await listCharacters(pool, userId);
      assert.equal(row.name, 'zzSvcListed');
      assert.equal(row.className, 'Mage');
      assert.equal(row.level, 4);
    });
  });

  await t.test('a character with no progression row still lists at level 1', async () => {
    await withUser('zzSvcFresh', async (userId) => {
      await createCharacter(pool, userId, 'zzSvcFreshChar', warrior.id);
      const [row] = await listCharacters(pool, userId);
      assert.equal(row.level, 1);
      assert.equal(row.lastWorldName, null, 'a character that has never played has no last world');
    });
  });

  await t.test('the list only ever shows the account its own characters', async () => {
    await withUser('zzSvcIsoA', async (a) => {
      await withUser('zzSvcIsoB', async (b) => {
        await createCharacter(pool, a, 'zzSvcIsoAChar', warrior.id);
        await createCharacter(pool, b, 'zzSvcIsoBChar', warrior.id);
        const listA = await listCharacters(pool, a);
        assert.deepEqual(listA.map((c) => c.name), ['zzSvcIsoAChar']);
      });
    });
  });
});
