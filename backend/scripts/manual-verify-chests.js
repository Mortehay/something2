#!/usr/bin/env node
// ONE-OFF, THROWAWAY verification aid for Task 7 (SOMET-244, "Chests, Guards
// and Loot Maps"), NOT part of the automated suite (not under tests/, not
// run by `npm test`). Its purpose is to exercise the real chest feature at
// the actual WebSocket protocol level -- a real standalone instance of THIS
// worktree's backend authority code, talking to the real shared dev
// Postgres, driven by a real `ws` client sending real `join`/`openchest`/
// `use` frames -- as the CLI/API-level substitute for the browser
// verification this feature has no frontend surface for yet (see
// task-7-report.md for the full writeup, including why this exists and what
// it found).
//
// Deliberately does NOT boot backend/src/index.js: that file unconditionally
// calls runMigrations() (node-pg-migrate up) whenever require.main === module,
// and this task's own DB-safety rules forbid running migrate up/down against
// the live shared DB. Calling attachAuthority() directly -- the exact same
// call index.js itself makes right after app.listen() -- gets the real
// authority/WS layer against a real pg Pool with zero migration side effect
// and no dependency on the REST layer (auth here is a JWT signed with the
// same JWT_SECRET the real server uses, matching how every WS integration
// test in this repo already authenticates).
//
// Safe to delete after review; kept (per the task's own instructions) as a
// documented one-off rather than silently discarded, in case a future task
// needs the same kind of exercise once the DB-state issue this script
// surfaced (see below) is resolved.
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { Pool } = require('pg');
const { applyMapSpec } = require('./seed-map.js');
const { attachAuthority } = require('../src/authority/server.js');

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://user:password@localhost:15432/game_db';
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = Number(process.env.VERIFY_PORT) || 13102; // NEVER 13101 -- that's the live shared stack

const WORLD_NAME = 'zz Manual Verify Chest World';

function log(...args) { console.log(new Date().toISOString(), ...args); }

async function withEntryPreserved(pool, fn) {
  const before = await pool.query('SELECT id FROM worlds WHERE is_entry = true');
  const beforeId = before.rows[0]?.id ?? null;
  try {
    return await fn();
  } finally {
    await pool.query(
      'UPDATE worlds SET is_entry = COALESCE(id = $1, false) WHERE is_entry = true OR id = $1',
      [beforeId],
    );
  }
}

async function cleanup(pool) {
  await pool.query('DELETE FROM worlds WHERE name = $1', [WORLD_NAME]).catch((e) => log('cleanup world:', e.message));
  await pool.query("DELETE FROM users WHERE username LIKE 'zz-manual-verify-chest-%'").catch((e) => log('cleanup user:', e.message));
}

function connect(url, token) {
  return new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
}
function nextMsg(ws, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('timeout waiting for a message')), timeoutMs);
    ws.once('message', (data) => { clearTimeout(to); resolve(JSON.parse(data)); });
    ws.once('close', (code, reason) => { clearTimeout(to); reject(new Error(`socket closed before a message arrived (code ${code} ${reason})`)); });
    ws.once('error', (err) => { clearTimeout(to); reject(err); });
  });
}

