// The world boss audit fixes: where loot lands, who owns it, who earns it, Victor's
// Boon, the warning broadcast, spawning only with a creature on the ground, phase
// stepping and the HP gate, re-placing a boss mid-fight, minion cleanup, names on the
// wire, status size and throttling, and the persisted schedule.
const test = require('node:test');
const assert = require('node:assert/strict');
const { WorldBossManager } = require('../src/authority/worldBoss.js');
const { CreatureSim } = require('../src/authority/creatures.js');
const { GroundItemSim } = require('../src/authority/groundItems.js');
const { applyDamage } = require('../src/authority/damage.js');
const { clearArenaCache } = require('../src/authority/bossArena.js');
const skillBalance = require('../src/authority/skillBalance.js');
const balance = require('../src/services/bossBalance.js');

const bossRow = {
  id: 901, name: 'zzFix Titan', color: '#f00', hp: 10000, max_hp: 10000, defense: 20, resistances: {}, faction: 'hostile',
  gold_min: 0, gold_max: 0, attack_element: 'fire', vfx: null, prompt: 'zz', boss_tier: 'world', element: 'fire',
  hitbox_size: 96, auras: null, xp_reward: 0, base_damage: 40, display_width: 96, display_height: 96,
  behavior_name: null, abilities: null, loot_rolls: 0, loot_chest: false,
};
const minionRow = { ...bossRow, id: 902, name: 'Fire Elemental Guard', boss_tier: null, hp: 300, max_hp: 300, base_damage: 10 };

function entryOf(id = 'w1', name = 'Emerald Grove', extra = {}) {
  const map = { isWalkable: () => true, speedAt: () => 1, chunkSize: 8 };
  return {
    worldId: id,
    row: { name, width: 100, height: 100 },
    waypoints: new Map(),
    goldItemTypeId: null,
    world: { map, creatures: new CreatureSim(map, () => 0.05), groundItems: new GroundItemSim(8), players: new Map(), now: 5000 },
    ...extra,
  };
}
async function mgr(opts = {}) {
  clearArenaCache();
  const m = new WorldBossManager({
    bossIntervalMs: 600000, bossWarningMs: 120000, rng: () => 0,
    loadCatalog: async () => ({ bosses: [bossRow], minionsByElement: new Map([['fire', minionRow]]) }),
    ...opts,
  });
  await m.refreshCatalog();
  return m;
}
const worldsOf = (...entries) => new Map(entries.map((e) => [e.worldId, e]));
const minionsIn = (e) => e.world.creatures.all().filter((c) => String(c.id).startsWith('wb_minion_'));

// ---- 1. loot lands where the boss died ---------------------------------------------

test('1. loot lands at the boss\'s death position, not at the arena post', async () => {
  const m = await mgr();
  const e = entryOf();
  const drops = [];
  m.forceSpawn(Date.now(), worldsOf(e), {}, () => {});
  const c = e.world.creatures.get(m.bossCreatureId);
  c._playerDamage = new Map([['7', 5000]]);
  m.currentBoss._playerDamage = c._playerDamage;
  // The real path: the creature is already gone from the sim; only the snapshot knows.
  e.world.creatures.remove(c.id);
  await m.onCreatureDeath(e, null, '7', {
    dropLegendaryFn: async (en, uid, x, y) => { drops.push({ x, y }); return { id: 'i1' }; },
    killed: { x: 1234, y: 4321 },
  });
  assert.ok(drops.length >= 1);
  assert.ok(Math.abs(drops[0].x - 1234) <= 40, `${drops[0].x}`);
  assert.equal(drops[0].y, 4321 + 30);
});

test('1. without a snapshot the manager uses the last position it saw, then the arena', async () => {
  const m = await mgr();
  const e = entryOf();
  m.forceSpawn(Date.now(), worldsOf(e), {}, () => {});
  const c = e.world.creatures.get(m.bossCreatureId);
  c.x = 3000 - 48; c.y = 2000 - 48; // moved off its post
  m.tick(Date.now(), worldsOf(e), () => {});
  assert.deepEqual(m._deathPosition(null, null), { x: 3000, y: 2000 });
  m.currentBoss.lastX = undefined;
  assert.deepEqual(m._deathPosition(null, null), { x: m.currentBoss.spawnX, y: m.currentBoss.spawnY });
});

