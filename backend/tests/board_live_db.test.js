// SOMET-720. Play statistics and the board's live view, through the running authority:
// a real join over a real websocket, the real tick loop, the real projectile, effect and
// creature code. The only things placed by hand are what stands in the world (a creature
// with 1 hp, a flying shot, a wave, a trap), because the question here is whether each
// way of dying moves the right counter, once.
//
// Runs in a throwaway world of its own; the entry world is never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const WebSocket = require('ws');

const { attachAuthority } = require('../src/authority/server.js');
const { boardInternalHandler } = require('../src/api/boardInternal.js');
const { createCharacter } = require('../src/services/characters.js');
const { applyEffect, BURN } = require('../src/authority/effects.js');
const { applyDamageWithEffects, playerKey, creatureKey } = require('../src/authority/damage.js');
const { withFixtureWorld } = require('./helpers/fixtureWorld');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = DB_URL ? false : 'no TEST_DATABASE_URL';
const SECRET = 'somet720-test-secret';
const TAG = `s720_${process.pid}_${Date.now().toString(36)}`;
const CREATURE = 'Bat';
const BOSS = 'Shade Herald';
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

function nextMsg(ws, type, ms = 15000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
    ws.on('message', function onMsg(data) {
      const m = JSON.parse(data);
      if (m.type === 'error') { clearTimeout(to); ws.off('message', onMsg); reject(new Error(`server error: ${m.message}`)); }
      else if (m.type === type) { clearTimeout(to); ws.off('message', onMsg); resolve(m); }
    });
  });
}

// One authority on the scratch DB, its world, and the helpers every case uses.
async function rig(t, { worldOpts = {}, authorityOpts = {}, dungeonBoss = null } = {}) {
  const pool = new Pool({ connectionString: DB_URL, max: 8, connectionTimeoutMillis: 5000 });
  const sockets = [];
  const userIds = [];
  const servers = [];
  const boot = async (opts = {}) => {
    const server = http.createServer();
    const handle = attachAuthority(server, pool, {
      jwtSecret: SECRET, tickMs: 20, heartbeatMs: 1e9, flushMs: 1e9, creatureSweepMs: 1e9, itemSweepMs: 1e9, creatureFlushMs: 1e9,
      gameStatsFlushMs: 1e9, ...authorityOpts, ...opts,
    });
    await new Promise((r) => { server.listen(0, r); });
    servers.push({ server, handle });
    return { handle, url: `ws://127.0.0.1:${server.address().port}/authority` };
  };
  const stop = async ({ handle, url }) => {
    for (const ws of sockets) if (ws.url.startsWith(url)) ws.terminate();
    handle.close();
    const s = servers.find((x) => x.handle === handle);
    await new Promise((r) => { s.server.close(r); });
    servers.splice(servers.indexOf(s), 1);
  };
  let seq = 0;
  async function newCharacter() {
    seq += 1;
    const u = await pool.query("INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id, token_version", [`${TAG}u${seq}`]);
    userIds.push(u.rows[0].id);
    const cls = await pool.query("SELECT id FROM entity_types WHERE name = 'Warrior'");
    const character = await createCharacter(pool, u.rows[0].id, `${TAG}c${seq}`, cls.rows[0].id);
    return { userId: u.rows[0].id, tv: u.rows[0].token_version, character };
  }
  async function join(app, worldId, who) {
    const { userId, tv, character } = who || await newCharacter();
    const token = jwt.sign({ user_id: userId, tv }, SECRET, { algorithm: 'HS256' });
    const ws = new WebSocket(`${app.url}?token=${encodeURIComponent(token)}`);
    sockets.push(ws);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const joined = nextMsg(ws, 'joined');
    ws.send(JSON.stringify({ type: 'join', world_id: worldId, character_id: character.id }));
    await joined;
    const entry = app.handle.worlds.get(worldId);
    // `joined` does not wait for the chunks around the player. A creature spawned while
    // they load can be read by that SELECT, killed, then re-added 4 ms later by the same
    // SELECT's rows, alive and with no row behind it (SOMET-744).
    await until('the chunks around the player', () => entry.loadedChunks.size > 0 && entry.chunkLoads.size === 0, 30000);
    const p = entry.world.getPlayer(String(userId));
    return { ws, userId: String(userId), rawUserId: userId, character, characterId: character.id, entry, p };
  }
  t.after(async () => {
    for (const ws of sockets) { try { ws.terminate(); } catch { /* gone */ } }
    for (const s of servers) { s.handle.close(); if (s.server.listening) s.server.close(); }
    await sleep(30);
    if (userIds.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [userIds]).catch(() => {});
    await pool.end().catch(() => {});
  });
  return { pool, boot, stop, join, newCharacter, worldOpts, dungeonBoss };
}

