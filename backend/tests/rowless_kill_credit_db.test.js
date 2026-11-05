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
const { shareBossXp } = require('../src/authority/loot.js');
const { createCharacter } = require('../src/services/characters.js');
const { withFixtureWorld } = require('./helpers/fixtureWorld');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = DB_URL ? false : 'no TEST_DATABASE_URL';
const SECRET = 'somet735-test-secret';
const TAG = `s735_${process.pid}_${Date.now().toString(36)}`;
const BOSS = 'Abyssor, the Voidreaver';
const SUMMON = 'Slime'; // a seeded kill quest names it
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

// One authority and one fixture world. The tick is
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

  // A seeded quest, never a fixture row: `quests` is a catalog table, and the seed-sync
  // tests running in parallel diff it.
  async function quest(characterId, objectiveType, targetKey = null) {
    const q = await pool.query(
      `SELECT id FROM quests
        WHERE objective_type = $1 AND target_key IS NOT DISTINCT FROM $2 AND time_limit_sec IS NULL
        ORDER BY id LIMIT 1`,
      [objectiveType, targetKey],
    );
    assert.equal(q.rowCount, 1, `fixture premise: a seeded ${objectiveType} quest for ${targetKey}`);
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

test('shareBossXp: the killer alone, or evenly over the group', () => {
  const all = () => true;
  assert.deepEqual(shareBossXp(3500, [], 'k', all), [{ userId: 'k', xp: 3500 }], 'solo, no recorded damage');
  assert.deepEqual(shareBossXp(3500, ['k'], 'k', all), [{ userId: 'k', xp: 3500 }], 'solo, not counted twice');
  assert.deepEqual(shareBossXp(100, ['a', 'k'], 'k', all), [{ userId: 'a', xp: 50 }, { userId: 'k', xp: 50 }]);
  assert.deepEqual(
    shareBossXp(100, ['a', 'b'], 'k', all),
    [{ userId: 'a', xp: 33 }, { userId: 'b', xp: 33 }, { userId: 'k', xp: 34 }],
    'the killer counts without recorded damage, and keeps the remainder',
  );
  assert.deepEqual(
    shareBossXp(100, ['a', 'gone', 'k'], 'k', (id) => id !== 'gone'),
    [{ userId: 'a', xp: 50 }, { userId: 'k', xp: 50 }],
    'someone who left takes no share',
  );
  assert.deepEqual(
    shareBossXp(101, ['a', 'b'], 'gone', (id) => id !== 'gone'),
    [{ userId: 'a', xp: 51 }, { userId: 'b', xp: 50 }],
    'a killer who left: the group still shares all of it',
  );
  assert.deepEqual(shareBossXp(100, ['a', 'b'], null, all), [{ userId: 'a', xp: 50 }, { userId: 'b', xp: 50 }], 'no killer');
  assert.deepEqual(shareBossXp(0, ['a'], 'k', all), [], 'no reward, nobody paid');
  assert.deepEqual(shareBossXp(100, ['gone'], null, () => false), [], 'nobody present');
});

// A real attack frame from a player next to the boss, so the group is whoever the real
// damage path recorded. A fresh Warrior's swing cannot kill these bosses except at 1 hp.
async function swing(player, boss) {
  const p = player.entry.world.getPlayer(player.userId);
  boss.x = p.x + 20;
  boss.y = p.y;
  player.ws.send(JSON.stringify({ type: 'attack', ax: 1, ay: 0 }));
  await until(`${player.userId}'s hit to land`, () => boss._playerDamage && boss._playerDamage.has(player.userId));
}

async function killingSwing(player, boss) {
  boss.hp = 1;
  await swing(player, boss);
  await until('the boss to die', () => !player.entry.world.creatures.get(boss.id));
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
      const any = await r.quest(a.characterId, 'kill_any');

      assert.equal(m.forceSpawn(Date.now(), r.handle.worlds, { bossName: BOSS, preferredWorldId: worldId }, () => {}), true);
      const before = await r.experience(a.characterId);
      const bossId = m.bossCreatureId;
      await killedByRealRemoval(r.handle, a.entry, bossId, a.userId);

      assert.equal(await r.experience(a.characterId), before + reward, 'exactly xp_reward, not the level formula');
      await until('quest credit', async () => (await boss()) === 1 && (await any()) === 1);
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

    await t.test('a phase minion pays by its level and credits a kill, not a boss', async () => {
      const b = await r.join(worldId);
      assert.equal(m.forceSpawn(Date.now(), r.handle.worlds, { bossName: BOSS, preferredWorldId: worldId }, () => {}), true);
      const bossCreature = b.entry.world.creatures.get(m.bossCreatureId);
      const known = new Set(b.entry.world.creatures.creatures.keys());
      m._spawnPhaseMinions(bossCreature, b.entry);
      const minionId = [...b.entry.world.creatures.creatures.keys()].find((id) => !known.has(id));
      assert.match(minionId, /^wb_minion_/);
      const any = await r.quest(b.characterId, 'kill_any');
      const boss = await r.quest(b.characterId, 'boss');

      const before = await r.experience(b.characterId);
      await killedByRealRemoval(r.handle, b.entry, minionId, b.userId);
      // Level 80 minion, level 1 killer: 10 x 80 x 2 (the capped factor).
      assert.equal(await r.experience(b.characterId), before + 1600);
      await until('quest credit', async () => (await any()) === 1);
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

    await t.test('a rowless kill with no killer opens no transaction', async () => {
      const d = await r.join(worldId);
      const id = placeSummon(d.entry, 1);
      const realConnect = r.pool.connect;
      let connects = 0;
      r.pool.connect = function connect(...args) { connects += 1; return realConnect.apply(this, args); };
      try {
        await killedByRealRemoval(r.handle, d.entry, id, null);
      } finally {
        r.pool.connect = realConnect;
      }
      assert.equal(connects, 0);
      r.noCommitErrors();
    });

    await t.test('a killer who left before the kill was reported is not paid', async () => {
      const gone = await r.join(worldId);
      const id = placeSummon(gone.entry, 2);
      const before = await r.experience(gone.characterId);
      gone.ws.terminate();
      await until('the player to leave', () => !gone.entry.world.getPlayer(gone.userId));
      await killedByRealRemoval(r.handle, gone.entry, id, gone.userId);
      assert.equal(await r.experience(gone.characterId), before);
      r.noCommitErrors();
    });
  }, { prefix: 'zzRowlessKill' });
});