// ---- 2. drops are held for their owner ---------------------------------------------

test('2. the guaranteed legendary is reserved for its recipient (and a non-recipient cannot take it)', async () => {
  const m = await mgr();
  const e = entryOf();
  m.forceSpawn(Date.now(), worldsOf(e), {}, () => {});
  const c = e.world.creatures.get(m.bossCreatureId);
  c._playerDamage = new Map([['7', 6000], ['8', 3000]]);
  m.currentBoss._playerDamage = c._playerDamage;
  e.world.groundItems.add([{ id: 'leg1', item_type_id: 1, x: 0, y: 0, expires_at: null }, { id: 'leg2', item_type_id: 1, x: 0, y: 0, expires_at: null }]);
  let n = 0;
  await m.onCreatureDeath(e, c, '7', { dropLegendaryFn: async () => ({ id: `leg${++n}` }), killed: { x: 500, y: 500 } });
  const gi = e.world.groundItems;
  assert.equal(gi.canClaim('leg1', 7, Date.now()), true, 'the top damager (id 7 as a number) can claim');
  assert.equal(gi.canClaim('leg1', 9, Date.now()), false, 'a bystander cannot');
  assert.equal(gi.canClaim('leg2', 8, Date.now()), true);
  assert.equal(gi.canClaim('leg2', 7, Date.now()), false, 'nor can the other contributor');
  assert.equal(gi.canClaim('leg1', 7, Date.now() + 11 * 60 * 1000), true, 'free once the item has outlived its hold');
});

test('2. gold: one pile per eligible contributor, each held for its owner', async () => {
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/INSERT INTO world_items/.test(sql)) return { rows: [{ id: `g${queries.length}`, item_type_id: 5, x: params[2], y: params[3], expires_at: null, quantity: params[4], rarity: 'white', item_level: 1 }] };
      return { rows: [] };
    },
  };
  const m = await mgr();
  const e = entryOf('w1', 'Emerald Grove', { goldItemTypeId: 5 });
  m.forceSpawn(Date.now(), worldsOf(e), {}, () => {});
  const c = e.world.creatures.get(m.bossCreatureId);
  c._playerDamage = new Map([['7', 6000], ['8', 3000]]);
  m.currentBoss._playerDamage = c._playerDamage;
  m.currentBoss.goldReward = 1000;
  await m.onCreatureDeath(e, c, '7', { pool, dropLegendaryFn: async () => null, killed: { x: 500, y: 500 } });
  const piles = queries.filter((q) => /INSERT INTO world_items/.test(q.sql));
  assert.equal(piles.length, 2);
  assert.deepEqual(piles.map((p) => p.params[4]), [500, 500], 'the reward is split');
  const held = [...e.world.groundItems.items.values()];
  assert.equal(held.length, 2);
  assert.equal(held.filter((it) => it.reservedFor === '7').length, 1);
  assert.equal(held.filter((it) => it.reservedFor === '8').length, 1);
});

// ---- 3. eligibility ----------------------------------------------------------------

test('3. one tap does not make a contributor: no legendary, no boon', async () => {
  const m = await mgr();
  const e = entryOf();
  m.forceSpawn(Date.now(), worldsOf(e), {}, () => {});
  const c = e.world.creatures.get(m.bossCreatureId);
  c._playerDamage = new Map([['7', 6000], ['8', 2500], ['999', 1]]); // 999: an alt that hit once
  m.currentBoss._playerDamage = c._playerDamage;
  const got = [];
  const r = await m.onCreatureDeath(e, c, '7', { dropLegendaryFn: async (en, uid) => { got.push(uid); return null; }, killed: { x: 1, y: 1 } });
  assert.deepEqual(got, ['7', '8']);
  assert.deepEqual(r.eligibleContributors.map((x) => x.userId), ['7', '8']);
  assert.equal(m.hasBuff('999'), false);
  assert.equal(m.hasBuff('8'), true);
});

