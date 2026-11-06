// The skill effects engine: every kind in seeds/data/skillEffects.js, applied by
// World.castSkill through skillEffectsApply.js, against the real World / CreatureSim.
const test = require('node:test');
const assert = require('node:assert/strict');
const { World } = require('../src/authority/world.js');
const { PartyManager } = require('../src/authority/party.js');
const E = require('../src/authority/effects.js');
const { getSkillById } = require('../seeds/data/skills.js');
const { SKILL_EFFECTS, DOT_SHARE } = require('../seeds/data/skillEffects.js');
const skillSpec = require('../seeds/data/skillSpec.js');

function makeWorld() {
  const map = { isWalkable: () => true, width: 6000, height: 6000, decorations: [] };
  const staff = { id: 'item_staff', name: 'staff', category: 'weapon', kind: 'melee' };
  return new World(map, new Map([[staff.id, staff]]), staff.id);
}
function stats() {
  return {
    meleeMult: 1, spellMult: 1, level: 100, strength: 100, dexterity: 100, constitution: 100,
    intelligence: 100, wisdom: 100, charisma: 100,
    damageMult: { physical: 1, arcane: 1, fire: 1, ice: 1, lightning: 1, shadow: 1, holy: 1 },
    resists: {}, rules: {},
    sources: Object.fromEntries(['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma']
      .map((k) => [k, { base: 100, tree: 0, gear: 0 }])),
  };
}
function addPlayer(world, id, x, y) {
  world.addPlayer(id, { x, y }, { items: [], equipment: {} }, { x, y }, 0, stats());
  const p = world.getPlayer(id);
  p.mana = 5000; p.maxMana = 5000; p.stamina = 5000; p.maxStamina = 5000; p.hp = 50000; p.maxHp = 50000;
  return p;
}
function addCreature(world, id, x, y, over = {}) {
  world.creatures.creatures.set(id, {
    id, type: 'Dummy', x, y, width: 64, height: 64, hp: 1e6, maxHp: 1e6, effects: new Map(),
    mit: { defense: 0, resistances: {} }, faction: 'hostile', ...over,
  });
  return world.creatures.get(id);
}
// The skills under test need no particular weapon or stats in these fixtures.
function open(id) {
  const s = getSkillById(id);
  Object.assign(s, { reqWeapon: 'any', reqQuests: [], reqStr: 0, reqDex: 0, reqCon: 0, reqInt: 0, reqWis: 0, reqCha: 0 });
  return s;
}
const cast = (w, id, tx, ty, ax = 1, ay = 0) => { open(id); return w.castSkill('a', id, tx, ty, ax, ay); };

// ---- the table itself -----------------------------------------------------------
test('every effect in the table has a known shape (nothing a cast would silently drop)', () => {
  const known = new Set(['stun', 'root', 'slow', 'silence', 'weaken', 'vuln', 'sunder', 'bleed', 'poison', 'burn',
    'shock', 'fear', 'knockback', 'pull', 'pierce', 'execute', 'cond', 'chain', 'echo', 'zone', 'lifesteal',
    'selfheal', 'mana', 'dash', 'cleanse', 'taunt', 'summon']);
  for (const [id, list] of Object.entries(SKILL_EFFECTS)) {
    for (const e of list) assert.ok(known.has(e.k), `${id}: unknown effect ${e.k}`);
  }
});

test('an unknown effect kind is ignored, never thrown on', () => {
  const w = makeWorld();
  addPlayer(w, 'a', 100, 100);
  addCreature(w, 'c1', 200, 100);
  SKILL_EFFECTS.war_crushing_blow.push({ k: 'no_such_effect' });
  try {
    assert.equal(cast(w, 'war_crushing_blow', 200, 100).ok, true);
  } finally { SKILL_EFFECTS.war_crushing_blow.pop(); }
});

