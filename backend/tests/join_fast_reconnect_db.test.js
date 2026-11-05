// SOMET-739: a character who has just joined a world can always come back to it.
//
// A join writes the visit row, which closes the first-join allowance, and used to
// leave world_players empty until the first flush or the disconnect's own save.
// Rejoining inside that window matched no rule in joinPolicy and was refused with
// "you cannot travel there". The close's save is held back here so that window is
// open for as long as the test needs, instead of being a race it wins sometimes.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const WebSocket = require('ws');

const { attachAuthority } = require('../src/authority/server.js');
const { createCharacter } = require('../src/services/characters.js');
const { entryWorldForJoin } = require('./helpers/entryWorld.js');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const SECRET = 'somet739-test-secret';
const TAG = `s739_${process.pid}_${Date.now().toString(36)}`;

function nextOf(ws, type, ms = 15000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
    ws.on('message', function onMsg(data) {
      const m = JSON.parse(data);
      if (m.type === type || m.type === 'error') {
        clearTimeout(to); ws.off('message', onMsg); resolve(m);
      }
    });
  });
}

test('a rejoin faster than the disconnect\'s save is let back in', { skip: !DB_URL ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 3000, max: 6 });
  const server = http.createServer();
  const handle = attachAuthority(server, pool, { jwtSecret: SECRET, tickMs: 50 });
  await new Promise((r) => server.listen(0, r));
  const url = `ws://127.0.0.1:${server.address().port}/authority`;

  const sockets = [];
  const userIds = [];
  const otherWorlds = [];
  const realQuery = pool.query.bind(pool);
  t.after(async () => {
    pool.query = realQuery;
    for (const ws of sockets) { try { ws.terminate(); } catch { /* already gone */ } }
    handle.close();
    if (server.listening) await new Promise((r) => server.close(r));
    if (userIds.length) await realQuery('DELETE FROM users WHERE id = ANY($1::int[])', [userIds]).catch(() => {});
    if (otherWorlds.length) await realQuery('DELETE FROM worlds WHERE id = ANY($1::uuid[])', [otherWorlds]).catch(() => {});
    await pool.end().catch(() => {});
  });

  const { id: worldId } = await entryWorldForJoin(pool);
  const cls = await pool.query("SELECT id FROM entity_types WHERE name = 'Warrior'");
  assert.equal(cls.rowCount, 1, 'the database needs a Warrior');

  const u = await pool.query(
    "INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id", [`${TAG}_a`]);
  const userId = u.rows[0].id;
  userIds.push(userId);
  const character = await createCharacter(pool, userId, `${TAG}a`, cls.rows[0].id);

  async function join(world) {
    const token = jwt.sign({ user_id: userId, tv: 1 }, SECRET, { algorithm: 'HS256' });
    const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
    sockets.push(ws);
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    ws.send(JSON.stringify({ type: 'join', character_id: character.id, world_id: world }));
    return { ws, reply: await nextOf(ws, 'joined') };
  }

  const first = await join(worldId);
  assert.equal(first.reply.type, 'joined', first.reply.message);

  await t.test('the join itself records where the character is', async () => {
    const r = await pool.query(
      'SELECT world_id FROM world_players WHERE character_id = $1', [character.id]);
    assert.deepEqual(r.rows.map((row) => row.world_id), [worldId]);
  });

  await t.test('an immediate rejoin succeeds while the old connection is still saving', async () => {
    // Hold back only the save, by rows it writes: what keeps the policy's facts
    // reading the state a slow disconnect would leave them in.
    let held = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    pool.query = (...args) => {
      const text = typeof args[0] === 'string' ? args[0] : args[0].text;
      if (/INSERT INTO world_players/.test(text) && held === 0) {
        held += 1;
        return gate.then(() => realQuery(...args));
      }
      return realQuery(...args);
    };

    first.ws.terminate();
    const again = await join(worldId);
    release();
    assert.equal(again.reply.type, 'joined', again.reply.message);
    again.ws.terminate();
    pool.query = realQuery;
  });

  await t.test('the policy still refuses a world the character has no right to enter', async () => {
    const w = await pool.query(
      `INSERT INTO worlds (name, width, height, chunk_size, seed)
       VALUES ($1, 64, 64, 64, 1) RETURNING id`, [`${TAG}_elsewhere`]);
    otherWorlds.push(w.rows[0].id);
    const elsewhere = await join(w.rows[0].id);
    assert.equal(elsewhere.reply.type, 'error');
    assert.equal(elsewhere.reply.message, 'you cannot travel there');
  });
});