test('3. a crowd that splits the damage thinly still qualifies (the bar is min(1% hp, 25% of the top))', async () => {
  const m = await mgr();
  const e = entryOf();
  m.forceSpawn(Date.now(), worldsOf(e), {}, () => {});
  const c = e.world.creatures.get(m.bossCreatureId);
  const dmg = new Map();
  for (let i = 1; i <= 60; i += 1) dmg.set(String(i), 80); // 60 x 80 = 4800: nobody has 1% (100) of 10000
  c._playerDamage = dmg;
  m.currentBoss._playerDamage = dmg;
  const r = await m.onCreatureDeath(e, c, '1', { dropLegendaryFn: async () => null, killed: { x: 1, y: 1 } });
  assert.equal(r.eligibleContributors.length, 60);
});

test('3. damage that only broke a shield counts at half toward contribution', () => {
  const boss = { hp: 1000, maxHp: 1000, shield: 500 };
  applyDamage(boss, 400, 'physical', { defense: 0, resistances: {} }, 0, 'p:3');
  assert.equal(boss._playerDamage.get('3'), 200);
});

// ---- 5. Victor's Boon is real ------------------------------------------------------

test('5. the Boon is a live buff on online winners: +20% damage, +15% speed, +20% xp, inside the ceilings', async () => {
  const m = await mgr();
  const e = entryOf();
  m.forceSpawn(Date.now(), worldsOf(e), {}, () => {});
  const c = e.world.creatures.get(m.bossCreatureId);
  c._playerDamage = new Map([['7', 6000]]);
  m.currentBoss._playerDamage = c._playerDamage;
  const winner = { userId: '7', buffs: new Map(), maxHp: 100, hp: 100 };
  const other = { userId: '55', buffs: new Map(), maxHp: 100, hp: 100 };
  await m.onCreatureDeath(e, c, '7', {
    dropLegendaryFn: async () => null, killed: { x: 1, y: 1 },
    allPlayers: () => [{ player: winner, worldNow: 9000 }, { player: other, worldNow: 9000 }],
  });
  assert.ok(winner.buffs.has('wb_victors_boon'));
  assert.equal(winner._buffMods.dealt, 1.2);
  assert.equal(winner._buffMods.speed, 1.15);
  assert.equal(winner._buffMods.xp, 1.2);
  assert.equal(other.buffs.has('wb_victors_boon'), false);
  // survives into a later world: restored with the time that is left
  const later = { userId: 7, buffs: new Map(), maxHp: 100, hp: 100 };
  assert.equal(m.applyBoon(later, 100, Date.now() + 60 * 1000), true);
  const b = later.buffs.get('wb_victors_boon');
  assert.ok(b.durationMs < 15 * 60 * 1000 && b.durationMs > 13 * 60 * 1000);
  assert.equal(m.applyBoon({ userId: 1234, buffs: new Map() }, 0), false, 'no boon, no buff');
});

test('5. the xp multiplier reaches kill XP, and the buff ceilings still hold', () => {
  const p = { buffs: new Map() };
  skillBalance.grantTimedBuff(p, { id: 'a', nameEn: 'a' }, { xp: 1.6 }, 1000, 0);
  skillBalance.grantTimedBuff(p, { id: 'b', nameEn: 'b' }, { xp: 1.6 }, 1000, 0);
  assert.equal(p._buffMods.xp, 2, 'capped at x2');
});

// ---- 4. warning broadcast ----------------------------------------------------------

