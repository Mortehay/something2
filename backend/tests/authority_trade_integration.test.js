'use strict';

// SOMET-728. A trade over the real authority: two raw websockets, a real database,
// real ticks. What matters here is the wiring between frames, the session, the
// settlement and the live mirrors, none of which a fake pool can answer for.
//
// The clock of the registry is injected and pushed forward instead of sleeping
// through the 1.5 s confirm delay and the 30 s invite expiry.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const WebSocket = require('ws');
const { attachAuthority } = require('../src/authority/server.js');
const { createCharacter } = require('../src/services/characters.js');
const { TRADE_ALLOWED_FRAMES } = require('../src/authority/tradeFrames.js');
const { neighborhoodKeys, chunkOf } = require('../src/authority/coords.js');
const { edgeOfDoorwayTile } = require('../src/services/mapService.js');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const SECRET = 'trade-integration-secret';
const FREEZE = 'finish the trade first';
const GENERIC = 'that player cannot trade right now';
// Only these reach a client's frame list: state and creature broadcasts would bury them.
const KEPT = new Set(['joined', 'error', 'pong', 'wallet', 'kicked', 'transition', 'tradeInvited', 'tradeState', 'tradeEnded']);

const uniq = (tag) => `zzTrade${tag}${process.pid}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A socket with a memory: frames that arrived before a test looked for them are not lost.
class Client {
  constructor(ws) {
    this.ws = ws;
    this.frames = [];
    this.cursor = 0;
    this.wake = null;
    ws.on('message', (data) => {
      const m = JSON.parse(data);
      if (!KEPT.has(m.type)) return;
      this.frames.push(m);
      if (this.wake) this.wake();
    });
    ws.on('error', () => {});
  }

  send(frame) { this.ws.send(JSON.stringify(frame)); }

  // The next unread frame matching `match`; everything before it counts as read.
  async next(match, what, ms = 6000) {
    const pred = typeof match === 'string' ? (m) => m.type === match : match;
    const deadline = Date.now() + ms;
    for (;;) {
      for (let i = this.cursor; i < this.frames.length; i++) {
        if (pred(this.frames[i])) { this.cursor = i + 1; return this.frames[i]; }
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new Error(`timeout waiting for ${what || match}: saw ${JSON.stringify(this.frames.slice(this.cursor).map((f) => [f.type, f.message || f.reason]))}`);
      }
      await new Promise((r) => {
        const to = setTimeout(r, left);
        this.wake = () => { clearTimeout(to); this.wake = null; r(); };
      });
    }
  }

  error() { return this.next('error'); }
  ended() { return this.next('tradeEnded'); }
  state() { return this.next('tradeState'); }
  count(type) { return this.frames.filter((f) => f.type === type).length; }
  all(type) { return this.frames.filter((f) => f.type === type); }
}

async function harness(t, { tickMs = 20 } = {}) {
  if (!DB_URL) { t.skip('no TEST_DATABASE_URL / DATABASE_URL'); return null; }
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 12 });
  try { await pool.query('SELECT 1'); } catch (err) {
    await pool.end().catch(() => {});
    t.skip(`NO DATABASE (${err.message})`);
    return null;
  }

  const clock = { offset: 0, now: () => Date.now() + clock.offset };
  const server = http.createServer();
  const handle = attachAuthority(server, pool, { jwtSecret: SECRET, tickMs, tradeClock: clock.now });
  await new Promise((r) => server.listen(0, r));
  const url = `ws://127.0.0.1:${server.address().port}/authority`;

  const worldRow = await pool.query(
    `INSERT INTO worlds (name, seed, chunk_size, width, height, allows_fast_travel)
     VALUES ($1, 1, 16, 32, 32, true) RETURNING id`,
    [uniq('World')],
  );
  const worldId = worldRow.rows[0].id;
  const classRow = await pool.query("SELECT id FROM entity_types WHERE name = 'Warrior'");
  assert.strictEqual(classRow.rowCount, 1, 'the database needs a Warrior');

  const h = { pool, handle, clock, url, worldId, users: [], typeIds: [], sockets: [], holds: [] };
  t.after(async () => {
    for (const hold of h.holds) await hold.release();
    for (const ws of h.sockets) { try { ws.terminate(); } catch { /* gone */ } }
    handle.close();
    await new Promise((r) => server.close(r));
    // Close handlers persist positions: let them land before the rows go.
    await sleep(100);
    if (h.users.length) {
      await pool.query(
        'DELETE FROM player_items WHERE character_id IN (SELECT id FROM characters WHERE user_id = ANY($1::int[]))',
        [h.users],
      ).catch(() => {});
      await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [h.users]).catch(() => {});
    }
    for (const id of h.typeIds) await pool.query('DELETE FROM item_types WHERE id = $1', [id]).catch(() => {});
    await pool.query('DELETE FROM worlds WHERE id = $1', [worldId]).catch(() => {});
    await pool.end().catch(() => {});
  });

  h.socket = async (userId) => {
    const token = jwt.sign({ user_id: userId, tv: 1 }, SECRET, { algorithm: 'HS256' });
    const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
    h.sockets.push(ws);
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    return new Client(ws);
  };

  h.player = async (tag, { gold = 1000 } = {}) => {
    const u = await pool.query(
      "INSERT INTO users (username, password_hash, gold) VALUES ($1, 'x', $2) RETURNING id",
      [uniq(tag).toLowerCase(), gold],
    );
    const userId = u.rows[0].id;
    h.users.push(userId);
    const name = uniq(tag).slice(0, 24);
    const character = await createCharacter(pool, userId, name, classRow.rows[0].id);
    const client = await h.socket(userId);
    client.send({ type: 'join', character_id: character.id, world_id: worldId });
    const joined = await client.next('joined', `${tag} joining`);
    return {
      tag, name, userId, uid: String(userId), characterId: character.id, client, joined,
      live: () => handle.worlds.get(worldId).world.getPlayer(String(userId)),
    };
  };

  // Two players at the same spot, inside the invite radius.
  h.pair = async () => {
    const a = await h.player('Ann');
    const b = await h.player('Bob');
    b.live().x = a.live().x;
    b.live().y = a.live().y;
    return [a, b];
  };

  h.session = async () => {
    const [a, b] = await h.pair();
    a.client.send({ type: 'tradeInvite', targetId: b.uid });
    await b.client.next('tradeInvited');
    b.client.send({ type: 'tradeRespond', accept: true });
    await a.client.state();
    await b.client.state();
    return [a, b];
  };

  h.type = async (over = {}) => {
    const r = await pool.query(
      `INSERT INTO item_types (name, category, slot, damage, cooldown, defense, value)
       VALUES ($1, 'armor', 'chest', 0, 0, 3, 40) RETURNING id`,
      [uniq('Type')],
    );
    h.typeIds.push(r.rows[0].id);
    // The world loaded its catalog at first join; a later type needs to be in it,
    // the way a type that existed at boot is.
    const entry = handle.worlds.get(worldId);
    if (entry) {
      const row = await pool.query('SELECT id, name, category, slot FROM item_types WHERE id = $1', [r.rows[0].id]);
      entry.world.weapons.set(r.rows[0].id, { ...row.rows[0], ...over });
    }
    return r.rows[0].id;
  };

  // A row in the database and in the owner's live bag, as a pickup would leave it.
  h.give = async (who, typeId, cols = {}) => {
    const r = await pool.query(
      `INSERT INTO player_items (character_id, item_type_id, quantity, rarity, item_level, enchant_level)
       VALUES ($1, $2, 1, $3, $4, $5) RETURNING id`,
      [who.characterId, typeId, cols.rarity || 'white', cols.itemLevel || 1, cols.enchantLevel || 0],
    );
    const id = r.rows[0].id;
    who.live().inv.items.push({
      id, typeId, quantity: 1, soulbound: false, rarity: cols.rarity || 'white',
      itemLevel: cols.itemLevel || 1, enchantLevel: cols.enchantLevel || 0, affixes: [],
    });
    return id;
  };

  h.owner = async (itemId) => {
    const r = await pool.query('SELECT character_id FROM player_items WHERE id = $1', [itemId]);
    return r.rows[0] ? r.rows[0].character_id : null;
  };
  h.gold = async (who) => Number((await pool.query('SELECT gold FROM users WHERE id = $1', [who.userId])).rows[0].gold);

  // Holds an item row so a settlement blocks on it, proving what happens meanwhile.
  h.holdRow = async (itemId) => {
    const client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM player_items WHERE id = $1 FOR UPDATE', [itemId]);
    const hold = {
      released: false,
      release: async () => {
        if (hold.released) return;
        hold.released = true;
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      },
    };
    h.holds.push(hold);
    return hold;
  };

  // Wait until a statement really is parked behind that lock. Without this a test
  // could close its socket before the settlement had even begun.
  h.settlementBlocked = async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const r = await pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FROM player_items%FOR UPDATE%'`,
      );
      if (r.rows[0].n > 0) return;
      await sleep(10);
    }
    throw new Error('the settlement never reached the held row');
  };

  // Parks the next query matching `match` until released, so a test can act inside a
  // handler's await rather than hoping to land there. `answer` replaces the result.
  h.gate = (match, answer = null) => {
    const original = pool.query;
    let open;
    let hit;
    const opened = new Promise((r) => { open = r; });
    const reached = new Promise((r) => { hit = r; });
    let used = false;
    pool.query = async function gated(sql, params) {
      if (!used && match(String(sql), params)) {
        used = true;
        hit();
        await opened;
        if (answer) return answer;
      }
      return original.call(pool, sql, params);
    };
    const gate = {
      reached,
      released: false,
      release: async () => {
        if (gate.released) return;
        gate.released = true;
        pool.query = original;
        open();
      },
    };
    h.holds.push(gate);
    return gate;
  };

  // The server's end of a player's socket, made to throw on one kind of frame.
  h.breakSend = (who, needle) => {
    const sock = handle.worlds.get(worldId).sockets.get(who.uid);
    const send = sock.send.bind(sock);
    sock.send = (text, ...rest) => {
      if (String(text).includes(needle)) throw new Error(`broken send: ${needle}`);
      return send(text, ...rest);
    };
  };

  // A second invite within the same run: past the 3 s throttle, by the clock.
  h.reopen = async (inviter, target) => {
    clock.offset += 3100;
    inviter.client.send({ type: 'tradeInvite', targetId: target.uid });
    await target.client.next('tradeInvited', 'the second invite');
    target.client.send({ type: 'tradeRespond', accept: true });
    await inviter.client.state();
    await target.client.state();
  };

  // Resume is what authorizes a second login, and only a close writes this row.
  h.resumable = (who) => pool.query(
    'INSERT INTO world_players (world_id, character_id, x, y) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
    [worldId, who.characterId, who.live().x, who.live().y],
  );

  // From an open session to the moment before the last confirm.
  h.lockBoth = async (a, b) => {
    a.client.send({ type: 'tradeLock' });
    await a.client.next((m) => m.type === 'tradeState' && m.mine.locked, 'A locked');
    b.client.send({ type: 'tradeLock' });
    await b.client.next((m) => m.type === 'tradeState' && m.phase === 'both_locked', 'both locked');
    await a.client.next((m) => m.type === 'tradeState' && m.phase === 'both_locked', 'both locked');
    clock.offset += 1600;
  };

  h.offer = async (who, itemId) => {
    who.client.send({ type: 'tradeItem', itemId, add: true });
    await who.client.next((m) => m.type === 'tradeState' && m.mine.items.some((i) => i.id === itemId), 'offer shown');
  };

  return h;
}

