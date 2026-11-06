// SOMET-676: a shutdown inside the flush window keeps a player's position, a bind
// and a dirty creature. The floors are set far above the test's length so NOTHING
// else could have written them: if the row changed, drain() did it.
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
const SECRET = 'somet676-test-secret';
const TAG = `s676_${process.pid}_${Date.now().toString(36)}`;

function nextOf(ws, type, ms = 15000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
    ws.on('message', function onMsg(data) {
      const m = JSON.parse(data);
      if (m.type === type || m.type === 'error') { clearTimeout(to); ws.off('message', onMsg); resolve(m); }
    });
  });
}

test('drain() persists position, bind and dirty creatures that no timer had written',
  { skip: !DB_URL ? 'no database URL' : false }, async (t) => {
    const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 3000, max: 6 });
    const server = http.createServer();
    const HOUR = 3600 * 1000;
    const handle = attachAuthority(server, pool, {
      jwtSecret: SECRET, tickMs: 50, flushMs: HOUR, creatureFlushMs: HOUR, bindWriteMinMs: HOUR,
    });
    await new Promise((r) => server.listen(0, r));
    const url = `ws://127.0.0.1:${server.address().port}/authority`;
    const sockets = [];
    const userIds = [];
    t.after(async () => {
      for (const ws of sockets) { try { ws.terminate(); } catch { /* gone */ } }
      handle.close();
      if (server.listening) await new Promise((r) => server.close(r));
      if (userIds.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [userIds]).catch(() => {});
      await pool.end().catch(() => {});
    });

    const { id: worldId } = await entryWorldForJoin(pool);
    const cls = await pool.query("SELECT id FROM entity_types WHERE name = 'Warrior'");
    const u = await pool.query("INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id", [`${TAG}_a`]);
    const userId = u.rows[0].id;
    userIds.push(userId);
    const character = await createCharacter(pool, userId, `${TAG}a`, cls.rows[0].id);

    const token = jwt.sign({ user_id: userId, tv: 1 }, SECRET, { algorithm: 'HS256' });
    const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
    sockets.push(ws);
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    ws.send(JSON.stringify({ type: 'join', character_id: character.id, world_id: worldId }));
    const joined = await nextOf(ws, 'joined');
    assert.equal(joined.type, 'joined', joined.message);

    const entry = handle.worlds.get(worldId);
    const p = entry.world.getPlayer(String(userId));
    assert.ok(p, 'the player is live in the world');

    // Move the player, dirty a bind and a creature, all in memory only.
    const NEW_X = 123.5; const NEW_Y = 456.5;
    p.x = NEW_X; p.y = NEW_Y;
    p.bind = { worldId, x: 77, y: 88 };
    p._bindDirty = true;
    p._bindWroteAt = Date.now(); // inside the write floor: the tick path will not write it
    // A persisted creature, injected into the live sim the way a mid-session spawn is.
    const ct = await pool.query("SELECT name FROM entity_types WHERE category = 'creature' ORDER BY name LIMIT 1")
      .catch(() => ({ rows: [] }));
    const CREATURE_TYPE = ct.rows[0] ? ct.rows[0].name : 'Goblin';
    const ins = await pool.query(
      `INSERT INTO world_creatures (world_id, type, x, y, hp, level, damage)
       VALUES ($1, $2, $3, $4, 40, 3, 4) RETURNING id`,
      [worldId, CREATURE_TYPE, p.x + 60, p.y]);
    const creatureId = ins.rows[0].id;
    t.after(() => pool.query('DELETE FROM world_creatures WHERE id = $1', [creatureId]).catch(() => {}));
    entry.world.creatures.addCreatures([{
      id: creatureId, type: CREATURE_TYPE, x: p.x + 60, y: p.y, hp: 40,
      level: 3, damage: 4, facing: 'S', color: '#c00', faction: 'hostile',
    }]);
    const real = entry.world.creatures.creatures.get(creatureId);
    assert.ok(real, 'the creature is in the live sim');
    real.x += 11; real.y += 13; real.dirty = true;
    const creatureBefore = { id: creatureId, x: real.x, y: real.y };

    const before = await pool.query('SELECT x, y FROM world_players WHERE character_id = $1', [character.id]);
    assert.notDeepEqual([before.rows[0].x, before.rows[0].y], [NEW_X, NEW_Y], 'the DB does not have it yet');

    const stats = await handle.drain();
    assert.equal(stats.failed, 0);
    assert.ok(stats.players >= 1);

    await t.test('position', async () => {
      const r = await pool.query('SELECT x, y FROM world_players WHERE character_id = $1', [character.id]);
      assert.deepEqual([Number(r.rows[0].x), Number(r.rows[0].y)], [NEW_X, NEW_Y]);
    });
    await t.test('bind (forced past its write floor)', async () => {
      const r = await pool.query('SELECT world_id, x, y FROM player_binds WHERE character_id = $1', [character.id]);
      assert.equal(r.rowCount, 1);
      assert.deepEqual([Number(r.rows[0].x), Number(r.rows[0].y)], [77, 88]);
    });
    await t.test('dirty creature', async () => {
      const r = await pool.query('SELECT x, y FROM world_creatures WHERE id = $1', [creatureBefore.id]);
      assert.deepEqual([Number(r.rows[0].x), Number(r.rows[0].y)], [creatureBefore.x, creatureBefore.y]);
    });
    await t.test('afterwards: no new sockets, registry cleared, second drain is the same promise', async () => {
      assert.equal(handle.worlds.size, 0);
      assert.equal(handle.drain(), handle.drain());
      await assert.rejects(new Promise((resolve, reject) => {
        const w2 = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
        sockets.push(w2);
        w2.on('open', resolve); w2.on('error', reject);
      }));
    });
  });
