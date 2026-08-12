const test = require('node:test');
const assert = require('node:assert');
const { World } = require('../src/authority/world.js');
const { commitCreatureDeath, claimItem, dropItem, dropGraceActive, DROP_GRACE_MS } = require('../src/authority/loot.js');

// Routes queries by SQL pattern and records every call, so a test can assert
// that a query NEVER ran — which is the point of the rowCount guard.
//
// `.connect()` returns a DISTINCT client object per call (its own call log,
// its own release counter) rather than `{ query: pool.query, release: () =>
// {} }` — the original shape made `client.query(x)` and `pool.query(x)` the
// SAME function reference, so nothing here could tell "issued on the
// checked-out client" apart from "issued on the bare pool" (review round 1,
// finding 2, on progression_kill_xp.test.js — fixed the same way here for
// consistency). `pool.matching(re)` still searches everything (pool calls +
// every client's calls combined), so every existing assertion below keeps
// working unchanged; `pool.calls`/`pool.clients[i].calls` are additive, for
// tests that want to know WHICH connection a statement landed on.
function scriptedPool(routes = []) {
  const poolCalls = [];
  const clients = [];
  function route(sql, params) {
    for (const [re, result] of routes) {
      if (re.test(sql)) return typeof result === 'function' ? result(params) : result;
    }
    return { rows: [], rowCount: 0 };
  }
  return {
    calls: poolCalls,
    clients,
    matching(re) {
      return [...poolCalls, ...clients.flatMap((c) => c.calls)].filter((c) => re.test(c.sql));
    },
    query: async (sql, params) => { poolCalls.push({ sql, params }); return route(sql, params); },
    connect: async () => {
      const calls = [];
      const client = {
        calls,
        released: 0,
        matching(re) { return calls.filter((c) => re.test(c.sql)); },
        query: async (sql, params) => { calls.push({ sql, params }); return route(sql, params); },
        release: () => { client.released += 1; },
      };
      clients.push(client);
      return client;
    },
  };
}

function armEntry() {
  const map = { chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] };
  return {
    worldId: 'w1',
    world: new World(map, new Map(), null, 8),
    creatureTypeIds: new Map([['Wolf', 42]]),
  };
}

const DROP_ROW = { item_type_id: 7, chance: '1', min_qty: 1, max_qty: 1 };
const always = () => 0; // rng: always rolls under chance, always min qty

test('a death whose DELETE affects no row rolls NO drops', async () => {
  const entry = armEntry();
  const pool = scriptedPool([
    [/DELETE FROM world_creatures/i, { rows: [], rowCount: 0 }], // already finalized elsewhere
    [/FROM creature_drops/i, { rows: [DROP_ROW], rowCount: 1 }],
  ]);

  await commitCreatureDeath(pool, entry, 'c1', { rng: always, ttlMs: 1000 });

  assert.strictEqual(pool.matching(/FROM creature_drops/i).length, 0, 'must not even look up the drop table');
  assert.strictEqual(pool.matching(/INSERT INTO world_items/i).length, 0, 'must not spawn loot');
  assert.strictEqual(entry.world.groundItems.count(), 0);
});

test('a death whose DELETE affects one row drops loot at the corpse CENTRE, not its stored top-left corner', async () => {
  // world_creatures.x/y is the creature's top-left corner (creatures.js
  // center() adds half of CREATURE_SIZE=48 to get the visual centre), but
  // pickup measures from the player's centre — so the drop must be spawned
  // at the corpse's centre (500+24, 600+24) or it sits 24px off from where
  // the creature visibly died. This deliberately supersedes the old task-5
  // assertion that the drop lands at the raw corpse x/y.
  const entry = armEntry();
  const pool = scriptedPool([
    [/DELETE FROM world_creatures/i, { rows: [{ type: 'Wolf', x: 500, y: 600 }], rowCount: 1 }],
    [/FROM creature_drops/i, { rows: [DROP_ROW], rowCount: 1 }],
    // SOMET-96 changed the drop INSERT from one statement per unit to a
    // single multi-row INSERT, so the params are now
    // [worldId, x, y, ttlMs, itemTypeId[]] rather than one item per call.
    [/INSERT INTO world_items/i, (p) => ({
      rows: p[4].map((typeId, i) => ({
        id: i === 0 ? 'g1' : `g${i + 1}`, item_type_id: typeId, x: p[1], y: p[2],
        expires_at: '2999-01-01T00:00:00Z',
      })),
      rowCount: p[4].length,
    })],
  ]);

  await commitCreatureDeath(pool, entry, 'c1', { rng: always, ttlMs: 1000 });

  const inserts = pool.matching(/INSERT INTO world_items/i);
  assert.strictEqual(inserts.length, 1, 'ONE statement, not one per dropped unit');
  // The point of this test is unchanged: the corpse's CENTRE (500+24, 600+24),
  // not its stored top-left. Only the parameter positions moved.
  assert.deepStrictEqual(inserts[0].params.slice(0, 3), ['w1', 524, 624]);
  assert.deepStrictEqual(inserts[0].params[4], [7], 'the rolled item type rides in the array');
  assert.strictEqual(entry.world.groundItems.count(), 1, 'lands in the sim for the next broadcast');
  assert.deepStrictEqual(entry.world.groundItems.get('g1').x, 524);
  assert.deepStrictEqual(entry.world.groundItems.get('g1').y, 624);
});