test('full trade moves items and gold, both get tradeEnded completed', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  const typeId = await h.type();
  const fromA = await h.give(a, typeId);
  const fromB = await h.give(b, typeId);

  await h.offer(a, fromA);
  await h.offer(b, fromB);
  a.client.send({ type: 'tradeGold', amount: 100 });
  await b.client.next((m) => m.type === 'tradeState' && m.theirs.gold === 100, 'gold shown to the partner');
  b.client.send({ type: 'tradeGold', amount: 30 });
  await a.client.next((m) => m.type === 'tradeState' && m.theirs.gold === 30, 'gold shown to the partner');

  await h.lockBoth(a, b);
  a.client.send({ type: 'tradeConfirm' });
  await b.client.next((m) => m.type === 'tradeState' && m.theirs.confirmed, 'A confirmed');
  b.client.send({ type: 'tradeConfirm' });

  const endA = await a.client.ended();
  const endB = await b.client.ended();
  assert.strictEqual(endA.completed, true);
  assert.strictEqual(endB.completed, true);
  assert.deepStrictEqual(endA.removedItemIds, [fromA]);
  assert.deepStrictEqual(endA.addedItems.map((i) => i.id), [fromB]);
  assert.strictEqual(endA.gold, 930);
  assert.strictEqual(endB.gold, 1070);

  assert.strictEqual(await h.owner(fromA), b.characterId);
  assert.strictEqual(await h.owner(fromB), a.characterId);
  assert.strictEqual(await h.gold(a), 930);
  assert.strictEqual(await h.gold(b), 1070);

  // Live mirrors and wallets, without a reconnect.
  assert.ok(a.live().inv.items.some((i) => i.id === fromB));
  assert.ok(!a.live().inv.items.some((i) => i.id === fromA));
  assert.ok(b.live().inv.items.some((i) => i.id === fromA));
  assert.strictEqual(a.live().gold, 930);
  assert.strictEqual((await a.client.next('wallet')).gold, 930);
  assert.strictEqual((await b.client.next('wallet')).gold, 1070);

  // And the session is over: the freeze has lifted.
  a.client.send({ type: 'sell', itemId: fromB });
  assert.strictEqual((await a.client.error()).message, 'no merchant nearby');
});

