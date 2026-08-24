// SOMET-499 -- a stale ws close must not tear down the session that replaced it.
//
// THE DEFECT. `ws.on('close')` identity-checks the outgoing socket at the TOP,
// then awaits persist() and flushBind() before running removePlayer /
// sockets.delete / the empty-world eviction. A new session for the same
// account that registers INSIDE that await window is torn down by the stale
// close: the reconnected client stays open and stays in wss.clients but never
// receives another `state` frame. Measured pre-fix on this file's own loop:
// the world entry itself was EVICTED out from under the live socket.
//
// WHY THIS FILE IS SHAPED THE WAY IT IS. The whole defect lives in the
// interleaving of two REAL registrations, so nothing here calls the close
// handler directly with a synthetic socket -- every session below is a real
// websocket to a real attachAuthority over the real pool. A handler-level unit
// test would have to invent the interleaving it is supposed to be proving.
//
// WHAT THE TESTS COVER. Measuring the bug end to end turned up FOUR distinct
// await windows behind the same one symptom, not the single one the ticket
// names, so each has its own forced, deterministic test on top of the
// statistical loop. Measured on this host over the same harness: 14 ghosts in
// 90 close-then-rejoin runs before the fix, 0 in 200 after it.
//   1. reconnect delivery  -- the bug end to end, over 32 consecutive runs
//   2. stale close, forced -- teardown after the persist/flushBind awaits;
//                             also proves the outgoing session STILL saved
//   3. eviction vs join    -- `worlds.delete` after the flushAndPrune await
//   4. join vs eviction    -- a join holding an entry that was evicted while it
//                             awaited its policy check and spawn
//   5. registered, not added -- another account's close evicting a world a
//                             reserved-but-not-yet-added session is in
//   6. genuine last close  -- the leak the teardown exists to prevent; the test
//                             that goes red if any guard here is too broad and
//                             a real last close skips its teardown

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const WebSocket = require('ws');

const { attachAuthority } = require('../src/authority/server.js');
const { createCharacter } = require('../src/services/characters.js');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const SECRET = 'somet499-test-secret';
const TAG = `s499_${process.pid}_${Date.now().toString(36)}`;

// 32, not 3. The ticket reports ~1 in 3 and this host measured ~1 in 6.4;
// either way a handful of runs cannot tell a fix from luck. This loop alone is
// still only ~1% likely to pass by chance at the pre-fix rate, which is why
// the four forced tests below carry the real weight and this one carries the
// end-to-end shape.
const RECONNECT_RUNS = 32;

// How long the forced-stale test holds the outgoing session's persist() open.
// Long enough for a whole join (several DB round trips) to land inside it.
const PERSIST_STALL_MS = 600;