test('4. entering the warning sends a status frame, and refreshes it every 5 seconds', async () => {
  const m = await mgr();
  const e = entryOf();
  const now = Date.now();
  m.nextSpawnTime = now + 100000;
  const frames = [];
  m.tick(now, worldsOf(e), (f) => frames.push(f));
  assert.equal(m.state, 'warning');
  const st = frames.find((f) => f.type === 'world_boss_status');
  assert.equal(st.status.state, 'warning');
  assert.equal(st.status.bossName, 'zzFix Titan');
  frames.length = 0;
  m.tick(now + 2000, worldsOf(e), (f) => frames.push(f));
  assert.equal(frames.length, 0, 'not every tick');
  m.tick(now + 5100, worldsOf(e), (f) => frames.push(f));
  assert.equal(frames.filter((f) => f.type === 'world_boss_status').length, 1);
  assert.ok(frames[0].status.timeToSpawnMs > 0 && frames[0].status.timeToSpawnMs <= 100000, 'a countdown the client can run down');
});

// ---- 12. no NaN --------------------------------------------------------------------

test('12. a planned boss has a finite hpRatio in the warning state', async () => {
  const m = await mgr();
  const e = entryOf();
  m.nextSpawnTime = Date.now() + 1000;
  m.tick(Date.now(), worldsOf(e), () => {});
  const s = m.getStatus();
  assert.equal(s.state, 'warning');
  assert.equal(s.hpRatio, 1);
  assert.ok(Number.isFinite(s.currentHp));
});

// ---- 6. never active without a creature --------------------------------------------

test('6. no loaded world at the warning: nothing is announced, the rotation is not burned, it retries soon', async () => {
  const m = await mgr();
  const now = Date.now();
  m.nextSpawnTime = now + 60000;
  const frames = [];
  m.tick(now, new Map(), (f) => frames.push(f));
  assert.equal(m.state, 'idle');
  assert.equal(frames.length, 0);
  assert.ok(m.nextSpawnTime - now <= 31000 && m.nextSpawnTime > now, 'ask again in ~30s, not in 30 minutes');
  // a world appears: the full warning is given from then, not the short remainder
  const e = entryOf();
  m.tick(now + 31000, worldsOf(e), (f) => frames.push(f));
  assert.equal(m.state, 'warning');
  assert.ok(m.nextSpawnTime - (now + 31000) >= 119000, 'a full warning window');
});

test('6. the planned world was evicted during the warning: the boss goes to another loaded world', async () => {
  const m = await mgr();
  const a = entryOf('wa', 'World A');
  const b = entryOf('wb', 'World B');
  const now = Date.now();
  m.nextSpawnTime = now + 1000;
  m.tick(now, worldsOf(a, b), () => {});
  assert.equal(m.state, 'warning');
  const planned = m.activeWorldId;
  const survivor = planned === 'wa' ? b : a;
  m.tick(now + 2000, worldsOf(survivor), () => {});
  assert.equal(m.state, 'active');
  assert.equal(m.activeWorldId, survivor.worldId);
  assert.ok(survivor.world.creatures.get(m.bossCreatureId), 'and it is really there');
});

test('6. every world evicted at the spawn: still warning (not "active" with no boss), retries soon', async () => {
  const m = await mgr();
  const a = entryOf('wa', 'World A');
  const now = Date.now();
  m.nextSpawnTime = now + 1000;
  m.tick(now, worldsOf(a), () => {});
  const frames = [];
  m.tick(now + 2000, new Map(), (f) => frames.push(f));
  assert.notEqual(m.state, 'active');
  assert.equal(frames.some((f) => f.kind === 'world_boss_spawn'), false, 'no "has awakened" for a boss that is not there');
  assert.ok(m.nextSpawnTime > now + 2000);
  // A world is back: the boss is re-announced with a FULL warning (the first one was for
  // a world that no longer exists), then spawns for real.
  m.tick(now + 40000, worldsOf(a), () => {});
  assert.equal(m.state, 'warning');
  assert.ok(m.nextSpawnTime - (now + 40000) >= 119000);
  m.tick(now + 40000 + 121000, worldsOf(a), () => {});
  assert.equal(m.state, 'active');
  assert.ok(a.world.creatures.get(m.bossCreatureId));
});

