// backend/tests/world_boss.test.js
// SOMET-603 (S1): the world boss rotation is driven by entity_types rows
// (boss_tier = 'world'), loaded through an injectable loader. Fixture rows are
// zz-named on purpose: the manager must spawn whatever the catalog holds and
// must never know a boss by name.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { WorldBossManager } = require('../src/authority/worldBoss');
const { CreatureSim } = require('../src/authority/creatures');

function bossRow(over = {}) {
  return {
    id: 901, name: 'zzMagma Boss', color: '#ff4757', hp: 12000, max_hp: 12000, defense: 25,
    resistances: {}, faction: 'hostile', gold_min: 500, gold_max: 500, attack_element: 'fire',
    vfx: null, prompt: 'zz', boss_tier: 'world', element: 'fire', hitbox_size: 96, auras: null,
    xp_reward: 3500, base_damage: 42, display_width: 96, display_height: 96,
    behavior_name: null, abilities: null, ...over,
  };
}
const catalogOf = (bosses, minions = []) =>
  async () => ({ bosses, minionsByElement: new Map(minions.map((m) => [m.element, m])) });

function worldEntry(worldId = 'w1', name = 'Emerald Grove') {
  const sim = new CreatureSim({ isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }, () => 0.05);
  return {
    worldId,
    row: { name, width: 32, height: 32 },
    waypoints: new Map([['0,0', { id: 'wp_1', name: 'Grove Waypoint', x: 200, y: 200 }]]),
    world: { creatures: sim },
  };
}
async function managerWith(loadCatalog) {
  const m = new WorldBossManager({ bossIntervalMs: 600000, bossWarningMs: 120000, rng: () => 0, loadCatalog });
  await m.refreshCatalog();
  return m;
}

test('transitions from idle to warning at 2 minutes remaining', async () => {
  const m = await managerWith(catalogOf([bossRow()]));
  const worlds = new Map([['w1', worldEntry('w1', 'Sunken Vale')]]);
  const now = Date.now();
  m.nextSpawnTime = now + 100000;
  const frames = [];
  m.tick(now, worlds, (f) => frames.push(f));
  assert.equal(m.state, 'warning');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].kind, 'world_boss_warning');
  assert.ok(frames[0].text.includes('zzMagma Boss will emerge in 2 minutes'));
  assert.equal(frames[0].nearestWaypointId, 'wp_1');
});

test('spawns the catalog row into the sim at its catalog hitbox and stats', async () => {
  const m = await managerWith(catalogOf([bossRow()]));
  const entry = worldEntry('w1', 'Frozen Wastes');
  const worlds = new Map([['w1', entry]]);
  const now = Date.now();
  m.state = 'warning';
  m.nextSpawnTime = now - 1;
  const frames = [];
  m.tick(now, worlds, (f) => frames.push(f));

  assert.equal(m.state, 'active');
  const spawn = frames.find((f) => f.kind === 'world_boss_spawn');
  assert.ok(spawn.text.includes('zzMagma Boss has awakened at Frozen Wastes!'));
  const c = entry.world.creatures.get(m.bossCreatureId);
  assert.ok(c, 'the boss is in the real sim');
  assert.equal(c.bossTier, 'world');
  assert.equal(c.element, 'fire');
  assert.equal(c.name, 'zzMagma Boss');
  assert.equal(c.width, 96);
  assert.equal(c.height, 96);
  assert.equal(c.maxHp, 12000);
  assert.equal(c.damage, 42);
  assert.equal(c.level, 100);
});

// Review Focus 3.
test('idles without crashing when the catalog holds no world-tier rows', async (t) => {
  const warns = t.mock.method(console, 'warn', () => {});
  const m = await managerWith(catalogOf([]));
  const worlds = new Map([['w1', worldEntry()]]);
  const now = Date.now();
  m.nextSpawnTime = now + 1000;
  const frames = [];
  assert.doesNotThrow(() => m.tick(now, worlds, (f) => frames.push(f)));
  assert.equal(m.state, 'idle');
  assert.deepEqual(frames, []);
  assert.ok(m.nextSpawnTime > now + 1000, 'the empty rotation is pushed back, not retried every tick');
  // A second rotation that is also empty must not log again.
  const later = m.nextSpawnTime;
  assert.doesNotThrow(() => m.tick(later, worlds, (f) => frames.push(f)));
  assert.equal(m.state, 'idle');
  assert.deepEqual(frames, []);
  assert.ok(m.nextSpawnTime > later, 'the second empty rotation is pushed back too');
  assert.equal(m.forceSpawn(now, worlds, {}, () => {}), false);
  assert.equal(m.state, 'idle');
  const emptyLines = warns.mock.calls.filter((c) => /boss_tier = 'world'/.test(String(c.arguments[0])));
  assert.equal(emptyLines.length, 1, 'the empty catalog is logged once, not once per rotation');
});