function nextFrame(ws, type, ms = 15000) {
  return new Promise((resolve) => {
    const to = setTimeout(() => { ws.off('message', onMsg); resolve(null); }, ms);
    function onMsg(data) {
      let m;
      try { m = JSON.parse(data); } catch { return; }
      if (m.type === type) { clearTimeout(to); ws.off('message', onMsg); resolve(m); }
    }
    ws.on('message', onMsg);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Every gate below is opened by the SERVER reaching a particular statement, so
// a fix (or a mutant) that never reaches it would hang the whole file and
// report a timeout naming no test. Bounded, so it fails as an assertion that
// says which step never happened.
const NOT_YET = Symbol('not yet');
async function opensWithin(promise, ms, what) {
  const won = await Promise.race([promise, sleep(ms).then(() => NOT_YET)]);
  assert.notStrictEqual(won, NOT_YET, what);
  return won;
}

test('SOMET-499: a stale close must not tear down the reconnected session', {
  skip: !DB_URL ? 'no database URL' : false,
}, async (t) => {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 3000, max: 10 });
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    await pool.end().catch(() => {});
    // Loud, not silent: a skipped run of this file verifies nothing, and this
    // is the file that proves the reconnect is not a ghost.
    throw new Error(`database unreachable, so nothing here was verified: ${err.message}`);
  }

  const userIds = [];
  const servers = [];
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) { try { ws.terminate(); } catch { /* already gone */ } }
    for (const s of servers) {
      s.handle.close();
      if (s.server.listening) await new Promise((r) => s.server.close(r));
    }
    if (userIds.length) {
      await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [userIds]).catch(() => {});
    }
    await pool.end().catch(() => {});
  });

  const entryRow = await pool.query('SELECT id FROM worlds WHERE is_entry = true LIMIT 1');
  assert.strictEqual(entryRow.rows.length, 1, 'the database needs a seeded entry world');
  const worldId = entryRow.rows[0].id;

  const cls = await pool.query(
    "SELECT id FROM entity_types WHERE name = 'Warrior' AND is_playable = true LIMIT 1");
  assert.strictEqual(cls.rows.length, 1, 'the database needs a playable Warrior');
  const classId = cls.rows[0].id;

  // Boots a real authority. `db` defaults to the plain pool; the forced-stale
  // test hands in a wrapper that stalls exactly one statement.
  async function boot(db = pool) {
    const server = http.createServer();
    const handle = attachAuthority(server, db, { jwtSecret: SECRET, tickMs: 50 });
    await new Promise((r) => server.listen(0, r));
    const rec = { server, handle, url: `ws://127.0.0.1:${server.address().port}/authority` };
    servers.push(rec);
    return rec;
  }

  let seq = 0;
  async function makeAccount() {
    const who = `${TAG}_${seq++}`.toLowerCase();
    const u = await pool.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id", [who]);
    const userId = u.rows[0].id;
    userIds.push(userId);
    const token = jwt.sign({ user_id: userId, tv: 1 }, SECRET, { algorithm: 'HS256' });
    return { userId, token, key: String(userId) };
  }

  async function join(rt, account, characterId) {
    const ws = new WebSocket(`${rt.url}?token=${encodeURIComponent(account.token)}`);
    sockets.push(ws);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    ws.send(JSON.stringify({ type: 'join', character_id: characterId, world_id: worldId }));
    const joined = await nextFrame(ws, 'joined');
    // A silently-bailed join is one of the two faces of this bug (the join
    // handler's own post-await guard bails when a stale close deleted the
    // entry.sockets reservation it made), so "no joined frame" is a failure
    // here, never a retry.
    assert.ok(joined, 'the join never completed -- no `joined` frame arrived');
    return ws;
  }

  await t.test(`close-then-immediately-rejoin still gets state frames, ${RECONNECT_RUNS} runs`, async () => {
    const rt = await boot();
    const account = await makeAccount();
    const character = await createCharacter(pool, account.userId, `${TAG}a`, classId);

    let cur = await join(rt, account, character.id);
    assert.ok(await nextFrame(cur, 'state', 5000), 'the first session must receive state frames');

    const ghosts = [];
    for (let i = 1; i <= RECONNECT_RUNS; i++) {
      cur.close();
      const next = await join(rt, account, character.id);
      const st = await nextFrame(next, 'state', 3000);
      if (!st) {
        // Read the ACTUAL failure rather than reporting "a timeout": which
        // registry entry went missing is what names the mechanism.
        const e = rt.handle.worlds.get(worldId);
        ghosts.push(`run ${i}: no state frame; worldEntry=${e ? 'present' : 'EVICTED'}` +
          (e ? `, socketRegistered=${e.sockets.get(account.key) === next}` +
               `, playerInWorld=${!!e.world.getPlayer(account.key)}` : '') +
          `, clientReadyState=${next.readyState}`);
        next.terminate();
        cur = await join(rt, account, character.id);
        await nextFrame(cur, 'state', 5000);
        continue;
      }
      cur = next;
    }

    assert.strictEqual(ghosts.length, 0,
      `${ghosts.length}/${RECONNECT_RUNS} reconnects were ghosted:\n  ${ghosts.join('\n  ')}`);
    cur.close();
  });

  await t.test('a forced-stale close leaves the new session alive and still saves the old one', async () => {
    // The same race as above, made deterministic: the outgoing session's
    // persist() is held open while the replacement session joins, so the close
    // handler is GUARANTEED to reach its teardown after the new registration.
    const stalled = { charId: null, started: null };
    const stallingPool = {
      query(...args) {
        const text = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].text) || '';
        const values = typeof args[0] === 'string' ? args[1] : (args[0] && args[0].values);
        if (text.includes('INSERT INTO world_players')
            && stalled.charId != null && Array.isArray(values) && values[1] === stalled.charId) {
          if (stalled.started) stalled.started();
          return sleep(PERSIST_STALL_MS).then(() => pool.query(...args));
        }
        return pool.query(...args);
      },
      connect: (...args) => pool.connect(...args),
    };

    const rt = await boot(stallingPool);
    const account = await makeAccount();
    // Two characters on ONE account: entry.sockets and world.players are keyed
    // by account, so this is the same collision the bug turns on, and it lets
    // the outgoing session's saved row be asserted without the incoming
    // session overwriting the very row under test.
    const outgoing = await createCharacter(pool, account.userId, `${TAG}out`, classId);
    const incoming = await createCharacter(pool, account.userId, `${TAG}in`, classId);

    const ws1 = await join(rt, account, outgoing.id);
    assert.ok(await nextFrame(ws1, 'state', 5000), 'the outgoing session must be live first');

    const entry = rt.handle.worlds.get(worldId);
    assert.ok(entry, 'the world must be loaded');
    const player = entry.world.getPlayer(account.key);
    assert.ok(player, 'the outgoing session must have a player in the world');

    // Fractional, and off any tile boundary: a value this specific can only
    // have reached the row through THIS session's persist().
    const savedX = Math.round(player.x) + 0.5;
    const savedY = Math.round(player.y) + 0.25;
    player.x = savedX;
    player.y = savedY;

    const persistStarted = new Promise((r) => { stalled.started = r; });
    stalled.charId = outgoing.id;

    ws1.close();
    // Deterministic handshake, not a sleep: the replacement joins only once
    // the outgoing close is provably parked inside its persist().
    await persistStarted;

    const ws2 = await join(rt, account, incoming.id);
    const st = await nextFrame(ws2, 'state', 5000);
    assert.ok(st, 'the replacement session was ghosted by the stale close -- no state frame');

    // The SERVER-side socket, captured while the replacement is known good.
    // `ws2` is this process's client end and is a different object entirely,
    // so comparing against it could never hold; this is what the teardown
    // would delete.
    const registered = rt.handle.worlds.get(worldId).sockets.get(account.key);
    assert.ok(registered, 'the replacement session must be in the socket registry after joining');

    // Let the stalled close finish and run (or skip) its teardown.
    await sleep(PERSIST_STALL_MS + 400);

    const after = rt.handle.worlds.get(worldId);
    assert.ok(after, 'the stale close must not evict the world the new session is in');
    assert.strictEqual(after.sockets.get(account.key), registered,
      'the stale close deleted the new session from the socket registry');
    assert.ok(after.world.getPlayer(account.key),
      'the stale close removed the new session\'s player from the world');
    // And still live AFTER the teardown window, not merely at the moment it joined.
    assert.ok(await nextFrame(ws2, 'state', 3000),
      'the new session stopped receiving state frames once the stale close completed');

    // Acceptance 3: skipping the teardown must not skip the saving. Assert the
    // stored row, not the absence of an exception.
    const row = await pool.query(
      'SELECT x, y FROM world_players WHERE world_id = $1 AND character_id = $2',
      [worldId, outgoing.id]);
    assert.strictEqual(row.rows.length, 1, 'the outgoing session never persisted at all');
    assert.strictEqual(Number(row.rows[0].x), savedX,
      'the stale close skipped persisting the outgoing session\'s position');
    assert.strictEqual(Number(row.rows[0].y), savedY,
      'the stale close skipped persisting the outgoing session\'s position');

    ws2.close();
  });

  await t.test('an eviction that races a join must not detach the world it flushed', async () => {
    // The THIRD window, and the one that survived the first two fixes: the
    // empty-world eviction awaits flushAndPrune BEFORE `worlds.delete`, and a
    // whole join fits inside that await. The join then holds an entry that the
    // delete detaches a moment later -- the player is in a world the tick loop
    // no longer iterates. Forced here by stalling the creature flush the
    // eviction performs.
    const stall = { armed: false, started: null };
    const stallingPool = {
      query(...args) {
        const text = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].text) || '';
        if (stall.armed && text.includes('UPDATE world_creatures')) {
          stall.armed = false; // one shot: later flushes run at full speed
          if (stall.started) stall.started();
          return sleep(PERSIST_STALL_MS).then(() => pool.query(...args));
        }
        return pool.query(...args);
      },
      connect: (...args) => pool.connect(...args),
    };

    // creatureFlushMs far beyond the test: the periodic flush must not be the
    // thing that consumes the one-shot stall.
    const server = http.createServer();
    const handle = attachAuthority(server, stallingPool, {
      jwtSecret: SECRET, tickMs: 50, creatureFlushMs: 600000,
    });
    await new Promise((r) => server.listen(0, r));
    const rt = { server, handle, url: `ws://127.0.0.1:${server.address().port}/authority` };
    servers.push(rt);

    const account = await makeAccount();
    const character = await createCharacter(pool, account.userId, `${TAG}evict`, classId);

    const ws1 = await join(rt, account, character.id);
    assert.ok(await nextFrame(ws1, 'state', 5000), 'the first session must be live');

    // The eviction only has an await window if it has creature state to
    // flush. Gate on that rather than hoping -- a run where nothing was dirty
    // would exercise nothing and still pass.
    const entry = handle.worlds.get(worldId);
    assert.ok(entry, 'the world must be loaded');
    let dirty = 0;
    for (let i = 0; i < 100 && dirty === 0; i++) {
      await sleep(50);
      dirty = entry.world.creatures.getDirty().length;
    }
    assert.ok(dirty > 0,
      'no creature ever went dirty, so the eviction would not have awaited anything');

    const flushStarted = new Promise((r) => { stall.started = r; });
    stall.armed = true;
    ws1.close();
    // the eviction is now parked inside its creature flush
    await opensWithin(flushStarted, 15000,
      'the close never reached the eviction\'s creature flush -- its teardown did not run at all');

    const ws2 = await join(rt, account, character.id);
    assert.ok(await nextFrame(ws2, 'state', 5000),
      'the rejoining session never got a state frame while the eviction was in flight');

    await sleep(PERSIST_STALL_MS + 400); // let the eviction finish and decide

    const after = handle.worlds.get(worldId);
    assert.ok(after, 'the eviction detached the world a live session had just joined');
    assert.strictEqual(after, entry, 'the joined entry is no longer the registered one');
    assert.ok(after.world.getPlayer(account.key), 'the rejoined player is gone from the world');
    assert.ok(await nextFrame(ws2, 'state', 3000),
      'state frames stopped once the racing eviction completed');

    ws2.close();
  });

  await t.test('a join whose world is evicted mid-flight re-attaches instead of joining a detached one', async () => {
    // The SECOND window. A join resolves its world entry from the registry
    // and then awaits the policy lookup and loadSpawn; the outgoing session's
    // close can complete its whole teardown -- eviction included -- inside
    // those awaits. Nothing the close does can help here: at that moment this
    // session had not registered yet, so from the close's point of view it was
    // genuinely the last one out. The join is what has to notice.
    //
    // Held open on an explicit gate rather than a timer, so the eviction is
    // OBSERVED to have completed before the join is allowed to continue.
    const gate = { armed: null, started: null, release: null };
    const stallingPool = {
      query(...args) {
        const text = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].text) || '';
        const values = typeof args[0] === 'string' ? args[1] : (args[0] && args[0].values);
        if (gate.armed != null && text.includes('SELECT x, y FROM world_players')
            && Array.isArray(values) && values[1] === gate.armed) {
          gate.armed = null; // one shot
          if (gate.started) gate.started();
          return new Promise((r) => { gate.release = r; }).then(() => pool.query(...args));
        }
        return pool.query(...args);
      },
      connect: (...args) => pool.connect(...args),
    };

    const rt = await boot(stallingPool);
    const account = await makeAccount();
    const character = await createCharacter(pool, account.userId, `${TAG}mid`, classId);

    // A throwaway first session AND its close, before the experiment starts.
    // Not ceremony: joinPolicy's `resume` leg needs a world_players row, and
    // persist() is what writes one -- a character that has joined but never
    // closed has history and no last world, which mayJoin refuses outright.
    // Without this the rejoin below would be refused for a reason that has
    // nothing to do with the race under test.
    const ws0 = await join(rt, account, character.id);
    assert.ok(await nextFrame(ws0, 'state', 5000), 'the warm-up session must be live');
    ws0.close();
    for (let i = 0; i < 100 && rt.handle.worlds.has(worldId); i++) await sleep(50);
    const persisted = await pool.query(
      'SELECT 1 FROM world_players WHERE world_id = $1 AND character_id = $2',
      [worldId, character.id]);
    assert.strictEqual(persisted.rows.length, 1,
      'the warm-up close did not persist, so the rejoin below would be refused, not raced');

    const ws1 = await join(rt, account, character.id);
    assert.ok(await nextFrame(ws1, 'state', 5000), 'the outgoing session must be live');
    const entry = rt.handle.worlds.get(worldId);
    assert.ok(entry, 'the world must be loaded');

    // Start the rejoin but do NOT wait for it -- it is about to be parked
    // inside loadSpawn, which runs after the world entry has been resolved and
    // before anything is registered.
    const spawnStalled = new Promise((r) => { gate.started = r; });
    gate.armed = character.id;
    const ws2 = new WebSocket(`${rt.url}?token=${encodeURIComponent(account.token)}`);
    sockets.push(ws2);
    await new Promise((res, rej) => { ws2.on('open', res); ws2.on('error', rej); });
    const ws2Joined = nextFrame(ws2, 'joined');
    ws2.send(JSON.stringify({ type: 'join', character_id: character.id, world_id: worldId }));
    await opensWithin(spawnStalled, 15000, 'the rejoin never reached loadSpawn');

    // Now let the outgoing session go all the way, eviction included. From its
    // point of view it really is the last one out -- the rejoin has registered
    // nothing yet -- so no amount of care in the close handler can help here.
    ws1.close();
    let evicted = false;
    for (let i = 0; i < 100 && !evicted; i++) {
      await sleep(50);
      evicted = !rt.handle.worlds.has(worldId);
    }
    assert.strictEqual(evicted, true,
      'the outgoing close did not evict, so this test never exercised the window');

    gate.release();
    assert.ok(await ws2Joined, 'the rejoin never completed after its world was evicted');
    assert.ok(await nextFrame(ws2, 'state', 5000),
      'the rejoin landed in a detached world entry -- no state frame ever arrived');

    const after = rt.handle.worlds.get(worldId);
    assert.ok(after, 'the world the rejoin is in must be in the registry');
    assert.strictEqual(after, entry,
      'the registered entry is not the one the rejoining session was added to');
    assert.ok(after.world.getPlayer(account.key), 'the rejoined player is not in the world');

    ws2.close();
  });

  await t.test('another account\'s close must not evict a world a registered join is in', async () => {
    // The same family, one account over. A join RESERVES its slot in
    // entry.sockets several awaits before its player reaches world.addPlayer,
    // so between those two points the world reads empty while somebody is very
    // much in it. A different account's close landing in that gap would evict
    // the world the reserving session is about to be added to -- and it is not
    // a stale close at all, which is why the identity re-check above cannot be
    // the thing that stops it.
    //
    // Held on the gold lookup, which sits inside exactly that gap.
    const gate = { armed: null, started: null, release: null };
    const stallingPool = {
      query(...args) {
        const text = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].text) || '';
        const values = typeof args[0] === 'string' ? args[1] : (args[0] && args[0].values);
        if (gate.armed != null && text.includes('SELECT gold FROM users')
            && Array.isArray(values) && String(values[0]) === String(gate.armed)) {
          gate.armed = null; // one shot
          if (gate.started) gate.started();
          return new Promise((r) => { gate.release = r; }).then(() => pool.query(...args));
        }
        return pool.query(...args);
      },
      connect: (...args) => pool.connect(...args),
    };

    const rt = await boot(stallingPool);
    const leaver = await makeAccount();
    const arriver = await makeAccount();
    const leaverChar = await createCharacter(pool, leaver.userId, `${TAG}leave`, classId);
    const arriverChar = await createCharacter(pool, arriver.userId, `${TAG}arrive`, classId);

    const wsLeave = await join(rt, leaver, leaverChar.id);
    assert.ok(await nextFrame(wsLeave, 'state', 5000), 'the leaving session must be live');
    const entry = rt.handle.worlds.get(worldId);
    assert.ok(entry, 'the world must be loaded');

    const goldStalled = new Promise((r) => { gate.started = r; });
    gate.armed = arriver.userId;
    const wsArrive = new WebSocket(`${rt.url}?token=${encodeURIComponent(arriver.token)}`);
    sockets.push(wsArrive);
    await new Promise((res, rej) => { wsArrive.on('open', res); wsArrive.on('error', rej); });
    const arriveJoined = nextFrame(wsArrive, 'joined');
    wsArrive.send(JSON.stringify({
      type: 'join', character_id: arriverChar.id, world_id: worldId,
    }));
    await opensWithin(goldStalled, 15000, 'the arriving join never reached its gold lookup');

    // Registered, not yet added: this is the state the eviction must respect.
    assert.strictEqual(entry.sockets.size, 2,
      'the arriving session should hold a reservation while it is stalled');
    assert.strictEqual(!!entry.world.getPlayer(arriver.key), false,
      'the arriving session should not have a player yet -- the stall is in the wrong place');

    wsLeave.close();
    // Wait for the leaver's teardown to have actually run, then confirm the
    // world survived it.
    let torn = false;
    for (let i = 0; i < 100 && !torn; i++) {
      await sleep(50);
      torn = !entry.sockets.has(leaver.key) && !entry.world.getPlayer(leaver.key);
    }
    assert.strictEqual(torn, true, 'the leaving session never ran its teardown');
    assert.strictEqual(rt.handle.worlds.get(worldId), entry,
      'the leaver evicted the world out from under a session already registered in it');

    gate.release();
    assert.ok(await arriveJoined, 'the arriving join never completed');
    assert.ok(await nextFrame(wsArrive, 'state', 5000),
      'the arriving session was added to a detached world -- no state frame arrived');
    assert.strictEqual(rt.handle.worlds.get(worldId), entry,
      'the world the arriving session joined is not the registered one');

    wsArrive.close();
  });

  await t.test('the last session out still removes its player and evicts its world', async () => {
    // The direction a too-broad re-check breaks: if the close decides it is
    // stale whenever anything changed (e.g. re-reading sessionsByUser, which
    // the top of the handler has already deleted), a GENUINE last close skips
    // its teardown and leaks both the player and the loaded world.
    const rt = await boot();
    const account = await makeAccount();
    const character = await createCharacter(pool, account.userId, `${TAG}last`, classId);

    const ws = await join(rt, account, character.id);
    assert.ok(await nextFrame(ws, 'state', 5000), 'the session must be live before it closes');

    const entry = rt.handle.worlds.get(worldId);
    assert.ok(entry, 'the world must be loaded while the session is live');
    assert.ok(entry.world.getPlayer(account.key), 'the player must be in the world');

    ws.close();

    // Poll rather than sleep a guessed duration: the close handler awaits real
    // DB work before the eviction.
    let evicted = false;
    for (let i = 0; i < 100 && !evicted; i++) {
      await sleep(50);
      evicted = !rt.handle.worlds.has(worldId);
    }

    assert.strictEqual(evicted, true,
      'the last session out left its world loaded -- the empty-world eviction did not run');
    assert.strictEqual(entry.sockets.has(account.key), false,
      'the last session out left its socket in the registry');
    assert.strictEqual(!!entry.world.getPlayer(account.key), false,
      'the last session out left its player in the world');
  });
});
