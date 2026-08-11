#!/usr/bin/env node
// ONE-OFF, THROWAWAY verification aid for Task 8 (SOMET-245, "Magic Stones
// and Sockets"), NOT part of the automated suite (not under tests/, not run
// by `npm test`). Same posture as manual-verify-chests.js (Task 7 of the
// earlier chests sub-project, read in full before writing this): a real
// WebSocket client driving a real standalone instance of THIS worktree's
// backend authority code, as the CLI/API-level substitute for the browser
// verification this feature has no frontend surface for yet.
//
// A wrinkle manual-verify-chests.js did NOT have: this branch's schema
// migrations (1714440165000_stone_item_type.js, category='stone' +
// stat_bonus_* columns; 1714440166000_stone_instances.js, the socket table
// + its partial unique index) have NOT been applied to the shared dev DB
// (by design -- this project's rules forbid running `migrate up`/`down`
// against a database a concurrent human session may be using). Booting
// attachAuthority with a real `pg.Pool` straight against that DB, the way
// manual-verify-chests.js does, would make every stone-catalog INSERT and
// every stone_instances query fail outright.
//
// The fix is the SAME transactional-test technique
// stones_integration_db.test.js uses (read that file's header comment for
// the full derivation): one dedicated `pg.Client`, one outer transaction
// that applies both schema migrations and is NEVER committed, and a
// `savepointPool` wrapper that translates the literal 'BEGIN'/'COMMIT'/
// 'ROLLBACK' strings real application code (socketStone/unsocketStone,
// seed-map.js's applyMapSpec) issues into SAVEPOINT/RELEASE SAVEPOINT/
// ROLLBACK TO SAVEPOINT against that same open transaction, instead of
// letting them actually commit. `attachAuthority` itself just needs
// something `.query()`/`.connect()`-shaped -- it has no idea this isn't a
// real Pool. Everything this script does, including the live WS protocol
// traffic, therefore runs against a real Postgres session that is rolled
// back in its entirety at the end, exactly like the automated test file.
//
// Driven strictly SEQUENTIALLY (one WS round trip awaited fully before the
// next is sent) -- stones_integration_db.test.js's own header comment
// documents why genuinely concurrent/interleaved use of `savepointPool`
// corrupts the savepoint stack (Postgres RELEASE SAVEPOINT cascades to
// every savepoint opened after the one named). A single-player, one-frame-
// at-a-time manual verification never needs concurrent transactions on this
// one connection, so that hazard never comes up here -- but it is exactly
// why this script must never be adapted into a multi-client load test
// without first solving that problem for real (e.g. genuinely separate
// connections against a really-migrated database).
//
// KNOWN COSMETIC RISK, not a functional one: the live world's own tick loop
// (setInterval, tickMs) shares this SAME `client` (via `pool`/`savepointPool`
// above) with this script's own out-of-band verification queries
// (`client.query('SELECT ... FROM stone_instances ...')` after each step). A
// real run of this script has shown `pg`'s "Calling client.query() when the
// client is already executing a query is deprecated" warning when a tick's
// background query and a verification query landed close together -- `pg`
// queues rather than errors on this (deprecated, not yet removed), so it did
// not corrupt anything or fail the run, but it is a real seam: a single
// `Client` was never meant to serve two independent callers. Acceptable for
// a short, single-player, non-transactional verification query; would need
// a rethink (a genuinely separate connection, accepting that it cannot see
// this transaction's uncommitted schema) before ever scaling this script up.
//
// Safe to delete after review; kept as a documented one-off, same as
// manual-verify-chests.js.
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { Client } = require('pg');
const MigrationBuilder = require('node-pg-migrate/dist/migration-builder').default;
const migStoneType = require('../migrations/1714440165000_stone_item_type.js');
const migStoneInstances = require('../migrations/1714440166000_stone_instances.js');
const { applyMapSpec } = require('./seed-map.js');
const { attachAuthority } = require('../src/authority/server.js');