// A real world_creatures row and its sim creature, 1 hp, standing dx,dy from the player.
async function spawn(pool, entry, p, { dx = 60, dy = 0, hp = 1, type = CREATURE } = {}) {
  const x = p.x + dx; const y = p.y + dy;
  const r = await pool.query(
    'INSERT INTO world_creatures (world_id, type, x, y, hp, level, damage) VALUES ($1, $2, $3, $4, $5, 1, 0) RETURNING id',
    [entry.worldId, type, x, y, hp],
  );
  const id = r.rows[0].id;
  entry.world.creatures.addCreatures([{
    id, type, x, y, hp, level: 1, damage: 0, facing: 'S', color: '#c00', faction: 'hostile', width: 40, height: 40,
  }]);
  const c = entry.world.creatures.get(id);
  c.speed = 0;
  return id;
}

const shot = { kind: 'ranged', range: 900, projectile_speed: 600, projectile_radius: 12, pierce: 0, aoe_radius: 0, element: null };

async function withWorld(pool, fn, over = {}) {
  return withFixtureWorld(pool, fn, { prefix: `zz${TAG}`, ...over });
}

// session + counters: how far one kill path moved things.
const snap = (app, a) => {
  const s = app.handle._gameStats.session(a.characterId);
  return { mob: s.mobKills, pvp: s.pvpKills, deaths: s.deaths, boss: s.bossKills };
};
async function assertKill(app, a, { mob = 1, boss = 0, pvp = 0, deaths = 0 }, before, label) {
  await until(`${label} to count`, () => snap(app, a).mob === before.mob + mob);
  await sleep(120); // long enough for a second report of the same kill to land
  const now = snap(app, a);
  assert.deepEqual(now, {
    mob: before.mob + mob, boss: before.boss + boss, pvp: before.pvp + pvp, deaths: before.deaths + deaths,
  }, label);
}

test('every way a player kills a creature moves mob_kills once', { skip, timeout: 120000 }, async (t) => {
  const r = await rig(t);
  await withWorld(r.pool, async (worldId) => {
    const app = await r.boot();
    const a = await r.join(app, worldId);
    const { entry, p } = a;
    const world = entry.world;
    p.maxHp = 100000; p.hp = 100000;
    const gone = (id) => until(`creature ${id} gone`, () => !world.creatures.get(id));
    const killTest = async (label, fn, { count = 1 } = {}) => {
      await t.test(label, async () => {
        const before = snap(app, a);
        const ids = await fn();
        await Promise.all(ids.map(gone));
        await assertKill(app, a, { mob: count }, before, label);
      });
    };

    await killTest('melee: the attack frame', async () => {
      const id = await spawn(r.pool, entry, p, { dx: 30 });
      p._attackCd = 0;
      a.ws.send(JSON.stringify({ type: 'attack', ax: 1, ay: 0 }));
      return [id];
    });

    await killTest('skill: the castSkill frame', async () => {
      const id = await spawn(r.pool, entry, p, { dx: 30 });
      p.ownedGems = undefined;
      p._skillCds = undefined;
      p.stamina = 1000; p.mana = 1000;
      const skillId = 'war_crushing_blow';
      p.stats = { ...p.stats, strength: 999, dexterity: 999, intelligence: 999, level: 200 };
      p.inv.equipment.main_hand = { id: 'x', category: 'weapon', kind: 'melee', name: 'sword', weaponClass: 'sword' };
      a.ws.send(JSON.stringify({ type: 'castSkill', skillId, targetX: p.x + 30, targetY: p.y, ax: 1, ay: 0 }));
      return [id];
    });
    delete p.inv.equipment.main_hand;

    await killTest('projectile: a direct hit, reported by the tick', async () => {
      const id = await spawn(r.pool, entry, p, { dx: 120 });
      world.projectiles.spawn({
        ownerId: a.userId, x: p.x + 20, y: p.y + 20, nx: 1, ny: 0, weapon: shot, damage: 500,
      });
      return [id];
    });

    await killTest('projectile: an area detonation kills two, two kills', async () => {
      const one = await spawn(r.pool, entry, p, { dx: 120, dy: 0 });
      const two = await spawn(r.pool, entry, p, { dx: 120, dy: 60 });
      world.projectiles.spawn({
        ownerId: a.userId, x: p.x + 20, y: p.y + 20, nx: 1, ny: 0, weapon: { ...shot, aoe_radius: 200 }, damage: 500,
      });
      return [one, two];
    }, { count: 2 });

    await killTest('burn: a rider credited to whoever applied it', async () => {
      const id = await spawn(r.pool, entry, p);
      applyEffect(world.creatures.get(id), BURN, { durationMs: 5000, magnitude: 50, sourceId: a.userId, now: world.now });
      return [id];
    });

    await killTest('wave: a lingering wave', async () => {
      const id = await spawn(r.pool, entry, p, { dx: 40 });
      world.waves.push({
        ownerId: a.userId, x: p.x, y: p.y, nx: 1, ny: 0, reach: 300, arc: Math.PI * 2, damage: 500, element: null, expiresAt: world.now + 5000, acc: 0,
      });
      return [id];
    });
    world.waves.length = 0;

    await killTest('buff effect: thrown-back damage', async () => {
      const id = await spawn(r.pool, entry, p);
      p._pendingReflect = [{ source: creatureKey(id), amount: 500 }];
      return [id];
    });

    await killTest('buff effect: a trap', async () => {
      const id = await spawn(r.pool, entry, p, { dx: 300 });
      world.traps.push({
        ownerId: a.userId, kind: 'bear', x: p.x + 320, y: p.y + 20, triggerRadius: 200, damage: 500, expiresAt: world.now + 5000,
      });
      return [id];
    });

    await killTest('blood rebirth: the blast of a caught death', async () => {
      const id = await spawn(r.pool, entry, p, { dx: 40 });
      p.buffs = p.buffs || new Map();
      p.buffs.set('test_revive', { fx: { revive: 0.5 }, until: world.now + 60000, expiresAt: world.now + 60000 });
      p.hp = 0;
      return [id];
    });
    p.maxHp = 100000; p.hp = 100000;

    await killTest('a pet: the creature tick credits its owner', async () => {
      const pet = await spawn(r.pool, entry, p, { dx: 60, hp: 500 });
      const prey = await spawn(r.pool, entry, p, { dx: 90, hp: 1 });
      const petC = world.creatures.get(pet);
      petC.damage = 500; petC.speed = 100;
      world.creatures.charm(pet, { userId: a.userId, characterId: a.characterId, expiresAt: Date.now() + 60000 });
      p._charmTargetId = prey;
      return [prey];
    });

    await t.test('a kill with no killer counts nothing', async () => {
      const before = snap(app, a);
      const id = await spawn(r.pool, entry, p);
      applyEffect(world.creatures.get(id), BURN, { durationMs: 5000, magnitude: 50, sourceId: null, now: world.now });
      await gone(id);
      await sleep(150);
      assert.deepEqual(snap(app, a), before);
    });

    await t.test('the same creature reported twice counts once', async () => {
      const before = snap(app, a);
      const id = await spawn(r.pool, entry, p);
      world.creatures.remove(id);
      await Promise.all([
        app.handle._onCreatureDeath(entry, id, a.userId),
        app.handle._onCreatureDeath(entry, id, a.userId),
      ]);
      await sleep(80);
      assert.equal(snap(app, a).mob, before.mob + 1);
      await app.handle._onCreatureDeath(entry, id, a.userId);
      assert.equal(snap(app, a).mob, before.mob + 1, 'a third, later report');
    });
    assert.equal(app.handle._gameStats.totals().mobKills, snap(app, a).mob, 'the process total is the sum of its kills');
    await r.stop(app);
  });
});