test('an unknown creature type drops nothing and does not throw', async () => {
  const entry = armEntry();
  const pool = scriptedPool([
    [/DELETE FROM world_creatures/i, { rows: [{ type: 'Ghost', x: 0, y: 0 }], rowCount: 1 }],
  ]);
  await commitCreatureDeath(pool, entry, 'c1', { rng: always, ttlMs: 1000 });
  assert.strictEqual(pool.matching(/INSERT INTO world_items/i).length, 0);
});

test('removing the rowCount guard would double-drop on two damage sources reporting the same kill', async () => {
  // This does not call commitCreatureDeath twice (that would just prove the
  // guard's *effect*, not its necessity). It proves the SECOND finalize
  // attempt on an already-deleted row cannot roll drops at all, by scripting
  // the second call's DELETE to behave the way Postgres actually behaves:
  // rowCount 0, empty rows. If the `r.rowCount !== 1` guard in loot.js were
  // removed outright so `r.rows[0]` is read unconditionally, this test
  // fails — either by throwing (rows[0] undefined) or by issuing the
  // creature_drops lookup it must not issue. It does NOT prove anything
  // about weakening the guard to `!r.rows.length`: for DELETE ... RETURNING,
  // rowCount === rows.length always, so this mock's empty rows/rowCount pair
  // makes that weakening behave identically here (verified: swapping in
  // `!r.rows.length` still passes all 4 tests in this file).
  const entry = armEntry();
  const pool = scriptedPool([
    [/DELETE FROM world_creatures/i, { rows: [], rowCount: 0 }],
    [/FROM creature_drops/i, { rows: [DROP_ROW], rowCount: 1 }],
    [/INSERT INTO world_items/i, () => { throw new Error('must never be reached'); }],
  ]);

  await assert.doesNotReject(commitCreatureDeath(pool, entry, 'c1', { rng: always, ttlMs: 1000 }));

  assert.strictEqual(pool.matching(/FROM creature_drops/i).length, 0, 'second finalize must not roll drops');
  assert.strictEqual(entry.world.groundItems.count(), 0);

  // The refused finalize must still ROLLBACK and release its own client,
  // not silently leak a checked-out connection.
  assert.strictEqual(pool.calls.length, 0, 'nothing may be issued on the bare pool');
  assert.strictEqual(pool.clients.length, 1);
  assert.strictEqual(pool.clients[0].matching(/^\s*ROLLBACK/i).length, 1);
  assert.strictEqual(pool.clients[0].released, 1);
});

function armClaimEntry() {
  const entry = armEntry();
  entry.claiming = new Set();
  // SOMET-257: the player carries BOTH ids -- userId keys the in-memory map
  // and owns gold, characterId keys every database write.
  entry.world.addPlayer('u1', { x: 0, y: 0 }, { items: [], equipment: {} },
    { x: 0, y: 0 }, 0, undefined, 31);
  entry.world.groundItems.add([{ id: 'g1', item_type_id: 7, x: 10, y: 10, expires_at: '2999-01-01T00:00:00Z' }]);
  return entry;
}