test('a world boss killed by a group pays everyone still here, evenly', { skip }, async (t) => {
  const r = await rig(t);
  await withFixtureWorld(r.pool, async (worldId) => {
    const [a, b, gone, killer, bystander] = [await r.join(worldId), await r.join(worldId), await r.join(worldId), await r.join(worldId), await r.join(worldId)];
    const m = r.handle._worldBossManager;
    await m.refreshCatalog();
    const reward = (await r.pool.query('SELECT xp_reward FROM entity_types WHERE name = $1', [BOSS])).rows[0].xp_reward;
    assert.ok(reward % 3 !== 0, `fixture premise: ${reward} leaves a remainder over 3`);
    assert.equal(m.forceSpawn(Date.now(), r.handle.worlds, { bossName: BOSS, preferredWorldId: worldId }, () => {}), true);
    const boss = a.entry.world.creatures.get(m.bossCreatureId);

    const everyone = [a, b, gone, killer, bystander];
    const before = await Promise.all(everyone.map((p) => r.experience(p.characterId)));
    const killerBoss = await r.quest(killer.characterId, 'boss');
    const memberBoss = await r.quest(a.characterId, 'boss');

    await swing(a, boss);
    await swing(b, boss);
    await swing(gone, boss);
    gone.ws.terminate();
    await until('the player to leave', () => !gone.entry.world.getPlayer(gone.userId));
    await killingSwing(killer, boss);

    const share = Math.floor(reward / 3);
    await until('every share', async () => (await r.experience(a.characterId)) > before[0]
      && (await r.experience(b.characterId)) > before[1]
      && (await r.experience(killer.characterId)) > before[3]);
    assert.equal(await r.experience(a.characterId), before[0] + share);
    assert.equal(await r.experience(b.characterId), before[1] + share);
    assert.equal(await r.experience(killer.characterId), before[3] + reward - 2 * share, 'the killer keeps the remainder');
    assert.equal(await r.experience(gone.characterId), before[2], 'left before the kill');
    assert.equal(await r.experience(bystander.characterId), before[4], 'dealt no damage');

    const frame = await until("a member's progression frame", () => a.frames.find((f) => f.type === 'progression'));
    assert.equal(frame.awarded, share);
    await until('the killer quest credit', async () => (await killerBoss()) === 1);
    assert.equal(await memberBoss(), 0, 'quest credit stays with the killer');
    await until('the victory chest', async () => (await r.pool.query('SELECT 1 FROM world_chests WHERE world_id = $1', [worldId])).rowCount > 0);
    r.noCommitErrors();
  }, { prefix: 'zzRowlessGroup' });
});