test('confirm before the delay is refused and does not count', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  const item = await h.give(a, await h.type());
  await h.offer(a, item);
  a.client.send({ type: 'tradeLock' });
  await a.client.next((m) => m.type === 'tradeState' && m.mine.locked);
  b.client.send({ type: 'tradeLock' });
  const opened = await b.client.next((m) => m.type === 'tradeState' && m.phase === 'both_locked');
  assert.ok(opened.confirmOpensInMs > 0 && opened.confirmOpensInMs <= 1500, `${opened.confirmOpensInMs}`);
  a.client.send({ type: 'tradeConfirm' });
  assert.strictEqual((await a.client.error()).message, 'too soon');
  h.clock.offset += 1600;
  b.client.send({ type: 'tradeConfirm' });
  const seen = await a.client.next((m) => m.type === 'tradeState' && m.theirs.confirmed);
  assert.strictEqual(seen.mine.confirmed, false);
  assert.strictEqual(await h.owner(item), a.characterId);
});

test('forged itemId belonging to the partner is refused', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  const theirs = await h.give(b, await h.type());
  const before = a.client.count('tradeState');
  a.client.send({ type: 'tradeItem', itemId: theirs, add: true });
  assert.strictEqual((await a.client.error()).message, 'you do not own that item');
  assert.strictEqual(a.client.count('tradeState'), before, 'a refusal changes nothing to show');
  // The same frame with nothing wrong in it: the refusal above came from ownership.
  const mine = await h.give(a, await h.type());
  await h.offer(a, mine);
  assert.strictEqual(a.client.all('tradeState').at(-1).mine.items.length, 1);
});

test('a worn item cannot be offered, in the words of the chest', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a] = await h.session();
  const item = await h.give(a, await h.type());
  await h.pool.query(
    'INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1, $2, $3)',
    [a.characterId, 'chest', item],
  );
  a.client.send({ type: 'tradeItem', itemId: item, add: true });
  assert.strictEqual((await a.client.error()).message, 'unequip it first');
});

test('taking an item back out of the stash', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  const item = await h.give(a, await h.type());
  await h.offer(a, item);
  await b.client.next((m) => m.type === 'tradeState' && m.theirs.items.length === 1);
  a.client.send({ type: 'tradeItem', itemId: item, add: false });
  await b.client.next((m) => m.type === 'tradeState' && m.theirs.items.length === 0, 'item gone from the partner view');
});

test('gold above the balance is refused, and so is anything not an integer', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  for (const [amount, words] of [[1001, 'not enough gold'], [-1, 'invalid gold'], [1.5, 'invalid gold'], ['7', 'invalid gold'], [null, 'invalid gold']]) {
    a.client.send({ type: 'tradeGold', amount });
    assert.strictEqual((await a.client.error()).message, words, `amount ${amount}`);
  }
  a.client.send({ type: 'tradeGold', amount: 1000 });
  await b.client.next((m) => m.type === 'tradeState' && m.theirs.gold === 1000);
});

test('distant target refused', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.pair();
  b.live().x = a.live().x + 121;
  a.client.send({ type: 'tradeInvite', targetId: b.uid });
  assert.strictEqual((await a.client.error()).message, GENERIC);
  assert.strictEqual(b.client.count('tradeInvited'), 0);
  // Exactly at the radius it goes through: 121 was refused for being 121.
  b.live().x = a.live().x + 120;
  b.live().y = a.live().y;
  a.client.send({ type: 'tradeInvite', targetId: b.uid });
  const invited = await b.client.next('tradeInvited');
  assert.strictEqual(invited.fromName, a.name);
  assert.strictEqual(invited.expiresInMs, 30000);
});

test('an unknown or malformed target gets the same words as a distant one', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a] = await h.pair();
  for (const targetId of ['987654321', null, { x: 1 }]) {
    a.client.send({ type: 'tradeInvite', targetId });
    assert.strictEqual((await a.client.error()).message, GENERIC);
  }
});

// Tick stopped: on a running one, resolveDeaths heals before the invite is decided.
test('neither a dead target nor a dead inviter can trade', async (t) => {
  const h = await harness(t, { tickMs: 1000000 });
  if (!h) return;
  const [a, b] = await h.pair();
  b.live().hp = 0;
  a.client.send({ type: 'tradeInvite', targetId: b.uid });
  assert.strictEqual((await a.client.error()).message, GENERIC);
  b.live().hp = 50;
  a.live().hp = 0;
  a.client.send({ type: 'tradeInvite', targetId: b.uid });
  assert.strictEqual((await a.client.error()).message, GENERIC);
  assert.strictEqual(b.client.count('tradeInvited'), 0);
  // Alive, the same frame goes through: the refusals above came from the hp.
  a.live().hp = 50;
  a.client.send({ type: 'tradeInvite', targetId: b.uid });
  await b.client.next('tradeInvited');
});

test('a player dying takes their invites along', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.pair();
  a.client.send({ type: 'tradeInvite', targetId: b.uid });
  await b.client.next('tradeInvited');
  b.live().hp = 0;
  assert.strictEqual((await a.client.ended()).reason, 'invite cancelled');
  b.client.send({ type: 'tradeRespond', accept: true });
  assert.strictEqual((await b.client.error()).message, 'no invite');

  h.clock.offset += 3100;
  a.client.send({ type: 'tradeInvite', targetId: b.uid });
  await b.client.next('tradeInvited');
  a.live().hp = 0;
  assert.strictEqual((await b.client.ended()).reason, 'invite cancelled');
  b.client.send({ type: 'tradeRespond', accept: true });
  assert.strictEqual((await b.client.error()).message, 'no invite');
});

// A reconnect leaves the old player in the world while the new socket loads.
test('a player whose reconnect is still loading cannot be invited', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.pair();
  await h.resumable(a);
  const gate = h.gate((sql, params) => /FROM player_items/.test(sql) && params && params[0] === a.characterId);
  const second = await h.socket(a.userId);
  second.send({ type: 'join', character_id: a.characterId, world_id: h.worldId });
  await gate.reached;
  assert.ok(a.live(), 'the old player is still in the world, which is the point');
  b.client.send({ type: 'tradeInvite', targetId: a.uid });
  assert.strictEqual((await b.client.error()).message, GENERIC);
  assert.strictEqual(second.count('tradeInvited'), 0);
  await gate.release();
  await second.next('joined');
  // Joined, the same frame goes through.
  a.live().x = b.live().x;
  a.live().y = b.live().y;
  h.clock.offset += 3100;
  b.client.send({ type: 'tradeInvite', targetId: a.uid });
  await second.next('tradeInvited');
});

test('a socket that never joined cannot answer the invite either', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.pair();
  b.client.send({ type: 'tradeInvite', targetId: a.uid });
  await a.client.next('tradeInvited');
  const extra = await h.socket(a.userId);
  extra.send({ type: 'tradeRespond', accept: true });
  extra.send({ type: 'ping' });
  await extra.next('pong');
  await sleep(50);
  assert.strictEqual(a.client.count('tradeState'), 0);
  assert.strictEqual(b.client.count('tradeState'), 0);
  a.client.send({ type: 'tradeRespond', accept: true });
  await b.client.state();
});

test('accept counts only when it is true', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.pair();
  a.client.send({ type: 'tradeInvite', targetId: b.uid });
  await b.client.next('tradeInvited');
  b.client.send({ type: 'tradeRespond', accept: 1 });
  assert.strictEqual((await a.client.ended()).reason, 'trade declined');
  assert.strictEqual(a.client.count('tradeState'), 0);
  assert.strictEqual(b.client.count('tradeState'), 0);
  a.client.send({ type: 'sell', itemId: 'x' });
  assert.strictEqual((await a.client.error()).message, 'no merchant nearby', 'no session, no freeze');
});

