const test = require('node:test');
const assert = require('node:assert/strict');
const {
  WorldBossManager, WORLD_BOSS_CATALOG, BOSS_INTERVAL_MS, BOSS_WARNING_MS,
} = require('../src/authority/worldBoss');

function fakeWorldEntry(worldId = 'w1', name = 'Emerald Grove') {
  const creatures = new Map();
  return {
    worldId,
    row: { name, width: 32, height: 32 },
    waypoints: new Map([['0,0', { id: 'wp_1', name: 'Grove Waypoint', x: 200, y: 200 }]]),
    world: {
      creatures: {
        get: (id) => creatures.get(id),
        addCreatures: (list) => {
          for (const c of list) creatures.set(c.id, c);
        },
        remove: (id) => creatures.delete(id),
      },
    },
  };
}

test('WorldBossManager catalog contains 4 distinct elemental bosses in English', () => {
  assert.strictEqual(WORLD_BOSS_CATALOG.length, 4);
  const elements = WORLD_BOSS_CATALOG.map((b) => b.element).sort();
  assert.deepStrictEqual(elements, ['arcane', 'fire', 'ice', 'lightning']);

  for (const boss of WORLD_BOSS_CATALOG) {
    assert.ok(boss.name && typeof boss.name === 'string');
    assert.ok(boss.maxHp >= 10000, `${boss.name} should have boss-tier HP`);
    assert.ok(boss.damage >= 30, `${boss.name} should have high damage`);
    assert.ok(/^[A-Za-z0-9\s,'.]+$/.test(boss.name), `${boss.name} must be in English`);
  }
});

test('WorldBossManager transitions from idle to warning at 2 minutes remaining', () => {
  const manager = new WorldBossManager({
    bossIntervalMs: 600000,
    bossWarningMs: 120000,
  });

  const worlds = new Map([['w1', fakeWorldEntry('w1', 'Sunken Vale')]]);
  const now = Date.now();
  manager.nextSpawnTime = now + 100000; // 100s left (< 120s warning)

  const announcements = [];
  manager.tick(now, worlds, (frame) => announcements.push(frame));

  assert.strictEqual(manager.state, 'warning');
  assert.strictEqual(announcements.length, 1);
  assert.strictEqual(announcements[0].type, 'announcement');
  assert.strictEqual(announcements[0].kind, 'world_boss_warning');
  assert.ok(announcements[0].text.includes('[World Boss Alert]'));
  assert.ok(announcements[0].text.includes('will emerge in 2 minutes'));
  assert.strictEqual(announcements[0].nearestWaypointId, 'wp_1');
});

test('WorldBossManager spawns boss at nextSpawnTime with English spawn announcement', () => {
  const manager = new WorldBossManager({
    bossIntervalMs: 600000,
    bossWarningMs: 120000,
  });

  const entry = fakeWorldEntry('w1', 'Frozen Wastes');
  const worlds = new Map([['w1', entry]]);
  const now = Date.now();
  manager.state = 'warning';
  manager.nextSpawnTime = now - 1; // Time to spawn

  const frames = [];
  manager.tick(now, worlds, (frame) => frames.push(frame));

  assert.strictEqual(manager.state, 'active');
  assert.ok(manager.bossCreatureId);

  const spawnAnnouncement = frames.find((f) => f.kind === 'world_boss_spawn');
  assert.ok(spawnAnnouncement);
  assert.ok(spawnAnnouncement.text.includes('[World Boss]'));
  assert.ok(spawnAnnouncement.text.includes('has awakened at Frozen Wastes!'));

  // Creature added to sim
  const bossInSim = entry.world.creatures.get(manager.bossCreatureId);
  assert.ok(bossInSim);
  assert.strictEqual(bossInSim.isWorldBoss, true);
  assert.ok(bossInSim.maxHp >= 10000);
});

test('WorldBossManager onCreatureDeath gives guaranteed Legendary to Top 3 and Victor Boon to participants', async () => {
  const manager = new WorldBossManager({
    bossIntervalMs: 600000,
  });

  const entry = fakeWorldEntry('w1', 'Molten Core');
  manager.state = 'active';
  manager.currentBoss = { ...WORLD_BOSS_CATALOG[0] };
  manager.bossCreatureId = 'wb_test_1';

  const bossCreature = {
    id: 'wb_test_1',
    isWorldBoss: true,
    name: 'Ignis, the Magma Colossus',
    x: 500,
    y: 500,
    _playerDamage: new Map([
      ['user_1', 4500],
      ['user_2', 3200],
      ['user_3', 2100],
      ['user_4', 1200],
      ['user_5', 400],
    ]),
  };

  const legendaryDrops = [];
  const announcements = [];

  const result = await manager.onCreatureDeath(entry, bossCreature, 'user_1', {
    broadcastFn: (frame) => announcements.push(frame),
    dropLegendaryFn: async (e, userId, x, y, lvl) => {
      legendaryDrops.push({ userId, lvl });
    },
  });

  assert.strictEqual(result.slain, true);
  assert.strictEqual(result.topDamagers.length, 3);
  assert.deepStrictEqual(result.topDamagers.map((t) => t.userId), ['user_1', 'user_2', 'user_3']);

  // Exactly Top 3 get legendary drop
  assert.strictEqual(legendaryDrops.length, 3);
  assert.deepStrictEqual(legendaryDrops.map((d) => d.userId), ['user_1', 'user_2', 'user_3']);

  // All 5 participants receive Victor's Boon buff
  for (const uid of ['user_1', 'user_2', 'user_3', 'user_4', 'user_5']) {
    assert.strictEqual(manager.hasBuff(uid), true);
    const buff = manager.getBuff(uid);
    assert.strictEqual(buff.speedBonus, 0.15);
    assert.strictEqual(buff.damageBonus, 0.20);
    assert.strictEqual(buff.xpBonus, 0.20);
  }

  // Non-participant has no buff
  assert.strictEqual(manager.hasBuff('user_999'), false);

  // Victory broadcast is in English
  const slainFrame = announcements.find((f) => f.kind === 'world_boss_slain');
  assert.ok(slainFrame);
  assert.ok(slainFrame.text.includes('[World Boss Defeated]'));
  assert.ok(slainFrame.text.includes('Ignis, the Magma Colossus has been slain!'));
  assert.ok(slainFrame.text.includes("Victor's Boon"));
});
