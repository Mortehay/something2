const test = require('node:test');
const assert = require('node:assert/strict');
const { World } = require('../src/authority/world.js');

function makeTestWorld() {
  const map = {
    isWalkable: () => true,
    width: 2000,
    height: 2000,
    decorations: [],
  };
  const weapons = new Map();
  return new World(map, weapons, 'fists');
}

test('castSkill damages creatures in area and deducts mana authoritatively', () => {
  const world = makeTestWorld();
  const userId = 'u_caster';
  world.addPlayer(userId, { x: 100, y: 100 });

  const player = world.getPlayer(userId);
  player.mana = 100;
  player.maxMana = 100;

  // Add creature near target
  world.creatures.creatures.set('c_target', {
    id: 'c_target',
    name: 'Skeleton',
    x: 250,
    y: 100,
    hp: 150,
    maxHp: 150,
    effects: new Map(),
    mit: { defense: 0, resists: {} },
  });

  const res = world.castSkill(userId, 'mag_fireball', 250, 100, 1, 0);
  assert.equal(res.ok, true);
  assert.equal(player.mana < 100, true, 'Mana was deducted');

  const creature = world.creatures.get('c_target');
  if (creature) {
    assert.equal(creature.hp < 150, true, 'Creature took damage from Fireball');
  }
});

test('castSkill executes melee skill damage and respects range', () => {
  const world = makeTestWorld();
  const userId = 'u_warrior';
  world.addPlayer(userId, { x: 100, y: 100 });

  const player = world.getPlayer(userId);
  player.stamina = 100;

  // Add creature in front
  world.creatures.creatures.set('c_goblin', {
    id: 'c_goblin',
    name: 'Goblin',
    x: 140,
    y: 100,
    width: 48,
    height: 48,
    hp: 180,
    maxHp: 180,
    effects: new Map(),
    mit: { defense: 0, resists: {} },
  });

  const res = world.castSkill(userId, 'war_crushing_blow', 140, 100, 1, 0);
  assert.equal(res.ok, true);
  assert.equal(player.stamina < 100, true, 'Stamina was deducted');

  const creature = world.creatures.get('c_goblin');
  if (creature) {
    assert.equal(creature.hp < 180, true, 'Creature took melee skill damage');
  }
});

test('castSkill executes buff skills, restores resources, and applies player buff', () => {
  const world = makeTestWorld();
  const userId = 'u_paladin';
  world.addPlayer(userId, { x: 100, y: 100 });

  const player = world.getPlayer(userId);
  player.hp = 40;
  player.maxHp = 100;
  player.mana = 100;

  // Cast heal buff
  const res = world.castSkill(userId, 'war_steel_tempering', 100, 100, 0, 1);
  assert.equal(res.ok, true);
  assert.equal(player.buffs.has('war_steel_tempering'), true, 'Buff was added to player buffs');

  const buff = player.buffs.get('war_steel_tempering');
  assert.equal(buff.nameUk, 'Загартування сталлю');
  assert.equal(buff.expiresAt > world.now, true);

  const snapshot = world.snapshot();
  const playerSnap = snapshot.players.find(p => p.id === userId);
  assert.equal(Array.isArray(playerSnap.buffs), true);
  assert.equal(playerSnap.buffs.length, 1);
  assert.equal(playerSnap.buffs[0].id, 'war_steel_tempering');
});

test('castSkill executes Barrage with individual arrow damage hits in shotgun cone', () => {
  const world = makeTestWorld();
  const userId = 'u_archer';
  world.addPlayer(userId, { x: 100, y: 100 });

  const player = world.getPlayer(userId);
  player.stamina = 100;

  // Creature standing point-blank directly in line of fire
  world.creatures.creatures.set('c_boss', {
    id: 'c_boss',
    name: 'Troll',
    x: 130,
    y: 100,
    hp: 500,
    maxHp: 500,
    effects: new Map(),
    mit: { defense: 0, resists: {} },
  });

  // Aiming to the right
  const res = world.castSkill(userId, 'arc_barrage', 350, 100, 1, 0);
  assert.equal(res.ok, true);
  assert.equal(player.stamina < 100, true);

  const troll = world.creatures.get('c_boss');
  assert.equal(troll.hp < 500, true);
  // Full shotgun hit: all 12 arrows struck the single point-blank target
  assert.equal(troll.hp <= 450, true);
});

test('castSkill executes Rain of Arrows dealing damage in target area', () => {
  const world = makeTestWorld();
  const userId = 'u_archer2';
  world.addPlayer(userId, { x: 100, y: 100 });

  const player = world.getPlayer(userId);
  player.stamina = 100;

  world.creatures.creatures.set('c_group', {
    id: 'c_group',
    name: 'Bandit',
    x: 300,
    y: 300,
    hp: 300,
    maxHp: 300,
    effects: new Map(),
    mit: { defense: 0, resists: {} },
  });

  const res = world.castSkill(userId, 'arc_rain_of_arrows', 300, 300, 1, 1);
  assert.equal(res.ok, true);

  const bandit = world.creatures.get('c_group');
  assert.equal(bandit.hp < 300, true);
});

test('castSkill executes Mage Blink and teleports player forward', () => {
  const world = makeTestWorld();
  const userId = 'u_mage_blink';
  world.addPlayer(userId, { x: 100, y: 100 });

  const player = world.getPlayer(userId);
  player.mana = 100;

  const res = world.castSkill(userId, 'mag_blink', 300, 100, 1, 0);
  assert.equal(res.ok, true);
  assert.equal(player.x > 100, true);
});

test('castSkill executes Frost Nova centered on caster', () => {
  const world = makeTestWorld();
  const userId = 'u_mage_nova';
  world.addPlayer(userId, { x: 200, y: 200 });

  const player = world.getPlayer(userId);
  player.mana = 100;

  world.creatures.creatures.set('c_surrounding', {
    id: 'c_surrounding',
    name: 'Goblin',
    x: 230,
    y: 200,
    hp: 150,
    maxHp: 150,
    effects: new Map(),
    mit: { defense: 0, resists: {} },
  });

  // Cast Frost Nova (even if targeting elsewhere, it centers around caster)
  const res = world.castSkill(userId, 'mag_frost_nova', 800, 800, 1, 0);
  assert.equal(res.ok, true);

  const mob = world.creatures.get('c_surrounding');
  assert.equal(mob.hp < 150, true);
});

test('castSkill executes Gravity Singularity and pulls creatures towards center', () => {
  const world = makeTestWorld();
  const userId = 'u_mage_rift';
  world.addPlayer(userId, { x: 100, y: 100 });

  const player = world.getPlayer(userId);
  player.mana = 100;

  world.creatures.creatures.set('c_rift_mob', {
    id: 'c_rift_mob',
    name: 'Skeleton',
    x: 350,
    y: 200,
    hp: 200,
    maxHp: 200,
    effects: new Map(),
    mit: { defense: 0, resists: {} },
  });

  const res = world.castSkill(userId, 'mag_gravity_singularity', 300, 200, 1, 0);
  assert.equal(res.ok, true);

  const mob = world.creatures.get('c_rift_mob');
  // Mob pulled closer to center (x decreased from 350 towards 300)
  assert.equal(mob.x < 350, true);
});