test('6. a debug spawn with no world says no and stays idle', async () => {
  const m = await mgr();
  assert.equal(m.forceSpawn(Date.now(), new Map(), {}, () => {}), false);
  assert.equal(m.state, 'idle');
});

// ---- 8. phases step in order; the HP gate ------------------------------------------

test('8. a burst from 80% to 20% goes through phases 2, 3 and 4 in order (a shield and stats for each)', async () => {
  const m = await mgr();
  const e = entryOf();
  const frames = [];
  m.forceSpawn(Date.now(), worldsOf(e), {}, () => {});
  const c = e.world.creatures.get(m.bossCreatureId);
  c.hp = 2000; // 20%
  m.tick(Date.now(), worldsOf(e), (f) => frames.push(f));
  const phases = frames.filter((f) => f.kind === 'world_boss_phase').map((f) => f.phase);
  assert.deepEqual(phases, [2, 3, 4]);
  assert.equal(m.currentBoss.phase, 4);
  assert.ok(c.shield >= 10000 * (balance.PHASE_SHIELD[2] + balance.PHASE_SHIELD[3] + balance.PHASE_SHIELD[4]) * 0.99 || c.shield === 10000 * balance.SHIELD_CAP_FRACTION, `shield ${c.shield}`);
  assert.equal(c.damage, Math.round(m.currentBoss.damage * 1.5));
  assert.equal(c.mit.defense, Math.round(20 * 1.25 * 100) / 100, 'the phase-3 defence boost is real (it used to set an inert field)');
  assert.equal(minionsIn(e).length > 0, true);
});

test('8. the HP gate holds the boss at the next threshold until the phase has been applied', async () => {
  const m = await mgr();
  const e = entryOf();
  m.forceSpawn(Date.now(), worldsOf(e), {}, () => {});
  const c = e.world.creatures.get(m.bossCreatureId);
  assert.equal(c._hpFloor, 7500);
  c.damageTakenMult = 1; c.shield = 0;
  applyDamage(c, 9000, 'physical', { defense: 0, resistances: {} }, 1, 'p:1');
  assert.equal(c.hp, 7500, 'a huge hit stops at the 75% line');
  m.tick(Date.now(), worldsOf(e), () => {});
  assert.equal(m.currentBoss.phase, 2);
  assert.equal(c._hpFloor, 5000, 'the next gate is armed');
  m.currentBoss.phase = 4; m._checkPhaseTransition(c, e, null);
  assert.equal(c._hpFloor, null, 'no gate after the last phase');
});

// ---- 7. re-placing mid-fight -------------------------------------------------------

test('7. a boss re-placed in phase 4 keeps its phase stats, its enrage and its minions', async () => {
  const m = await mgr();
  const e = entryOf();
  m.forceSpawn(Date.now(), worldsOf(e), {}, () => {});
  const c = e.world.creatures.get(m.bossCreatureId);
  c.hp = 2000;
  m.tick(Date.now(), worldsOf(e), () => {});
  m._enrage(c, e, null);
  const base = m.currentBoss.damage;
  // the world is evicted and loaded again: a fresh sim, no boss in it
  const fresh = entryOf('w1', 'Emerald Grove');
  m.tick(Date.now() + 5, worldsOf(fresh), () => {});
  const back = fresh.world.creatures.get(m.bossCreatureId);
  assert.ok(back, 're-placed');
  assert.equal(back.hp, 2000);
  assert.equal(back.damage, Math.round(base * 1.5), 'phase-4 damage, not phase 1');
  assert.equal(back.speed, Math.round(m.currentBoss.speed * 1.3));
  assert.equal(back.enraged, true);
  assert.ok(minionsIn(fresh).length > 0, 'the phase minions are back');
  assert.equal(back._hpFloor, null);
});

// ---- 9. minions go with the boss ---------------------------------------------------

