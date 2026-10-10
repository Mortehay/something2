// SOMET-609 (S9). The live authority on a real DB: a world with dungeon_boss
// loads with exactly one boss; killing it fires exactly ONE respawn path (the
// manager) -- no creature_respawns row, no world_creatures write, no
// WorldBossManager, no "death commit failed" -- and it comes back once after
// respawn_s, not before, not on reload, not twice.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { Pool } = require('pg');
const { attachAuthority } = require('../src/authority/server.js');
const { withFixtureWorld } = require('./helpers/fixtureWorld');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL' : false;

test('loadWorld selects dungeon_boss (explicit-column SELECT, SOMET-288/309 trap)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/authority/server.js'), 'utf8');
  const start = src.indexOf('async function loadWorld(');
  const body = src.slice(start, src.indexOf('\n  }\n', start));
  const m = /pool\.query\('SELECT ([^']+) FROM worlds WHERE id = \$1'/.exec(body);
  assert.ok(m, 'could not locate the worlds SELECT inside loadWorld');
  assert.ok(m[1].split(',').map((c) => c.trim()).includes('dungeon_boss'));
});

// Ruling P2: commitCreatureDeath writes through pool.connect() + client.query,
// not pool.query, so a spy on pool.query alone could never see the write this
// test exists to forbid. Both are recorded; restore() undoes both.
function spyPool(pool) {
  const queries = [];
  let connects = 0;
  const origQuery = pool.query;
  const origConnect = pool.connect;
  pool.query = function spiedQuery(sql, ...rest) {
    queries.push(String(sql && sql.text ? sql.text : sql));
    return origQuery.call(this, sql, ...rest);
  };
  pool.connect = async function spiedConnect(...a) {
    connects += 1;
    const client = await origConnect.apply(this, a);
    const cq = client.query;
    client.query = function spiedClientQuery(sql, ...rest) {
      queries.push(String(sql && sql.text ? sql.text : sql));
      return cq.call(this, sql, ...rest);
    };
    const release = client.release;
    client.release = function spiedRelease(...r) {
      client.query = cq;
      client.release = release;
      return release.apply(this, r);
    };
    return client;
  };
  return {
    queries,
    connects: () => connects,
    restore() { pool.query = origQuery; pool.connect = origConnect; },
  };
}

test('the P2 spy sees a write made through pool.connect (the spy is not blind)', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const spy = spyPool(pool);
    const c = await pool.connect();
    try { await c.query('SELECT count(*) FROM world_creatures WHERE false'); } finally { c.release(); }
    spy.restore();
    assert.equal(spy.connects(), 1);
    assert.ok(spy.queries.some((q) => /world_creatures/.test(q)), spy.queries.join('\n'));
  } finally {
    await pool.end();
  }
});