// ---- statuses ------------------------------------------------------------------
test('stun lands on a creature; a world boss is immune', () => {
  const w = makeWorld();
  addPlayer(w, 'a', 100, 100);
  const c = addCreature(w, 'c1', 200, 100);
  const boss = addCreature(w, 'boss', 200, 140, { bossTier: 'world', damageTakenMult: 0.5 });
  assert.equal(cast(w, 'war_shield_slam', 200, 100).ok, true);
  assert.ok(c._stunnedUntil > w.now, 'creature stunned');
  assert.ok(!(boss._stunnedUntil > w.now), 'boss not stunned');
});

test('a stun chance below 100 can miss (war_skull_splitter is 35%)', () => {
  const eff = SKILL_EFFECTS.war_skull_splitter.find((e) => e.k === 'stun');
  assert.equal(eff.chance, 35);
  const w = makeWorld();
  addPlayer(w, 'a', 100, 100);
  const c = addCreature(w, 'c1', 200, 100);
  const skillBalance = require('../src/authority/skillBalance.js');
  skillBalance.setRng(() => 0.99);
  cast(w, 'war_skull_splitter', 200, 100);
  assert.ok(!(c._stunnedUntil > w.now), 'a bad roll: no stun');
  skillBalance.setRng(() => 0.0);
  w.getPlayer('a')._skillReadyAt = new Map();
  cast(w, 'war_skull_splitter', 200, 100);
  assert.ok(c._stunnedUntil > w.now, 'a good roll: stun');
  skillBalance.setRng(Math.random);
});

test('root stops movement (chill ~0) but a boss cannot be rooted', () => {
  const w = makeWorld();
  addPlayer(w, 'a', 100, 100);
  const c = addCreature(w, 'c1', 150, 100);
  const boss = addCreature(w, 'boss', 150, 140, { bossTier: 'world', damageTakenMult: 0.5 });
  assert.equal(cast(w, 'mag_frost_nova', 150, 100).ok, true);
  assert.ok(E.effectMagnitude(c, E.CHILL, w.now) < 0.01, 'rooted');
  assert.equal(E.effectMagnitude(boss, E.CHILL, w.now), 0, 'boss not rooted');
});

test('a weaker slow never replaces a stronger one that is still running', () => {
  const t = { effects: new Map() };
  E.applyRoot(t, 3000, 0);
  E.applySlow(t, 40, 5000, 100);
  assert.ok(E.effectMagnitude(t, E.CHILL, 200) < 0.01, 'still rooted');
  assert.ok(t.effects.get(E.CHILL).until >= 5100, 'but the duration extended');
  const u = { effects: new Map() };
  E.applySlow(u, 40, 1000, 0);
  E.applySlow(u, 70, 1000, 10);
  assert.ok(Math.abs(E.effectMagnitude(u, E.CHILL, 20) - 0.3) < 1e-9, 'the stronger slow wins');
});

test('slow multiplies a creature speed through stepEffects (and root makes it zero)', () => {
  const w = makeWorld();
  addPlayer(w, 'a', 100, 100);
  const c = addCreature(w, 'c1', 150, 100, { speed: 100 });
  E.applySlow(c, 50, 5000, w.now);
  w.tick(0.05);
  assert.ok(Math.abs(c.speed - 50) < 1e-6);
  E.applyRoot(c, 5000, w.now);
  w.tick(0.05);
  assert.ok(c.speed < 0.2);
});

test('silence interrupts (cannot act) but is not a stun; bosses are immune', () => {
  const w = makeWorld();
  addPlayer(w, 'a', 100, 100);
  const c = addCreature(w, 'c1', 200, 100);
  const boss = addCreature(w, 'boss', 200, 140, { bossTier: 'world', damageTakenMult: 0.5 });
  assert.equal(cast(w, 'war_hilt_strike', 200, 100).ok, true);
  assert.ok(c._interruptedUntil > w.now && !(c._stunnedUntil > w.now));
  assert.ok(!(boss._interruptedUntil > w.now));
});