const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';
// A fixed, throwaway secret for THIS standalone process only -- it signs and
// verifies its own tokens against its own in-process attachAuthority
// instance and never talks to the real shared stack, so it does not need to
// (and, in this worktree, has no `.env` to) match the real JWT_SECRET.
const JWT_SECRET = 'zz-manual-verify-stones-secret';
const PORT = Number(process.env.VERIFY_PORT) || 13104; // NEVER 13101 (live) or 13102 (chests' own script's default)
const WORLD_NAME = 'zz Manual Verify Stones World';

function log(...args) { console.log(new Date().toISOString(), ...args); }

async function applyMigration(client, migModule, direction) {
  const pgm = new MigrationBuilder({}, {}, false, { debug() {}, info() {}, warn() {}, error() {} });
  migModule[direction](pgm);
  for (const sql of pgm.getSqlSteps()) await client.query(sql);
}

// See the file header for the full derivation. Only sequential, single-
// flight use is safe -- see the header's concurrency warning.
function savepointPool(client) {
  let counter = 0;
  const stack = [];
  async function query(sql, params) {
    const s = typeof sql === 'string' ? sql.trim() : sql;
    if (s === 'BEGIN') { const name = `zz_sp_${++counter}`; stack.push(name); return client.query(`SAVEPOINT ${name}`); }
    if (s === 'COMMIT') { const name = stack.pop(); return client.query(`RELEASE SAVEPOINT ${name}`); }
    if (s === 'ROLLBACK') { const name = stack.pop(); return client.query(`ROLLBACK TO SAVEPOINT ${name}`); }
    return client.query(sql, params);
  }
  return { query, connect: async () => ({ query, release: () => {} }) };
}

function connect(url, token) { return new WebSocket(`${url}?token=${encodeURIComponent(token)}`); }