test('a boss kill counts boss_kills for the killer only, and a minion is a mob', { skip, timeout: 60000 }, async (t) => {
  const r = await rig(t);
  await withWorld(r.pool, async (worldId) => {
    const app = await r.boot();
    await r.pool.query(
      `UPDATE worlds SET biomes = '["Deep Forest"]'::jsonb, level_min = 41, level_max = 50, dungeon_boss = $2::jsonb WHERE id = $1`,
      [worldId, JSON.stringify({ entity: BOSS, x: 4850, y: 4850, respawn_s: 600 })],
    );
    const a = await r.join(app, worldId);
    const other = await r.join(app, worldId);
    const { entry, p } = a;
    p.maxHp = 100000; p.hp = 100000; other.p.maxHp = 100000; other.p.hp = 100000;
    const world = entry.world;
    const id = `boss:${worldId}`;
    const c = await until('the boss to be placed', () => world.creatures.get(id));
    assert.equal(c.bossTier, 'dungeon_elite');
    // West of the boss's post, so the shot's line crosses the boss and not its escort.
    // The bystander stands well clear: a shot stops at the first player it meets.
    p.x = 4850 - 200; p.y = 4850 - p.height / 2;
    other.p.x = 4850 - 500; other.p.y = 4850 + 500;
    const shootAt = (target) => {
      const sx = p.x + p.width / 2; const sy = p.y + p.height / 2;
      const dx = target.x + (target.width || 40) / 2 - sx; const dy = target.y + (target.height || 40) / 2 - sy;
      const len = Math.hypot(dx, dy);
      world.projectiles.spawn({
        ownerId: a.userId, x: sx, y: sy, nx: dx / len, ny: dy / len, weapon: shot, damage: 50000,
      });
    };

    await t.test('a dungeon boss, killed by a real shot', async () => {
      const before = snap(app, a);
      const otherBefore = snap(app, other);
      // Past its phases: at 1 hp with phases to run it would sit invulnerable in a transition.
      while (c.bossAI.nextPhaseDef) c.bossAI.phase += 1;
      c._hpFloor = null;
      c.hp = 1; c.shield = 0; c.speed = 0;
      // The bystander has hurt it too. Damage earned is not the kill.
      applyDamageWithEffects(c, 0, 'physical', undefined, world.now, playerKey(other.userId));
      c.hp = 1;
      shootAt(c);
      await until('the boss to die', () => !world.creatures.get(id));
      await assertKill(app, a, { mob: 1, boss: 1 }, before, 'dungeon boss');
      assert.deepEqual(snap(app, other), otherBefore, 'the bystander earned nothing');
    });

    await t.test('its escort minion is a mob kill, once', async () => {
      const mid = [...world.creatures.all()].find((x) => String(x.id).startsWith('dminion:'));
      assert.ok(mid, 'the boss has an escort');
      const before = snap(app, a);
      mid.hp = 1; mid.speed = 0;
      shootAt(mid);
      await until('the minion to die', () => !world.creatures.get(mid.id));
      await assertKill(app, a, { mob: 1, boss: 0 }, before, 'minion');
    });

    await t.test('a world boss, once, with no double count from its commit', async () => {
      const m = app.handle._worldBossManager;
      await m.refreshCatalog();
      const name = m.catalog.bosses[0].name;
      assert.equal(m.forceSpawn(Date.now(), app.handle.worlds, { bossName: name, preferredWorldId: worldId }), true);
      const bid = m.bossCreatureId;
      const wb = world.creatures.get(bid);
      assert.ok(wb, 'placed');
      // Already in its last phase: entering one raises a shield this 1 hp would hide behind.
      m.currentBoss.phase = 4; m.currentBoss.lastWardAt = Date.now();
      wb.hp = 1; wb.shield = 0; wb.speed = 0; wb.x = p.x + 120; wb.y = p.y - 150;
      const before = snap(app, a);
      shootAt(wb);
      await until('the world boss to die', () => !world.creatures.get(bid));
      await assertKill(app, a, { mob: 1, boss: 1 }, before, 'world boss');
      await sleep(200); // its loot and the failed uuid commit, both after the kill
      assert.equal(snap(app, a).boss, before.boss + 1);
    });
    await r.stop(app);
  });
});

