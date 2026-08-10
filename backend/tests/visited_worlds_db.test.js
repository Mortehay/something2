const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { recordVisit, listVisited } = require('../src/services/visitedWorlds');
const { createCharacter, listPlayableClasses } = require('../src/services/characters');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

test('both entry paths record a visit', () => {
  // A source-text guard, and the most important assertion in this file. A
  // visit recorded on join but not on transition passes every behavioural test
  // written against join, and is dead the moment a player walks through a
  // portal. That is precisely how P2a shipped an inert creature-behaviour
  // loader: wired into one of two paths, green the whole way.
  const src = fs.readFileSync(path.join(__dirname, '../src/authority/server.js'), 'utf8');
  const calls = src.match(/recordVisit\(/g) || [];
  assert.ok(calls.length >= 3,
    `expected recordVisit at the join call site and BOTH transition call sites, found ${calls.length}`);

  const joinStart = src.indexOf('async join(ws, msg)');
  assert.ok(joinStart !== -1, 'could not locate the join handler');
  const joinEnd = src.indexOf('\n    },', joinStart);
  assert.match(src.slice(joinStart, joinEnd), /recordVisit\(/, 'join must record a visit');

  // Every place the server pushes a transition frame must record the
  // destination. Located by the frame itself rather than by line number.
  const transitions = [...src.matchAll(/type: 'transition'/g)].map((m) => m.index);
  assert.ok(transitions.length > 0, 'could not locate any transition frame');
  for (const idx of transitions) {
    const after = src.slice(idx, idx + 600);
    assert.match(after, /recordVisit\(/,
      'every transition push must record the destination as visited');
  }
});

test('character_visited_worlds', { skip: !url ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());

  const classes = await listPlayableClasses(pool);
  const warrior = classes.find((c) => c.name === 'Warrior');
  const worlds = (await pool.query('SELECT id FROM worlds ORDER BY name LIMIT 2')).rows;

  async function withUser(username, fn) {
    await pool.query(
      "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player') ON CONFLICT (username) DO NOTHING",
      [username]);
    const id = (await pool.query('SELECT id FROM users WHERE username = $1', [username])).rows[0].id;
    try { return await fn(id); }
    finally { await pool.query('DELETE FROM users WHERE username = $1', [username]); }
  }

  await t.test('a fresh character has visited nothing', async () => {
    await withUser('zzVisitFresh', async (userId) => {
      const c = await createCharacter(pool, userId, 'zzVisitFreshChar', warrior.id);
      assert.deepEqual(await listVisited(pool, c.id), []);
    });
  });

  await t.test('recording is idempotent and keeps the first timestamp', async () => {
    await withUser('zzVisitIdem', async (userId) => {
      const c = await createCharacter(pool, userId, 'zzVisitIdemChar', warrior.id);
      await recordVisit(pool, c.id, worlds[0].id);
      const first = (await pool.query(
        'SELECT first_seen_at FROM character_visited_worlds WHERE character_id = $1', [c.id]
      )).rows[0].first_seen_at;
      await recordVisit(pool, c.id, worlds[0].id);
      const rows = await pool.query(
        'SELECT first_seen_at FROM character_visited_worlds WHERE character_id = $1', [c.id]);
      assert.equal(rows.rows.length, 1);
      assert.deepEqual(rows.rows[0].first_seen_at, first, 'a re-visit must not move first_seen_at');
    });
  });

  await t.test('visits are per character, not per account', async () => {
    await withUser('zzVisitPerChar', async (userId) => {
      const a = await createCharacter(pool, userId, 'zzVisitPerCharA', warrior.id);
      const b = await createCharacter(pool, userId, 'zzVisitPerCharB', warrior.id);
      await recordVisit(pool, a.id, worlds[0].id);
      assert.deepEqual(await listVisited(pool, a.id), [{ worldId: worlds[0].id }]);
      assert.deepEqual(await listVisited(pool, b.id), [],
        "one character's exploration must not reveal the map to its sibling");
    });
  });

  await t.test('deleting the character cascades its visits', async () => {
    let captured;
    await withUser('zzVisitCascade', async (userId) => {
      const c = await createCharacter(pool, userId, 'zzVisitCascadeChar', warrior.id);
      captured = c.id;
      await recordVisit(pool, c.id, worlds[0].id);
    });
    const r = await pool.query(
      'SELECT count(*)::int AS n FROM character_visited_worlds WHERE character_id = $1', [captured]);
    assert.equal(r.rows[0].n, 0);
  });
});
