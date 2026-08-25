const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachAuthority } = require('../src/authority/server.js');

// SOMET-490 -- a dropped item's rarity grade has to REACH the client, or the
// glow has nothing to colour itself with.
//
// The pure GroundItemSim half is covered in groundItems.test.js. This file
// exists because that unit test stays green with the whole feature unwired:
// the grade only becomes visible if activateChunk's explicit SELECT column
// list names `rarity` AND broadcastItems' snapshot carries it. This epic has
// now shipped four separate features that were inert behind green unit tests,
// twice for exactly this reason -- a column missing from an explicit SELECT.
//
// Hence the COLUMN-HONEST pool below: like a real database, it returns only
// the columns the statement asked for. A SELECT that stops naming `rarity`
// therefore yields a row with no rarity, exactly as Postgres would, and these
// tests go red instead of quietly passing on a fixture that over-supplies.
//
// Fake-pool shape, bootWith and nextMsg mirror
// authority_groundItems_integration.test.js, whose walk-away-and-back recipe
// the reactivation test below reuses verbatim.

const SECRET = 'test-secret';

function token(u) { return jwt.sign({ user_id: u, tv: 1 }, SECRET, { algorithm: 'HS256' }); }
function connect(url, uid) { return new WebSocket(`${url}?token=${encodeURIComponent(token(uid))}`); }

function bootWith(pool, opts = {}) {
  return new Promise((resolve) => {
    const server = http.createServer();
    const handle = attachAuthority(server, pool, {
      jwtSecret: SECRET, tickMs: 20, creatureBroadcastEvery: 2, creatureFlushMs: 100, ...opts,
    });
    server.listen(0, () => resolve({ url: `ws://127.0.0.1:${server.address().port}/authority`, handle, server }));
  });
}