test('player deaths: PvP counts for both sides, a creature only for the victim', { skip, timeout: 60000 }, async (t) => {
  const r = await rig(t);
  await withWorld(r.pool, async (worldId) => {
    const app = await r.boot();
    const a = await r.join(app, worldId);
    const v = await r.join(app, worldId);
    const world = a.entry.world;
    a.p.maxHp = 100000; a.p.hp = 100000;
    const beside = () => {
      v.p.x = a.p.x + 30; v.p.y = a.p.y; v.p.hp = 1;
    };

    await t.test('melee PvP: the real attack frame, resolved by the next tick', async () => {
      const ab = snap(app, a); const vb = snap(app, v);
      beside();
      a.p._attackCd = 0;
      a.ws.send(JSON.stringify({ type: 'attack', ax: 1, ay: 0 }));
      await until('the death', () => snap(app, v).deaths === vb.deaths + 1);
      await sleep(120);
      assert.deepEqual(snap(app, a), { ...ab, pvp: ab.pvp + 1 });
      assert.deepEqual(snap(app, v), { ...vb, deaths: vb.deaths + 1 });
    });

    await t.test('projectile PvP: a real shot in the tick', async () => {
      const ab = snap(app, a); const vb = snap(app, v);
      v.p.x = a.p.x + 100; v.p.y = a.p.y; v.p.hp = 1;
      world.projectiles.spawn({ ownerId: a.userId, x: a.p.x + 20, y: a.p.y + 20, nx: 1, ny: 0, weapon: shot, damage: 5000 });
      await until('the death', () => snap(app, v).deaths === vb.deaths + 1);
      await sleep(120);
      assert.equal(snap(app, a).pvp, ab.pvp + 1);
      assert.equal(snap(app, v).pvp, vb.pvp);
      assert.equal(snap(app, a).deaths, ab.deaths);
    });

    await t.test('a creature: deaths only, nobody gets a PvP kill', async () => {
      const ab = snap(app, a); const vb = snap(app, v);
      applyDamageWithEffects(v.p, 1e6, 'physical', undefined, world.now, creatureKey('11111111-1111-1111-1111-111111111111'));
      await until('the death', () => snap(app, v).deaths === vb.deaths + 1);
      await sleep(80);
      assert.deepEqual(snap(app, a), ab);
      assert.equal(snap(app, v).pvp, vb.pvp);
    });

    await t.test('no known source: the death still counts, no PvP kill', async () => {
      const ab = snap(app, a); const vb = snap(app, v);
      applyDamageWithEffects(v.p, 1e6, 'physical', undefined, world.now, null);
      await until('the death', () => snap(app, v).deaths === vb.deaths + 1);
      await sleep(80);
      assert.deepEqual(snap(app, a), ab);
    });

    await t.test('an earlier PvP hit is not inherited by a later unrelated death', async () => {
      const ab = snap(app, a); const vb = snap(app, v);
      applyDamageWithEffects(v.p, 1, 'physical', undefined, world.now, playerKey(a.userId));
      applyDamageWithEffects(v.p, 1e6, 'physical', undefined, world.now, creatureKey('11111111-1111-1111-1111-111111111111'));
      await until('the death', () => snap(app, v).deaths === vb.deaths + 1);
      assert.equal(snap(app, a).pvp, ab.pvp, 'the killing blow was the creature');
    });

    await t.test('a caught death (blood rebirth) is not a death', async () => {
      const vb = snap(app, v);
      v.p.buffs = v.p.buffs || new Map();
      v.p.buffs.set('test_revive', { fx: { revive: 0.5 }, until: world.now + 60000, expiresAt: world.now + 60000 });
      v.p.hp = 0;
      await until('the revive', () => v.p.hp > 0);
      await sleep(60);
      assert.equal(snap(app, v).deaths, vb.deaths);
    });
    await r.stop(app);
  });
});