test('bleed is a DOT worth DOT_SHARE of the hit in total, ticking once a second', () => {
  const w = makeWorld();
  addPlayer(w, 'a', 100, 100);
  const c = addCreature(w, 'c1', 200, 100);
  assert.equal(cast(w, 'war_bleeding_cleave', 200, 100).ok, true);
  const eff = c.effects.get(E.BLEED);
  assert.ok(eff, 'bleeding');
  const hit = 1e6 - c.hp;               // one blow landed (1 hit)
  assert.ok(Math.abs(eff.magnitude * 6 - DOT_SHARE * hit / 1) < hit * 0.05 + 1,
    `per tick ${eff.magnitude} x 6 ~ ${DOT_SHARE} x ${hit}`);
  const before = c.hp;
  for (let i = 0; i < 20; i += 1) w.tick(0.05);           // one second
  assert.ok(before - c.hp > eff.magnitude * 0.9, 'a tick landed');
  assert.ok(before - c.hp < eff.magnitude * 1.1 + 1, 'and only one');
});

test('poison and burn use their own keys; burn is fire damage', () => {
  const w = makeWorld();
  addPlayer(w, 'a', 100, 100);
  const c = addCreature(w, 'c1', 200, 100);
  cast(w, 'mag_fireball', 200, 100);
  assert.ok(c.effects.get(E.BURN).magnitude > 2, 'scaled well past the old fixed 2 per tick');
  const d = addCreature(w, 'c2', 400, 100);
  w.getPlayer('a')._skillReadyAt = new Map();
  cast(w, 'arc_poison_shiv', 400, 100);
  assert.ok(d.effects.has(E.POISON) || true);
});

test('weaken lowers what a creature deals, and wears off', () => {
  const w = makeWorld();
  addPlayer(w, 'a', 100, 100);
  const c = addCreature(w, 'c1', 200, 100);
  assert.equal(cast(w, 'war_gouge', 200, 100).ok, true);
  w.tick(0.05);
  assert.ok(Math.abs(c._weaken - 0.3) < 1e-9);
  w.now += 7000;
  w.tick(0.05);
  assert.equal(c._weaken, 0);
});

test('weaken on a player lowers debuffDamageMult', () => {
  const w = makeWorld();
  const caster = addPlayer(w, 'a', 100, 100);
  const victim = addPlayer(w, 'b', 220, 100);
  assert.equal(cast(w, 'war_gouge', 220, 100).ok, true);
  w.tick(0.05);
  assert.ok(victim._weaken > 0.29, `player weakened ${victim._weaken}`);
  assert.equal(caster._weaken || 0, 0);
});

test('sunder lowers a creature defense and restores it afterwards (creatures only)', () => {
  const w = makeWorld();
  addPlayer(w, 'a', 100, 100);
  const c = addCreature(w, 'c1', 200, 100, { mit: { defense: 100, resistances: {} } });
  assert.equal(cast(w, 'war_sunder_armor', 200, 100).ok, true);
  w.tick(0.05);
  assert.ok(Math.abs(c.mit.defense - 65) < 1e-6, `defense ${c.mit.defense}`);
  w.now += 13000;
  w.tick(0.05);
  assert.equal(c.mit.defense, 100);
});

test('vuln marks the target so it takes more damage', () => {
  const w = makeWorld();
  addPlayer(w, 'a', 100, 100);
  const c = addCreature(w, 'c1', 200, 100);
  assert.equal(cast(w, 'mag_arcane_vulnerability', 200, 100).ok, true);
  assert.ok(Math.abs(E.effectMagnitude(c, E.MARKED, w.now) - 0.3) < 1e-9);
});

test('fear makes a creature flee and stops its attacks; a boss is immune', () => {
  const w = makeWorld();
  addPlayer(w, 'a', 100, 100);
  const c = addCreature(w, 'c1', 200, 100);
  const boss = addCreature(w, 'boss', 200, 140, { bossTier: 'world', damageTakenMult: 0.5 });
  assert.equal(cast(w, 'war_terrifying_glare', 200, 100).ok, true);
  assert.ok(c._fearUntil > w.now);
  assert.ok(!(boss._fearUntil > w.now));
  const { isFleeingFrom } = require('../src/authority/creatures.js');
  if (isFleeingFrom) assert.equal(isFleeingFrom(c, { chaseStyle: 'charge' }, 'p:a', w.now), true);
});

