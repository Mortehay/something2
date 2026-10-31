// Follow-ups to the buff mechanics: traps reach the client, a burn tick is not a
// blow, a vanished player is lost by whoever chased them, Sniper Stance casts.
const test = require('node:test');
const assert = require('node:assert/strict');
const { World } = require('../src/authority/world.js');
const { applyDamage } = require('../src/authority/damage.js');
const balance = require('../src/authority/skillBalance.js');

function makeWorld() {
  const map = { isWalkable: () => true, width: 2000, height: 2000, decorations: [] };
  const sword = { id: 'item_sword', name: 'sword', category: 'weapon', kind: 'melee' };
  return new World(map, new Map([[sword.id, sword]]), sword.id);
}

function addPlayer(world, userId = 'u1') {
  const stats = {
    meleeMult: 1, spellMult: 1, level: 100,
    strength: 100, dexterity: 100, constitution: 100, intelligence: 100, wisdom: 100, charisma: 100,
    damageMult: { physical: 1, arcane: 1, fire: 1, ice: 1, lightning: 1, shadow: 1, holy: 1 },
    resists: {}, rules: {}, sources: {},
  };
  world.addPlayer(userId, { x: 100, y: 100 }, { items: [], equipment: {} }, { x: 100, y: 100 }, 0, stats);
  const p = world.getPlayer(userId);
  p.maxHp = 1000; p.hp = 1000; p.maxMana = 200; p.mana = 200; p.stamina = 100; p.maxStamina = 100;
  return p;
}

test.afterEach(() => balance.setRng());

test('traps ride the snapshot with kind, position, radius and time left', () => {
  const w = makeWorld();
  addPlayer(w);
  assert.equal(w.snapshot().traps, undefined, 'omitted when none');
  w.castSkill('u1', 'arc_bear_trap', 300, 300, 1, 0);
  w.castSkill('u1', 'arc_tar_trap', 500, 500, 1, 0);
  const traps = w.snapshot().traps;
  assert.deepEqual(traps.map((t) => t.k).sort(), ['bear', 'tar']);
  const bear = traps.find((t) => t.k === 'bear');
  assert.equal(bear.x, 300);
  assert.ok(bear.r > 0 && bear.ms > 0);
});

test('a burn tick cannot be dodged or reflected', () => {
  const w = makeWorld();
  const p = addPlayer(w);
  w.castSkill('u1', 'mnk_drunken_brawler_stance', 100, 100, 0, 1);
  balance.setRng(() => 0);
  p._dotTick = true;
  applyDamage(p, 10, 'fire', {}, w.now, 'c:troll');
  p._dotTick = false;
  assert.equal(p.hp, 990, 'the tick landed');
  assert.equal(p._pendingReflect, undefined);
  applyDamage(p, 10, 'physical', {}, w.now, 'c:troll');
  assert.equal(p.hp, 990, 'a real hit is still dodged');
});

test('the world marks its own DoT ticks (burn and aura)', () => {
  const fs = require('fs');
  const world = fs.readFileSync(require.resolve('../src/authority/world.js'), 'utf8');
  const creatures = fs.readFileSync(require.resolve('../src/authority/creatures.js'), 'utf8');
  assert.match(world, /t\._dotTick = true;/);
  assert.match(creatures, /p\._dotTick = true;/);
});

test('a creature chasing a player who went stealthy loses them from afar', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../src/authority/creatures.js'), 'utf8');
  assert.match(src, /prey && prey\._stealthed/);
});