test('a dungeon boss pays its xp_reward, its escort pays by level', { skip }, async (t) => {
  const r = await rig(t);
  await withFixtureWorld(r.pool, async (worldId) => {
    await r.pool.query(
      `UPDATE worlds SET biomes = '["Deep Forest"]'::jsonb, level_min = 41, level_max = 50, dungeon_boss = $2::jsonb WHERE id = $1`,
      [worldId, JSON.stringify({ entity: 'Shade Herald', x: 4850, y: 4850, respawn_s: 600 })],
    );
    const reward = (await r.pool.query("SELECT xp_reward FROM entity_types WHERE name = 'Shade Herald'")).rows[0].xp_reward;
    assert.ok(reward > 0, 'fixture premise: the seeded boss has an xp_reward');

    const [member, killer] = [await r.join(worldId), await r.join(worldId)];
    const sim = killer.entry.world.creatures;
    const killerBoss = await r.quest(killer.characterId, 'boss');
    const memberBoss = await r.quest(member.characterId, 'boss');

    await t.test('the escort minion pays by its level and is no boss', async () => {
      const minion = sim.get(`dminion:${worldId}:0`);
      assert.ok(minion, 'fixture premise: the escort is placed');
      assert.equal(minion.bossTier, null);
      const any = await r.quest(killer.characterId, 'kill_any');
      const before = await r.experience(killer.characterId);
      sim._removeKilled(minion);
      await r.handle._onCreatureDeath(killer.entry, minion.id, killer.userId);
      // Level L minion, level 1 killer, factor capped at 2.
      assert.equal(await r.experience(killer.characterId), before + 10 * minion.level * 2);
      await until('quest credit', async () => (await any()) === 1);
      assert.equal(await killerBoss(), 0);
      r.noCommitErrors();
    });

    await t.test('a respawned escort keeps its band level, so it still pays', async () => {
      const first = sim.get(`dminion:${worldId}:0`);
      assert.equal(first, undefined, 'fixture premise: killed above');
      const firstLevel = 47; // Shade Herald's elite band in a 41-50 world, per dungeon_boss_live_db
      const rec = [...r.handle._dungeonBosses.minionRecords.values()].find((m) => m.creatureId === `dminion:${worldId}:0`);
      assert.ok(rec.deadUntil != null, 'fixture premise: the escort is on its cooldown');
      rec.deadUntil = 0;
      rec.x = 9000; rec.y = 9000; // clear of the players, the sweep's own rule
      await r.handle._dungeonBosses._sweepMinions(r.handle.worlds, () => []);
      const again = sim.get(`dminion:${worldId}:0`);
      assert.ok(again, 'the sweep put it back');
      assert.equal(again.level, firstLevel);
    });

    await t.test('the boss splits its reward over the group, once', async () => {
      const boss = sim.get(`boss:${worldId}`);
      assert.ok(boss, 'fixture premise: the boss is placed');
      const beforeM = await r.experience(member.characterId);
      const beforeK = await r.experience(killer.characterId);
      await swing(member, boss);
      await killingSwing(killer, boss);
      const share = Math.floor(reward / 2);
      await until('both shares', async () => (await r.experience(member.characterId)) > beforeM && (await r.experience(killer.characterId)) > beforeK);
      assert.equal(await r.experience(member.characterId), beforeM + share);
      assert.equal(await r.experience(killer.characterId), beforeK + reward - share);
      await until('the killer quest credit', async () => (await killerBoss()) === 1);
      assert.equal(await memberBoss(), 0, 'quest credit stays with the killer');

      await r.handle._onCreatureDeath(killer.entry, boss.id, killer.userId);
      assert.equal(await r.experience(killer.characterId), beforeK + reward - share, 'a repeat report pays nothing');
      r.noCommitErrors();
    });
  }, { prefix: 'zzRowlessDungeon' });
});

test('a persisted miniboss is a boss helper: a kill, not a boss', { skip }, async (t) => {
  const r = await rig(t);
  await withFixtureWorld(r.pool, async (worldId) => {
    const k = await r.join(worldId);
    const row = await r.pool.query("SELECT name FROM entity_types WHERE boss_tier = 'miniboss' ORDER BY id LIMIT 1");
    assert.equal(row.rowCount, 1, 'fixture premise: a seeded miniboss');
    const type = row.rows[0].name;
    const ins = await r.pool.query(
      'INSERT INTO world_creatures (world_id, type, x, y, hp, level, damage) VALUES ($1, $2, 100, 100, 1, 1, 0) RETURNING id',
      [worldId, type],
    );
    const id = ins.rows[0].id;
    k.entry.world.creatures.addCreatures([{ id, type, x: 100, y: 100, hp: 1, level: 1, bossTier: 'miniboss' }]);
    const boss = await r.quest(k.characterId, 'boss');
    const any = await r.quest(k.characterId, 'kill_any');
    const before = await r.experience(k.characterId);
    assert.equal(k.entry.world.creatures.get(id).bossTier, 'miniboss', 'fixture premise: the sim holds it as a miniboss');
    await killedByRealRemoval(r.handle, k.entry, id, k.userId);
    assert.equal(await r.experience(k.characterId), before + 10, 'the level formula, not xp_reward');
    await until('quest credit', async () => (await any()) === 1);
    assert.equal(await boss(), 0);
    r.noCommitErrors();
  }, { prefix: 'zzRowlessMini' });
});