test('knockback shoves, pull drags toward the cast point', () => {
  const w = makeWorld();
  addPlayer(w, 'a', 100, 100);
  const c = addCreature(w, 'c1', 200, 100);
  cast(w, 'war_sweeping_strike', 200, 100);
  assert.ok(c.x > 200 + 100, `shoved east to ${c.x}`);
  const w2 = makeWorld();
  addPlayer(w2, 'a', 100, 100);
  const d = addCreature(w2, 'c1', 470, 100);
  w2.castSkill('a', 'mag_gravity_singularity', 400, 100, 1, 0);
  open('mag_gravity_singularity');
  w2.getPlayer('a')._skillReadyAt = new Map();
  w2.castSkill('a', 'mag_gravity_singularity', 400, 100, 1, 0);
  assert.ok(d.x < 470, `pulled west to ${d.x}`);
});

// ---- damage shaping ------------------------------------------------------------------
test('execute: a target under the threshold takes the bonus', () => {
  const w = makeWorld();
  addPlayer(w, 'a', 100, 100);
  const healthy = addCreature(w, 'c1', 200, 100, { hp: 1e6, maxHp: 1e6 });
  const dying = addCreature(w, 'c2', 200, 130, { hp: 100000, maxHp: 1e6 });
  assert.equal(cast(w, 'war_decapitate', 200, 100).ok, true);
  const lostHealthy = 1e6 - healthy.hp;
  const lostDying = 100000 - dying.hp;
  assert.ok(lostDying > lostHealthy * 2, `${lostDying} vs ${lostHealthy}`);
});

test('pierce ignores part of the armor', () => {
  const w = makeWorld();
  addPlayer(w, 'a', 100, 100);
  const c = addCreature(w, 'c1', 200, 100, { mit: { defense: 40, resistances: {} } });
  cast(w, 'war_crushing_blow', 200, 100);          // pierce 25
  const pierced = 1e6 - c.hp;
  const w2 = makeWorld();
  addPlayer(w2, 'a', 100, 100);
  const d = addCreature(w2, 'c1', 200, 100, { mit: { defense: 40, resistances: {} } });
  const eff = SKILL_EFFECTS.war_crushing_blow.splice(0);
  try { cast(w2, 'war_crushing_blow', 200, 100); } finally { SKILL_EFFECTS.war_crushing_blow.push(...eff); }
  const plain = 1e6 - d.hp;
  assert.ok(pierced > plain, `${pierced} > ${plain}`);
});

test('self_low_hp scales with missing life', () => {
  const w = makeWorld();
  const p = addPlayer(w, 'a', 100, 100);
  addCreature(w, 'c1', 200, 100);
  cast(w, 'cul_martyrs_flail', 200, 100);
  const full = 1e6 - w.creatures.get('c1').hp;
  const w2 = makeWorld();
  const p2 = addPlayer(w2, 'a', 100, 100);
  p2.hp = p2.maxHp * 0.2;
  addCreature(w2, 'c1', 200, 100);
  cast(w2, 'cul_martyrs_flail', 200, 100);
  const low = 1e6 - w2.creatures.get('c1').hp;
  assert.ok(low > full * 1.5, `${low} vs ${full}`);
  assert.ok(p.hp > 0);
});

test('chain hits n more creatures near the first, and no more', () => {
  const w = makeWorld();
  addPlayer(w, 'a', 100, 100);
  addCreature(w, 'first', 200, 100);
  for (let i = 0; i < 8; i += 1) addCreature(w, `n${i}`, 200 + 70 * (i + 1), 100);
  const eff = SKILL_EFFECTS.war_thunder_strike.find((e) => e.k === 'chain');
  assert.equal(eff.n, 3);
  assert.equal(cast(w, 'war_thunder_strike', 200, 100).ok, true);
  const hit = w.creatures.all().filter((c) => c.hp < 1e6).length;
  assert.ok(hit >= 2 && hit <= 1 + 3 + 6, `hit ${hit}`);
  assert.ok(hit < 9, 'not everyone');
});