// claimItem now issues ONE statement (a CTE that DELETEs world_items and
// INSERTs player_items together), so routing must key on something that
// can't also match the other half of the statement — "DELETE FROM
// world_items" and "INSERT INTO player_items" both appear as substrings of
// the combined SQL text, so a route keyed on either alone would ambiguously
// match every call. `WITH d AS` (its literal opening) is unambiguous.
const CLAIM_RE = /^\s*WITH d AS/i;

test('two claims of one item: the loser actually issues its claim attempt and loses on rowCount', async () => {
  const entry = armClaimEntry();
  let attempts = 0;
  const pool = scriptedPool([
    // First attempt wins, every later one finds the row already gone. This is
    // exactly what Postgres does when two sessions race the same row.
    [CLAIM_RE, () => (++attempts === 1
      ? { rows: [{ id: 'inst-1', item_type_id: 7 }], rowCount: 1 }
      : { rows: [], rowCount: 0 })],
  ]);

  const first = await claimItem(pool, entry, 'u1', 31, 'g1');
  const second = await claimItem(pool, entry, 'u1', 31, 'g1');

  assert.deepStrictEqual(first, { id: 'inst-1', typeId: 7, quantity: 1 });
  assert.strictEqual(second, null, 'the loser gets nothing');
  // This is the invariant this slice exists to establish: not merely that
  // item counts come out right, but that the LOSER actually issued its claim
  // query and lost on rowCount, rather than short-circuiting on some
  // in-memory check. Both calls are driven sequentially with await, so by
  // the second call the item is already gone from the in-memory sim — an
  // in-memory-only guard would return null identically without ever
  // querying. Asserting the query ran twice is what tells the two apart.
  assert.strictEqual(pool.matching(/DELETE FROM world_items/i).length, 2,
    'both the winner and the loser must issue the claim query');
  assert.strictEqual(pool.matching(CLAIM_RE).length, 2);
  assert.strictEqual(entry.world.groundItems.get('g1'), null, 'gone from the sim either way');
});

test('a claim loses when the DB row is already gone even though the sim still holds the item', async () => {
  // The case the two-claim test above cannot reach: this is a SINGLE claim
  // attempt, and the in-memory sim still has the item (armClaimEntry loaded
  // it), but the DB says rowCount 0 — e.g. the expiry sweep deleted the
  // world_items row out from under this loaded chunk between the sim load
  // and this claim. If the guard were ever weakened to trust sim presence
  // instead of the query's rowCount, this would wrongly "win".
  const entry = armClaimEntry();
  const pool = scriptedPool([
    [CLAIM_RE, { rows: [], rowCount: 0 }],
  ]);

  const got = await claimItem(pool, entry, 'u1', 31, 'g1');

  assert.strictEqual(got, null, 'the DB rowCount is authoritative, not sim presence');
  assert.strictEqual(entry.world.getPlayer('u1').inv.items.length, 0, 'nothing was granted');
  assert.strictEqual(entry.world.groundItems.get('g1'), null, 'evicted from the sim as a stale row');
});

// SOMET-96: this test used to assert that a REJECTED claim drained `claiming`
// immediately. That property is exactly what produced the retry storm: the
// item stays in the sim, so auto-loot re-attempted it on the very next tick
// and a DB outage became ~20 queries + 20 log lines per second per looting
// player, aimed at a database already in trouble.
//
// The contract it was really protecting -- "never stuck unclaimable FOREVER"
// -- is kept, and now has a deadline attached rather than being immediate.
test('a rejected claim holds the id for a backoff instead of retrying every tick', async () => {
  const entry = armClaimEntry();
  const pool = scriptedPool([
    [CLAIM_RE, () => { throw new Error('db down'); }],
  ]);
  let clock = 1000;
  const now = () => clock;

  await assert.rejects(claimItem(pool, entry, 'u1', 31, 'g1', { now }), /db down/);

  // The very next tick must not reach the database at all.
  clock += 50;
  assert.strictEqual(await claimItem(pool, entry, 'u1', 31, 'g1', { now }), null,
    'a retry inside the backoff window is refused before any query');
  assert.strictEqual(pool.matching(CLAIM_RE).length, 1,
    'exactly ONE query for the whole backoff window -- this is the storm being prevented');
});

