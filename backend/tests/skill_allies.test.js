// Summoned allies (skill effect 'summon'): real creatures that fight for the caster,
// not a damage number. Driven through the real CreatureSim / World like the other
// skill suites.
const test = require('node:test');
const assert = require('node:assert/strict');
const { CreatureSim } = require('../src/authority/creatures.js');
const { World } = require('../src/authority/world.js');
const { SUMMON_KINDS } = require('../seeds/data/skillEffects.js');

const openMap = () => ({ isWalkable: () => true, speedAt: () => 1, chunkSize: 8, width: 4000, height: 4000, decorations: [] });
const active = new Set(['0,0', '0,1', '1,0', '1,1', '2,2', '3,3', '2,3', '3,2']);

function row(over = {}) {
  return {
    id: over.id, type: over.type || 'Wolf', name: over.type || 'Wolf', x: over.x ?? 0, y: over.y ?? 0, hp: over.hp ?? 100, facing: 'S',
    home_x: null, home_y: null, level: 1, damage: over.damage ?? 10, blocks_portal_id: null, defense: 0, color: '#fff',
    resistances: {}, faction: over.faction || 'hostile', attack_element: 'physical', behavior_name: 'T',
    aggro_radius: 400, leash_radius: 800, chase_style: over.chase || 'charge', preferred_range: 0, move_speed_mult: 1,
    damage_override: null, aura_names: null, aura_defs: [], behavior_gold_min: 0, behavior_gold_max: 0,
    abilities: [{ slot: 1, name: 'Bite', attack_kind: 'melee', attack_range: 70, attack_cooldown: 1,
      projectile_speed: 0, projectile_radius: 0, element: null, damage_mult: 1, knockback: 0 }],
    skills: [], hitbox_size: 40, ...over.extra,
  };
}
const catalog = () => new Map([['Wolf', row({ type: 'Wolf' })], ['Skeleton', row({ type: 'Skeleton' })], ['Bat', row({ type: 'Bat' })]]);
const player = (over = {}) => ({
  userId: 'u1', characterId: 7, x: 500, y: 500, width: 64, height: 64, hp: 1000, maxHp: 1000, _buff: undefined, ...over,
});
function sim() {
  const s = new CreatureSim(openMap(), () => 0.5);
  const cat = catalog();
  let now = 0;
  const step = (players, ms) => { now += ms; return s.tick(ms / 1000, active, players, now, cat); };
  step([player()], 50); // lets the sim see the catalog, as the first server tick does
  return { s, step, clock: () => now };
}
const SKILL = { reqLvl: 37 };
const allies = (s) => [...s.creatures.values()].filter((c) => c.ephemeral);

test('summonAllies makes n charmed, ephemeral allies sized from the owner and the skill', () => {
  const { s, clock } = sim();
  const owner = player();
  const ids = s.summonAllies(owner, { kind: 'wolf', n: 2, s: 25 }, SKILL, { x: 530, y: 530 }, clock());
  assert.equal(ids.length, 2);
  for (const id of ids) {
    const c = s.get(id);
    assert.equal(c.ephemeral, true);
    assert.equal(c.faction, 'charmed');
    assert.equal(c.charmOwnerUserId, 'u1');
    assert.equal(c.maxHp, Math.round(1000 * SUMMON_KINDS.wolf.hpOwner));
    assert.ok(c.damage > 2);
    assert.equal(c.charmExpiresAt, clock() + 25000);
  }
});

test('an unknown kind, or one whose catalog row is not loaded, makes nothing and does not throw', () => {
  const { s, clock } = sim();
  assert.deepEqual(s.summonAllies(player(), { kind: 'nope', n: 1, s: 5 }, SKILL, { x: 0, y: 0 }, clock()), []);
  s._skillCatalogRows = new Map();
  assert.deepEqual(s.summonAllies(player(), { kind: 'wolf', n: 1, s: 5 }, SKILL, { x: 0, y: 0 }, clock()), []);
});

test('one owner cannot raise an army: a new summon retires the oldest beyond the cap', () => {
  const { s, clock } = sim();
  for (let i = 0; i < 6; i += 1) s.summonAllies(player(), { kind: 'wolf', n: 3, s: 25 }, SKILL, { x: 500, y: 500 }, clock());
  assert.ok(allies(s).length <= 8, `${allies(s).length}`);
});