// Buffers frames nobody has asked for yet, same technique (and same
// justification) as authority_socket_stone_integration.test.js's
// messageQueue: a socket/unsocket of a BUFF stone sends TWO frames
// ('socketed'/'unsocketed' immediately followed by 'progression') that can
// both arrive in one localhost read before a fresh single-shot listener for
// the second one is attached.
function messageQueue(ws) {
  const queue = [];
  const waiters = [];
  ws.on('message', (data) => {
    const m = JSON.parse(data);
    log('received:', JSON.stringify(m));
    const wi = waiters.findIndex((w) => !w.type || w.type === m.type);
    if (wi !== -1) { const [w] = waiters.splice(wi, 1); clearTimeout(w.to); w.resolve(m); } else queue.push(m);
  });
  return (type, timeoutMs = 4000) => {
    const qi = queue.findIndex((m) => !type || m.type === type);
    if (qi !== -1) return Promise.resolve(queue.splice(qi, 1)[0]);
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
      waiters.push({ type, resolve, to });
    });
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const client = new Client({ connectionString: DB_URL, connectionTimeoutMillis: 3000 });
  await client.connect();
  log('connected to', DB_URL, '(one dedicated connection, one never-committed transaction)');
  await client.query('BEGIN');
  await applyMigration(client, migStoneType, 'up');
  await applyMigration(client, migStoneInstances, 'up');
  log('applied 1714440165000 + 1714440166000 inside the transaction (uncommitted -- the shared dev DB is untouched)');
  const pool = savepointPool(client);

  let server; let handle; let worldId;
  try {
    // --- seed a minimal zz world (no chest -- unrelated to this feature) ---
    const spec = {
      name: 'zz-manual-verify-stones',
      topology: 'spine',
      worlds: [{
        key: 'a', name: WORLD_NAME, grid: [40, 40], seed: 707,
        width: 10, height: 10, chunk_size: 64, biomes: [], biome_cell: 32,
        allowed_creature_types: [], is_entry: true,
      }],
      links: [],
    };
    // Unlike manual-verify-chests.js, this script deliberately does NOT
    // restore whichever world was is_entry before seeding: the join below
    // needs THIS world to stay is_entry=true (or "reachable" refuses it --
    // see the failed first run of this script, caught exactly here), and
    // since this whole transaction is rolled back at the very end no matter
    // what, there is no real DB state to protect by restoring it mid-run.
    const seedResult = await applyMapSpec(pool, spec);
    log('applyMapSpec result:', seedResult);
    const world = await client.query('SELECT id FROM worlds WHERE name = $1', [WORLD_NAME]);
    worldId = world.rows[0].id;

    // --- catalog: a weak physical weapon, a strong fire spell stone, an
    // armor slot, and a constitution buff stone ---
    const tag = `${process.pid}-${Date.now()}`;
    async function insertItemType(fields) {
      const cols = Object.keys(fields); const vals = Object.values(fields);
      const r = await client.query(
        `INSERT INTO item_types (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        vals,
      );
      return r.rows[0].id;
    }
    const weaponTypeId = await insertItemType({
      name: `zz-stones-cli-wand-${tag}`, category: 'weapon', kind: 'melee',
      damage: 5, cooldown: 0.3, reach: 80, arc_width: 0.6, mana_cost: 0, element: null, stackable: false,
    });
    const spellStoneTypeId = await insertItemType({
      name: `stone_of_zz_cli_${tag}`, category: 'stone', element: 'fire', damage: 25, cooldown: 0.5, mana_cost: 0, stackable: false,
    });
    const armorTypeId = await insertItemType({
      name: `zz-stones-cli-armor-${tag}`, category: 'armor', slot: 'chest', damage: 0, cooldown: 0, defense: 3, stackable: false,
    });
    const buffStoneTypeId = await insertItemType({
      name: `stone_of_zz_cli_vigor_${tag}`, category: 'stone', stat_bonus_stat: 'constitution', stat_bonus_amount: 2, damage: 0, cooldown: 0, stackable: false,
    });
    log('seeded item types', { weaponTypeId, spellStoneTypeId, armorTypeId, buffStoneTypeId });

    // --- a zz user + character, pre-equipped (weapon in main_hand, armor
    // in chest) so the script can go straight to socketing over WS ---
    const userRow = await client.query(
      `INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player') RETURNING id`,
      [`zz-manual-verify-stones-${tag}`],
    );
    const userId = userRow.rows[0].id;
    const entityType = await client.query(`SELECT id FROM entity_types WHERE name = 'Warrior'`);
    if (entityType.rowCount !== 1) throw new Error('setup: the Warrior entity type must exist');
    const character = await client.query(
      `INSERT INTO characters (user_id, slot, name, entity_type_id) VALUES ($1, 1, $2, $3) RETURNING id`,
      [userId, `zz-manual-verify-stones-char-${tag}`, entityType.rows[0].id],
    );
    const characterId = character.rows[0].id;

    async function grantItem(itemTypeId) {
      const r = await client.query(
        `INSERT INTO player_items (id, character_id, item_type_id, quantity) VALUES (gen_random_uuid(), $1, $2, 1) RETURNING id`,
        [characterId, itemTypeId],
      );
      return r.rows[0].id;
    }
    const weaponItemId = await grantItem(weaponTypeId);
    const spellStoneItemId = await grantItem(spellStoneTypeId);
    const armorItemId = await grantItem(armorTypeId);
    const buffStoneItemId = await grantItem(buffStoneTypeId);
    await client.query('INSERT INTO stone_instances (player_item_id) VALUES ($1)', [spellStoneItemId]);
    await client.query('INSERT INTO stone_instances (player_item_id) VALUES ($1)', [buffStoneItemId]);
    await client.query(
      `INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1, 'main_hand', $2), ($1, 'chest', $3)`,
      [characterId, weaponItemId, armorItemId],
    );
    log('seeded character', characterId, 'with weapon/armor equipped, spell+buff stones loose', {
      weaponItemId, spellStoneItemId, armorItemId, buffStoneItemId,
    });

    // --- boot a standalone instance of THIS worktree's real authority code
    // against the savepoint-wrapped pool ---
    server = http.createServer();
    handle = attachAuthority(server, pool, {
      jwtSecret: JWT_SECRET, tickMs: 50, creatureBroadcastEvery: 4, creatureFlushMs: 300000,
      flushMs: 300000, heartbeatMs: 300000, itemSweepMs: 300000,
    });
    await new Promise((resolve) => server.listen(PORT, resolve));
    const url = `ws://127.0.0.1:${PORT}/authority`;
    log(`standalone worktree backend listening at ${url}`);

    const token = jwt.sign({ user_id: userId, tv: 1 }, JWT_SECRET, { algorithm: 'HS256' });
    const ws = connect(url, token);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const next = messageQueue(ws);
    log('WS connection open');

    try {
      log('--- sending: join ---');
      ws.send(JSON.stringify({ type: 'join', character_id: characterId, world_id: worldId }));
      const joined = await next('joined');
      if (joined.type !== 'joined') throw new Error('join failed -- stopping here');

      const entry = handle.worlds.get(worldId);
      // World's live player map is keyed by ws.userId, which server.js's
      // upgrade handler sets via `String(payload.user_id)` (read in full
      // before writing this) -- always a string, regardless of whatever
      // type Postgres handed back for `userId` above. getPlayer(userId)
      // (unstringified) looks up the wrong Map key and returns undefined.
      const wsUserId = String(userId);
      const player = entry.world.getPlayer(wsUserId);
      // Same reach/arc/geometry as authority_world_combat.test.js and
      // stones_integration_db.test.js's own fixture: player centre (132,132),
      // creature at (150,108), aim due east -- already proven to land.
      player.x = 100; player.y = 100;
      entry.world.creatures.addCreatures([{
        id: 'zz-cli-target', type: 'Wolf', x: 150, y: 108, hp: 500, facing: 'S', color: '#c00',
      }]);
      log('placed player at (100,100) and a 500hp target creature at (150,108)');

      log('--- sending: socket (spell stone -> weapon) ---');
      ws.send(JSON.stringify({ type: 'socket', stoneId: spellStoneItemId, hostId: weaponItemId }));
      const socketedSpell = await next('socketed');
      log('spell stone socketed:', JSON.stringify(socketedSpell));

      log('--- sending: attack (east, into the target creature) ---');
      ws.send(JSON.stringify({ type: 'attack', ax: 1, ay: 0 }));
      await sleep(150); // melee is synchronous server-side, but give the WS round trip a moment
      const creatureAfter = entry.world.creatures.get('zz-cli-target');
      const hpLost = 500 - creatureAfter.hp;
      log(`creature hp after the swing: ${creatureAfter.hp} (lost ${hpLost})`);
      if (hpLost !== 25) {
        throw new Error(`expected the swing to deal the SOCKETED STONE's damage (25, fire), not the bare weapon's own (5) -- lost ${hpLost}. Combat did not read the socketed stone.`);
      }
      log('CONFIRMED: the attack read the socketed spell stone\'s damage/element, not the weapon\'s own baked-in values');

      const xpRow = await client.query('SELECT xp FROM stone_instances WHERE player_item_id = $1', [spellStoneItemId]);
      log('spell stone xp after the landed hit (awarded by the real onStoneHit path):', xpRow.rows[0].xp);
      if (Number(xpRow.rows[0].xp) <= 0) throw new Error('expected the landed hit to award stone XP via the real server-side onStoneHit path');
      log('CONFIRMED: stone XP was awarded automatically by the real attack handler, not by this script');

      log('--- sending: socket (buff stone -> armor) ---');
      const hpBefore = player.maxHp;
      ws.send(JSON.stringify({ type: 'socket', stoneId: buffStoneItemId, hostId: armorItemId }));
      const socketedBuff = await next('socketed');
      log('buff stone socketed:', JSON.stringify(socketedBuff));
      const progressionAfterSocket = await next('progression');
      log('progression frame after socketing the buff stone:', JSON.stringify(progressionAfterSocket));
      // The 'progression' frame's own `progression` field is deliberately the
      // RAW (unbuffed) DB row by design (see server.js's other progression
      // sites, and authority_socket_stone_integration.test.js's own header
      // comment on this) -- the buffed bundle is applied straight to the
      // LIVE player object via applyDerivedStats, not echoed into the frame.
      // The observable proof of "a stat bonus is reflected" is therefore
      // BOTH the frame's arrival (confirming the re-derive fired) AND the
      // live player's maxHp, checked here.
      if (player.maxHp !== hpBefore + 20) { // +2 constitution * HP_PER_CON(10)
        throw new Error(`expected maxHp to rise by 20 (2 constitution * HP_PER_CON) right away -- was ${hpBefore}, now ${player.maxHp}`);
      }
      log(`CONFIRMED: maxHp rose from ${hpBefore} to ${player.maxHp} immediately on socketing the buff stone (a progression frame also arrived, matching the brief)`);

      log('--- sending: unsocket (spell stone, forced SURVIVE) ---');
      const origRandom = Math.random;
      Math.random = () => 0.99; // forces rollDestroy false
      ws.send(JSON.stringify({ type: 'unsocket', stoneId: spellStoneItemId, confirm: true }));
      let unsocketed = await next('unsocketed');
      Math.random = origRandom;
      log('unsocket (forced survive):', JSON.stringify(unsocketed));
      if (unsocketed.destroyed !== false) throw new Error('expected the forced-survive roll to survive');
      const surviveRow = await client.query('SELECT socketed_into_id, xp FROM stone_instances WHERE player_item_id = $1', [spellStoneItemId]);
      if (surviveRow.rowCount !== 1 || surviveRow.rows[0].socketed_into_id !== null) {
        throw new Error('expected the survived stone to be loose (socketed_into_id NULL), still owned');
      }
      log(`CONFIRMED: the spell stone survived, ejected, xp intact (${surviveRow.rows[0].xp})`);

      log('--- sending: socket (re-socket the survived spell stone), then unsocket (forced DESTROY) ---');
      ws.send(JSON.stringify({ type: 'socket', stoneId: spellStoneItemId, hostId: weaponItemId }));
      await next('socketed');
      Math.random = () => 0; // forces rollDestroy true
      ws.send(JSON.stringify({ type: 'unsocket', stoneId: spellStoneItemId, confirm: true }));
      unsocketed = await next('unsocketed');
      Math.random = origRandom;
      log('unsocket (forced destroy):', JSON.stringify(unsocketed));
      if (unsocketed.destroyed !== true) throw new Error('expected the forced-destroy roll to destroy the stone');
      const destroyedItem = await client.query('SELECT 1 FROM player_items WHERE id = $1', [spellStoneItemId]);
      const destroyedInstance = await client.query('SELECT 1 FROM stone_instances WHERE player_item_id = $1', [spellStoneItemId]);
      if (destroyedItem.rowCount !== 0 || destroyedInstance.rowCount !== 0) {
        throw new Error('expected the destroyed stone\'s player_items AND stone_instances rows to both be gone');
      }
      log('CONFIRMED: the destroyed stone\'s player_items row and stone_instances row are both gone');

      log('--- sending: unsocket (buff stone, forced SURVIVE) -- confirm the maxHp bonus drops immediately too ---');
      const hpBeforeUnsocket = player.maxHp;
      Math.random = () => 0.99;
      ws.send(JSON.stringify({ type: 'unsocket', stoneId: buffStoneItemId, confirm: true }));
      const buffUnsocketed = await next('unsocketed');
      const progressionAfterUnsocket = await next('progression');
      Math.random = origRandom;
      log('buff stone unsocket:', JSON.stringify(buffUnsocketed), JSON.stringify(progressionAfterUnsocket));
      if (player.maxHp !== hpBeforeUnsocket - 20) {
        throw new Error(`expected maxHp to drop by 20 right away -- was ${hpBeforeUnsocket}, now ${player.maxHp}`);
      }
      log(`CONFIRMED: maxHp dropped from ${hpBeforeUnsocket} to ${player.maxHp} immediately on unsocketing the buff stone`);

      log('ALL STEPS CONFIRMED.');
    } finally {
      ws.close();
      await sleep(100);
    }
  } finally {
    if (handle) handle.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    // Always rollback, pass or fail -- nothing in this script is ever
    // committed. The shared dev DB never saw the schema migrations, the
    // world, the item types, the user, or any of it.
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
    log('torn down: WS closed, standalone server closed, transaction rolled back (zero residue), connection ended');
  }
}

main().catch((err) => {
  console.error('manual-verify-stones FAILED:', err);
  process.exitCode = 1;
});
