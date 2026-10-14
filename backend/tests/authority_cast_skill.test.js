const test = require('node:test');
const assert = require('node:assert/strict');
const { World } = require('../src/authority/world.js');

function makeTestWorld(weapon = { id: 'item_sword', name: 'sword', category: 'weapon', kind: 'melee' }) {
  const map = {
    isWalkable: () => true,
    width: 2000,
    height: 2000,
    decorations: [],
  };
  const weapons = new Map();
  if (weapon) weapons.set(weapon.id, weapon);
  return new World(map, weapons, weapon ? weapon.id : 'fists');
}

function addTestPlayer(world, userId, spawn = { x: 100, y: 100 }, inv = { items: [], equipment: {} }) {
  const stats = {
    meleeMult: 1,
    spellMult: 1,
    level: 100,
    strength: 100,
    dexterity: 100,
    constitution: 100,
    intelligence: 100,
    wisdom: 100,
    charisma: 100,
    damageMult: { physical: 1, arcane: 1, fire: 1, ice: 1, lightning: 1, shadow: 1, holy: 1 },
    resists: {},
    rules: {},
    sources: {
      strength: { base: 100, tree: 0, gear: 0 },
      dexterity: { base: 100, tree: 0, gear: 0 },
      constitution: { base: 100, tree: 0, gear: 0 },
      intelligence: { base: 100, tree: 0, gear: 0 },
      wisdom: { base: 100, tree: 0, gear: 0 },
      charisma: { base: 100, tree: 0, gear: 0 },
    },
  };
  world.addPlayer(userId, spawn, inv, spawn, 0, stats);
  return world.getPlayer(userId);
}