test('a flush persists, is not per kill, survives a restart, and a failed one breaks nothing', { skip, timeout: 60000 }, async (t) => {
  const r = await rig(t);
  await withWorld(r.pool, async (worldId) => {
    const row = async (id) => (await r.pool.query('SELECT * FROM player_game_stats WHERE character_id = $1', [id])).rows[0];
    let app = await r.boot();
    const who = await r.newCharacter();
    const a = await r.join(app, worldId, who);
    const { entry, p } = a;
    p.maxHp = 100000; p.hp = 100000;
    const world = entry.world;

    const statements = [];
    const orig = r.pool.query;
    r.pool.query = function spy(sql, ...rest) {
      if (/player_game_stats/.test(String(sql))) statements.push(String(sql));
      return orig.call(this, sql, ...rest);
    };
    t.after(() => { r.pool.query = orig; });

    const killOne = async () => {
      const id = await spawn(r.pool, entry, p);
      const before = snap(app, a).mob;
      applyEffect(world.creatures.get(id), BURN, { durationMs: 5000, magnitude: 50, sourceId: a.userId, now: world.now });
      await until('the kill', () => snap(app, a).mob === before + 1);
    };

    await t.test('five kills write nothing; one flush writes them in one statement', async () => {
      for (let i = 0; i < 5; i += 1) await killOne();
      assert.equal(statements.length, 0, 'not per kill');
      assert.equal(await app.handle.flushGameStats(), true);
      assert.equal(statements.length, 1, 'one batched statement');
      const s = await row(a.characterId);
      assert.equal(Number(s.mob_kills), 5);
      assert.equal(Number(s.sessions), 1);
      assert.equal(s.user_id, who.userId);
      assert.ok(s.last_seen_at);
      statements.length = 0;
      await app.handle.flushGameStats();
      assert.equal(Number((await row(a.characterId)).mob_kills), 5, 'a second flush does not count them again');
    });

    await t.test('a failed flush logs, keeps the counters, and play goes on', async () => {
      const errors = [];
      const origErr = console.error;
      console.error = (...x) => { errors.push(x.join(' ')); };
      const q = r.pool.query;
      r.pool.query = function failing(sql, ...rest) {
        if (/INSERT INTO\s+player_game_stats/.test(String(sql))) return Promise.reject(new Error('db went away'));
        return q.call(this, sql, ...rest);
      };
      try {
        await killOne();
        assert.equal(await app.handle.flushGameStats(), false, 'reports the failure, does not throw');
        assert.ok(errors.some((e) => /flush failed/.test(e)), errors.join('\n'));
        await nextMsg(a.ws, 'state');
        await killOne();
      } finally {
        r.pool.query = q;
        console.error = origErr;
      }
      assert.equal(Number((await row(a.characterId)).mob_kills), 5, 'nothing was written');
      assert.equal(await app.handle.flushGameStats(), true);
      assert.equal(Number((await row(a.characterId)).mob_kills), 7, 'both kills arrive on the next flush');
    });

    await t.test('one deleted character does not poison the batch', async () => {
      const gs = app.handle._gameStats;
      gs.recordKill(2147483000); // no such character
      await killOne();
      assert.equal(await app.handle.flushGameStats(), true);
      assert.equal(Number((await row(a.characterId)).mob_kills), 8);
      assert.equal(await row(2147483000), undefined);
    });

    await t.test('a disconnect flushes without being asked', async () => {
      await killOne();
      a.ws.close();
      await until('the row', async () => Number((await row(a.characterId)).mob_kills) === 9);
    });

    await t.test('restart: the new process continues the totals, in the table and on /players', async () => {
      await r.stop(app);
      app = await r.boot();
      const b = await r.join(app, worldId, who);
      const { players } = await app.handle.boardLive.players();
      const me = players.find((x) => x.name === who.character.name);
      assert.ok(me, 'online');
      assert.equal(me.lifetime.mobKills, 9, 'lifetime came from the table');
      assert.equal(me.mobKills, 0, 'the session is new');
      assert.equal(me.lifetime.sessions, 2);
      assert.equal(app.handle._gameStats.totals().mobKills, 0, 'the rate counters start again');
      b.ws.terminate();
      await r.stop(app);
    });
  });
});

