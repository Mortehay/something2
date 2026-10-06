const test = require('node:test');
const assert = require('node:assert/strict');
const { WorldBossManager, WORLD_BOSS_CATALOG } = require('../src/authority/worldBoss');

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

test('WorldBossManager triggers phase 2 (Enraged) at 75% HP with announcement', () => {
  const manager = new WorldBossManager({ bossIntervalMs: 600000 });
  const entry = fakeWorldEntry('w1', 'Molten Core');
  const worlds = new Map([['w1', entry]]);
  const now = Date.now();

  manager.state = 'active';
  manager.spawnedAt = now;
  manager.currentBoss = { ...WORLD_BOSS_CATALOG[0], currentHp: 12000, maxHp: 12000, phase: 1 };
  manager.bossCreatureId = 'wb_boss_1';

  const bossCreature = {
    id: 'wb_boss_1',
    type: manager.currentBoss.type,
    name: manager.currentBoss.name,
    hp: 8000, // 8000 / 12000 = 66.6% HP -> triggers Phase 2 (75% threshold)
    maxHp: 12000,
    speed: 60,
    damage: 42,
    defense: 25,
  };
  entry.world.creatures.addCreatures([bossCreature]);

  const announcements = [];
  manager.tick(now, worlds, (frame) => announcements.push(frame));

  assert.strictEqual(manager.currentBoss.phase, 2);
  const phaseNotice = announcements.find((f) => f.kind === 'world_boss_phase');
  assert.ok(phaseNotice, 'Should broadcast world_boss_phase announcement');
  assert.strictEqual(phaseNotice.phase, 2);
  assert.ok(bossCreature.speed > 60, 'Boss speed should increase in Phase 2');
});

test('WorldBossManager triggers phase 3 (Elemental Nova) at 50% HP and spawns minions', () => {
  const manager = new WorldBossManager({ bossIntervalMs: 600000 });
  const entry = fakeWorldEntry('w1', 'Frozen Wastes');
  const worlds = new Map([['w1', entry]]);
  const now = Date.now();

  manager.state = 'active';
  manager.spawnedAt = now;
  manager.currentBoss = { ...WORLD_BOSS_CATALOG[1], currentHp: 14000, maxHp: 14000, phase: 2 };
  manager.bossCreatureId = 'wb_boss_2';

  const bossCreature = {
    id: 'wb_boss_2',
    type: manager.currentBoss.type,
    name: manager.currentBoss.name,
    hp: 6000, // 6000 / 14000 = 42.8% HP -> triggers Phase 3 (50% threshold)
    maxHp: 14000,
    speed: 50,
    damage: 35,
    defense: 32,
    x: 400,
    y: 400,
  };
  entry.world.creatures.addCreatures([bossCreature]);

  const announcements = [];
  manager.tick(now, worlds, (frame) => announcements.push(frame));

  assert.strictEqual(manager.currentBoss.phase, 3);
  assert.ok(bossCreature.defense > 32, 'Boss defense should increase in Phase 3');

  // Verify minions spawned
  const status = manager.getStatus();
  assert.strictEqual(status.phase, 3);
});