async function main() {
  if (!JWT_SECRET) throw new Error('JWT_SECRET is not set -- source .env first (see task-7-report.md)');

  const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000 });
  await pool.query('SELECT 1');
  log('connected to', DATABASE_URL);

  await cleanup(pool);

  let worldId; let chestId; let guardCreatureId;
  await withEntryPreserved(pool, async () => {
    const spec = {
      name: 'zz-manual-verify-chest',
      topology: 'spine',
      worlds: [{
        key: 'a', name: WORLD_NAME, grid: [40, 40], seed: 909,
        width: 10, height: 10, chunk_size: 64, biomes: [], biome_cell: 32,
        allowed_creature_types: [], is_entry: true,
        chest: {
          x: 500, y: 500, guard_creature_type: 'Wolf', level: 3,
        },
      }],
      links: [],
    };
    const result = await applyMapSpec(pool, spec);
    log('applyMapSpec result:', result);
  });

  const world = await pool.query('SELECT id FROM worlds WHERE name = $1', [WORLD_NAME]);
  worldId = world.rows[0].id;
  const chest = await pool.query('SELECT id, guard_creature_ids, state FROM world_chests WHERE world_id = $1', [worldId]);
  chestId = chest.rows[0].id;
  guardCreatureId = chest.rows[0].guard_creature_ids[0];
  log('seeded world', worldId, 'chest', chestId, 'guard', guardCreatureId, 'state', chest.rows[0].state);

  const userRow = await pool.query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player') RETURNING id`,
    [`zz-manual-verify-chest-${Date.now()}`],
  );
  const userId = userRow.rows[0].id;
  // SOMET-257/260 re-keyed player state onto CHARACTERS, and `join` now
  // refuses a frame whose character_id is not one of the token holder's --
  // deliberately, with no "first character" fallback. This script predates
  // that and stopped at "unknown character"; a character of its own is all it
  // needs to reach the chest again (SOMET-438).
  const charRow = await pool.query(
    `INSERT INTO characters (user_id, slot, name, entity_type_id)
     SELECT $1, 1, $2, (SELECT id FROM entity_types WHERE is_playable = true ORDER BY id LIMIT 1)
     RETURNING id`,
    [userId, `zz-manual-verify-chest-char-${Date.now()}`],
  );
  const characterId = charRow.rows[0].id;
  log('created test user', userId, 'character', characterId);

  // Granted BEFORE the socket opens, deliberately. `use` resolves the item id
  // against the inventory the authority loaded AT JOIN, so a row inserted
  // afterwards is genuinely not owned as far as this session is concerned --
  // which is what "you do not own that item" meant when this script granted it
  // mid-session. The check is right; the grant was in the wrong place.
  // player_items is keyed by CHARACTER since SOMET-257/260, not by account.
  const lm = await pool.query("SELECT id FROM item_types WHERE name = 'loot_map'");
  const piRow = await pool.query(
    'INSERT INTO player_items (character_id, item_type_id, quantity) VALUES ($1,$2,1) RETURNING id',
    [characterId, lm.rows[0].id],
  );
  const lootMapItemId = piRow.rows[0].id;
  log('granted a loot_map before join, item', lootMapItemId);

  // SOMET-266 authorizes every join server-side. A brand-new character has no
  // history, so the only worlds it may enter are the entry world and any world
  // flagged for fast travel -- rule 5 in joinPolicy. Flagging this throwaway
  // world is the legal path in (and leaves is_entry alone, which the live
  // region needs); without it the exercise stops at "you cannot travel there".
  await pool.query('UPDATE worlds SET allows_fast_travel = true WHERE id = $1', [worldId]);

  const server = http.createServer();
  const handle = attachAuthority(server, pool, {
    jwtSecret: JWT_SECRET, tickMs: 50, creatureBroadcastEvery: 4, creatureFlushMs: 5000,
  });
  await new Promise((resolve) => server.listen(PORT, resolve));
  const url = `ws://127.0.0.1:${PORT}/authority`;
  log(`standalone worktree backend listening at ${url} (this worktree's code, NOT the live 13101 stack)`);

  const token = jwt.sign({ user_id: userId, tv: 1 }, JWT_SECRET, { algorithm: 'HS256' });
  const ws = connect(url, token);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  log('WS connection open');

  try {
    log('--- sending: join ---');
    ws.send(JSON.stringify({ type: 'join', world_id: worldId, character_id: characterId }));
    const joined = await nextMsg(ws);
    log('received:', JSON.stringify(joined));

    if (joined.type !== 'joined') {
      log('join did not succeed -- stopping the WS-level exercise here; see task-7-report.md for why');
      return;
    }

    log('--- sending: openchest (guard still alive -- expect a rejection) ---');
    ws.send(JSON.stringify({ type: 'openchest' }));
    log('received:', JSON.stringify(await nextMsg(ws)));

    log('--- killing the guard directly (DELETE FROM world_creatures), exercising openChest\'s real guard-alive re-check honestly ---');
    await pool.query('DELETE FROM world_creatures WHERE id = $1', [guardCreatureId]);

    log('--- sending: openchest (guard dead -- expect chestOpened with real granted items) ---');
    ws.send(JSON.stringify({ type: 'openchest' }));
    log('received:', JSON.stringify(await nextMsg(ws)));

    log('--- sending: openchest again (already opened -- expect a clear rejection) ---');
    ws.send(JSON.stringify({ type: 'openchest' }));
    log('received:', JSON.stringify(await nextMsg(ws)));

    log('--- sending: use, on the loot_map granted before join ---');
    ws.send(JSON.stringify({ type: 'use', itemId: lootMapItemId }));
    log('received:', JSON.stringify(await nextMsg(ws)));
  } finally {
    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    handle.close();
    await new Promise((resolve) => server.close(resolve));
    await cleanup(pool);
    await pool.end();
    log('torn down: WS closed, standalone server closed, zz-prefixed rows deleted, pool ended');
  }
}

main().catch((err) => {
  console.error('manual-verify-chests FAILED:', err);
  process.exitCode = 1;
});