test('sessions: changing world continues one, a stale close cannot end it, play time accrues', { skip, timeout: 60000 }, async (t) => {
  const r = await rig(t);
  await withWorld(r.pool, async (worldId) => {
    let clock = Date.now();
    const app = await r.boot({ gameStatsClock: () => clock });
    const who = await r.newCharacter();
    const first = await r.join(app, worldId, who);
    const s1 = app.handle._gameStats.session(first.characterId);
    clock += 30_000;
    // A reconnect while the old socket is still open: the new join kicks it.
    const second = await r.join(app, worldId, who);
    await until('the old socket to close', () => first.ws.readyState === WebSocket.CLOSED);
    await sleep(60);
    const s2 = app.handle._gameStats.session(first.characterId);
    assert.equal(s2, s1, 'the same session');
    assert.equal(s2.online, true, 'the stale close did not end it');
    clock += 30_000;
    await app.handle.flushGameStats();
    const row = (await r.pool.query('SELECT sessions, play_seconds FROM player_game_stats WHERE character_id = $1', [first.characterId])).rows[0];
    assert.equal(Number(row.sessions), 1);
    assert.equal(Number(row.play_seconds), 60);
    second.ws.close();
    await until('the session to end', () => app.handle._gameStats.session(first.characterId).online === false);
    clock += 120_000;
    const third = await r.join(app, worldId, who);
    assert.notEqual(app.handle._gameStats.session(first.characterId), s1, 'a long gap starts a new one');
    third.ws.terminate();
    await r.stop(app);
  });
});

test('/players over the internal listener: fields, and ping from a real ws ping and pong', { skip, timeout: 30000 }, async (t) => {
  const r = await rig(t);
  await withWorld(r.pool, async (worldId, worldName) => {
    const app = await r.boot();
    const a = await r.join(app, worldId);
    const internal = http.createServer(boardInternalHandler(app.handle.boardLive));
    await new Promise((res) => { internal.listen(0, '127.0.0.1', res); });
    t.after(() => internal.close());
    const base = `http://127.0.0.1:${internal.address().port}`;
    const players = async () => (await (await fetch(`${base}/players`)).json()).players;

    let [me] = await players();
    assert.equal(me.name, a.character.name);
    assert.equal(me.world, worldName);
    assert.equal(me.level, 1);
    assert.equal(me.pingMs, null, 'null until the first pong');
    assert.ok(me.sessionStart);
    app.handle._heartbeatSweep();
    me = await until('a pong', async () => { const [x] = await players(); return x.pingMs !== null ? x : null; });
    assert.ok(me.pingMs >= 0 && me.pingMs < 2000, `a measured round trip, got ${me.pingMs}`);

    const c = await (await fetch(`${base}/counters`)).json();
    assert.deepEqual(c, { online: 1, mobKills: 0, pvpKills: 0 });

    // A slow client: the round trip is what is measured, not a constant. The ws
    // client answers pings itself, so hold its socket for the length of one.
    a.ws._socket.pause();
    app.handle._heartbeatSweep();
    await sleep(150);
    a.ws._socket.resume();
    const slow = await until('the slow pong', async () => { const [x] = await players(); return x.pingMs > me.pingMs ? x : null; });
    assert.ok(slow.pingMs >= 140, `measured ${slow.pingMs}`);
    await r.stop(app);
  });
});