test('an ally picks its own fight and the kill is credited to its owner', () => {
  const { s, step, clock } = sim();
  const owner = player();
  s.addCreatures([row({ id: 'E1', type: 'Skeleton', x: 600, y: 520, hp: 20 })]);
  s.summonAllies(owner, { kind: 'wolf', n: 1, s: 25 }, SKILL, { x: 560, y: 520 }, clock());
  let credit = null;
  for (let t = 0; t < 4000 && !credit; t += 50) {
    const r = step([owner], 50);
    if (r.killCredits && r.killCredits.get('E1')) credit = r.killCredits.get('E1');
  }
  assert.equal(credit, 'u1', 'the owner gets the kill (XP, loot, quests)');
  assert.equal(s.get('E1'), undefined);
});

test('an ally that runs out of time disappears; it does not turn hostile', () => {
  const { s, step, clock } = sim();
  const owner = player();
  s.summonAllies(owner, { kind: 'wolf', n: 2, s: 1 }, SKILL, { x: 520, y: 520 }, clock());
  assert.equal(allies(s).length, 2);
  for (let t = 0; t < 1500; t += 50) step([owner], 50);
  assert.equal(allies(s).length, 0);
  assert.equal([...s.creatures.values()].filter((c) => c.type === 'Wolf').length, 0, 'gone, not released');
});

test('allies vanish when their owner dies or leaves', () => {
  const { s, step, clock } = sim();
  const owner = player();
  s.summonAllies(owner, { kind: 'wolf', n: 2, s: 60 }, SKILL, { x: 520, y: 520 }, clock());
  step([], 50);
  assert.equal(allies(s).length, 0);
});

test('allies are never saved: no dirty row, so no UPDATE on a non-uuid id', () => {
  const { s, step, clock } = sim();
  const owner = player();
  s.summonAllies(owner, { kind: 'wolf', n: 2, s: 60 }, SKILL, { x: 520, y: 520 }, clock());
  step([owner], 50);
  assert.deepEqual(s.getDirty().filter((d) => String(d.id).startsWith('ally:')), []);
});

test('a hostile\'s melee blow lands on a nearer ally instead of the player', () => {
  const { s, step, clock } = sim();
  const owner = player({ x: 500, y: 500, hp: 1000 });
  s.addCreatures([row({ id: 'H1', type: 'Skeleton', x: 600, y: 500, hp: 50000, damage: 50 })]);
  s.summonAllies(owner, { kind: 'treant', n: 1, s: 60 }, SKILL, { x: 590, y: 500 }, clock());
  const ally = allies(s)[0];
  const hp0 = ally.hp;
  for (let t = 0; t < 3000; t += 50) step([owner], 50);
  assert.ok(ally.hp < hp0 || !s.get(ally.id), 'the ally took the blows');
  assert.equal(owner.hp, 1000, 'the player was shielded');
});

test('a ranged skill cast through the world summons allies for the caster', () => {
  const staff = { id: 'item_staff', name: 'staff', category: 'weapon', kind: 'melee' };
  const w = new World(openMap(), new Map([[staff.id, staff]]), staff.id);
  const stats = {
    meleeMult: 1, spellMult: 1, level: 100, strength: 100, dexterity: 100, constitution: 100, intelligence: 100, wisdom: 100, charisma: 100,
    damageMult: {}, resists: {}, rules: {}, sources: {},
  };
  w.addPlayer('u1', { x: 500, y: 500 }, { items: [], equipment: {} }, { x: 500, y: 500 }, 0, stats, 7);
  const p = w.getPlayer('u1');
  p.mana = 500; p.maxMana = 500; p.hp = 2000; p.maxHp = 2000;
  w.creatures._skillCatalogRows = catalog();
  const res = w.castSkill('u1', 'dru_summon_wolfpack', 540, 500, 1, 0);
  assert.equal(res.ok, true, JSON.stringify(res));
  const mine = [...w.creatures.creatures.values()].filter((c) => c.ephemeral && c.charmOwnerUserId === 'u1');
  assert.equal(mine.length, 2);
  assert.equal(mine[0].summonKind, 'wolf');
});
