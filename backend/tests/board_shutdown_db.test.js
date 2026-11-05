// SOMET-720. A restart must not lose the last minute of play statistics. The real backend
// process on the scratch database, a real player in a world, and a real SIGTERM with the 60 s
// flush nowhere near: the row can only have come from the signal handler.
//
// In a database of its own. Booting src/index.js marks every running seed_export_runs row failed,
// across the whole database, which would poison seed_sync files running in parallel.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const WebSocket = require('ws');
const { createCharacter } = require('../src/services/characters.js');
const { withFixtureWorld } = require('./helpers/fixtureWorld');
const { withDatabase, databaseName, recreate, drop, migrate, seed } = require('../scripts/testdb.js');

const BASE_URL = process.env.TEST_DATABASE_URL;
const TAG = `s720s_${process.pid}_${Date.now().toString(36)}`;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

test('SIGTERM writes the unflushed statistics, then the process exits', { skip: BASE_URL ? false : 'no TEST_DATABASE_URL', timeout: 10 * 60 * 1000 }, async (t) => {
  assert.notEqual(databaseName(BASE_URL), 'game_db', 'TEST_DATABASE_URL points at the dev database; refusing');
  const name = `game_test_bs_${process.pid}`;
  const target = { name, url: withDatabase(BASE_URL, name), adminUrl: withDatabase(BASE_URL, 'postgres') };
  const DB_URL = target.url;
  let pool = null;
  let child = null;
  let ws = null;
  const userIds = [];
  // The pool ends before the drop: DROP ... FORCE would otherwise kill its idle clients.
  t.after(async () => {
    if (ws) ws.terminate();
    if (child && child.exitCode === null) child.kill('SIGKILL');
    if (pool) await pool.end().catch(() => {});
    await drop(target).catch((e) => console.error(`could not drop ${name}: ${e.message}`));
  });
  await recreate(target);
  migrate(target);
  seed(target);
  pool = new Pool({ connectionString: DB_URL, max: 3 });
  pool.on('error', () => {});
  await withFixtureWorld(pool, async (worldId) => {
    const u = await pool.query("INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id, token_version", [`${TAG}u`]);
    userIds.push(u.rows[0].id);
    const cls = await pool.query("SELECT id FROM entity_types WHERE name = 'Warrior'");
    const character = await createCharacter(pool, u.rows[0].id, `${TAG}c`, cls.rows[0].id);

    const secret = crypto.randomBytes(32).toString('hex');
    const port = await freePort();
    child = spawn(process.execPath, ['src/index.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DATABASE_URL: DB_URL, JWT_SECRET: secret, PORT: String(port), MIGRATE_ON_BOOT: '0', BOARD_INTERNAL_ENABLED: '0', NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    const end = Date.now() + 20000;
    while (!/Authority WS attached/.test(log)) {
      assert.ok(Date.now() < end && child.exitCode === null, `the backend did not boot:\n${log.slice(-400)}`);
      await new Promise((r) => { setTimeout(r, 50); });
    }

    const token = jwt.sign({ user_id: u.rows[0].id, tv: u.rows[0].token_version }, secret, { algorithm: 'HS256' });
    ws = new WebSocket(`ws://127.0.0.1:${port}/authority?token=${encodeURIComponent(token)}`);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const joined = new Promise((resolve, reject) => {
      ws.on('message', (d) => {
        const m = JSON.parse(d);
        if (m.type === 'joined') resolve();
        if (m.type === 'error') reject(new Error(m.message));
      });
    });
    ws.send(JSON.stringify({ type: 'join', world_id: worldId, character_id: character.id }));
    await joined;
    ws.on('error', () => {});

    const before = await pool.query('SELECT 1 FROM player_game_stats WHERE character_id = $1', [character.id]);
    assert.equal(before.rowCount, 0, 'nothing is written while playing (the flush is 60 s away)');

    const exited = new Promise((resolve) => { child.once('exit', (code, sig) => resolve({ code, sig })); });
    child.kill('SIGTERM');
    assert.deepEqual(await exited, { code: 0, sig: null });
    const row = await pool.query('SELECT sessions, last_seen_at FROM player_game_stats WHERE character_id = $1', [character.id]);
    assert.equal(row.rowCount, 1, 'the signal wrote it');
    assert.equal(Number(row.rows[0].sessions), 1);
    assert.ok(row.rows[0].last_seen_at);
  }, { prefix: `zz${TAG}` });
});