// Frozen frames go through the same dispatcher, so this is about the trade frames'
// own guard: they act for a user, and this socket is not that user's session.
test('a socket that never joined cannot speak for the session', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  const extra = await h.socket(a.userId);
  for (const frame of [
    { type: 'tradeLock' }, { type: 'tradeGold', amount: 5 }, { type: 'tradeInvite', targetId: b.uid },
    { type: 'tradeRespond', accept: true }, { type: 'tradeConfirm' }, { type: 'tradeAbort' },
  ]) extra.send(frame);
  extra.send({ type: 'ping' });
  await extra.next('pong');
  await sleep(50);
  assert.strictEqual(b.client.count('tradeEnded'), 0, 'its abort must not end the trade');
  a.client.send({ type: 'tradeGold', amount: 9 });
  const seen = await b.client.next((m) => m.type === 'tradeState' && m.theirs.gold === 9);
  assert.strictEqual(seen.theirs.locked, false);
  assert.ok(!b.client.all('tradeState').some((m) => m.theirs.gold === 5));
});

test('sell during a session answers finish the trade first and the item is not sold', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a] = await h.pair();
  const item = await h.give(a, await h.type());
  // Before the session this same frame reaches the handler.
  a.client.send({ type: 'sell', itemId: item });
  assert.strictEqual((await a.client.error()).message, 'no merchant nearby');

  const b = await h.player('Cid');
  b.live().x = a.live().x;
  b.live().y = a.live().y;
  a.client.send({ type: 'tradeInvite', targetId: b.uid });
  await b.client.next('tradeInvited');
  b.client.send({ type: 'tradeRespond', accept: true });
  await a.client.state();

  a.client.send({ type: 'sell', itemId: item });
  assert.strictEqual((await a.client.error()).message, FREEZE);
  assert.strictEqual(await h.owner(item), a.characterId);
  // The partner is frozen too.
  b.client.send({ type: 'sell', itemId: item });
  assert.strictEqual((await b.client.error()).message, FREEZE);
});

test('every real handler outside the allowlist answers the freeze over the wire', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a] = await h.session();
  const frozen = h.handle.frameTypes.filter((type) => !TRADE_ALLOWED_FRAMES.has(type));
  assert.ok(frozen.length >= 20, `${frozen.length} frozen handlers`);
  for (const type of frozen) {
    a.client.send({ type, itemId: 'x', slot: 'chest', stockId: 'x' });
    assert.strictEqual((await a.client.error()).message, FREEZE, type);
  }
});

test('the allowed frames still run during a session', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a] = await h.session();
  a.client.send({ type: 'teleportCancel' });
  a.client.send({ type: 'autoloot', on: true });
  a.client.send({ type: 'attack', ax: 1, ay: 0 });
  a.client.send({ type: 'castSkill', skillId: 'none', targetX: 0, targetY: 0, ax: 1, ay: 0 });
  a.client.send({ type: 'input', seq: 77, dx: 1, dy: 0, dt: 0.05 });
  a.client.send({ type: 'ping' });
  await a.client.next('pong');
  assert.strictEqual(a.client.all('error').filter((e) => e.message === FREEZE).length, 0);
  assert.strictEqual(a.live().autoLoot, true);
  assert.strictEqual(a.live().pendingSeq, 77, 'input still reaches the world');
});

test('declining tells the inviter and starts nothing', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.pair();
  a.client.send({ type: 'tradeInvite', targetId: b.uid });
  await b.client.next('tradeInvited');
  b.client.send({ type: 'tradeRespond', accept: false });
  const end = await a.client.ended();
  assert.strictEqual(end.completed, false);
  assert.strictEqual(end.reason, 'trade declined');
  a.client.send({ type: 'sell', itemId: 'x' });
  assert.strictEqual((await a.client.error()).message, 'no merchant nearby', 'no session, no freeze');
});

test('an invite left unanswered expires on the tick and both are told', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.pair();
  a.client.send({ type: 'tradeInvite', targetId: b.uid });
  await b.client.next('tradeInvited');
  h.clock.offset += 31000;
  assert.strictEqual((await a.client.ended()).reason, 'invite expired');
  assert.strictEqual((await b.client.ended()).reason, 'invite expired');
  b.client.send({ type: 'tradeRespond', accept: true });
  assert.strictEqual((await b.client.error()).message, 'no invite');
});

test('a player leaving takes their invites along and the other is told', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.pair();
  a.client.send({ type: 'tradeInvite', targetId: b.uid });
  await b.client.next('tradeInvited');
  a.client.ws.close();
  const end = await b.client.ended();
  assert.strictEqual(end.completed, false);
  assert.strictEqual(end.reason, 'invite cancelled');
  b.client.send({ type: 'tradeRespond', accept: true });
  assert.strictEqual((await b.client.error()).message, 'no invite');
});

test('tradeAbort ends it for both, nothing moved', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  const item = await h.give(a, await h.type());
  await h.offer(a, item);
  a.client.send({ type: 'tradeAbort' });
  const endB = await b.client.ended();
  assert.strictEqual(endB.completed, false);
  assert.strictEqual(endB.reason, `${a.name} cancelled the trade`);
  assert.strictEqual((await a.client.ended()).reason, 'you cancelled the trade');
  assert.strictEqual(await h.owner(item), a.characterId);
  a.client.send({ type: 'sell', itemId: item });
  assert.strictEqual((await a.client.error()).message, 'no merchant nearby', 'the freeze lifted');
});

test('close mid-session ends it, partner told, nothing moved', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  const item = await h.give(a, await h.type());
  await h.offer(a, item);
  a.client.send({ type: 'tradeGold', amount: 10 });
  await b.client.next((m) => m.type === 'tradeState' && m.theirs.gold === 10);
  a.client.ws.close();
  const end = await b.client.ended();
  assert.strictEqual(end.completed, false);
  assert.strictEqual(end.reason, `${a.name} left`);
  assert.strictEqual(await h.owner(item), a.characterId);
  assert.strictEqual(await h.gold(a), 1000);
  assert.strictEqual(await h.gold(b), 1000);
});

test('a second login mid-session ends the trade too, partner told', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  // A close writes this row. A kick is the path where it has not happened yet, and
  // resume is what authorizes the second login.
  await h.pool.query(
    'INSERT INTO world_players (world_id, character_id, x, y) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
    [h.worldId, a.characterId, a.live().x, a.live().y],
  );
  const second = await h.socket(a.userId);
  second.send({ type: 'join', character_id: a.characterId, world_id: h.worldId });
  await second.next('joined');
  assert.strictEqual((await b.client.ended()).reason, `${a.name} left`);
  // The new session is free of it.
  second.send({ type: 'sell', itemId: 'x' });
  assert.strictEqual((await second.error()).message, 'no merchant nearby');
});