test('a rejected claim becomes claimable again once the backoff expires', async () => {
  const entry = armClaimEntry();
  const pool = scriptedPool([
    [CLAIM_RE, () => { throw new Error('db down'); }],
  ]);
  let clock = 1000;
  const now = () => clock;

  await assert.rejects(claimItem(pool, entry, 'u1', 31, 'g1', { now }), /db down/);

  // Past the deadline the id must be genuinely free again -- the original
  // "not stuck forever" guarantee, delayed rather than removed.
  clock += 5000;
  await assert.rejects(claimItem(pool, entry, 'u1', 31, 'g1', { now }), /db down/);
  assert.strictEqual(pool.matching(CLAIM_RE).length, 2,
    'the retry after the window really did reach the database');
});

test('concurrent claims of the same item: the second is blocked by the claiming set before any query', async () => {
  const entry = armClaimEntry();
  const pool = scriptedPool([
    [CLAIM_RE, { rows: [{ id: 'inst-1', item_type_id: 7 }], rowCount: 1 }],
  ]);

  // Not awaited between calls: both run their synchronous prologue (the
  // `entry.claiming` check + add) before either's query settles. The first
  // call synchronously reserves the id, so the second is deterministically
  // the one blocked.
  const [first, second] = await Promise.all([
    claimItem(pool, entry, 'u1', 31, 'g1'),
    claimItem(pool, entry, 'u1', 31, 'g1'),
  ]);

  assert.deepStrictEqual(first, { id: 'inst-1', typeId: 7, quantity: 1 });
  assert.strictEqual(second, null, 'blocked by the claiming set, not a second DB round trip');
  assert.strictEqual(pool.matching(CLAIM_RE).length, 1, 'only one claim query was ever issued');
  assert.strictEqual(entry.claiming.size, 0, 'drains after both settle');
});

test('the claiming guard reserves an id SYNCHRONOUSLY, before any await: two concurrent claims of the same id issue exactly one query', async () => {
  // The auto-loot tick fires claimItem() calls unawaited from inside a
  // synchronous loop; its only defense against a DELETE storm (every item
  // under every auto-looting player, every tick) is that `claiming.has` /
  // `claiming.add` run before claimItem's first `await`. This test pins
  // that invariant directly, rather than trusting scriptedPool's
  // near-instant resolution to exercise it: `query` returns a promise this
  // test controls, so the assertion below runs BEFORE either query could
  // possibly have settled, proving the guard is synchronous rather than
  // merely fast.
  const entry = armClaimEntry();
  let calls = 0;
  let resolveQuery;
  const pending = new Promise((resolve) => { resolveQuery = resolve; });
  const pool = {
    query: () => {
      calls++;
      return pending.then(() => ({ rows: [{ id: 'inst-1', item_type_id: 7 }], rowCount: 1 }));
    },
  };

  // Not awaited between calls, and nothing here yields to the microtask
  // queue before the assertion: if `claiming.add` ran AFTER an `await`
  // (e.g. someone inserts `await something()` above it), both calls would
  // pass the (still-empty) `claiming.has` check and both would call
  // pool.query before either's query resolves, making `calls` 2 here.
  const p1 = claimItem(pool, entry, 'u1', 31, 'g1');
  const p2 = claimItem(pool, entry, 'u1', 31, 'g1');

  assert.strictEqual(calls, 1,
    'only the first call may issue a query; the second must be blocked by the synchronous claiming-set check');

  resolveQuery();
  const [first, second] = await Promise.all([p1, p2]);
  assert.deepStrictEqual(first, { id: 'inst-1', typeId: 7, quantity: 1 });
  assert.strictEqual(second, null, 'blocked by the claiming set');
});

test('a successful claim adds the instance to the in-memory inventory', async () => {
  const entry = armClaimEntry();
  const pool = scriptedPool([
    [CLAIM_RE, { rows: [{ id: 'inst-1', item_type_id: 7 }], rowCount: 1 }],
  ]);
  await claimItem(pool, entry, 'u1', 31, 'g1');
  assert.deepStrictEqual(entry.world.getPlayer('u1').inv.items, [{ id: 'inst-1', typeId: 7, quantity: 1 }]);
});

function armDropEntry(equipment = {}) {
  const entry = armEntry();
  entry.world.addPlayer('u1', { x: 300, y: 400 }, { items: [{ id: 'i1', typeId: 7 }], equipment });
  return entry;
}