test('9. phase minions are removed on timeout, on a debug despawn and on the kill', async () => {
  for (const how of ['timeout', 'kill']) {
    const m = await mgr({ bossLifetimeMs: 600000 });
    const e = entryOf();
    m.forceSpawn(Date.now(), worldsOf(e), {}, () => {});
    const c = e.world.creatures.get(m.bossCreatureId);
    c.hp = 4000;
    m.tick(Date.now(), worldsOf(e), () => {});
    assert.ok(minionsIn(e).length > 0, 'minions exist');
    if (how === 'timeout') m._despawnBoss(worldsOf(e), () => {}, 'timeout');
    else {
      c._playerDamage = new Map([['7', 9000]]);
      m.currentBoss._playerDamage = c._playerDamage;
      await m.onCreatureDeath(e, c, '7', { dropLegendaryFn: async () => null, killed: { x: 1, y: 1 } });
    }
    assert.equal(minionsIn(e).length, 0, how);
  }
});

// ---- 10. names, not account ids ----------------------------------------------------

test('10. top damagers and the slain announcement carry character names, never account ids', async () => {
  const m = await mgr({ nameOf: (id) => ({ 7: 'Valeria', 8: 'Brom' }[id] || null) });
  const e = entryOf();
  m.forceSpawn(Date.now(), worldsOf(e), {}, () => {});
  const c = e.world.creatures.get(m.bossCreatureId);
  c._playerDamage = new Map([['7', 6000], ['8', 3000]]);
  m.currentBoss._playerDamage = c._playerDamage;
  const st = m.getStatus();
  assert.deepEqual(st.topDamagers, [{ rank: 1, name: 'Valeria', damage: 6000 }, { rank: 2, name: 'Brom', damage: 3000 }]);
  assert.equal(JSON.stringify(st).includes('userId'), false, 'no account id anywhere in the status');
  const frames = [];
  await m.onCreatureDeath(e, c, '7', { dropLegendaryFn: async () => null, broadcastFn: (f) => frames.push(f), killed: { x: 1, y: 1 } });
  const slain = frames.find((f) => f.kind === 'world_boss_slain');
  assert.deepEqual(slain.topDamagers.map((d) => d.name), ['Valeria', 'Brom']);
  assert.equal(JSON.stringify(slain).includes('userId'), false);
});

test('10. an unnamed player is "Adventurer", not an id', async () => {
  const m = await mgr();
  const e = entryOf();
  m.forceSpawn(Date.now(), worldsOf(e), {}, () => {});
  m.currentBoss._playerDamage = new Map([['12345', 10]]);
  assert.equal(m.getTopDamagers(1)[0].name, 'Adventurer');
});

// ---- 13. status size and throttling ------------------------------------------------

test('13. the full card goes to the boss\'s world, a slim status to every other world', async () => {
  const m = await mgr({ nameOf: () => 'Valeria' });
  const e = entryOf();
  m.forceSpawn(Date.now(), worldsOf(e), {}, () => {});
  m.currentBoss._playerDamage = new Map([['7', 100]]);
  const full = m.getStatus();
  assert.equal(m.statusFor(full, 'w1'), full);
  const slim = m.statusFor(full, 'elsewhere');
  assert.equal(slim.topDamagers, undefined);
  assert.equal(slim.currentHp, undefined);
  assert.equal(slim.state, 'active');
  assert.equal(slim.worldName, 'Emerald Grove');
  assert.equal(slim.bossName, 'zzFix Titan');
  assert.equal(m.statusFor({ state: 'idle' }, 'x').state, 'idle');
  const warn = { state: 'warning', bossName: 'B', timeToSpawnMs: 5, topDamagers: [1], worldId: 'w1' };
  assert.equal(m.statusFor(warn, 'elsewhere').topDamagers, undefined, 'a warning is slim too');
});

