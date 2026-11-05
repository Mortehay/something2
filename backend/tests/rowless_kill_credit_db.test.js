// SOMET-735. A world boss, its phase minions and a creature's summons have no
// world_creatures row. Their ids used to reach commitCreatureDeath's uuid DELETE,
// which threw ("death commit failed"), so the killer got no XP and no quest credit.
//
// Through the running authority: a real join over a real websocket, the sim's real
// removal, the real onCreatureDeath. Expected XP is written out as a number: the
// world boss's comes from its catalog row, the rest from xpForKill's formula worked
// by hand (10 x creature level x level-difference factor capped at 2).
//
// Runs in a throwaway world; the entry world is never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const WebSocket = require('ws');

const { attachAuthority } = require('../src/authority/server.js');
const { createCharacter } = require('../src/services/characters.js');
const { withFixtureWorld } = require('./helpers/fixtureWorld');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = DB_URL ? false : 'no TEST_DATABASE_URL';
const SECRET = 'somet735-test-secret';
const TAG = `s735_${process.pid}_${Date.now().toString(36)}`;
const BOSS = 'Abyssor, the Voidreaver';
const MINION = 'Arcane Elemental Guard'; // Abyssor's element is arcane
const SUMMON = 'Bat';
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function until(what, fn, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

// One authority, one fixture world, one quest per way of being credited. The tick is
// off so a boss standing next to a level 1 character cannot kill it mid-test.
async function rig(t) {
  const pool = new Pool({ connectionString: DB_URL, max: 6, connectionTimeoutMillis: 5000 });
  const server = http.createServer();
  const handle = attachAuthority(server, pool, {
    jwtSecret: SECRET, tickMs: 1e9, heartbeatMs: 1e9, flushMs: 1e9, creatureSweepMs: 1e9, itemSweepMs: 1e9, creatureFlushMs: 1e9, gameStatsFlushMs: 1e9,
  });
  await new Promise((r) => { server.listen(0, r); });
  const url = `ws://127.0.0.1:${server.address().port}/authority`;
  const sockets = [];
  const userIds = [];
  const questKeys = [];

  const errors = [];
  const realError = console.error;
  console.error = (...a) => { errors.push(a.map(String).join(' ')); };

  t.after(async () => {
    console.error = realError;
    for (const ws of sockets) ws.terminate();
    handle.close();
    await new Promise((r) => { server.close(r); });
    await sleep(30);
    if (userIds.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [userIds]);
    if (questKeys.length) await pool.query('DELETE FROM quests WHERE key = ANY($1::text[])', [questKeys]);
    await pool.end();
  });

  let seq = 0;
  async function join(worldId) {
    seq += 1;
    const u = await pool.query("INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id, token_version", [`${TAG}u${seq}`]);
    userIds.push(u.rows[0].id);
    const cls = await pool.query("SELECT id FROM entity_types WHERE name = 'Warrior'");
    const character = await createCharacter(pool, u.rows[0].id, `${TAG}c${seq}`, cls.rows[0].id);
    const token = jwt.sign({ user_id: u.rows[0].id, tv: u.rows[0].token_version }, SECRET, { algorithm: 'HS256' });
    const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
    sockets.push(ws);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const frames = [];
    ws.on('message', (d) => frames.push(JSON.parse(d)));
    ws.send(JSON.stringify({ type: 'join', world_id: worldId, character_id: character.id }));
    await until('the joined frame', () => frames.some((f) => f.type === 'joined'), 15000);
    const entry = handle.worlds.get(worldId);
    return { ws, frames, userId: String(u.rows[0].id), characterId: character.id, entry };
  }

  async function quest(characterId, objectiveType, targetKey = null) {
    const key = `${TAG}_${objectiveType}_${questKeys.length}`;
    questKeys.push(key);
    const q = await pool.query(
      `INSERT INTO quests (key, act, title, description, objective_type, target_key, target_count)
       VALUES ($1, 1, $1, 'test', $2, $3, 10) RETURNING id`,
      [key, objectiveType, targetKey],
    );
    await pool.query('INSERT INTO character_quests (character_id, quest_id) VALUES ($1, $2)', [characterId, q.rows[0].id]);
    return async () => {
      const r = await pool.query(
        'SELECT progress_count FROM character_quests WHERE character_id = $1 AND quest_id = $2',
        [characterId, q.rows[0].id],
      );
      return r.rows[0].progress_count;
    };
  }

  async function experience(characterId) {
    const r = await pool.query('SELECT experience FROM player_progression WHERE character_id = $1', [characterId]);
    return Number(r.rows[0].experience);
  }

  const noCommitErrors = () => assert.deepEqual(errors.filter((e) => /death commit failed/.test(e)), []);
  return { pool, handle, join, quest, experience, noCommitErrors, errors };
}

function placeSummon(entry, level) {
  const id = `skillsummon:caster-1:skill-1:${level ?? 0}`;
  // The same shape creatures.js casts: id, position and the catalog type; no level,
  // so addCreatures gives it level 1.
  entry.world.creatures.addCreatures([{ id, type: SUMMON, x: 100, y: 100, hp: 1 }]);
  return id;
}

async function killedByRealRemoval(handle, entry, id, killerUserId) {
  const c = entry.world.creatures.get(id);
  assert.ok(c, `fixture premise: ${id} is alive in the sim`);
  entry.world.creatures._removeKilled(c);
  await handle._onCreatureDeath(entry, id, killerUserId);
}

test('rowless kills pay the killer, once', { skip }, async (t) => {
  const r = await rig(t);
  await withFixtureWorld(r.pool, async (worldId) => {
    const a = await r.join(worldId);
    const m = r.handle._worldBossManager;
    await m.refreshCatalog();

    await t.test('a world boss pays its catalog xp_reward and counts as a boss for quests', async () => {
      const row = await r.pool.query('SELECT xp_reward FROM entity_types WHERE name = $1', [BOSS]);
      const reward = row.rows[0].xp_reward;
      assert.ok(reward > 0, 'fixture premise: the seeded boss has an xp_reward');
      const boss = await r.quest(a.characterId, 'boss');
      const named = await r.quest(a.characterId, 'kill', BOSS);
      const any = await r.quest(a.characterId, 'kill_any');

      assert.equal(m.forceSpawn(Date.now(), r.handle.worlds, { bossName: BOSS, preferredWorldId: worldId }, () => {}), true);
      const before = await r.experience(a.characterId);
      const bossId = m.bossCreatureId;
      await killedByRealRemoval(r.handle, a.entry, bossId, a.userId);

      assert.equal(await r.experience(a.characterId), before + reward, 'exactly xp_reward, not the level formula');
      await until('quest credit', async () => (await boss()) === 1 && (await named()) === 1 && (await any()) === 1);
      const frame = await until('the progression frame', () => a.frames.find((f) => f.type === 'progression'));
      assert.equal(frame.awarded, reward);
      assert.equal(frame.leveledUp, true, `${reward} xp takes a level 1 character up`);
      // The chest is the manager's last write; wait so its work cannot outlive the world.
      await until('the victory chest', async () => (await r.pool.query('SELECT 1 FROM world_chests WHERE world_id = $1', [worldId])).rowCount > 0);
      r.noCommitErrors();
    });

    await t.test('a reported-twice world boss pays once', async () => {
      assert.equal(m.forceSpawn(Date.now(), r.handle.worlds, { bossName: BOSS, preferredWorldId: worldId }, () => {}), true);
      const before = await r.experience(a.characterId);
      const reward = (await r.pool.query('SELECT xp_reward FROM entity_types WHERE name = $1', [BOSS])).rows[0].xp_reward;
      const bossId = m.bossCreatureId;
      a.entry.world.creatures._removeKilled(a.entry.world.creatures.get(bossId));
      await Promise.all([
        r.handle._onCreatureDeath(a.entry, bossId, a.userId),
        r.handle._onCreatureDeath(a.entry, bossId, a.userId),
      ]);
      await r.handle._onCreatureDeath(a.entry, bossId, a.userId);
      assert.equal(await r.experience(a.characterId), before + reward);
      r.noCommitErrors();
    });

    await t.test('a phase minion pays by its level and credits a quest for its type', async () => {
      const b = await r.join(worldId);
      assert.equal(m.forceSpawn(Date.now(), r.handle.worlds, { bossName: BOSS, preferredWorldId: worldId }, () => {}), true);
      const bossCreature = b.entry.world.creatures.get(m.bossCreatureId);
      const known = new Set(b.entry.world.creatures.creatures.keys());
      m._spawnPhaseMinions(bossCreature, b.entry);
      const minionId = [...b.entry.world.creatures.creatures.keys()].find((id) => !known.has(id));
      assert.match(minionId, /^wb_minion_/);
      const named = await r.quest(b.characterId, 'kill', MINION);
      const boss = await r.quest(b.characterId, 'boss');

      const before = await r.experience(b.characterId);
      await killedByRealRemoval(r.handle, b.entry, minionId, b.userId);
      // Level 80 minion, level 1 killer: 10 x 80 x 2 (the capped factor).
      assert.equal(await r.experience(b.characterId), before + 1600);
      await until('quest credit', async () => (await named()) === 1);
      assert.equal(await boss(), 0, 'a minion is not a boss');
      r.noCommitErrors();
    });

    await t.test('a summon pays by its level and credits a quest for its type', async () => {
      const c = await r.join(worldId);
      const id = placeSummon(c.entry);
      const named = await r.quest(c.characterId, 'kill', SUMMON);
      const before = await r.experience(c.characterId);
      await killedByRealRemoval(r.handle, c.entry, id, c.userId);
      // Level 1 summon, level 1 killer: 10 x 1 x 1.
      assert.equal(await r.experience(c.characterId), before + 10);
      await until('quest credit', async () => (await named()) === 1);
      r.noCommitErrors();
    });

    await t.test('a real swing over the socket kills a summon and pays through the whole path', async () => {
      const e = await r.join(worldId);
      const p = e.entry.world.getPlayer(e.userId);
      const id = 'skillsummon:caster-2:skill-1:0';
      e.entry.world.creatures.addCreatures([{ id, type: SUMMON, x: p.x + 40, y: p.y, hp: 1 }]);
      const before = await r.experience(e.characterId);
      e.ws.send(JSON.stringify({ type: 'attack', ax: 1, ay: 0 }));
      await until('the summon to die', () => !e.entry.world.creatures.get(id));
      const frame = await until('the progression frame', () => e.frames.find((f) => f.type === 'progression'));
      assert.equal(frame.awarded, 10);
      assert.equal(await r.experience(e.characterId), before + 10);
      r.noCommitErrors();
    });

    await t.test('a rowless kill with no killer, or with one who left, is quiet and pays nobody', async () => {
      const d = await r.join(worldId);
      const before = await r.experience(d.characterId);
      await killedByRealRemoval(r.handle, d.entry, placeSummon(d.entry, 1), null);
      await killedByRealRemoval(r.handle, d.entry, placeSummon(d.entry, 2), 'no-such-user');
      assert.equal(await r.experience(d.characterId), before);
      r.noCommitErrors();
    });
  }, { prefix: 'zzRowlessKill' });
});