// Review Focus 2.
test('a renamed catalog row spawns under its new name', async () => {
  const m = await managerWith(catalogOf([bossRow({ name: 'zzRenamed Titan' })]));
  const entry = worldEntry();
  const worlds = new Map([['w1', entry]]);
  assert.equal(m.forceSpawn(Date.now(), worlds, {}, () => {}), true);
  assert.equal(m.getStatus().bossName, 'zzRenamed Titan');
  assert.equal(entry.world.creatures.get(m.bossCreatureId).name, 'zzRenamed Titan');
});

test('forceSpawn spawns the named boss, not the random pick', async () => {
  // rng () => 0 would pick the FIRST row; the name must win over it.
  const m = await managerWith(catalogOf([
    bossRow(), bossRow({ id: 902, name: 'zzFrost Boss', element: 'ice', attack_element: 'ice', hitbox_size: 80 }),
  ]));
  const entry = worldEntry();
  m.forceSpawn(Date.now(), new Map([['w1', entry]]), { bossName: 'zzFrost Boss' }, () => {});
  const c = entry.world.creatures.get(m.bossCreatureId);
  assert.equal(c.name, 'zzFrost Boss');
  assert.equal(c.width, 80);
});

test('getStatus exposes the live boss creature id', async () => {
  const m = await managerWith(catalogOf([bossRow()]));
  const entry = worldEntry();
  m.forceSpawn(Date.now(), new Map([['w1', entry]]), {}, () => {});
  const status = m.getStatus();
  assert.equal(status.bossCreatureId, m.bossCreatureId);
  assert.ok(entry.world.creatures.has(status.bossCreatureId));
});

test('a timed-out boss is removed from the sim, not left roaming untracked', async () => {
  const m = await managerWith(catalogOf([bossRow()]));
  const entry = worldEntry();
  const worlds = new Map([['w1', entry]]);
  const now = Date.now();
  m.forceSpawn(now, worlds, {}, () => {});
  const id = m.bossCreatureId;
  m.tick(now + m.bossLifetimeMs + 1, worlds, () => {});
  assert.equal(m.state, 'idle');
  assert.equal(entry.world.creatures.has(id), false);
});

test('refreshCatalog keeps the previous catalog when the loader throws', async () => {
  let fail = false;
  const m = await managerWith(async () => {
    if (fail) throw new Error('db down');
    return { bosses: [bossRow()], minionsByElement: new Map() };
  });
  fail = true;
  await m.refreshCatalog();
  assert.equal(m.catalog.bosses.length, 1);
});

test('onCreatureDeath gives guaranteed Legendary to Top 3 and Victor Boon to participants', async () => {
  const m = await managerWith(catalogOf([bossRow()]));
  const entry = worldEntry('w1', 'Molten Core');
  m.forceSpawn(Date.now(), new Map([['w1', entry]]), {}, () => {});
  const boss = {
    id: m.bossCreatureId, bossTier: 'world', name: 'zzMagma Boss', x: 500, y: 500,
    _playerDamage: new Map([['user_1', 4500], ['user_2', 3200], ['user_3', 2100], ['user_4', 1200], ['user_5', 400]]),
  };
  const drops = [];
  const frames = [];
  const result = await m.onCreatureDeath(entry, boss, 'user_1', {
    broadcastFn: (f) => frames.push(f),
    dropLegendaryFn: async (e, userId) => { drops.push(userId); },
  });
  assert.equal(result.slain, true);
  assert.deepEqual(drops, ['user_1', 'user_2', 'user_3']);
  for (const uid of ['user_1', 'user_2', 'user_3', 'user_4', 'user_5']) assert.equal(m.hasBuff(uid), true);
  assert.equal(m.hasBuff('user_999'), false);
  assert.ok(frames.find((f) => f.kind === 'world_boss_slain').text.includes('zzMagma Boss has been slain!'));
});

const flush = () => new Promise((r) => setImmediate(r));