test('/bosses and summon, against the real managers', { skip, timeout: 90000 }, async (t) => {
  const r = await rig(t);
  await withWorld(r.pool, async (worldId, worldName) => {
    await withWorld(r.pool, async (otherId, otherName) => {
      let dClock = Date.now();
      const app = await r.boot({ dungeonBossClock: () => dClock, creatureSweepMs: 1e9 });
      const spec = (x) => JSON.stringify({ entity: BOSS, x, y: 4850, respawn_s: 600 });
      await r.pool.query(`UPDATE worlds SET level_min = 41, level_max = 50, dungeon_boss = $2::jsonb WHERE id = $1`, [worldId, spec(4850)]);
      await r.pool.query(`UPDATE worlds SET level_min = 41, level_max = 50, dungeon_boss = $2::jsonb WHERE id = $1`, [otherId, spec(4850)]);
      const live = app.handle.boardLive;
      const a = await r.join(app, worldId);
      a.p.maxHp = 100000; a.p.hp = 100000;
      const { entry } = a;
      const world = entry.world;
      const bossId = `boss:${worldId}`;
      await until('the boss', () => world.creatures.get(bossId));
      const rowOf = async (owner, name, w) => (await live.bosses()).bosses.find((b) => b.owner === owner && b.name === name && (w === undefined || b.world === w));
      const bossCount = () => world.creatures.all().filter((c) => c.bossTier).length;
      const minions = () => world.creatures.all().filter((c) => String(c.id).startsWith('dminion:'));

      await t.test('a dungeon boss in a loaded world is alive, with HP and fighters', async () => {
        const c = world.creatures.get(bossId);
        c.hp = c.maxHp / 2;
        c._playerDamage = new Map([['1', 5], ['2', 5]]);
        const row = await rowOf('dungeon', BOSS, worldName);
        assert.equal(row.status, 'alive');
        assert.equal(row.hpPct, 50);
        assert.equal(row.fighters, 2);
        assert.equal(row.tier, 'dungeon_elite');
        assert.equal(row.players, 1);
      });

      await t.test('a dungeon whose world is not loaded says so, and summon refuses', async () => {
        const row = await rowOf('dungeon', BOSS, otherName);
        assert.equal(row.status, 'not_loaded');
        const out = await live.summon({ owner: 'dungeon', name: BOSS, world: otherName, replaces: null });
        assert.equal(out.status, 409);
        assert.equal(out.body.error, 'not_loaded');
        assert.match(out.body.message, /not loaded/);
        assert.equal(app.handle.worlds.has(otherId), false, 'the refusal did not load it');
      });

      await t.test('summon replaces a live dungeon boss at full health: one boss, not two', async () => {
        const before = world.creatures.get(bossId);
        // Not a phase's adds: they belong to the old boss, and the summon removes them.
        const escort = minions().filter((c) => !/:add\d+$/.test(c.id)).length;
        before.hp = 10;
        assert.ok(escort >= 1);
        const out = await live.summon({ owner: 'dungeon', name: BOSS, world: worldName, replaces: null });
        assert.equal(out.status, 200, JSON.stringify(out.body));
        const now = world.creatures.get(bossId);
        assert.notEqual(now, before, 'a new instance');
        assert.equal(now.hp, now.maxHp);
        assert.equal(bossCount(), 1);
        assert.equal(minions().length, escort, 'the escort is one set too');
      });

      await t.test('a summon that cannot be prepared leaves the boss standing', async () => {
        const dm = app.handle._dungeonBosses;
        const stood = world.creatures.get(bossId);
        const escort = minions().length;
        const { loadRow, loadMinionRow } = dm;
        const origErr = dm.log; dm.log = { error() {}, warn() {} };
        try {
          dm.loadRow = async () => null;
          assert.deepEqual(await dm.forceRespawn(entry), { ok: false, reason: 'no_catalog_row' });
          assert.equal(world.creatures.get(bossId), stood);
          dm.loadRow = async () => { throw new Error('db went away'); };
          assert.equal((await dm.forceRespawn(entry)).ok, false);
          assert.equal(world.creatures.get(bossId), stood);
          dm.loadRow = loadRow;
          dm.loadMinionRow = async () => { throw new Error('db went away'); };
          assert.equal((await dm.forceRespawn(entry)).ok, false);
          assert.equal(world.creatures.get(bossId), stood, 'not even for the escort read');
          assert.equal(minions().length, escort);
        } finally { dm.loadRow = loadRow; dm.loadMinionRow = loadMinionRow; dm.log = origErr; }
      });

      await t.test('a world still running an old placement refuses, and says so', async () => {
        const live2 = entry.row.dungeon_boss;
        entry.row.dungeon_boss = { ...live2, entity: 'Bone Regent' };
        try {
          const out = await live.summon({ owner: 'dungeon', name: BOSS, world: worldName, replaces: null });
          assert.equal(out.status, 409);
          assert.equal(out.body.error, 'stale');
          assert.match(out.body.message, /old placement \(Bone Regent\)/);
        } finally { entry.row.dungeon_boss = live2; }
      });

      await t.test('two summons at once still leave one boss', async () => {
        await Promise.all([
          app.handle._dungeonBosses.forceRespawn(entry),
          app.handle._dungeonBosses.forceRespawn(entry),
        ]);
        assert.equal(bossCount(), 1);
        assert.equal(minions().length, 1);
      });

      await t.test('a dead dungeon boss shows its return time; summon brings it back once and clears the timer', async () => {
        const c = world.creatures.get(bossId);
        world.creatures._removeKilled(c);
        await app.handle._onCreatureDeath(entry, bossId, a.userId);
        const dead = await rowOf('dungeon', BOSS, worldName);
        assert.equal(dead.status, 'dead');
        assert.equal(dead.secondsUntilReturn, 600);
        dClock += 100_000;
        assert.equal((await rowOf('dungeon', BOSS, worldName)).secondsUntilReturn, 500);

        const out = await live.summon({ owner: 'dungeon', name: BOSS, world: worldName, replaces: null });
        assert.equal(out.status, 200);
        assert.equal(bossCount(), 1);
        assert.equal(world.creatures.get(bossId).hp, world.creatures.get(bossId).maxHp);
        assert.equal((await rowOf('dungeon', BOSS, worldName)).status, 'alive');
        // The old timer falling due must not place a second.
        dClock += 600_000;
        a.p.x = 100; a.p.y = 100;
        await app.handle._creatureRespawnSweep();
        assert.equal(bossCount(), 1, 'the cleared timer places nothing');
        const again = world.creatures.get(bossId);
        // Killing the summoned boss still starts a normal timer.
        world.creatures._removeKilled(again);
        await app.handle._onCreatureDeath(entry, bossId, a.userId);
        assert.equal((await rowOf('dungeon', BOSS, worldName)).status, 'dead');
        await live.summon({ owner: 'dungeon', name: BOSS, world: worldName, replaces: null });
      });

      const m = app.handle._worldBossManager;
      await m.refreshCatalog();
      const [w1, w2] = m.catalog.bosses.map((b) => b.name);

      await t.test('a world boss not up is not_spawned, with the next rotation', async () => {
        assert.equal(m.state, 'idle');
        const row = await rowOf('world', w1);
        assert.equal(row.status, 'not_spawned');
        assert.ok(row.nextRotationSeconds > 0);
        assert.equal(row.world, null);
        assert.equal(row.summonWorld.name, worldName);
        assert.equal(row.summonWorld.players, 1);
        assert.equal(row.replaces, null);
        const list = (await live.bosses()).bosses.filter((b) => b.owner === 'world');
        assert.equal(list.length, m.catalog.bosses.length, 'one row per world boss in the catalog');
      });

      await t.test('summon spawns a world boss in the named world, with the announcement', async () => {
        const said = new Promise((resolve) => {
          a.ws.on('message', function on(d) {
            const f = JSON.parse(d);
            if (f.type === 'announcement' && f.kind === 'world_boss_spawn') { a.ws.off('message', on); resolve(f); }
          });
        });
        const out = await live.summon({ owner: 'world', name: w1, world: worldName, replaces: null });
        assert.equal(out.status, 200, JSON.stringify(out.body));
        assert.equal((await said).bossName, w1);
        const c = world.creatures.get(m.bossCreatureId);
        assert.ok(c, 'it really stands in the world');
        c.hp = c.maxHp * 0.25;
        c._playerDamage = new Map([['7', 1]]);
        const row = await rowOf('world', w1);
        assert.equal(row.status, 'alive');
        assert.equal(row.hpPct, 25);
        assert.equal(row.fighters, 1);
        assert.equal(row.world, worldName);
        assert.equal((await rowOf('world', w2)).replaces, w1, 'the other row names what it would replace');
      });

      await t.test('summon replaces a live world boss: one at a time', async () => {
        const old = m.bossCreatureId;
        // Its escort and summons go with it: repeated summons must not pile them up.
        const body = { id: 'wb_minion_1_1', type: CREATURE, x: 900, y: 900, hp: 5, level: 1, faction: 'hostile' };
        const summoned = { ...body, id: `skillsummon:${old}:1:0` };
        const bystander = { ...body, id: 'skillsummon:someone-else:1:0' };
        world.creatures.addCreatures([body, summoned, bystander]);
        const stale = await live.summon({ owner: 'world', name: w2, world: worldName, replaces: 'Somebody Else' });
        assert.equal(stale.status, 409);
        assert.equal(stale.body.error, 'replaces_changed');
        assert.match(stale.body.message, new RegExp(`${w1} is up now`));
        assert.equal(world.creatures.get(old) !== undefined, true, 'the refusal changed nothing');
        const out = await live.summon({ owner: 'world', name: w2, world: worldName, replaces: w1 });
        assert.equal(out.status, 200, JSON.stringify(out.body));
        assert.equal(out.body.replaced, w1);
        assert.equal(world.creatures.get(old), undefined, 'the old boss is gone');
        assert.equal(world.creatures.get(body.id), undefined, 'its phase minion is gone');
        assert.equal(world.creatures.get(summoned.id), undefined, 'its summon is gone');
        assert.ok(world.creatures.get(bystander.id), "another creature's summon stays");
        const up = world.creatures.all().filter((c) => c.bossTier === 'world' && c.id === m.bossCreatureId);
        assert.equal(up.length, 1);
        assert.equal(m.currentBoss.name, w2);
        assert.equal((await rowOf('world', w1)).status, 'not_spawned');
      });

      await t.test('summon refuses what is not on the list, and any other shape', async () => {
        const unknown = await live.summon({ owner: 'world', name: 'Nobody At All', world: worldName, replaces: null });
        assert.equal(unknown.status, 404);
        const wrong = await live.summon({ owner: 'dungeon', name: 'Nobody At All', world: worldName, replaces: null });
        assert.equal(wrong.status, 404);
        const inWrongWorld = await live.summon({ owner: 'world', name: w1, world: 'Somewhere Else', replaces: w2 });
        assert.equal(inWrongWorld.status, 409);
        assert.equal(inWrongWorld.body.error, 'stale');
        for (const bad of [null, [], 'x', {}, { owner: 'world', name: w1 }, { owner: 'world', name: w1, world: worldName }, { owner: 'nope', name: w1, world: worldName, replaces: null },
          { owner: 'world', name: w1, world: worldName, replaces: null, extra: 1 }, { owner: 'world', name: 5, world: worldName, replaces: null },
          { owner: 'world', name: w1, world: worldName, replaces: 5 }, { owner: 'world', name: 'x'.repeat(121), world: worldName, replaces: null }]) {
          assert.equal((await live.summon(bad)).status, 400, JSON.stringify(bad));
        }
        assert.equal(m.currentBoss.name, w2, 'none of them changed anything');
      });

      await t.test('no world loaded: a world boss is refused rather than spawned into nowhere', async () => {
        const m2 = app.handle._worldBossManager;
        m2._despawnBoss(app.handle.worlds, null, 'replaced');
        a.ws.terminate();
        await until('the world to empty', () => !app.handle.worlds.has(worldId));
        const out = await live.summon({ owner: 'world', name: w1, world: worldName, replaces: null });
        assert.equal(out.status, 409);
        assert.equal(out.body.error, 'not_loaded');
        assert.equal(m2.state, 'idle', 'nothing spawned');
      });
      await r.stop(app);
    }, { prefix: `zz${TAG}b` });
  });
});