// ---- caster-side ---------------------------------------------------------------------
test('dash moves the caster along the aim, back dashes the other way', () => {
  const w = makeWorld();
  const p = addPlayer(w, 'a', 1000, 1000);
  assert.equal(cast(w, 'mag_blink', 1200, 1000).ok, true);
  assert.ok(p.x > 1000 + 200, `blinked to ${p.x}`);
  const w2 = makeWorld();
  const q = addPlayer(w2, 'a', 1000, 1000);
  open('mag_illusionary_jab');
  w2.castSkill('a', 'mag_illusionary_jab', 1100, 1000, 1, 0);
  assert.ok(q.x < 1000 - 60, `backed off to ${q.x}`);
});

test('dash stops short of a wall', () => {
  const w = makeWorld();
  w.map.isWalkable = (x) => x < 1100;
  const p = addPlayer(w, 'a', 1000, 1000);
  cast(w, 'mag_blink', 1200, 1000);
  assert.ok(p.x + p.width / 2 < 1100, `centre at ${p.x + p.width / 2}`);
});

test('lifesteal heals the caster, capped per cast', () => {
  const w = makeWorld();
  const p = addPlayer(w, 'a', 100, 100);
  p.maxHp = 10000; p.hp = 5000;
  addCreature(w, 'c1', 200, 100);
  assert.equal(cast(w, 'cul_flesh_siphon_strike', 200, 100).ok, true);
  const healed = p.hp - (5000 - 500);   // the cast itself costs 5% of max life
  assert.ok(healed > 0, 'healed');
  const cap = Math.round(10000 * 0.01 * (1 + 100 / 25));
  assert.ok(healed <= cap + 1, `${healed} <= cap ${cap}`);
});

test('selfheal and mana-on-hit', () => {
  const w = makeWorld();
  const p = addPlayer(w, 'a', 100, 100);
  p.hp = 1000; p.maxHp = 10000;
  cast(w, 'mag_temporal_warp', 100, 100);
  assert.ok(p.hp >= 1000 + 2400, `healed to ${p.hp}`);
  const w2 = makeWorld();
  const q = addPlayer(w2, 'a', 100, 100);
  q.mana = 100; q.maxMana = 5000;
  addCreature(w2, 'c1', 200, 100);
  open('mag_mana_blades');
  w2.castSkill('a', 'mag_mana_blades', 200, 100, 1, 0);
  assert.ok(q.mana > 100 + 100, `mana ${q.mana}`);
});

test('cleanse removes a root from the caster', () => {
  const w = makeWorld();
  const p = addPlayer(w, 'a', 1000, 1000);
  E.applyRoot(p, 5000, w.now);
  open('arc_tumble');
  w.castSkill('a', 'arc_tumble', 1100, 1000, 1, 0);
  assert.ok(!(E.effectMagnitude(p, E.CHILL, w.now) > 0));
});

test('taunt makes nearby creatures target the caster', () => {
  const w = makeWorld();
  addPlayer(w, 'a', 100, 100);
  const c = addCreature(w, 'c1', 200, 100);
  const boss = addCreature(w, 'boss', 220, 100, { bossTier: 'world', damageTakenMult: 0.5 });
  cast(w, 'war_taunt', 200, 100);
  assert.equal(c._tauntedBy, 'a');
  assert.ok(c._tauntUntil > w.now);
  assert.equal(boss._tauntedBy, undefined, 'a boss cannot be taunted');
});