test('a second socket that never joined closes without ending the trade', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  const extra = await h.socket(a.userId);
  extra.ws.close();
  await sleep(100);
  assert.strictEqual(b.client.count('tradeEnded'), 0);
  a.client.send({ type: 'tradeGold', amount: 5 });
  await b.client.next((m) => m.type === 'tradeState' && m.theirs.gold === 5);
});

test('both confirm in the same tick settles once', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  const item = await h.give(a, await h.type());
  await h.offer(a, item);
  a.client.send({ type: 'tradeGold', amount: 100 });
  await b.client.next((m) => m.type === 'tradeState' && m.theirs.gold === 100);
  await h.lockBoth(a, b);

  const logged = [];
  const log = console.log;
  console.log = (...args) => { logged.push(args.join(' ')); log(...args); };
  t.after(() => { console.log = log; });

  a.client.send({ type: 'tradeConfirm' });
  b.client.send({ type: 'tradeConfirm' });
  assert.strictEqual((await a.client.ended()).completed, true);
  assert.strictEqual((await b.client.ended()).completed, true);
  await sleep(150);
  assert.strictEqual(a.client.count('tradeEnded'), 1);
  assert.strictEqual(b.client.count('tradeEnded'), 1);
  assert.strictEqual(await h.owner(item), b.characterId);
  assert.strictEqual(await h.gold(a), 900);
  assert.strictEqual(await h.gold(b), 1100);
  const lines = logged.filter((l) => l.includes('trade_completed'));
  assert.strictEqual(lines.length, 1, 'one structured line per completed trade');
  const line = JSON.parse(lines[0]);
  assert.strictEqual(line.a.characterId, a.characterId);
  assert.deepStrictEqual(line.a.itemIds, [item]);
  assert.strictEqual(line.a.gold, 100);
});

test('a confirm repeated by the same player does not stand in for the other, and says nothing', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  const item = await h.give(a, await h.type());
  await h.offer(a, item);
  await h.lockBoth(a, b);
  a.client.send({ type: 'tradeConfirm' });
  await b.client.next((m) => m.type === 'tradeState' && m.theirs.confirmed, 'A confirmed');
  const states = b.client.count('tradeState');
  a.client.send({ type: 'tradeConfirm' });
  await sleep(150);
  assert.strictEqual(a.client.count('error'), 0, 'a double click is not an error');
  assert.strictEqual(b.client.count('tradeState'), states, 'and changes nothing for anyone');
  assert.strictEqual(await h.owner(item), a.characterId);
  assert.strictEqual(a.client.count('tradeEnded'), 0);
});

test('a lock repeated by an already locked side says nothing and changes nothing', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  const item = await h.give(a, await h.type());
  await h.offer(a, item);
  a.client.send({ type: 'tradeLock' });
  await b.client.next((m) => m.type === 'tradeState' && m.theirs.locked, 'A locked');
  const statesA = a.client.count('tradeState');
  const statesB = b.client.count('tradeState');
  a.client.send({ type: 'tradeLock' });
  await sleep(150);
  assert.strictEqual(a.client.count('error'), 0);
  assert.strictEqual(a.client.count('tradeState'), statesA);
  assert.strictEqual(b.client.count('tradeState'), statesB);
  // Still refused where it matters: an edit after locking.
  a.client.send({ type: 'tradeGold', amount: 5 });
  assert.strictEqual((await a.client.error()).message, 'already locked');
});

test('a confirm or lock with no session, such as one landing after the trade finished, says nothing', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  const item = await h.give(a, await h.type());
  await h.offer(a, item);
  await h.lockBoth(a, b);
  a.client.send({ type: 'tradeConfirm' });
  await b.client.next((m) => m.type === 'tradeState' && m.theirs.confirmed, 'A confirmed');
  b.client.send({ type: 'tradeConfirm' });
  assert.strictEqual((await a.client.ended()).completed, true);
  await b.client.ended();
  const errors = a.client.count('error') + b.client.count('error');
  a.client.send({ type: 'tradeConfirm' });
  a.client.send({ type: 'tradeLock' });
  b.client.send({ type: 'tradeConfirm' });
  await sleep(150);
  assert.strictEqual(a.client.count('error') + b.client.count('error'), errors);
  // Other frames keep their refusal.
  a.client.send({ type: 'tradeGold', amount: 5 });
  assert.strictEqual((await a.client.error()).message, 'not trading');
});

test('close during settling still moves once and partner gets tradeEnded', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  const item = await h.give(a, await h.type());
  await h.offer(a, item);
  a.client.send({ type: 'tradeGold', amount: 100 });
  await b.client.next((m) => m.type === 'tradeState' && m.theirs.gold === 100);
  await h.lockBoth(a, b);

  const hold = await h.holdRow(item);
  a.client.send({ type: 'tradeConfirm' });
  await b.client.next((m) => m.type === 'tradeState' && m.theirs.confirmed);
  b.client.send({ type: 'tradeConfirm' });
  await h.settlementBlocked();

  a.client.ws.close();
  await sleep(100);
  assert.strictEqual(b.client.count('tradeEnded'), 0, 'closing during settling aborts nothing');

  await hold.release();
  const end = await b.client.ended();
  assert.strictEqual(end.completed, true);
  assert.deepStrictEqual(end.addedItems.map((i) => i.id), [item]);
  assert.strictEqual(await h.owner(item), b.characterId);
  assert.strictEqual(await h.gold(a), 900);
  assert.strictEqual(await h.gold(b), 1100);
  await sleep(100);
  assert.strictEqual(b.client.count('tradeEnded'), 1);
  // Finished means finished: the partner is free again.
  b.client.send({ type: 'sell', itemId: item });
  assert.strictEqual((await b.client.error()).message, 'no merchant nearby');
});

test('rejoin during settling does not load the traded item', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  const item = await h.give(a, await h.type());
  await h.offer(a, item);
  await h.lockBoth(a, b);

  const hold = await h.holdRow(item);
  a.client.send({ type: 'tradeConfirm' });
  await b.client.next((m) => m.type === 'tradeState' && m.theirs.confirmed);
  b.client.send({ type: 'tradeConfirm' });
  await h.settlementBlocked();

  a.client.ws.close();
  const again = await h.socket(a.userId);
  again.send({ type: 'join', character_id: a.characterId, world_id: h.worldId });
  await sleep(300);
  assert.strictEqual(again.count('joined'), 0, 'the join waits for the settlement');
  assert.strictEqual(again.all('error').length, 0, `join refused: ${JSON.stringify(again.all('error'))}`);

  await hold.release();
  const joined = await again.next('joined', 'the rejoin');
  assert.ok(!joined.items.some((i) => i.id === item), 'the new mirror must not hold what just left');
  assert.ok(!a.live().inv.items.some((i) => i.id === item));
  assert.strictEqual(await h.owner(item), b.characterId);
  assert.strictEqual((await b.client.ended()).completed, true);
  assert.ok(b.live().inv.items.some((i) => i.id === item));
});