test('dropping an equipped item is rejected and touches no table', async () => {
  const entry = armDropEntry({ main_hand: 'i1' });
  const pool = scriptedPool();

  const r = await dropItem(pool, entry, 'u1', 31, 'i1', { ttlMs: 1000 });

  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /unequip/i);
  assert.strictEqual(pool.matching(/DELETE FROM player_items/i).length, 0, 'must not delete the instance');
  assert.strictEqual(pool.matching(/INSERT INTO world_items/i).length, 0, 'must not spawn a ground item');
  assert.strictEqual(entry.world.getPlayer('u1').inv.items.length, 1, 'still owned');
});

test("dropping another user's item deletes nothing and spawns nothing", async () => {
  const entry = armDropEntry();
  // The character_id predicate matches no row in the CTE's DELETE, so the INSERT's
  // "SELECT ... FROM d" has nothing to project -> rowCount 0 for the whole
  // statement.
  const pool = scriptedPool([[DROP_RE, { rows: [], rowCount: 0 }]]);

  const r = await dropItem(pool, entry, 'u1', 31, 'not-mine', { ttlMs: 1000 });

  assert.strictEqual(r.ok, false);
  assert.strictEqual(entry.world.groundItems.count(), 0, 'nothing spawned in the sim');
  // Scripting rowCount 0 alone proves nothing about the query that was
  // actually issued — a test that only asserts a consequence of a result it
  // supplied itself never observes the ownership predicate. Assert on the
  // statement that was actually sent: both that its WHERE clause still
  // filters by character_id, and that the bound params are (itemId, callerCharacterId) —
  // not attacker-controlled data standing in for the caller. Without this, a
  // refactor that deletes "AND character_id = $2" from the SQL (while leaving the
  // params array untouched) would leave `r.ok === false` on THIS particular
  // scripted call yet stay green, because nothing here forces the SQL
  // itself to still contain the check.
  const q = pool.matching(DROP_RE)[0];
  assert.match(q.sql, /character_id\s*=\s*\$2/i,
    'the DELETE must filter by ownership (character_id), not just the item id');
  assert.deepStrictEqual(q.params.slice(0, 2), ['not-mine', 31],
    'ownership predicate must bind the CALLER\'s character (31), not the forged itemId');
});

// Critical #1 fix (SOMET-245 final review): stone_instances.player_item_id
// is ON DELETE CASCADE, and nothing on any acquisition path (claimItem,
// buyStock) ever recreates a stone_instances row -- so dropping a stone
// (loose OR socketed) would permanently destroy its xp/level and make a
// re-acquired copy unsocketable forever. dropItem must refuse rather than
// silently allow it, the same "unequip it first"-shaped rejection as the
// equipped-item guard right above.
const STONE_CHECK_RE = /^\s*SELECT 1 FROM stone_instances si\s+JOIN player_items pi/i;

test('dropItem refuses a LOOSE (unsocketed) stone, deletes nothing, and gives a clear reason', async () => {
  const entry = armDropEntry();
  const pool = scriptedPool([
    [STONE_CHECK_RE, { rows: [{ '?column?': 1 }], rowCount: 1 }], // itemId IS a stone
    [DROP_RE, () => { throw new Error('must never reach the delete+insert CTE'); }],
  ]);

  const r = await dropItem(pool, entry, 'u1', 31, 'i1', { ttlMs: 1000 });

  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /unsocket/i, 'must give a clear, specific reason -- not the generic "you do not own that item"');
  assert.strictEqual(pool.matching(DROP_RE).length, 0, 'must not touch player_items at all');
  assert.strictEqual(entry.world.getPlayer('u1').inv.items.length, 1, 'still owned -- nothing removed from in-memory inventory');
});

test('dropItem refuses a SOCKETED stone the same way as a loose one', async () => {
  // The guard keys purely on "does this player_items row have a
  // stone_instances row" -- socketed_into_id being set or NULL is
  // irrelevant to the check itself, but this pins the socketed case
  // explicitly per the finding's own requirement (both must be refused).
  const entry = armDropEntry();
  const pool = scriptedPool([
    [STONE_CHECK_RE, { rows: [{ '?column?': 1 }], rowCount: 1 }],
    [DROP_RE, () => { throw new Error('must never reach the delete+insert CTE'); }],
  ]);

  const r = await dropItem(pool, entry, 'u1', 31, 'i1', { ttlMs: 1000 });

  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /unsocket/i);
  assert.strictEqual(pool.matching(DROP_RE).length, 0);
});