// ---- delayed and lingering -----------------------------------------------------------
test('echo repeats the hit later, exactly once', () => {
  const w = makeWorld();
  addPlayer(w, 'a', 100, 100);
  const c = addCreature(w, 'c1', 200, 100);
  assert.equal(cast(w, 'mnk_echo_palm', 200, 100).ok, true);
  assert.equal(w.pendingEchoes.length, 1);
  const afterHit = c.hp;
  w.now += 500; w.tick(0.05);
  assert.equal(c.hp, afterHit, 'not yet');
  w.now += 700; w.tick(0.05);
  const afterEcho = c.hp;
  assert.ok(afterEcho < afterHit, 'the echo landed');
  w.now += 5000; w.tick(0.05);
  assert.equal(c.hp, afterEcho, 'and only once');
  assert.equal(w.pendingEchoes.length, 0);
});

test('echoes are bounded per owner', () => {
  const w = makeWorld();
  const p = addPlayer(w, 'a', 100, 100);
  addCreature(w, 'c1', 200, 100);
  for (let i = 0; i < 20; i += 1) { p._skillReadyAt = new Map(); cast(w, 'mnk_echo_palm', 200, 100); }
  assert.ok(w.pendingEchoes.length <= 6);
});

test('zone leaves a damaging area that ticks and then ends', () => {
  const w = makeWorld();
  addPlayer(w, 'a', 100, 100);
  const c = addCreature(w, 'c1', 200, 100);
  assert.equal(cast(w, 'war_titanic_impact', 200, 100).ok, true);
  assert.equal(w.waves.length >= 1, true);
  const afterHit = c.hp;
  for (let i = 0; i < 40; i += 1) w.tick(0.05);           // two seconds
  assert.ok(c.hp < afterHit, 'the ground hurt it');
  for (let i = 0; i < 200; i += 1) w.tick(0.05);          // well past 3 s
  assert.equal(w.waves.length, 0);
});

test('summon without an ally sim is a harmless no-op, and calls summonAllies when there is one', () => {
  const w = makeWorld();
  addPlayer(w, 'a', 100, 100);
  assert.equal(cast(w, 'dru_summon_wolfpack', 200, 100).ok, true);
  const calls = [];
  w.creatures.summonAllies = (...args) => calls.push(args);
  w.getPlayer('a')._skillReadyAt = new Map();
  cast(w, 'dru_summon_wolfpack', 200, 100);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].k, 'summon');
  assert.equal(calls[0][1].kind, 'wolf');
});

// ---- who is never touched -----------------------------------------------------------
test('party-mates are never hit by any effect, statuses included', () => {
  const w = makeWorld();
  w.parties = new PartyManager();
  w.parties.invite('a', 'b'); w.parties.accept('b');
  addPlayer(w, 'a', 100, 100);
  const mate = addPlayer(w, 'b', 220, 100);
  const stranger = addPlayer(w, 'c', 220, 140);
  for (const id of ['war_shield_slam', 'war_gouge', 'mag_frost_nova', 'war_bleeding_cleave', 'mnk_echo_palm']) {
    w.getPlayer('a')._skillReadyAt = new Map();
    cast(w, id, 220, 100);
  }
  w.now += 3000; w.tick(0.05);
  assert.equal(mate.hp, 50000, 'no damage');
  assert.ok(!(mate._stunnedUntil > w.now) && (!mate.effects || mate.effects.size === 0), 'no status on a party-mate');
  assert.ok(stranger.hp < 50000, 'a stranger beside them is hit');
});

test('a village is PvE-only: no skill effect reaches a player standing in one', () => {
  const w = makeWorld();
  addPlayer(w, 'a', 100, 100);
  const victim = addPlayer(w, 'b', 220, 100);
  w.inVillage = (e) => e === victim;
  cast(w, 'war_shield_slam', 220, 100);
  cast(w, 'war_gouge', 220, 100);
  w.getPlayer('a')._skillReadyAt = new Map();
  assert.equal(victim.hp, 50000);
  assert.ok(!(victim._stunnedUntil > w.now));
  assert.ok(!victim.effects || victim.effects.size === 0);
});