test('a rejoin on another character of the account gets the gold but not the items', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  const item = await h.give(a, await h.type());
  const fromB = await h.give(b, await h.type());
  await h.offer(a, item);
  await h.offer(b, fromB);
  a.client.send({ type: 'tradeGold', amount: 100 });
  await b.client.next((m) => m.type === 'tradeState' && m.theirs.gold === 100);
  await h.lockBoth(a, b);

  const hold = await h.holdRow(item);
  a.client.send({ type: 'tradeConfirm' });
  await b.client.next((m) => m.type === 'tradeState' && m.theirs.confirmed);
  b.client.send({ type: 'tradeConfirm' });
  await h.settlementBlocked();
  a.client.ws.close();

  const cls = await h.pool.query("SELECT id FROM entity_types WHERE name = 'Warrior'");
  const alt = await createCharacter(h.pool, a.userId, uniq('Alt').slice(0, 24), cls.rows[0].id);
  const again = await h.socket(a.userId);
  again.send({ type: 'join', character_id: alt.id, world_id: h.worldId });
  await sleep(200);
  await hold.release();

  // tradeEnded goes first: the join is waiting for the very thing that sends it.
  const end = await again.ended();
  const joined = await again.next('joined');
  assert.ok(!joined.items.some((i) => i.id === fromB), 'the other character received it, not this one');
  assert.strictEqual(joined.gold, 900);
  assert.strictEqual(end.completed, true);
  assert.deepStrictEqual(end.addedItems, []);
  assert.deepStrictEqual(end.removedItemIds, []);
  assert.strictEqual(end.gold, 900);
  assert.strictEqual(await h.owner(fromB), a.characterId);
});

test('a settlement that throws ends the session as trade failed, nothing moved', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  const item = await h.give(a, await h.type());
  await h.offer(a, item);
  await h.lockBoth(a, b);

  // The pool is what settleTrade reaches first; the failure is its, not a stub of settleTrade's.
  const connect = h.pool.connect;
  h.pool.connect = async () => { throw new Error('deadlock detected'); };
  const logged = console.error;
  console.error = () => {};
  t.after(() => { h.pool.connect = connect; console.error = logged; });

  a.client.send({ type: 'tradeConfirm' });
  await b.client.next((m) => m.type === 'tradeState' && m.theirs.confirmed);
  b.client.send({ type: 'tradeConfirm' });
  const endA = await a.client.ended();
  const endB = await b.client.ended();
  h.pool.connect = connect;
  assert.strictEqual(endA.completed, false);
  assert.strictEqual(endA.reason, 'trade failed');
  assert.strictEqual(endB.reason, 'trade failed');
  assert.strictEqual(await h.owner(item), a.characterId);
  a.client.send({ type: 'sell', itemId: item });
  assert.strictEqual((await a.client.error()).message, 'no merchant nearby', 'the session is gone');
});

test('a settlement refusal ends the session with the reason, nothing moved', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  const item = await h.give(a, await h.type());
  await h.offer(a, item);
  a.client.send({ type: 'tradeGold', amount: 100 });
  await b.client.next((m) => m.type === 'tradeState' && m.theirs.gold === 100);
  await h.lockBoth(a, b);
  // The gold went elsewhere after it was offered: settlement re-decides.
  await h.pool.query('UPDATE users SET gold = 0 WHERE id = $1', [a.userId]);
  a.client.send({ type: 'tradeConfirm' });
  await b.client.next((m) => m.type === 'tradeState' && m.theirs.confirmed);
  b.client.send({ type: 'tradeConfirm' });
  const end = await b.client.ended();
  assert.strictEqual(end.completed, false);
  assert.strictEqual(end.reason, 'not enough gold');
  assert.strictEqual(await h.owner(item), a.characterId);
});

test('walking beyond 240 px aborts, and 240 itself does not', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  a.live().x = b.live().x + 240;
  a.live().y = b.live().y;
  await sleep(700); // More than one 500 ms check.
  assert.strictEqual(a.client.count('tradeEnded'), 0, 'at the radius the session stands');
  a.live().x = b.live().x + 241;
  const end = await a.client.ended();
  assert.strictEqual(end.completed, false);
  assert.strictEqual(end.reason, 'you moved too far apart');
  assert.strictEqual((await b.client.ended()).reason, 'you moved too far apart');
});

test('death ends the trade synchronously with the respawn', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  a.live().hp = 0;
  assert.strictEqual((await b.client.ended()).reason, `${a.name} died`);
  assert.strictEqual((await a.client.ended()).reason, 'you died');
});

test('stepping through a portal mid-session ends the trade', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  const entry = h.handle.worlds.get(h.worldId);
  const p = a.live();
  const { cx, cy } = chunkOf(p.x, p.y, entry.row.chunk_size);
  const deadline = Date.now() + 5000;
  while (!neighborhoodKeys(cx, cy, 1).every((k) => entry.loadedChunks.has(k))) {
    assert.ok(Date.now() < deadline, 'the chunks around the player never loaded');
    await sleep(20);
  }
  const row = Math.floor((p.y + p.height / 2) / 100);
  const col = Math.floor((p.x + p.width / 2) / 100);
  p._lastPortalTile = null;
  entry.portalLinks = new Map([[`${row},${col}`, { id: 'link', toWorldId: h.worldId, toX: 1, toY: 1, fromX: p.x, fromY: p.y }]]);
  // In this order: the client hears the trade is over before it starts leaving.
  assert.strictEqual((await a.client.ended()).reason, 'you left');
  const transition = await a.client.next('transition', 'the portal firing');
  entry.portalLinks = new Map();
  assert.strictEqual(transition.toWorldId, h.worldId);
  assert.strictEqual((await b.client.ended()).reason, `${a.name} left`);
});

test('partner frame carries type row and affixes', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  const typeId = await h.type();
  const item = await h.give(a, typeId, { rarity: 'foxy', itemLevel: 88, enchantLevel: 3 });
  const at = await h.pool.query('SELECT id FROM affix_types ORDER BY id LIMIT 1');
  assert.strictEqual(at.rowCount, 1, 'the affix catalog must be seeded for this test to mean anything');
  await h.pool.query(
    'INSERT INTO player_item_affixes (player_item_id, idx, affix_type_id, value) VALUES ($1, 0, $2, 3.5)',
    [item, at.rows[0].id],
  );
  a.client.send({ type: 'tradeItem', itemId: item, add: true });
  const frame = await b.client.next((m) => m.type === 'tradeState' && m.theirs.items.length === 1, 'the partner frame');
  const [seen] = frame.theirs.items;
  assert.strictEqual(seen.id, item);
  assert.strictEqual(seen.rarity, 'foxy');
  assert.strictEqual(seen.itemLevel, 88);
  assert.strictEqual(seen.enchantLevel, 3);
  assert.strictEqual(seen.type.id, typeId);
  assert.strictEqual(seen.type.category, 'armor');
  assert.strictEqual(seen.affixes.length, 1);
  assert.ok(seen.affixes[0].label, 'an affix carries its label');
  assert.ok(seen.affixes[0].effect, 'an affix carries its effect');
  assert.strictEqual(frame.partnerName, a.name);
});

// ---- SOMET-728 review -------------------------------------------------------