// F-016 (SOMET-196): dropItem used to issue the DELETE FROM player_items and
// the INSERT INTO world_items as two INDEPENDENT pool.query calls -- two
// separate connections, two separate implicit transactions. A failure between
// them (a dropped connection, a world row deleted out from under a live
// session so the INSERT's FK rejects, a pool timeout) committed the DELETE
// and never ran the INSERT: the item vanished from the account and never
// reached the ground. This test pins the structural fix directly: the pair
// must reach the pool as ONE statement, matching claimItem's CTE pattern, so
// Postgres commits or rolls back both as a unit. Against the old two-call
// implementation this fails with `calls.length === 2`.
const DROP_RE = /^\s*WITH d AS/i;

test('dropItem persists the delete+insert as ONE atomic statement, not two independent pool.query calls', async () => {
  const entry = armDropEntry();
  const pool = scriptedPool([
    [DROP_RE, (p) => ({
      rows: [{ id: 'g9', item_type_id: 7, x: p[3], y: p[4], expires_at: '2999-01-01T00:00:00Z' }],
      rowCount: 1,
    })],
  ]);

  const r = await dropItem(pool, entry, 'u1', 31, 'i1', { ttlMs: 1000 });

  assert.strictEqual(r.ok, true);
  // SOMET-245 final review Critical #1 added a preliminary, READ-ONLY
  // stone_instances check ahead of this CTE (see loot.js) -- it does not
  // reopen the F-016 window this test guards (that window is specifically a
  // WRITE succeeding on one connection while a dependent WRITE fails on
  // another; a prior SELECT carries no such risk), so the assertion now
  // scopes to the delete+insert CTE call specifically rather than the total
  // call count.
  assert.strictEqual(pool.matching(DROP_RE).length, 1,
    'the delete and the insert must reach the pool as a single atomic statement, not two independent queries');
});

// SOMET-245 Task 4b: stone_instances.socketed_into_id has its own
// ON DELETE SET NULL FK back to player_items, so the DB already ejects a
// socketed stone the instant its host's row is deleted -- this test pins
// the explicit, SAME-STATEMENT eject dropItem now also does (belt and
// suspenders, and load-bearing if that FK is ever altered). It has to be
// folded into the existing CTE rather than a second pool.query call:
// dropItem has no checked-out client (see the atomicity test above), so a
// separate call would be a separate implicit transaction, reopening the
// exact crash window this exists to close.
test('dropItem ejects a stone socketed into the dropped item, in the same atomic statement as the delete', async () => {
  const entry = armDropEntry();
  const pool = scriptedPool([
    [DROP_RE, (p) => ({
      rows: [{ id: 'g9', item_type_id: 7, x: p[3], y: p[4], expires_at: '2999-01-01T00:00:00Z' }],
      rowCount: 1,
    })],
  ]);

  const r = await dropItem(pool, entry, 'u1', 31, 'i1', { ttlMs: 1000 });

  assert.strictEqual(r.ok, true);
  // See the atomicity test above for why this now scopes to DROP_RE rather
  // than the total call count (SOMET-245 final review Critical #1 added a
  // preliminary read-only stone_instances check ahead of this CTE).
  assert.strictEqual(pool.matching(DROP_RE).length, 1,
    'the eject must ride the SAME statement as the delete+insert, not a second query');
  const q = pool.matching(DROP_RE)[0];
  assert.match(q.sql, /UPDATE stone_instances SET socketed_into_id = NULL FROM d WHERE stone_instances\.socketed_into_id = \$1/i,
    'must eject any stone socketed into the dropped item, keyed on the same $1 (itemId) as the delete');
});

