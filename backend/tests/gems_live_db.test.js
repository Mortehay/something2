// Skill gems over a REAL websocket, against the real authority and the real database.
//
// This file exists because the first release of server-owned gems shipped a client that
// sent `buyGem` to a server process that had not been restarted: the old server ignores
// an unrecognised message type in silence, so the Buy button did exactly nothing and
// nothing anywhere failed. gems_db.test.js proves the purchase logic; THIS proves the
// message actually travels: the frame is answered, the gold moves, the row appears, the
// join frame reports the gems, and the one-time import behaves.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const WebSocket = require('ws');

const { attachAuthority } = require('../src/authority/server.js');
const { createCharacter } = require('../src/services/characters.js');
const { entryWorldForJoin } = require('./helpers/entryWorld.js');
const { SKILLS } = require('../seeds/data/skills.js');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const SECRET = 'gems-live-test-secret';
const TAG = `gemlive_${process.pid}_${Date.now().toString(36)}`;

const STARTER = SKILLS.find((s) => (s.reqQuests || []).length === 0 && s.reqLvl <= 1 && s.reqStr <= 10 && s.reqDex <= 10 && s.reqCon <= 10);

// Resolves with the first frame of `type`, or with the first error frame, whichever comes
// first -- a refusal is an answer too, and a test that waited only for the happy frame
// would hang instead of reporting what the server said.
function nextOf(ws, type, ms = 8000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout waiting for ${type}: the server never answered`)), ms);
    ws.on('message', function onMsg(data) {
      const m = JSON.parse(data);
      if (m.type === type || m.type === 'error') {
        clearTimeout(to); ws.off('message', onMsg); resolve(m);
      }
    });
  });
}

test('a skill gem is bought, owned and reported over a real websocket', { skip: !DB_URL ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 3000, max: 6 });
  try { await pool.query('SELECT 1'); } catch (err) {
    await pool.end().catch(() => {});
    throw new Error(`database unreachable, so nothing here was verified: ${err.message}`);
  }
  assert.ok(STARTER, 'the catalog has a gem a fresh character can buy');

  const server = http.createServer();
  const handle = attachAuthority(server, pool, { jwtSecret: SECRET, tickMs: 50 });
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
  const classRow = await pool.query("SELECT id FROM entity_types WHERE name = 'Warrior'");
  assert.equal(classRow.rowCount, 1, 'the database needs a Warrior');

  let seq = 0;
  async function join({ gold = 1000 } = {}) {
    const who = `${TAG}_${seq++}`.toLowerCase();
    const u = await pool.query("INSERT INTO users (username, password_hash, gold) VALUES ($1, 'x', $2) RETURNING id", [who, gold]);
    const userId = u.rows[0].id;
    userIds.push(userId);
    const character = await createCharacter(pool, userId, `${TAG}w${seq}`, classRow.rows[0].id);
    // Enough strength for the starter gem's requirement.
    await pool.query(
      `INSERT INTO player_progression (character_id, strength, dexterity, constitution) VALUES ($1, 10, 10, 10)
       ON CONFLICT (character_id) DO UPDATE SET strength = 10, dexterity = 10, constitution = 10`,
      [character.id]);
    const token = jwt.sign({ user_id: userId, tv: 1 }, SECRET, { algorithm: 'HS256' });
    const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
    sockets.push(ws);
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    ws.send(JSON.stringify({ type: 'join', character_id: character.id, world_id: worldId }));
    const joined = await nextOf(ws, 'joined');
    assert.equal(joined.type, 'joined', `join failed: ${joined.message}`);
    const entry = handle.worlds.get(worldId);
    const player = entry.world.getPlayer(String(userId));
    return { userId, characterId: character.id, ws, joined, entry, player };
  }

  let a = null;

  await t.test('the join frame carries the character\'s gems and the import flag', async () => {
    a = await join();
    assert.deepStrictEqual(a.joined.gems, []);
    assert.strictEqual(a.joined.gemsImported, false, 'a character that never claimed its old gems may do so once');
    assert.ok(a.player.ownedGems instanceof Set, 'ownership is loaded into the live player');
  });

  await t.test('buyGem is ANSWERED -- and refused when no gem merchant is in reach', async () => {
    // Put every merchant post far away, so this is purely about distance.
    a.entry.villages = [{ id: 'far', gemMerchantX: a.player.x + 5000, gemMerchantY: a.player.y + 5000 }];
    a.ws.send(JSON.stringify({ type: 'buyGem', skillId: STARTER.id }));
    const r = await nextOf(a.ws, 'gemBought');
    assert.strictEqual(r.type, 'error', 'a server that does not know the message would stay silent and time out instead');
    assert.match(r.message, /no gem merchant nearby/);
    assert.strictEqual(a.player.ownedGems.has(STARTER.id), false);
  });

  await t.test('next to a gem merchant the purchase goes through: frame, wallet, row, live state', async () => {
    const cx = a.player.x + a.player.width / 2;
    const cy = a.player.y + a.player.height / 2;
    a.entry.villages = [{ id: 'near', gemMerchantX: cx + 30, gemMerchantY: cy }];
    const walletP = new Promise((resolve) => a.ws.on('message', function onMsg(d) {
      const m = JSON.parse(d);
      if (m.type === 'wallet') { a.ws.off('message', onMsg); resolve(m); }
    }));
    a.ws.send(JSON.stringify({ type: 'buyGem', skillId: STARTER.id }));
    const r = await nextOf(a.ws, 'gemBought');
    assert.strictEqual(r.type, 'gemBought', `refused: ${r.message}`);
    assert.strictEqual(r.skillId, STARTER.id);
    assert.strictEqual(r.price, STARTER.gemPrice);
    assert.strictEqual(r.gold, 1000 - STARTER.gemPrice);
    assert.strictEqual((await walletP).gold, 1000 - STARTER.gemPrice);

    const row = await pool.query('SELECT price_paid FROM character_gems WHERE character_id = $1 AND skill_id = $2', [a.characterId, STARTER.id]);
    assert.strictEqual(row.rowCount, 1);
    assert.strictEqual(row.rows[0].price_paid, STARTER.gemPrice);
    const gold = Number((await pool.query('SELECT gold FROM users WHERE id = $1', [a.userId])).rows[0].gold);
    assert.strictEqual(gold, 1000 - STARTER.gemPrice);
    assert.ok(a.player.ownedGems.has(STARTER.id));
  });

  await t.test('buying it again is refused and costs nothing', async () => {
    a.ws.send(JSON.stringify({ type: 'buyGem', skillId: STARTER.id }));
    const r = await nextOf(a.ws, 'gemBought');
    assert.strictEqual(r.type, 'error');
    assert.match(r.message, /already own/);
    const gold = Number((await pool.query('SELECT gold FROM users WHERE id = $1', [a.userId])).rows[0].gold);
    assert.strictEqual(gold, 1000 - STARTER.gemPrice);
  });

  await t.test('the next join reports the gem, so a reconnect cannot lose it', async () => {
    a.ws.terminate();
    const again = await (async () => {
      const token = jwt.sign({ user_id: a.userId, tv: 1 }, SECRET, { algorithm: 'HS256' });
      const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
      sockets.push(ws);
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
      ws.send(JSON.stringify({ type: 'join', character_id: a.characterId, world_id: worldId }));
      return nextOf(ws, 'joined');
    })();
    assert.strictEqual(again.type, 'joined', again.message);
    assert.deepStrictEqual(again.gems, [STARTER.id]);
  });

  await t.test('the one-time import: answered once, then refused, and it grants only what qualifies', async () => {
    const b = await join();
    b.ws.send(JSON.stringify({ type: 'importGems', skillIds: [STARTER.id, 'bogus', SKILLS.find((s) => s.reqLvl >= 16).id] }));
    const first = await nextOf(b.ws, 'gemsImported');
    assert.strictEqual(first.type, 'gemsImported');
    assert.deepStrictEqual(first.granted, [STARTER.id], 'the quest-gated, high-level and bogus ones are not granted');
    assert.ok(b.player.ownedGems.has(STARTER.id));

    b.ws.send(JSON.stringify({ type: 'importGems', skillIds: [STARTER.id] }));
    const second = await nextOf(b.ws, 'gemsImported');
    assert.deepStrictEqual(second.granted, []);
    assert.match(second.refused, /already imported/);
    const gold = Number((await pool.query('SELECT gold FROM users WHERE id = $1', [b.userId])).rows[0].gold);
    assert.strictEqual(gold, 1000, 'the import is free');
  });

  await t.test('a skill that was never bought cannot be cast, one that was can', async () => {
    const c = await join();
    const refused = c.entry.world.castSkill(String(c.userId), STARTER.id, c.player.x + 40, c.player.y, 1, 0);
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.reason, 'not_learned');
    c.player.ownedGems.add(STARTER.id);
    c.player.stamina = 100; c.player.mana = 100;
    // Once learned the cast is no longer refused FOR THAT REASON. (Whether it then lands depends
    // on the character's weapon and stats, which is a different rule with its own tests.)
    const learned = c.entry.world.castSkill(String(c.userId), STARTER.id, c.player.x + 40, c.player.y, 1, 0);
    assert.notStrictEqual(learned.reason, 'not_learned');
  });
});