test('a settlement stuck behind a row lock gives up, both are told, nothing moved', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  const item = await h.give(a, await h.type());
  await h.offer(a, item);
  a.client.send({ type: 'tradeGold', amount: 100 });
  await b.client.next((m) => m.type === 'tradeState' && m.theirs.gold === 100);
  await h.lockBoth(a, b);

  await h.holdRow(item); // Never released while the test watches.
  a.client.send({ type: 'tradeConfirm' });
  await b.client.next((m) => m.type === 'tradeState' && m.theirs.confirmed);
  const started = Date.now();
  b.client.send({ type: 'tradeConfirm' });

  const endA = await a.client.next('tradeEnded', 'the bound', 10000);
  const endB = await b.client.next('tradeEnded', 'the bound', 10000);
  assert.ok(Date.now() - started < 10000, `took ${Date.now() - started} ms`);
  assert.strictEqual(endA.completed, false);
  assert.strictEqual(endA.reason, 'trade failed');
  assert.strictEqual(endB.completed, false);
  assert.strictEqual(endB.reason, 'trade failed');
  assert.strictEqual(await h.owner(item), a.characterId);
  assert.strictEqual(await h.gold(a), 1000);
  assert.strictEqual(await h.gold(b), 1000);
  a.client.send({ type: 'sell', itemId: item });
  assert.strictEqual((await a.client.error()).message, 'no merchant nearby', 'the freeze lifted');
  b.client.send({ type: 'sell', itemId: item });
  assert.strictEqual((await b.client.error()).message, 'no merchant nearby', 'the freeze lifted');
});

test('frames queued in one session do not apply to the next one', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  a.client.send({ type: 'tradeAbort' });
  await b.client.ended();

  // A's chain stalled before the session it is about to send frames in.
  const held = await h.give(a, await h.type());
  const hold = await h.holdRow(held);
  a.client.send({ type: 'drop', itemId: held });

  h.clock.offset += 3100;
  b.client.send({ type: 'tradeInvite', targetId: a.uid });
  await a.client.next('tradeInvited');
  a.client.send({ type: 'tradeRespond', accept: true });
  await a.client.state();
  a.client.send({ type: 'tradeGold', amount: 50 });
  a.client.send({ type: 'tradeLock' });
  a.client.send({ type: 'tradeAbort' });
  await b.client.next((m) => m.type === 'tradeEnded' && m.reason === `${a.name} cancelled the trade`);

  // The second session opens with those two frames still queued.
  h.clock.offset += 3100;
  b.client.send({ type: 'tradeInvite', targetId: a.uid });
  await a.client.next('tradeInvited');
  a.client.send({ type: 'tradeRespond', accept: true });
  const opening = await a.client.state();
  const fromHere = a.client.frames.length;
  assert.strictEqual(opening.mine.gold, 0);

  await hold.release();
  a.client.send({ type: 'tradeGold', amount: 7 });
  const seen = await b.client.next((m) => m.type === 'tradeState' && m.theirs.gold === 7, 'the second session\'s own frame');
  assert.strictEqual(seen.theirs.locked, false, 'the old lock must not reach this session');
  const later = a.client.frames.slice(fromHere).filter((m) => m.type === 'tradeState');
  assert.ok(!later.some((m) => m.mine.gold === 50), 'the old gold must not reach this session');
  assert.ok(!later.some((m) => m.mine.locked), 'the old lock must not reach this session');
});

test('a frame queued on a kicked socket does not touch the new session', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  await h.resumable(a);
  const held = await h.give(a, await h.type());
  a.client.send({ type: 'tradeAbort' });
  await b.client.ended();

  const hold = await h.holdRow(held);
  a.client.send({ type: 'drop', itemId: held });
  h.clock.offset += 3100;
  b.client.send({ type: 'tradeInvite', targetId: a.uid });
  await a.client.next('tradeInvited');
  a.client.send({ type: 'tradeRespond', accept: true });
  await a.client.state();
  a.client.send({ type: 'tradeGold', amount: 50 });
  await sleep(50); // Into the server's chain.

  const second = await h.socket(a.userId);
  second.send({ type: 'join', character_id: a.characterId, world_id: h.worldId });
  await second.next('joined');
  a.live().x = b.live().x;
  a.live().y = b.live().y;
  await b.client.next((m) => m.type === 'tradeEnded' && m.reason === `${a.name} left`);

  h.clock.offset += 3100;
  b.client.send({ type: 'tradeInvite', targetId: a.uid });
  await second.next('tradeInvited');
  second.send({ type: 'tradeRespond', accept: true });
  await second.state();
  await hold.release();
  await sleep(100);
  second.send({ type: 'tradeGold', amount: 7 });
  await b.client.next((m) => m.type === 'tradeState' && m.theirs.gold === 7);
  assert.ok(!second.all('tradeState').some((m) => m.mine.gold === 50));
});

test('an invite queued on a kicked socket is not sent, nor one kicked during its name lookup', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.pair();
  await h.resumable(a);
  const held = await h.give(a, await h.type());
  const hold = await h.holdRow(held);
  a.client.send({ type: 'drop', itemId: held });
  a.client.send({ type: 'tradeInvite', targetId: b.uid });
  await sleep(50);
  const second = await h.socket(a.userId);
  second.send({ type: 'join', character_id: a.characterId, world_id: h.worldId });
  await second.next('joined');
  await hold.release();
  await sleep(100);
  assert.strictEqual(b.client.count('tradeInvited'), 0, 'queued behind the drop');

  a.live().x = b.live().x;
  a.live().y = b.live().y;
  const gate = h.gate((sql) => /SELECT name FROM characters/.test(sql));
  second.send({ type: 'tradeInvite', targetId: b.uid });
  await gate.reached;
  const third = await h.socket(a.userId);
  third.send({ type: 'join', character_id: a.characterId, world_id: h.worldId });
  await third.next('joined');
  await gate.release();
  await sleep(100);
  assert.strictEqual(b.client.count('tradeInvited'), 0, 'kicked during the lookup');
});

test('gold that was awaiting its balance when the session ended is dropped', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  const gate = h.gate((sql) => /SELECT gold FROM users/.test(sql));
  a.client.send({ type: 'tradeGold', amount: 5 });
  await gate.reached;
  a.client.send({ type: 'tradeAbort' });
  await b.client.ended();
  await h.reopen(b, a);
  await gate.release();
  // On the same chain, so it runs after the stale frame, and it overwrites no gold.
  a.client.send({ type: 'tradeLock' });
  const seen = await b.client.next((m) => m.type === 'tradeState' && m.theirs.locked, 'the lock');
  assert.strictEqual(seen.theirs.gold, 0, 'the old amount must not reach the new session');
});

test('an offer that was being validated when the session ended is dropped', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  const item = await h.give(a, await h.type());
  const gate = h.gate((sql) => /FROM player_items WHERE id = \$1 AND character_id/.test(sql));
  a.client.send({ type: 'tradeItem', itemId: item, add: true });
  await gate.reached;
  a.client.send({ type: 'tradeAbort' });
  await b.client.ended();
  await h.reopen(b, a);
  await gate.release();
  // The frame hides an id with no cached item, so ask the stash itself. Same chain.
  a.client.send({ type: 'tradeItem', itemId: item, add: false });
  assert.strictEqual((await a.client.error()).message, 'item not offered');
});