test('a successful drop spawns a ground item at the player centre and removes the instance', async () => {
  const entry = armDropEntry();
  const pool = scriptedPool([
    [DROP_RE, (p) => ({
      rows: [{ id: 'g9', item_type_id: 7, x: p[3], y: p[4], expires_at: '2999-01-01T00:00:00Z' }],
      rowCount: 1,
    })],
  ]);

  const r = await dropItem(pool, entry, 'u1', 31, 'i1', { ttlMs: 1000 });

  assert.strictEqual(r.ok, true);
  const p = entry.world.getPlayer('u1');
  const q = pool.matching(DROP_RE)[0];
  // (itemId, characterId, worldId, cx, cy): the ownership predicate binds the
  // CHARACTER, not the account -- inventory is per-character since SOMET-257.
  assert.deepStrictEqual(q.params.slice(0, 5), ['i1', 31, 'w1', p.x + p.width / 2, p.y + p.height / 2]);
  assert.strictEqual(entry.world.groundItems.count(), 1);
  assert.strictEqual(p.inv.items.length, 0, 'no longer owned');
});

// Finding 1: without a grace window, dropItem spawns the ground item at the
// player's exact centre, and the tick's auto-loot scan (within(pcx, pcy,
// PICKUP_RADIUS) from that same centre) finds it at distance 0 and re-claims
// it inside one tick — drop becomes a silent no-op for a player with
// auto-loot on. These tests drive dropGraceActive directly with explicit
// `now` values (never a real sleep) so the window's expiry is deterministic.
function scriptedDropPool() {
  return scriptedPool([
    [DROP_RE, (p) => ({
      rows: [{ id: 'g9', item_type_id: 7, x: p[3], y: p[4], expires_at: '2999-01-01T00:00:00Z' }],
      rowCount: 1,
    })],
  ]);
}

test('(a) a freshly-dropped item is inside the dropper\'s grace window: auto-loot must skip it', async () => {
  const entry = armDropEntry();
  const pool = scriptedDropPool();
  const now = 1_000_000;

  const r = await dropItem(pool, entry, 'u1', 31, 'i1', { ttlMs: 1000, now });

  const p = entry.world.getPlayer('u1');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(
    dropGraceActive(p, r.item.id, now + 1000), true,
    '1s after the drop, well inside the 3s window, auto-loot must still skip this item',
  );
});

test('(b) the grace window expires: auto-loot may claim the drop once it has', async () => {
  const entry = armDropEntry();
  const pool = scriptedDropPool();
  const now = 1_000_000;

  const r = await dropItem(pool, entry, 'u1', 31, 'i1', { ttlMs: 1000, now });

  const p = entry.world.getPlayer('u1');
  const after = now + DROP_GRACE_MS + 1;
  assert.strictEqual(
    dropGraceActive(p, r.item.id, after), false,
    'once the grace window has elapsed, auto-loot must be allowed to claim the drop',
  );
});

test('(c) manual pickup ignores the grace window entirely: claimItem succeeds even while grace is active', async () => {
  // claimItem is the single claim path shared by manual pickup and
  // auto-loot; it must not consult dropGrace itself, so a deliberate
  // keypress on a just-dropped item always succeeds. Only the tick's
  // auto-loot scan (in server.js) is expected to check dropGraceActive
  // before calling claimItem at all.
  const entry = armClaimEntry(); // ground item 'g1' present, player 'u1'
  const p = entry.world.getPlayer('u1');
  p.dropGrace.set('g1', Date.now() + 60000); // deep inside an active grace window
  const pool = scriptedPool([
    [CLAIM_RE, { rows: [{ id: 'inst-1', item_type_id: 7 }], rowCount: 1 }],
  ]);

  const got = await claimItem(pool, entry, 'u1', 31, 'g1');

  assert.deepStrictEqual(got, { id: 'inst-1', typeId: 7, quantity: 1 },
    'manual pickup (claimItem) is unaffected by an active grace window');
});

test('(d) dropGraceActive prunes only the expired entry it checks, without disturbing unrelated entries', () => {
  const entry = armDropEntry();
  const p = entry.world.getPlayer('u1');
  p.dropGrace.set('expired-1', 100); // already expired as of now=200
  p.dropGrace.set('still-active', 5000); // not yet expired as of now=200
  assert.strictEqual(p.dropGrace.size, 2);

  assert.strictEqual(dropGraceActive(p, 'expired-1', 200), false);

  assert.strictEqual(p.dropGrace.has('expired-1'), false, 'expired entry is pruned as it is checked');
  assert.strictEqual(p.dropGrace.has('still-active'), true, 'unrelated, still-active entry is left alone');
  assert.strictEqual(p.dropGrace.size, 1, 'the map does not grow without bound');
});