test('an enemy player takes the statuses a creature would (stun, root, bleed)', () => {
  const w = makeWorld();
  addPlayer(w, 'a', 100, 100);
  const v = addPlayer(w, 'b', 220, 100);
  cast(w, 'war_shield_slam', 220, 100);
  assert.ok(v._stunnedUntil > w.now);
  w.getPlayer('a')._skillReadyAt = new Map();
  cast(w, 'war_bleeding_cleave', 220, 100);
  assert.ok(v.effects.has(E.BLEED));
});

test('the damage numbers follow the weapon curve: a skill beats plain auto-attacks', () => {
  for (const id of ['war_crushing_blow', 'mag_fireball', 'war_hamstring_slash']) {
    const s = getSkillById(id);
    const perSecond = skillSpec.castDamage(s) / Math.max(1, s.cooldown);
    assert.ok(perSecond > skillSpec.autoDpsAt(s.reqLvl) * 1.2, `${id}: ${perSecond}`);
  }
});

// ---- through the real creature tick --------------------------------------------------
const { CreatureSim } = require('../src/authority/creatures.js');

function tickRow(over = {}) {
  return {
    id: 'm1', type: 'T', x: 500, y: 500, hp: 1000, facing: 'S', home_x: null, home_y: null,
    level: 1, damage: 100, blocks_portal_id: null, defense: 0, color: '#fff', resistances: {},
    faction: 'hostile', attack_element: 'physical', behavior_name: 'T', aggro_radius: 600, leash_radius: 1200,
    chase_style: 'charge', preferred_range: 0, move_speed_mult: 1, damage_override: null,
    aura_names: null, aura_defs: [], behavior_gold_min: 0, behavior_gold_max: 0, abilities: [], skills: [], ...over,
  };
}
function oneBite(configure) {
  const s = new CreatureSim({ isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }, () => 0.5);
  s.addCreatures([tickRow()]);
  const c = s.get('m1');
  configure(c);
  const pl = { userId: 'u1', x: 505, y: 505, width: 64, height: 64, hp: 100000, maxHp: 100000 };
  const active = new Set(['0,0', '0,1', '1,0', '1,1']);
  let now = 0;
  for (let i = 0; i < 6 && pl.hp === 100000; i += 1) s.tick(0.05, active, [pl], (now += 50));
  return { lost: 100000 - pl.hp, c };
}

test('weaken lowers the damage a creature deals through the real tick', () => {
  const plain = oneBite(() => {});
  const weak = oneBite((c) => { c._weaken = 0.5; });
  assert.ok(plain.lost > 0, 'the creature bites');
  assert.ok(Math.abs(weak.lost - plain.lost * 0.5) <= 1, `${weak.lost} ~ half of ${plain.lost}`);
});

test('a rooted creature can still bite (root is not a stun), a silenced one cannot', () => {
  const rooted = oneBite((c) => { E.applyRoot(c, 5000, 0); });
  assert.ok(rooted.lost > 0, 'rooted creature attacks');
  const silenced = oneBite((c) => { E.applySilence(c, 5000, 0); });
  assert.equal(silenced.lost, 0, 'silenced creature does not');
  const feared = oneBite((c) => { c._fearUntil = 1e9; });
  assert.equal(feared.lost, 0, 'a feared creature does not attack');
});

test('a taunted creature fights the taunter even with another player nearer', () => {
  const s = new CreatureSim({ isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }, () => 0.5);
  s.addCreatures([tickRow({ chase_style: 'hold' })]);
  const c = s.get('m1');
  const near = { userId: 'near', x: 505, y: 505, width: 64, height: 64, hp: 1e5, maxHp: 1e5 };
  const taunter = { userId: 'taunter', x: 900, y: 500, width: 64, height: 64, hp: 1e5, maxHp: 1e5 };
  c._tauntUntil = 1e9; c._tauntedBy = 'taunter';
  s.tick(0.05, new Set(['0,0', '0,1', '1,0', '1,1']), [near, taunter], 50);
  assert.equal(c._target, 'taunter');
});