test('an edit that changes nothing sends no state to anyone', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  const item = await h.give(a, await h.type());
  await h.offer(a, item);
  a.client.send({ type: 'tradeGold', amount: 7 });
  await b.client.next((m) => m.type === 'tradeState' && m.theirs.gold === 7);
  await a.client.next((m) => m.type === 'tradeState' && m.mine.gold === 7);
  const countA = a.client.count('tradeState');
  const countB = b.client.count('tradeState');

  a.client.send({ type: 'tradeGold', amount: 7 });
  a.client.send({ type: 'tradeItem', itemId: item, add: true });
  a.client.send({ type: 'tradeGold', amount: 8 }); // On the same chain, so it comes last.
  await b.client.next((m) => m.type === 'tradeState' && m.theirs.gold === 8);
  await a.client.next((m) => m.type === 'tradeState' && m.mine.gold === 8);
  assert.strictEqual(a.client.count('tradeState'), countA + 1);
  assert.strictEqual(b.client.count('tradeState'), countB + 1);
  assert.strictEqual(a.client.all('tradeState').at(-1).mine.items.length, 1, 'still offered once');
});

test('a throw while announcing settling does not strand the session', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  const item = await h.give(a, await h.type());
  await h.offer(a, item);
  await h.lockBoth(a, b);
  a.client.send({ type: 'tradeConfirm' });
  await b.client.next((m) => m.type === 'tradeState' && m.theirs.confirmed);
  h.breakSend(b, '"phase":"settling"');
  h.breakSend(a, '"phase":"settling"');
  const logged = console.error;
  console.error = () => {};
  t.after(() => { console.error = logged; });
  b.client.send({ type: 'tradeConfirm' });
  assert.strictEqual((await a.client.ended()).completed, true);
  assert.strictEqual((await b.client.ended()).completed, true);
  assert.strictEqual(await h.owner(item), b.characterId);
});

test('a throw delivering to one player still delivers to the other', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  const item = await h.give(a, await h.type());
  await h.offer(a, item);
  await h.lockBoth(a, b);
  h.breakSend(a, '"type":"tradeEnded"');
  const logged = console.error;
  console.error = () => {};
  t.after(() => { console.error = logged; });
  a.client.send({ type: 'tradeConfirm' });
  await b.client.next((m) => m.type === 'tradeState' && m.theirs.confirmed);
  b.client.send({ type: 'tradeConfirm' });
  const end = await b.client.ended();
  assert.strictEqual(end.completed, true);
  assert.deepStrictEqual(end.addedItems.map((i) => i.id), [item]);
  assert.ok(b.live().inv.items.some((i) => i.id === item));
  // The committed trade is not reported failed, and the freeze has lifted for both.
  a.client.send({ type: 'sell', itemId: item });
  assert.strictEqual((await a.client.error()).message, 'no merchant nearby');
});

test('the partner rejoining during settling loads what they received, not what they gave', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  const fromA = await h.give(a, await h.type());
  const fromB = await h.give(b, await h.type());
  await h.offer(a, fromA);
  await h.offer(b, fromB);
  await h.lockBoth(a, b);

  const hold = await h.holdRow(fromA);
  b.client.send({ type: 'tradeConfirm' });
  await a.client.next((m) => m.type === 'tradeState' && m.theirs.confirmed);
  a.client.send({ type: 'tradeConfirm' }); // A's chain runs it: B is only the other side.
  await h.settlementBlocked();

  b.client.ws.close();
  const again = await h.socket(b.userId);
  again.send({ type: 'join', character_id: b.characterId, world_id: h.worldId });
  await sleep(300);
  assert.strictEqual(again.count('joined'), 0, 'the join waits for the settlement');

  await hold.release();
  const joined = await again.next('joined', 'the rejoin');
  assert.ok(!joined.items.some((i) => i.id === fromB), 'the new mirror must not hold what just left');
  assert.ok(joined.items.some((i) => i.id === fromA), 'it holds what arrived');
  assert.strictEqual(await h.owner(fromA), b.characterId);
  assert.strictEqual(await h.owner(fromB), a.characterId);
});

// Death with no bind in a world with no village relocates after a round trip, and a
// session can be accepted inside it. onDeath has already run by then.
test('a session accepted during the death relocation round trip ends when it lands', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.pair();
  const gate = h.gate(
    (sql) => /FROM villages v JOIN worlds w/.test(sql),
    { rows: [{ world_id: h.worldId, spawn_x: 50, spawn_y: 50 }] },
  );
  a.live().hp = 0;
  await gate.reached;
  b.client.send({ type: 'tradeInvite', targetId: a.uid });
  await a.client.next('tradeInvited');
  a.client.send({ type: 'tradeRespond', accept: true });
  await a.client.state();
  await gate.release();
  assert.strictEqual((await a.client.ended()).reason, 'you left');
  const transition = await a.client.next('transition', 'the relocation');
  assert.strictEqual(transition.toWorldId, h.worldId);
  assert.strictEqual((await b.client.ended()).reason, `${a.name} left`);
});

test('walking through a doorway mid-session ends the trade', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  const entry = h.handle.worlds.get(h.worldId);
  let door = null;
  for (let row = 0; row < 32 && !door; row++) {
    for (let col = 0; col < 32 && !door; col++) {
      const edge = edgeOfDoorwayTile(row, col, entry.row.width, entry.row.height);
      if (edge) door = { row, col, edge };
    }
  }
  assert.ok(door, 'this world has a doorway tile');
  const place = (who, row, col) => {
    const p = who.live();
    p.x = col * 100 + 50 - p.width / 2;
    p.y = row * 100 + 50 - p.height / 2;
  };
  place(b, door.row, door.col + 1);
  // Off the tile first, so the arrival latch lets go as it does for a walking player.
  place(a, door.row + 1, door.col + 1);
  await sleep(60);
  entry.links = new Map([[door.edge, { toWorldId: h.worldId, toWidth: 32, toHeight: 32 }]]);
  const { map } = entry.world;
  const getTileAt = map.getTileAt.bind(map);
  map.getTileAt = (x, y) => (Math.floor(x / 100) === door.col && Math.floor(y / 100) === door.row ? 'map_doorway' : getTileAt(x, y));
  t.after(() => { map.getTileAt = getTileAt; entry.links = new Map(); });
  place(a, door.row, door.col);

  assert.strictEqual((await a.client.ended()).reason, 'you left');
  const transition = await a.client.next('transition', 'the doorway firing');
  assert.strictEqual(transition.toWorldId, h.worldId);
  assert.strictEqual((await b.client.ended()).reason, `${a.name} left`);
});

test('a player gone from the world without a close does not leave the survivor frozen', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const [a, b] = await h.session();
  h.handle.worlds.get(h.worldId).world.removePlayer(a.uid);
  const end = await b.client.ended();
  assert.strictEqual(end.completed, false);
  b.client.send({ type: 'sell', itemId: 'x' });
  assert.strictEqual((await b.client.error()).message, 'no merchant nearby', 'the freeze lifted');
});