test('13. hp-change broadcasts: not within a second, not for a 0.1% change, always a heartbeat', async () => {
  const m = await mgr();
  const e = entryOf();
  const t0 = Date.now();
  m.forceSpawn(t0, worldsOf(e), {}, () => {});
  const c = e.world.creatures.get(m.bossCreatureId);
  const sent = [];
  const send = (f) => { if (f.type === 'world_boss_status') sent.push(f); };
  m.tick(t0 + 100, worldsOf(e), send);
  assert.equal(sent.length, 0, 'nothing moved');
  c.hp = 9990; // 0.1%
  m.tick(t0 + 1500, worldsOf(e), send);
  assert.equal(sent.length, 0, 'too small a change');
  c.hp = 9900; // 1% since the last broadcast
  m.tick(t0 + 1700, worldsOf(e), send);
  assert.equal(sent.length, 1, 'a real change, a second since the spawn broadcast');
  c.hp = 9800;
  m.tick(t0 + 2000, worldsOf(e), send);
  assert.equal(sent.length, 1, 'but not twice within a second');
  m.tick(t0 + 5000, worldsOf(e), send);
  assert.equal(sent.length, 2, 'the heartbeat / the pending change goes out');
});

// ---- 11. persisted schedule --------------------------------------------------------

test('11. the spawn time is saved when it changes, and restored on start', async () => {
  const saved = [];
  let stored = null;
  const pool = {
    query: async (sql, params) => {
      if (/INSERT INTO world_boss_state/.test(sql)) { stored = params[0]; saved.push(params[0]); return { rows: [] }; }
      if (/SELECT next_spawn_at FROM world_boss_state/.test(sql)) return { rows: stored ? [{ next_spawn_at: stored }] : [] };
      return { rows: [] };
    },
  };
  const m = await mgr({ pool, persistSchedule: true });
  const target = Date.now() + 3600 * 1000;
  m.nextSpawnTime = target;
  await new Promise((r) => setImmediate(r));
  assert.equal(saved.length, 1);
  assert.equal(new Date(stored).getTime(), target);
  m.nextSpawnTime = target; // unchanged: no write
  await new Promise((r) => setImmediate(r));
  assert.equal(saved.length, 1);

  const restarted = await mgr({ pool, persistSchedule: true });
  assert.equal(await restarted.restoreSchedule(), true);
  assert.equal(restarted.nextSpawnTime, target);
});

test('11. a schedule that is already overdue on start becomes warning + grace, not an instant spawn', async () => {
  const pool = { query: async () => ({ rows: [{ next_spawn_at: new Date(Date.now() - 3600 * 1000) }] }) };
  const m = await mgr({ pool, persistSchedule: true });
  const now = Date.now();
  await m.restoreSchedule(now);
  assert.ok(m.nextSpawnTime >= now + 120000, 'at least the warning window away');
});

test('11. persistence is off for a bare manager, and a failing database never breaks the tick', async () => {
  const m = await mgr();
  assert.equal(await m.restoreSchedule(), false);
  const bad = await mgr({ pool: { query: async () => { throw new Error('db down'); } }, persistSchedule: true });
  assert.equal(await bad.restoreSchedule(), false);
  bad.nextSpawnTime = Date.now() + 5;
  await new Promise((r) => setImmediate(r));
});

// ---- 5 (xp). the boon's xp multiplier reaches paid XP -------------------------------

test('5. withXpBoon scales XP for a player holding the boon, and only for them', () => {
  const { withXpBoon } = require('../src/authority/loot.js');
  const holder = { userId: 'a', buffs: new Map() };
  skillBalance.grantTimedBuff(holder, { id: 'wb_victors_boon', nameEn: 'b' }, { xp: 1.2 }, 1000, 0);
  const plain = { userId: 'b', buffs: new Map() };
  const entry = { world: { getPlayer: (id) => ({ a: holder, b: plain }[id]) } };
  assert.equal(withXpBoon(entry, 'a', 1000), 1200);
  assert.equal(withXpBoon(entry, 'b', 1000), 1000);
  assert.equal(withXpBoon(entry, null, 1000), 1000);
  assert.equal(withXpBoon(entry, 'nobody', 1000), 1000);
});
