// SOMET-737: the wiring. village_pve_only.test.js sets world.villages by hand, so
// it stays green if the server never hands a world its villages. Here the
// authority boots against the real database, two real characters join the seeded
// entry world over websockets, and the only way anything happens is the same
// `attack` and `charm` frames a browser sends.
//
// Each refusal is measured against the same action landing outside the village:
// a silent "nothing happened" proves nothing unless it can also happen.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const WebSocket = require('ws');

const { attachAuthority } = require('../src/authority/server.js');
const { hasLineOfSight } = require('../src/authority/weapons.js');
const { createCharacter } = require('../src/services/characters.js');
const { entryWorldForJoin } = require('./helpers/entryWorld.js');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const SECRET = 'somet737-test-secret';
const TAG = `s737_${process.pid}_${Date.now().toString(36)}`;
const SEPARATION = 40;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nextMsg(ws, type, ms = 15000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
    ws.on('message', function onMsg(data) {
      const m = JSON.parse(data);
      if (m.type === type) { clearTimeout(to); ws.off('message', onMsg); resolve(m); }
    });
  });
}

// Puts the pair side by side with a clear line between them, first spot that
// meets `wanted`. The positions are written straight onto the server's own player
// objects: nothing here is testing movement.
function placePair(world, a, b, spots) {
  for (const [x, y] of spots) {
    a.x = x; a.y = y; b.x = x + SEPARATION; b.y = y;
    const ax = a.x + a.width / 2, ay = a.y + a.height / 2;
    const bx = b.x + b.width / 2, by = b.y + b.height / 2;
    if (world.map.isWalkable(ax, ay) && world.map.isWalkable(bx, by) && hasLineOfSight(world.map, ax, ay, bx, by)) {
      return true;
    }
  }
  return false;
}

test('the live server keeps PvP out of a village and allows it outside', { skip: !DB_URL ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 3000, max: 6 });
  const server = http.createServer();
  const handle = attachAuthority(server, pool, { jwtSecret: SECRET, tickMs: 50 });
  await new Promise((r) => server.listen(0, r));
  const url = `ws://127.0.0.1:${server.address().port}/authority`;

  const sockets = [];
  const userIds = [];
  t.after(async () => {
    for (const ws of sockets) { try { ws.terminate(); } catch { /* already gone */ } }
    handle.close();
    if (server.listening) await new Promise((r) => server.close(r));
    if (userIds.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [userIds]).catch(() => {});
    await pool.end().catch(() => {});
  });

  const { id: worldId } = await entryWorldForJoin(pool);
  const druid = await pool.query("SELECT id FROM entity_types WHERE name = 'Druid'");
  assert.equal(druid.rows.length, 1, 'the database needs a Druid class');

  async function join(label) {
    const u = await pool.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id", [`${TAG}_${label}`]);
    const userId = u.rows[0].id;
    userIds.push(userId);
    const character = await createCharacter(pool, userId, `${TAG}${label}`, druid.rows[0].id);
    const token = jwt.sign({ user_id: userId, tv: 1 }, SECRET, { algorithm: 'HS256' });
    const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
    sockets.push(ws);
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    ws.send(JSON.stringify({ type: 'join', character_id: character.id, world_id: worldId }));
    await nextMsg(ws, 'joined');
    return { ws, id: String(userId) };
  }

  const attacker = await join('a');
  const victim = await join('b');
  const entry = handle.worlds.get(worldId);
  const { world } = entry;
  const a = world.getPlayer(attacker.id);
  const b = world.getPlayer(victim.id);

  assert.ok(entry.villages.length > 0, 'the entry world needs a village, or nothing below means anything');
  assert.strictEqual(world.villages, entry.villages, 'the world was handed the villages the server loaded');

  const swing = async () => {
    for (let i = 0; i < 12; i++) {
      attacker.ws.send(JSON.stringify({ type: 'attack', ax: 1, ay: 0 }));
      await sleep(150);
    }
  };
  const damageFromAttacker = () => (b._playerDamage && b._playerDamage.get(attacker.id)) || 0;
  let charmedFrames = 0;
  attacker.ws.on('message', (data) => { if (JSON.parse(data).type === 'charmed') charmedFrames += 1; });

  // Inside, from the village's own spawn outward.
  const v = entry.villages[0];
  const insideSpots = [];
  for (let row = v.minRow + 1; row < v.minRow + v.height - 1; row++) {
    for (let col = v.minCol + 1; col < v.minCol + v.width - 1; col++) insideSpots.push([col * 100 + 10, row * 100 + 10]);
  }
  assert.ok(placePair(world, a, b, insideSpots), 'no clear spot inside the village');
  assert.equal(world.inVillage(a) && world.inVillage(b), true, 'sanity: both stand inside');

  await swing();
  assert.equal(damageFromAttacker(), 0, 'a player was hurt by another player inside a village');
  attacker.ws.send(JSON.stringify({ type: 'charm', player_id: victim.id }));
  await sleep(500);
  assert.equal(charmedFrames, 0, 'a player was pacified inside a village');

  // Outside, the same two characters and the same frames.
  const outsideSpots = [];
  for (let dr = -8; dr <= 8; dr++) {
    for (let dc = -8; dc <= 8; dc++) {
      const row = v.minRow + v.height + dr, col = v.minCol + v.width + dc;
      if (row < 1 || col < 1) continue;
      const point = { x: col * 100 + 10, y: row * 100 + 10, width: a.width, height: a.height };
      const twin = { ...point, x: point.x + SEPARATION };
      if (!world.inVillage(point) && !world.inVillage(twin)) outsideSpots.push([point.x, point.y]);
    }
  }
  assert.ok(placePair(world, a, b, outsideSpots), 'no clear spot outside the village');
  assert.equal(world.inVillage(a) || world.inVillage(b), false, 'sanity: both stand outside');

  await swing();
  assert.ok(damageFromAttacker() > 0, 'the same swings must land outside, or the check above proved nothing');
  attacker.ws.send(JSON.stringify({ type: 'charm', player_id: victim.id }));
  const deadline = Date.now() + 5000;
  while (charmedFrames === 0 && Date.now() < deadline) await sleep(25);
  assert.equal(charmedFrames, 1, 'the same charm must land outside, or the check above proved nothing');
});