function nextMsg(ws, type) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout ${type}`)), 4000);
    ws.on('message', function onMsg(data) {
      const m = JSON.parse(data);
      if (!type || m.type === type) { clearTimeout(to); ws.off('message', onMsg); resolve(m); }
    });
  });
}

// Wait for an 'items' frame that actually contains `id`. Early frames are
// legitimately empty (the chunk has not activated yet), and asserting on the
// first one would test the race rather than the wire.
async function itemsFrameContaining(ws, id, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    const m = await nextMsg(ws, 'items');
    const hit = (m.items || []).find((it) => it.id === id);
    if (hit) return hit;
  }
  return null;
}

const CLAIM_RE = /^\s*WITH d AS/i;
const ITEMS_SELECT_RE = /SELECT[\s\S]*FROM world_items/i;

// The whole point of this file. Given the statement text and the full stored
// row, hand back ONLY the columns the SELECT list names -- what pg does.
function projectSelectedColumns(sql, row) {
  const m = /SELECT\s+([\s\S]*?)\s+FROM\s+world_items/i.exec(sql);
  if (!m) return { ...row };
  const out = {};
  for (const raw of m[1].split(',')) {
    const col = raw.trim().split(/\s+AS\s+/i).pop().trim();
    if (Object.prototype.hasOwnProperty.call(row, col)) out[col] = row[col];
  }
  return out;
}

// Sanity check on the harness itself: a fake pool whose projection silently
// did nothing would make every assertion below vacuous.
test('the fake pool projects a row through the SELECT column list (harness self-check)', () => {
  const row = { id: 'g1', item_type_id: 7, x: 1, y: 2, expires_at: 'z', rarity: 'foxy' };
  assert.deepStrictEqual(
    projectSelectedColumns('SELECT id, item_type_id, x, y, expires_at, rarity FROM world_items WHERE 1', row),
    row,
  );
  assert.deepStrictEqual(
    projectSelectedColumns('SELECT id, item_type_id, x, y, expires_at FROM world_items WHERE 1', row),
    { id: 'g1', item_type_id: 7, x: 1, y: 2, expires_at: 'z' },
    'a SELECT that omits rarity must yield a row with no rarity, as Postgres would',
  );
});

function makePool(chunkSize, { storedItemsFor } = {}) {
  const calls = [];
  const pool = {
    calls,
    matching(re) { return calls.filter((c) => re.test(c.sql)); },
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM worlds WHERE id/i.test(sql)) return { rows: [{ id: 'w1', seed: '1', chunk_size: chunkSize }] };
      if (/token_version.*FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1 }] };
      if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
      if (/FROM entity_types e[\s\S]*WHERE e\.is_creature/i.test(sql)) return { rows: [] };
      if (/INSERT INTO world_chunks/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM characters/i.test(sql)) return { rows: [{ id: Number(params[0]), entity_type_id: 1 }] };
      if (/FROM worlds w WHERE w\.id/i.test(sql)) {
        return { rows: [{ is_entry: true, allows_fast_travel: false, visited: false, visited_any: false, last_world: null }] };
      }
      if (/FROM world_players WHERE/i.test(sql)) return { rows: [] };
      if (/FROM world_creatures/i.test(sql)) return { rows: [] };
      if (/INSERT INTO world_players/i.test(sql)) return { rows: [] };
      if (/^\s*DELETE FROM world_items WHERE expires_at/i.test(sql)) return { rows: [], rowCount: 0 };
      if (CLAIM_RE.test(sql)) return { rows: [{ id: 'inst-1', item_type_id: 7 }], rowCount: 1 };
      if (ITEMS_SELECT_RE.test(sql)) {
        const stored = (storedItemsFor && storedItemsFor(params)) || [];
        const rows = stored.map((r) => projectSelectedColumns(sql, r));
        return { rows, rowCount: rows.length };
      }
      return { rows: [] };
    },
  };
  pool.connect = async () => ({ query: pool.query, release: () => {} });
  return pool;
}

// chunk (0,0) of a chunk_size-8 world spans [0,800) on both axes; the
// world-center spawn is (400,400), so an item at (420,420) is right there.
function inChunk00(params) { return params[1] === 0 && params[3] === 0; }
const AT_SPAWN = (rarity) => ({ id: 'g1', item_type_id: 7, x: 420, y: 420, expires_at: '2999-01-01T00:00:00Z', rarity });

test('the items broadcast carries a dropped item\'s rarity grade', async () => {
  const pool = makePool(8, { storedItemsFor: (p) => (inChunk00(p) ? [AT_SPAWN('foxy')] : []) });
  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  try {
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
    await nextMsg(ws, 'joined');

    const wired = await itemsFrameContaining(ws, 'g1');
    assert.ok(wired, 'the loaded ground item reached an items broadcast at all');
    assert.strictEqual(wired.rarity, 'foxy',
      'the grade must survive the chunk SELECT, the sim and the snapshot; a white here means one of the three dropped it');
  } finally { ws.close(); handle.close(); server.close(); }
});

test('a white item is wired as white, so it can render exactly as it did before this feature', async () => {
  // AC4. The two grades must be DISTINGUISHABLE on the wire -- a pipeline that
  // reports 'white' for everything would pass the test above if that test were
  // the only one, since it never sees a second grade.
  const pool = makePool(8, { storedItemsFor: (p) => (inChunk00(p) ? [AT_SPAWN('white')] : []) });
  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  try {
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
    await nextMsg(ws, 'joined');
    const wired = await itemsFrameContaining(ws, 'g1');
    assert.ok(wired);
    assert.strictEqual(wired.rarity, 'white');
  } finally { ws.close(); handle.close(); server.close(); }
});

test('a pre-SOMET-480 row with no rarity value at all reaches the client as white', async () => {
  // A row whose rarity is NULL (or a statement that never had the column):
  // it must arrive as the grade that draws nothing, not as `undefined`, which
  // a client-side `rarity !== 'white'` test would treat as "glow".
  const pool = makePool(8, {
    storedItemsFor: (p) => (inChunk00(p)
      ? [{ id: 'g1', item_type_id: 7, x: 420, y: 420, expires_at: '2999-01-01T00:00:00Z' }]
      : []),
  });
  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  try {
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
    await nextMsg(ws, 'joined');
    const wired = await itemsFrameContaining(ws, 'g1');
    assert.ok(wired);
    assert.strictEqual(wired.rarity, 'white');
  } finally { ws.close(); handle.close(); server.close(); }
});

test('the grade survives a chunk deactivate/reactivate cycle', async () => {
  // AC2, through the REAL lifecycle: walk out of the item's chunk
  // neighborhood so flushAndPrune's pruneInactive forgets the entry, then walk
  // back so recomputeActive re-activates the chunk and re-SELECTs the row.
  // Travel distance is kept short with chunk_size 1 (100px spans), the same
  // trick authority_groundItems_integration.test.js uses.
  //
  // The DB row never changes. The only way the grade can come back wrong is if
  // the reload path fails to carry it -- which is precisely the bug this
  // criterion exists to prevent, and which reads in-game as a glow that
  // flickers off when you walk away and come back.
  let loads = 0;
  const pool = makePool(1, {
    storedItemsFor: (p) => {
      if (!(p[1] === 0 && p[3] === 0)) return [];
      loads += 1;
      return [{ id: 'g1', item_type_id: 7, x: 90, y: 90, expires_at: '2999-01-01T00:00:00Z', rarity: 'foxy' }];
    },
  });

  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  try {
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
    const joined = await nextMsg(ws, 'joined');
    const spawnX = joined.spawn.x;

    const before = await itemsFrameContaining(ws, 'g1');
    assert.ok(before && before.rarity === 'foxy', 'baseline: the grade is on the wire before the walk');

    // Away.
    ws.send(JSON.stringify({ type: 'input', seq: 1, dx: 1, dy: 0 }));
    let far = null;
    for (let i = 0; i < 200 && !far; i += 1) {
      const s = await nextMsg(ws, 'state');
      const me = s.players.find((p) => p.id === '1');
      if (me && me.x >= spawnX + 300) far = me;
    }
    assert.ok(far, 'player walked clear of the item\'s chunk neighborhood');
    // Let the 100ms creatureFlushTimer run flushAndPrune while chunk (0,0) is
    // out of the active set.
    await new Promise((r) => setTimeout(r, 300));

    // Back.
    ws.send(JSON.stringify({ type: 'input', seq: 2, dx: -1, dy: 0 }));
    let home = null;
    for (let i = 0; i < 200 && !home; i += 1) {
      const s = await nextMsg(ws, 'state');
      const me = s.players.find((p) => p.id === '1');
      if (me && me.x <= spawnX + 20) home = me;
    }
    assert.ok(home, 'player walked back into the item\'s chunk neighborhood');
    ws.send(JSON.stringify({ type: 'input', seq: 3, dx: 0, dy: 0 }));

    const after = await itemsFrameContaining(ws, 'g1');
    assert.ok(after, 'the item is broadcast again after the chunk reactivated');
    assert.strictEqual(after.rarity, 'foxy',
      'the grade must come back with the item; a white here is the glow-flicker bug');
    // Sanity: the round trip really did go through the DB again rather than
    // being answered from a sim entry that was never evicted.
    assert.ok(loads >= 2, `chunk (0,0) was re-SELECTed after the walk (loads=${loads})`);
  } finally { ws.close(); handle.close(); server.close(); }
});
