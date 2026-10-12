// SOMET-606. A defense debuff must reach EVERY way a player takes damage --
// a creature bite AND a creature projectile (projectiles.js read pl.mit
// directly at three sites). The source guard stops a new site reading p.mit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CreatureSim } = require('../src/authority/creatures.js');
const { ProjectileSim } = require('../src/authority/projectiles.js');

const stubMap = () => ({ isWalkable: () => true, speedAt: () => 1, chunkSize: 8 });
const ACTIVE = new Set(['0,0', '0,1', '1,0', '1,1']);
function hold() {
  return { name: 'T', aggroRadius: 0, leashRadius: 800, chaseStyle: 'hold', preferredRange: 0,
    moveSpeedMult: 1, damageOverride: null, goldMin: 0, goldMax: 0,
    abilities: [{ slot: 1, name: 'Attack', attackKind: 'melee', attackRange: 60, attackCooldown: 1,
      projectileSpeed: 0, projectileRadius: 0, element: null, damageMult: 1, knockback: 0 }] };
}
const dread = { name: 'dread', targetSide: 'enemies', radius: 400, damageMult: 1, defenseMult: 0.5,
  speedMult: 1, dotDps: 0, dotElement: 'physical', tickMs: 1000 };

test('a bite on a defense-debuffed player uses the debuffed defense (5 - 4*0.5 = 3)', () => {
  for (const [auras, expected] of [[[dread], 97], [[], 99]]) {
    const s = new CreatureSim(stubMap(), () => 0.5);
    s.addCreatures([
      { id: 'L', type: 'T', x: 100, y: 100, hp: 100, faction: 'hostile', behavior: hold(), auras },
      { id: 'F', type: 'T', x: 100, y: 100, hp: 100, faction: 'hostile', damage: 5 },
    ]);
    const p = { userId: 'u1', x: 120, y: 100, width: 64, height: 64, hp: 100, maxHp: 100,
      mit: { defense: 4, resistances: {} } };
    s.tick(0.05, ACTIVE, [p], 0);
    assert.equal(p.hp, expected, `auras=${auras.length}`);
  }
});

test('a creature projectile on a defense-debuffed player uses the debuffed defense', () => {
  const ps = new ProjectileSim();
  ps.spawn({ ownerId: 'c1', ownerKind: 'creature', ownerFaction: 'hostile', ownerType: 'T',
    x: 0, y: 32, nx: 1, ny: 0, damage: 10,
    weapon: { projectile_speed: 1000, projectile_radius: 8, range: 500, pierce: 1, aoe_radius: 0, element: null, damage: 10 } });
  const p = { userId: 'u1', x: 40, y: 0, width: 64, height: 64, hp: 100, maxHp: 100,
    mit: { defense: 4, resistances: {} }, _buff: { damageMult: 1, defenseMult: 0.5, speedMult: 1, auras: [] } };
  for (let i = 0; i < 10 && p.hp === 100; i++) {
    ps.step(0.05, { map: stubMap(), creatures: new CreatureSim(stubMap(), () => 0.5), players: [p], now: 0 });
  }
  assert.equal(p.hp, 100 - (10 - 4 * 0.5));
});

test('source guard: no damage site reads `<any>.mit || ...` directly', () => {
  const dir = path.join(__dirname, '..', 'src', 'authority');
  const offenders = [];
  for (const f of ['creatures.js', 'projectiles.js', 'world.js']) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      if (/^\s*\/\//.test(line)) return; // prose may name the pattern
      // effectiveMit's own body is the one place allowed to read it.
      if (/^\s*const mit = target\.mit \|\| NO_MITIGATION;/.test(line)) return;
      if (/\b\w+\.mit\s*\|\|/.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], 'route through effectiveMit()');
});