test('a placed dungeon boss: one instance, one respawn path, one respawn', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 4 });
  const server = http.createServer();
  let now = Date.now();
  const kills = [];
  const srv = attachAuthority(server, pool, {
    jwtSecret: 'test-secret', creatureSweepMs: 1e9, itemSweepMs: 1e9, heartbeatMs: 1e9,
    flushMs: 1e9, dungeonBossClock: () => now, onDungeonBossKilled: (k) => kills.push(k),
  });
  const errors = [];
  const origError = console.error;
  console.error = (...a) => { errors.push(a.map(String).join(' ')); origError(...a); };
  try {
    await withFixtureWorld(pool, async (worldId) => {
      await pool.query(
        `UPDATE worlds SET biomes = '["Deep Forest"]'::jsonb, level_min = 41, level_max = 50,
                dungeon_boss = $2::jsonb WHERE id = $1`,
        [worldId, JSON.stringify({ entity: 'Shade Herald', x: 4850, y: 4850, respawn_s: 600 })]);
      const id = `boss:${worldId}`;
      const bossesIn = (e) => e.world.creatures.all().filter((c) => c.bossTier);

      // 1. It was actually placed -- every later "nothing happened" assertion
      // is vacuous without this.
      let entry = await srv._loadWorld(worldId);
      assert.equal(bossesIn(entry).length, 1, 'placed on load');
      const c = entry.world.creatures.get(id);
      assert.ok(c, 'the boss sits under its fixed id');
      assert.equal(c.type, 'Shade Herald');
      assert.equal(c.bossTier, 'dungeon_elite');
      assert.equal(c.level, 47);
      assert.deepEqual(c.home, { x: 4850, y: 4850 });
      await srv._dungeonBosses.place(entry); // a second placement attempt
      assert.equal(bossesIn(entry).length, 1, 'double placement is a no-op');

      // A boss that moved is dirty; the 3 s creature flush must not try to
      // UPDATE a world_creatures row it does not have (the `boss:` id fails the
      // uuid cast, stays dirty, and would be retried every flush forever).
      c.dirty = true;
      const flushSpy = spyPool(pool);
      try {
        await srv._flushAndPrune(entry);
      } finally {
        flushSpy.restore();
      }
      assert.ok(!flushSpy.queries.some((q) => /world_creatures/.test(q)), flushSpy.queries.join('\n'));
      assert.equal(c.dirty, false, 'the boss is cleared, not retried every flush');
      assert.equal(bossesIn(entry).length, 1, 'the flush/prune keeps the boss');

      // 2. Kill it, with every other death path instrumented.
      let worldBossCalls = 0;
      const wbm = srv._worldBossManager;
      const origWb = wbm.onCreatureDeath;
      wbm.onCreatureDeath = async (...a) => { worldBossCalls += 1; return origWb.apply(wbm, a); };
      const spy = spyPool(pool);
      try {
        entry.world.creatures._removeKilled(c); // what every kill site does first
        await srv._onCreatureDeath(entry, id, null);
        await new Promise((r) => setTimeout(r, 50));
      } finally {
        spy.restore();
        wbm.onCreatureDeath = origWb;
      }

      // 3. Exactly one path fired: the manager's.
      assert.equal(worldBossCalls, 0, 'a dungeon boss is not a world boss');
      assert.ok(!spy.queries.some((q) => /world_creatures|creature_respawns/.test(q)), spy.queries.join('\n'));
      assert.equal(spy.connects(), 0, 'no transaction was opened for the kill (commitCreatureDeath never ran)');
      assert.ok(!errors.some((e) => /death commit failed/.test(e)), errors.join('\n'));
      const queued = await pool.query('SELECT count(*)::int AS n FROM creature_respawns WHERE world_id = $1', [worldId]);
      assert.equal(queued.rows[0].n, 0, 'the creature_respawns path never fires for a boss');
      assert.equal(kills.length, 1, 'the S10 hook fired once');
      assert.equal(kills[0].creatureId, id);
      assert.equal(bossesIn(entry).length, 0, 'dead');

      // Leave + rejoin before due: the world is evicted and reloaded.
      now += 300_000;
      assert.equal(srv.evictWorld(worldId), true);
      entry = await srv._loadWorld(worldId);
      assert.equal(bossesIn(entry).length, 0, 'reload while dead places nothing');
      await srv._creatureRespawnSweep();
      assert.equal(bossesIn(entry).length, 0, 'the sweep before due places nothing');

      // 4. Exactly one respawn after respawn_s, and still one after another sweep.
      now += 300_000; // 600 s after death
      await srv._creatureRespawnSweep();
      assert.equal(bossesIn(entry).length, 1, 'exactly one respawn after respawn_s');
      assert.equal(entry.world.creatures.get(id).hp, entry.world.creatures.get(id).maxHp, 'full hp');
      await srv._creatureRespawnSweep();
      assert.equal(bossesIn(entry).length, 1, 'a second sweep adds nothing');
      const rows = await pool.query('SELECT count(*)::int AS n FROM world_creatures WHERE world_id = $1 AND type = $2', [worldId, 'Shade Herald']);
      assert.equal(rows.rows[0].n, 0, 'the boss is never persisted');
      assert.equal(kills.length, 1);
      srv.evictWorld(worldId);
    }, { prefix: 'zzS9live' });
  } finally {
    console.error = origError;
    srv.close();
    await pool.end();
  }
});