// D2: pruning or world eviction used to make the tick read "boss missing" as a
// kill -- slain announcement, legendary drops (to user '1' as the fallback),
// gold pile and chest, with nobody having fought it.
test('a boss missing from its loaded world is re-placed, never announced slain (SOMET-603)', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const m = await managerWith(catalogOf([bossRow()]));
  let queries = 0;
  m.pool = { query: async () => { queries++; return { rows: [] }; } };
  const entry = worldEntry();
  const worlds = new Map([['w1', entry]]);
  const now = Date.now();
  m.forceSpawn(now, worlds, {}, () => {});
  const id = m.bossCreatureId;
  entry.world.creatures.remove(id); // pruned / world reloaded without it
  m.currentBoss.currentHp = 7000;
  m.currentBoss._playerDamage = new Map([['user_1', 5000]]);

  const frames = [];
  m.tick(now + 1000, worlds, (f) => frames.push(f));
  await flush();

  assert.equal(frames.filter((f) => f.kind === 'world_boss_slain').length, 0, 'no slain announcement');
  assert.equal(queries, 0, 'no drops, gold or chest written');
  assert.equal(m.hasBuff('user_1'), false, 'no Victor\'s Boon');
  assert.equal(m.state, 'active');
  assert.equal(m.bossCreatureId, id);
  const c = entry.world.creatures.get(id);
  assert.ok(c, 'the boss is back in the sim under the same id');
  assert.equal(c.hp, 7000, 'at its current hp, not healed');
  assert.equal(c.maxHp, 12000, 'its max hp is the boss max, not the current hp');
  assert.equal(c.bossTier, 'world');
  assert.equal(c._playerDamage.get('user_1'), 5000, 'contribution survives the re-place');
});

// I3: the death used to be claimed only after the reward awaits, so a tick
// landing mid-reward saw "boss missing" and paid out a second time.
test('a real kill announces slain exactly once even if the tick runs mid-reward (SOMET-603)', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const m = await managerWith(catalogOf([bossRow()]));
  const entry = worldEntry();
  const worlds = new Map([['w1', entry]]);
  const now = Date.now();
  m.forceSpawn(now, worlds, {}, () => {});
  const id = m.bossCreatureId;
  const c = entry.world.creatures.get(id);
  c._playerDamage = new Map([['user_1', 9000]]);
  entry.world.creatures.remove(id); // the real kill paths remove before dispatch

  let release;
  const gate = new Promise((r) => { release = r; });
  const drops = [];
  const frames = [];
  const death = m.onCreatureDeath(entry, c, 'user_1', {
    broadcastFn: (f) => frames.push(f),
    dropLegendaryFn: async (e, uid) => { drops.push(uid); await gate; },
  });
  m.tick(now + 1000, worlds, (f) => frames.push(f)); // lands mid-reward
  await flush();
  release();
  await death;
  await flush();

  assert.equal(frames.filter((f) => f.kind === 'world_boss_slain').length, 1, 'slain exactly once');
  assert.deepEqual(drops, ['user_1'], 'one set of drops');
  assert.equal(entry.world.creatures.has(id), false, 'a killed boss is not re-placed');
  assert.equal(m.state, 'idle');
});

// The deleted constant used to be referenced by server.js without being
// imported -- every "Spawn <boss>" test-panel click threw ReferenceError.
test('nothing references the deleted WORLD_BOSS_CATALOG constant', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/authority/server.js'), 'utf8');
  assert.doesNotMatch(src, /WORLD_BOSS_CATALOG/);
});

// Minor (b): the debug panel names a boss; a name the catalog does not hold
// must fail loudly (server.js sends 'no world boss in the catalog'), not
// spawn a random boss in its place.
test('forceSpawn / forceWarning refuse an unknown boss name instead of picking a random one', async () => {
  const m = await managerWith(catalogOf([bossRow()]));
  const entry = worldEntry();
  const worlds = new Map([['w1', entry]]);
  const frames = [];
  assert.equal(m.forceSpawn(Date.now(), worlds, { bossName: 'zzNo Such Boss' }, (f) => frames.push(f)), false);
  assert.equal(m.state, 'idle');
  assert.equal(m.currentBoss, null);
  assert.equal(entry.world.creatures.count(), 0, 'nothing spawned');
  assert.equal(m.forceWarning(Date.now(), worlds, { bossName: 'zzNo Such Boss' }, (f) => frames.push(f)), false);
  assert.equal(m.state, 'idle');
  assert.equal(m.currentBoss, null);
  assert.deepEqual(frames, []);
  // The known name still works.
  assert.equal(m.forceSpawn(Date.now(), worlds, { bossName: 'zzMagma Boss' }, () => {}), true);
});

// Minor (c): a failed load is not an empty catalog; the skip log names the
// real cause.
test('a rotation skipped because the catalog failed to load says so, not "no boss rows"', async (t) => {
  const warns = t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const m = await managerWith(async () => { throw new Error('db down'); });
  const worlds = new Map([['w1', worldEntry()]]);
  const now = Date.now();
  m.nextSpawnTime = now + 1000;
  m.tick(now, worlds, () => {});
  assert.equal(m.state, 'idle');
  const lines = warns.mock.calls.map((c) => String(c.arguments[0]));
  assert.equal(lines.filter((l) => /catalog failed to load/.test(l) && /db down/.test(l)).length, 1, lines.join('\n'));
  assert.equal(lines.filter((l) => /boss_tier = 'world'/.test(l)).length, 0, 'not misreported as an empty catalog');
});