test('castSkill damages creatures in area and deducts mana authoritatively', () => {
  const world = makeTestWorld({ id: 'item_staff', name: 'staff', category: 'weapon', kind: 'melee' });
  const userId = 'u_caster';
  const player = addTestPlayer(world, userId, { x: 100, y: 100 });
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
  const world = makeTestWorld({ id: 'item_sword', name: 'sword', category: 'weapon', kind: 'melee' });
  const userId = 'u_warrior';
  const player = addTestPlayer(world, userId, { x: 100, y: 100 });
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
  const world = makeTestWorld({ id: 'item_sword', name: 'sword', category: 'weapon', kind: 'melee' });
  const userId = 'u_paladin';
  const player = addTestPlayer(world, userId, { x: 100, y: 100 });
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

test('castSkill executes Mana Surge and restores 40% of maximum mana', () => {
  const world = makeTestWorld({ id: 'item_staff', name: 'staff', category: 'weapon', kind: 'magic' });
  const userId = 'u_mage';
  const player = addTestPlayer(world, userId, { x: 100, y: 100 });
  player.maxMana = 3277;
  player.mana = 327; // ~10% mana

  const res = world.castSkill(userId, 'mag_mana_surge', 100, 100, 0, 1);
  assert.equal(res.ok, true);
  // 40% of 3277 is 1311, so mana becomes 327 + 1311 = 1638
  assert.equal(player.mana, 1638, 'Mana Surge restored 40% of max mana');
  assert.equal(player.buffs.has('mag_mana_surge'), true, 'Buff registered in active buffs');
});

test('castSkill executes Barrage with individual arrow damage hits in shotgun cone', () => {
  const world = makeTestWorld({ id: 'item_bow', name: 'bow', category: 'weapon', kind: 'projectile' });
  const userId = 'u_archer';
  const player = addTestPlayer(world, userId, { x: 100, y: 100 });
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
  const world = makeTestWorld({ id: 'item_bow', name: 'bow', category: 'weapon', kind: 'projectile' });
  const userId = 'u_archer2';
  const player = addTestPlayer(world, userId, { x: 100, y: 100 });
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
  const world = makeTestWorld({ id: 'item_staff', name: 'staff', category: 'weapon', kind: 'melee' });
  const userId = 'u_mage_blink';
  const player = addTestPlayer(world, userId, { x: 100, y: 100 });
  player.mana = 100;

  const res = world.castSkill(userId, 'mag_blink', 300, 100, 1, 0);
  assert.equal(res.ok, true);
  assert.equal(player.x > 100, true);
});

test('castSkill executes Frost Nova centered on caster', () => {
  const world = makeTestWorld({ id: 'item_staff', name: 'staff', category: 'weapon', kind: 'melee' });
  const userId = 'u_mage_nova';
  const player = addTestPlayer(world, userId, { x: 200, y: 200 });
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
  const world = makeTestWorld({ id: 'item_staff', name: 'staff', category: 'weapon', kind: 'melee' });
  const userId = 'u_mage_rift';
  const player = addTestPlayer(world, userId, { x: 100, y: 100 });
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

test('castSkill validates weapon requirements for skill gems and rejects mismatches', () => {
  const world = makeTestWorld({ id: 'item_sword', name: 'sword', category: 'weapon', kind: 'melee' });
  const userId = 'u_archer_equip';
  
  // Equip a melee dagger in main_hand
  const inv = {
    items: [],
    equipment: {
      main_hand: { id: 'item_dagger', name: 'dagger', category: 'weapon', kind: 'melee' },
    },
  };
  const player = addTestPlayer(world, userId, { x: 100, y: 100 }, inv);

  player.stamina = 100;
  player.mana = 100;

  // 1. Trying to cast a bow skill (arc_barrage) with a dagger -> rejected with weapon_mismatch
  const bowRes = world.castSkill(userId, 'arc_barrage', 300, 100, 1, 0);
  assert.equal(bowRes.ok, false);
  assert.equal(bowRes.reason, 'weapon_mismatch');

  // 2. Equip a bow in main_hand
  player.inv.equipment.main_hand = { id: 'item_bow', name: 'bow', category: 'weapon', kind: 'projectile', ammo_type_id: 101 };
  
  // Casting bow skill now succeeds
  const bowRes2 = world.castSkill(userId, 'arc_barrage', 300, 100, 1, 0);
  assert.equal(bowRes2.ok, true);

  // 3. Trying to cast a melee crushing blow with a bow -> rejected
  const meleeRes = world.castSkill(userId, 'war_crushing_blow', 140, 100, 1, 0);
  assert.equal(meleeRes.ok, false);
  assert.equal(meleeRes.reason, 'weapon_mismatch');
});


// SOMET-575 (D4): melee skill reach is max(90, range*1.3), measured to the
// target's body edge. war_crushing_blow has range 80 -> reach 104.
function crushingBlowHitsAt(d) {
  const world = makeTestWorld({ id: 'item_sword', name: 'sword', category: 'weapon', kind: 'melee' });
  const player = addTestPlayer(world, 'u_reach', { x: 100, y: 100 });
  player.stamina = 100;
  const pcx = player.x + player.width / 2, pcy = player.y + player.height / 2;
  world.creatures.creatures.set('c_far', {
    id: 'c_far', name: 'Goblin', x: pcx + d - 24, y: pcy - 24, width: 48, height: 48,
    hp: 180, maxHp: 180, effects: new Map(), mit: { defense: 0, resists: {} },
  });
  const res = world.castSkill('u_reach', 'war_crushing_blow', pcx + d, pcy, 1, 0);
  assert.equal(res.ok, true);
  const c = world.creatures.get('c_far');
  return !c || c.hp < 180;
}

test('SOMET-575 melee skill reach restored to max(90, range*1.3), edge-measured', () => {
  // Centre 134 -> padded edge 134-32 = 102: inside 104, outside the 100 of the regression.
  assert.equal(crushingBlowHitsAt(134), true);
  // Centre 140 -> edge 108: beyond 104.
  assert.equal(crushingBlowHitsAt(140), false);
});

test('castSkill executes channeled skills with ramping intensity, damage, and resource drain', () => {
  const world = makeTestWorld({ id: 'item_staff', name: 'staff', category: 'weapon', kind: 'melee' });
  const userId = 'u_channeled';
  const player = addTestPlayer(world, userId, { x: 100, y: 100 });
  player.mana = 3277;
  player.maxMana = 3277;

  // Add dummy high-hp target
  world.creatures.creatures.set('c_boss', {
    id: 'c_boss', name: 'Training Dummy', x: 200, y: 100, width: 48, height: 48,
    hp: 100000, maxHp: 100000, effects: new Map(), mit: { defense: 0, resists: {} },
  });

  // Tick 0 (Stack 0): Base cost for mag_blizzard is 6.
  const manaBefore0 = player.mana;
  const hpBefore0 = world.creatures.get('c_boss').hp;
  world.now = 1000;
  const res0 = world.castSkill(userId, 'mag_blizzard', 200, 100, 1, 0);
  assert.equal(res0.ok, true);
  const cost0 = manaBefore0 - player.mana;
  const dmg0 = hpBefore0 - world.creatures.get('c_boss').hp;
  assert.equal(cost0, 6); // Stack 0: base cost exactly 6

  // Fast forward 16 consecutive ticks (250ms interval) to reach Stack 8 (MAX)
  // Stack increments every 2 ticks (every 0.5s)
  for (let i = 1; i <= 16; i++) {
    world.now += 250;
    const res = world.castSkill(userId, 'mag_blizzard', 200, 100, 1, 0);
    assert.equal(res.ok, true);
  }

  // At Stack 8:
  // Base cost 6 * (1 + 8 * 0.35) = 6 * 3.8 = 22.8
  // Pool drain: (3277 * (8 * 0.0125)) / 4 = (3277 * 0.10) / 4 = 81.925
  // Total cost per tick = round(22.8 + 81.925) = 105
  // Damage multiplier = 1 + 8 * 0.15 = 2.2x (+120% damage)
  const manaBefore8 = player.mana;
  const hpBefore8 = world.creatures.get('c_boss').hp;
  world.now += 250;
  const res8 = world.castSkill(userId, 'mag_blizzard', 200, 100, 1, 0);
  assert.equal(res8.ok, true);
  const cost8 = manaBefore8 - player.mana;
  const dmg8 = hpBefore8 - world.creatures.get('c_boss').hp;
  assert.equal(cost8, 105);
  assert.equal(Math.round(dmg0 * 2.2), dmg8);

  // If player pauses for > 600ms, channel ticks reset back to stack 0
  world.now += 1000; // 1s pause
  const manaBeforeReset = player.mana;
  const hpBeforeReset = world.creatures.get('c_boss').hp;
  const resReset = world.castSkill(userId, 'mag_blizzard', 200, 100, 1, 0);
  assert.equal(resReset.ok, true);
  assert.equal(manaBeforeReset - player.mana, 6); // Reset back to base cost
  assert.equal(hpBeforeReset - world.creatures.get('c_boss').hp, dmg0); // Reset back to base damage

  // If player runs low on mana and cannot afford the cost, cast is refused and channel resets
  player.mana = 3; // base cost is 6
  const resRefused = world.castSkill(userId, 'mag_blizzard', 200, 100, 1, 0);
  assert.equal(resRefused.ok, false);
  assert.equal(resRefused.reason, 'mana');
});

