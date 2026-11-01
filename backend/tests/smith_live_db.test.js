// The village blacksmith over a REAL websocket, against the real authority and database:
// scrolls are bought at the smith, weapons are enchanted at the smith, and nowhere else.
//
// Like gems_live_db.test.js this exists because a message the server does not understand is
// answered with silence. Everything here waits for a REPLY, so "the server ignored it" fails
// as a timeout with a message, not as a green test that asserted nothing.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const WebSocket = require('ws');

const { attachAuthority } = require('../src/authority/server.js');
const { createCharacter } = require('../src/services/characters.js');
const { entryWorldForJoin } = require('./helpers/entryWorld.js');
const enchant = require('../src/services/enchant.js');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const SECRET = 'smith-live-test-secret';
const TAG = `smith_${process.pid}_${Date.now().toString(36)}`;

function nextOf(ws, types, ms = 8000) {
  const wanted = Array.isArray(types) ? types : [types];
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout waiting for ${wanted.join('/')}: the server never answered`)), ms);
    ws.on('message', function onMsg(data) {
      const m = JSON.parse(data);
      if (wanted.includes(m.type) || m.type === 'error') {
        clearTimeout(to); ws.off('message', onMsg); resolve(m);
      }
    });
  });
}

test('buy scrolls and enchant a weapon at the village smith', { skip: !DB_URL ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 3000, max: 6 });
  try { await pool.query('SELECT 1'); } catch (err) {
    await pool.end().catch(() => {});
    throw new Error(`database unreachable, so nothing here was verified: ${err.message}`);
  }
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
  const weaponType = await pool.query("SELECT id FROM item_types WHERE name = 'dagger'");
  const scrollType = await pool.query("SELECT id FROM item_types WHERE name = 'enchant_scroll'");
  assert.equal(weaponType.rowCount, 1, 'the catalog needs a dagger');
  assert.equal(scrollType.rowCount, 1, 'the migration must have created the scroll');
  const PRICE = enchant.ENCHANT_CONFIG.scrollPrice;

  const who = `${TAG}_a`.toLowerCase();
  const u = await pool.query("INSERT INTO users (username, password_hash, gold) VALUES ($1, 'x', 10000) RETURNING id", [who]);
  const userId = u.rows[0].id;
  userIds.push(userId);
  const character = await createCharacter(pool, userId, `${TAG}w`, classRow.rows[0].id);
  const weapon = await pool.query(
    'INSERT INTO player_items (character_id, item_type_id) VALUES ($1, $2) RETURNING id', [character.id, weaponType.rows[0].id]);
  const weaponId = weapon.rows[0].id;

  const token = jwt.sign({ user_id: userId, tv: 1 }, SECRET, { algorithm: 'HS256' });
  const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
  sockets.push(ws);
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  ws.send(JSON.stringify({ type: 'join', character_id: character.id, world_id: worldId }));
  const joined = await nextOf(ws, 'joined');
  assert.equal(joined.type, 'joined', joined.message);
  const entry = handle.worlds.get(worldId);
  const player = entry.world.getPlayer(String(userId));
  const send = (m) => ws.send(JSON.stringify(m));
  const goldInDb = async () => Number((await pool.query('SELECT gold FROM users WHERE id = $1', [userId])).rows[0].gold);

  await t.test('the join frame delivers the config the menu needs and the smith posts', () => {
    assert.ok(Array.isArray(joined.blacksmiths), 'blacksmiths is part of the join frame');
    for (const b of joined.blacksmiths) {
      assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y));
      assert.ok('villageId' in b);
    }
    assert.equal(joined.enchant.scrollPrice, PRICE);
    assert.equal(joined.enchant.maxScrollPurchase, enchant.ENCHANT_CONFIG.maxScrollPurchase);
    assert.equal(joined.enchant.maxLevel, 15);
    assert.ok(joined.items.some((i) => i.id === weaponId), 'the weapon is in the inventory frame');
  });

  await t.test('away from the smith both requests are refused -- and ANSWERED', async () => {
    entry.villages = [{ id: 'far', blacksmithX: player.x + 5000, blacksmithY: player.y + 5000 }];
    send({ type: 'buyScrolls', quantity: 1 });
    const a = await nextOf(ws, 'scrollsBought');
    assert.equal(a.type, 'error');
    assert.match(a.message, /no blacksmith nearby/);
    send({ type: 'enchant', scrollId: 'any-scroll', itemId: weaponId });
    const b = await nextOf(ws, 'enchanted');
    assert.equal(b.type, 'error');
    assert.match(b.message, /no blacksmith nearby/);
    assert.equal(await goldInDb(), 10000, 'nothing was charged');
  });

  const nearSmith = () => {
    const cx = player.x + player.width / 2;
    const cy = player.y + player.height / 2;
    entry.villages = [{ id: 'near', blacksmithX: cx + 30, blacksmithY: cy }];
  };
  let stackId = null;

  await t.test('next to the smith a purchase goes through: frame, wallet, row, live inventory', async () => {
    nearSmith();
    send({ type: 'buyScrolls', quantity: 3 });
    const r = await nextOf(ws, 'scrollsBought');
    assert.equal(r.type, 'scrollsBought', `refused: ${r.message}`);
    assert.equal(r.added, 3);
    assert.equal(r.price, 3 * PRICE);
    assert.equal(r.gold, 10000 - 3 * PRICE);
    assert.equal(r.item.quantity, 3);
    assert.equal(r.item.typeId, scrollType.rows[0].id);
    stackId = r.item.id;
    assert.equal(await goldInDb(), 10000 - 3 * PRICE);
    const row = await pool.query('SELECT quantity FROM player_items WHERE id = $1', [stackId]);
    assert.equal(Number(row.rows[0].quantity), 3);
    assert.equal(player.inv.items.find((i) => i.id === stackId).quantity, 3);
  });

  await t.test('a second purchase STACKS onto the first instead of opening another slot', async () => {
    send({ type: 'buyScrolls', quantity: 2 });
    const r = await nextOf(ws, 'scrollsBought');
    assert.equal(r.type, 'scrollsBought', r.message);
    assert.equal(r.item.id, stackId, 'the same row');
    assert.equal(r.item.quantity, 5);
    const rows = await pool.query('SELECT id FROM player_items WHERE character_id = $1 AND item_type_id = $2', [character.id, scrollType.rows[0].id]);
    assert.equal(rows.rowCount, 1);
    assert.equal(player.inv.items.filter((i) => i.typeId === scrollType.rows[0].id).length, 1);
  });

  await t.test('bad quantities and a short wallet are refused without moving gold', async () => {
    const before = await goldInDb();
    for (const [quantity, pattern] of [[0, /choose how many/], [-3, /choose how many/], [enchant.ENCHANT_CONFIG.maxScrollPurchase + 1, /at most/]]) {
      send({ type: 'buyScrolls', quantity });
      const r = await nextOf(ws, 'scrollsBought');
      assert.equal(r.type, 'error', `quantity ${quantity}`);
      assert.match(r.message, pattern);
    }
    // a non-integer is dropped at the door (no reply is owed to nonsense) -- prove it did nothing
    send({ type: 'buyScrolls', quantity: 'many' });
    send({ type: 'buyScrolls', quantity: 1.5 });
    await pool.query('UPDATE users SET gold = $2 WHERE id = $1', [userId, PRICE - 1]);
    send({ type: 'buyScrolls', quantity: 1 });
    const poor = await nextOf(ws, 'scrollsBought');
    assert.equal(poor.type, 'error');
    assert.equal(poor.message, 'not enough gold');
    assert.equal(await goldInDb(), PRICE - 1);
    const stack = await pool.query('SELECT quantity FROM player_items WHERE id = $1', [stackId]);
    assert.equal(Number(stack.rows[0].quantity), 5, 'no scroll was added');
    await pool.query('UPDATE users SET gold = $2 WHERE id = $1', [userId, before]);
  });

  await t.test('at the smith a scroll enchants the weapon: the result frame, the row and the stack', async () => {
    send({ type: 'enchant', scrollId: stackId, itemId: weaponId });
    const r = await nextOf(ws, 'enchanted');
    assert.equal(r.type, 'enchanted', `refused: ${r.message}`);
    // +1 is in the safe zone: it cannot fail.
    assert.equal(r.outcome, 'success');
    assert.equal(r.level, 1);
    assert.equal(r.scrollsLeft, 4);
    assert.equal(r.destroyed, false);
    const lvl = await pool.query('SELECT enchant_level FROM player_items WHERE id = $1', [weaponId]);
    assert.equal(lvl.rows[0].enchant_level, 1);
    const stack = await pool.query('SELECT quantity FROM player_items WHERE id = $1', [stackId]);
    assert.equal(Number(stack.rows[0].quantity), 4);
    assert.equal(player.inv.items.find((i) => i.id === weaponId).enchantLevel, 1);
  });

  await t.test('a scroll cannot be used as the weapon, nor a weapon as the scroll', async () => {
    send({ type: 'enchant', scrollId: weaponId, itemId: stackId });
    const r = await nextOf(ws, 'enchanted');
    assert.equal(r.type, 'error');
    assert.match(r.message, /not an enchant scroll|only weapons/);
    const stack = await pool.query('SELECT quantity FROM player_items WHERE id = $1', [stackId]);
    assert.equal(Number(stack.rows[0].quantity), 4, 'nothing was spent');
  });

  await t.test('the blessed scroll is its own stack at its own price, and an unknown kind is treated as standard', async () => {
    const blessedType = await pool.query('SELECT id FROM item_types WHERE name = $1', [enchant.ENCHANT_CONFIG.blessedScrollItemName]);
    const BLESSED = enchant.ENCHANT_CONFIG.blessedScrollPrice;
    await pool.query('UPDATE users SET gold = 50000 WHERE id = $1', [userId]);
    const before = await goldInDb();
    send({ type: 'buyScrolls', quantity: 2, kind: 'blessed' });
    const r = await nextOf(ws, 'scrollsBought');
    assert.equal(r.type, 'scrollsBought', `refused: ${r.message}`);
    assert.equal(r.price, 2 * BLESSED);
    assert.equal(r.item.typeId, blessedType.rows[0].id);
    assert.notEqual(r.item.id, stackId, 'a different stack from the standard scrolls');
    assert.equal(await goldInDb(), before - 2 * BLESSED);

    send({ type: 'buyScrolls', quantity: 1, kind: 'bogus' });
    const s = await nextOf(ws, 'scrollsBought');
    assert.equal(s.price, PRICE, 'a kind the server does not know buys the standard scroll');
    assert.equal(s.item.id, stackId);
  });
});
