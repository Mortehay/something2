// SOMET-343: augment stones on projectile weapons, and ammunition that
// contributes to the shot it becomes.

const test = require('node:test');
const assert = require('node:assert');
const { ProjectileSim } = require('../src/authority/projectiles.js');

const WALK_ALL = { isWalkable: () => true };
const BOW = { damage: 10, range: 700, projectile_speed: 100, projectile_radius: 8, pierce: 1, element: null };
const FROST = { element: 'ice', bonusDamage: 4, impactBehaviorId: null };

function mkCreature(id, cx, cy, hp = 100) {
  return { id, x: cx - 24, y: cy - 24, width: 48, height: 48, hp };
}
function mkPlayer(userId, cx, cy, hp = 100) {
  return { userId, x: cx - 32, y: cy - 32, width: 64, height: 64, hp, maxHp: 100 };
}
// A creatures stub that mirrors the REAL contract: damageCreatureById applies
// damage, resolves the kill, deletes on death, and returns whether it died.
// That deletion is the whole reason the augment packet must land first.
function creaturesStub(list) {
  const byId = new Map(list.map((c) => [c.id, c]));
  return {
    byId,
    forEachNear(_x, _y, _r, fn) { for (const c of byId.values()) fn(c); },
    all() { return [...byId.values()]; },
    get(id) { return byId.get(id); },
    damageCreatureById(id, dmg, _el, _now, _src) {
      const c = byId.get(id);
      if (!c) return false;
      c.hp -= dmg;
      if (c.hp <= 0) { byId.delete(id); return true; }
      return false;
    },
  };
}
const ctx = (creatures, players = []) => ({ creatures, players, map: WALK_ALL });

test('an augment bonus lands on a direct projectile hit', () => {
  const plain = new ProjectileSim();
  plain.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: BOW });
  const cs1 = creaturesStub([mkCreature('c1', 32, 0, 500)]);
  plain.step(1, ctx(cs1));

  const aug = new ProjectileSim();
  aug.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...BOW, augment: FROST } });
  const cs2 = creaturesStub([mkCreature('c1', 32, 0, 500)]);
  aug.step(1, ctx(cs2));

  assert.ok(cs2.get('c1').hp < cs1.get('c1').hp,
    `augmented shot must hurt more: plain ${cs1.get('c1').hp}, augmented ${cs2.get('c1').hp}`);
  assert.equal(cs1.get('c1').hp - cs2.get('c1').hp, 4, 'exactly the bonus');
});

test('a creature killed by the BONUS is reported exactly once', () => {
  // THE ordering hazard this slice exists to resolve. hp sits between the
  // weapon's 10 and the augmented 14, so only the bonus can kill. If the bonus
  // were applied AFTER the weapon packet, damageCreatureById would already
  // have deleted the creature and the kill would be lost or double-counted.
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...BOW, augment: FROST } });
  const cs = creaturesStub([mkCreature('c1', 32, 0, 12)]);
  const r = sim.step(1, ctx(cs));
  assert.equal(r.kills.length, 1, `expected exactly one kill, got ${r.kills.length}`);
  assert.equal(r.kills[0].id, 'c1');
  assert.equal(cs.get('c1'), undefined, 'and it is gone from the sim');
});

test('the bonus reaches players on a direct hit too', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...BOW, augment: FROST } });
  const target = mkPlayer('u2', 32, 0);
  sim.step(1, ctx(creaturesStub([]), [target]));
  assert.equal(target.hp, 100 - 14, 'weapon 10 + bonus 4');
});

test('an AoE blast applies the bonus with the SAME falloff as the weapon', () => {
  // A bonus that ignored distance would make an augmented blast hit harder at
  // the rim than the weapon it is attached to.
  const staff = { damage: 100, range: 40, projectile_speed: 100, projectile_radius: 4, pierce: 1, aoe_radius: 100, element: null };
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...staff, augment: { element: 'ice', bonusDamage: 20, impactBehaviorId: null } } });
  const target = mkPlayer('u2', 32, 0);
  sim.step(1, ctx(creaturesStub([]), [target]));
  // Blast at x=48, target centre x=32 -> d=16, r=100 -> falloff 0.84.
  // weapon 100*0.84 = 84, bonus 20*0.84 = 16.8 -> 100.8 total.
  const taken = 100 - target.hp;
  assert.ok(taken > 84, `bonus must land in the blast: took ${taken}`);
  assert.ok(Math.abs(taken - 100.8) < 0.01, `expected weapon+bonus both scaled: took ${taken}`);
});

test('an unaugmented shot is byte-for-byte unchanged', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: BOW });
  const target = mkPlayer('u2', 32, 0);
  sim.step(1, ctx(creaturesStub([]), [target]));
  assert.equal(target.hp, 90);
});

// ---------------------------------------------------------------------------
// Ammunition contributing to the shot
// ---------------------------------------------------------------------------

test('explosive AMMO makes an ordinary bow detonate', () => {
  // The bow carries no aoe of its own; the arrow does. Before this slice the
  // ammo row was spent and contributed nothing.
  const sim = new ProjectileSim();
  sim.spawn({
    ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0,
    weapon: { ...BOW, range: 40 },
    ammo: { name: 'explosive arrow', aoe_radius: 100 },
  });
  const r = sim.step(1, ctx(creaturesStub([])));
  assert.equal(r.detonations.length, 1, 'the shot must have detonated');
  assert.equal(r.detonations[0].radius, 100);
});

test('silent ammo leaves the weapon own behaviour alone', () => {
  // Every arrow in the game today. A merge that overwrote with null would
  // un-explode every existing staff.
  const staff = { ...BOW, range: 40, aoe_radius: 70 };
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: staff, ammo: { name: 'arrow', aoe_radius: null } });
  const r = sim.step(1, ctx(creaturesStub([])));
  assert.equal(r.detonations[0].radius, 70, "the weapon's own radius survives");
});

test('MERGED pierce + detonate is resolved, not left to slip through', () => {
  // item_types_aoe_pierce_check is a ROW-level CHECK: a piercing arbalest and
  // a detonating bolt each pass on their own, and the forbidden combination
  // exists only here, after the merge, where no constraint can see it.
  //
  // Pierce is clamped to 1, per that constraint's own reasoning: a detonating
  // projectile has nothing left to pierce with.
  const arbalest = { damage: 10, range: 40, projectile_speed: 100, projectile_radius: 8, pierce: 3, element: null };
  const sim = new ProjectileSim();
  const id = sim.spawn({
    ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0,
    weapon: arbalest, ammo: { name: 'explosive bolt', aoe_radius: 100 },
  });
  const p = sim.projectiles.find((x) => x.id === id);
  assert.equal(p.pierceLeft, 1, 'pierce clamped once the shot detonates');
  assert.equal(p.aoeRadius, 100, 'and the detonation is kept');
});

test('a piercing weapon with NON-explosive ammo keeps its pierce', () => {
  // The clamp must be conditional on the merge actually producing a
  // detonating shot -- otherwise it would silently nerf every arbalest.
  const arbalest = { damage: 10, range: 700, projectile_speed: 100, projectile_radius: 8, pierce: 3, element: null };
  const sim = new ProjectileSim();
  const id = sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: arbalest, ammo: { name: 'bolt', aoe_radius: null } });
  assert.equal(sim.projectiles.find((x) => x.id === id).pierceLeft, 3);
});

// ---------------------------------------------------------------------------
// SOMET-343 part 3: detonate_at = 'max_range'
// ---------------------------------------------------------------------------

test("a max_range shot flies THROUGH a target instead of detonating on it", () => {
  // "Magic that explodes when the distance ends". A contact detonator would
  // have gone off on this creature; this one must damage it and keep going.
  const staff = {
    damage: 10, range: 200, projectile_speed: 100, projectile_radius: 4,
    pierce: 3, aoe_radius: 100, element: null, detonate_at: 'max_range',
  };
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: staff });
  const cs = creaturesStub([mkCreature('c1', 32, 0, 500)]);
  const r = sim.step(0.4, ctx(cs));   // 40px of travel: reaches c1, not the end
  assert.equal(r.detonations.length, 0, 'must NOT detonate on contact');
  assert.ok(cs.get('c1').hp < 500, 'but must still deal its direct-hit damage');
});

test('a max_range shot detonates when its distance runs out', () => {
  const staff = {
    damage: 10, range: 40, projectile_speed: 100, projectile_radius: 4,
    pierce: 1, aoe_radius: 100, element: null, detonate_at: 'max_range',
  };
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: staff });
  const r = sim.step(1, ctx(creaturesStub([])));
  assert.equal(r.detonations.length, 1);
  assert.equal(r.detonations[0].radius, 100);
});

test('a max_range shot keeps its pierce, or it could never reach the range', () => {
  // The clamp that resolves merged pierce+detonate is CONTACT-only. Applied to
  // a max_range shot it would stop it at the first creature, and the feature
  // would be inert -- the exact failure this epic exists to remove.
  const staff = {
    damage: 10, range: 200, projectile_speed: 100, projectile_radius: 4,
    pierce: 3, aoe_radius: 100, element: null, detonate_at: 'max_range',
  };
  const sim = new ProjectileSim();
  const id = sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: staff });
  assert.equal(sim.projectiles.find((x) => x.id === id).pierceLeft, 3);
});

test("an unspecified detonate_at is 'contact', so nothing existing changes", () => {
  const staff = { damage: 10, range: 200, projectile_speed: 100, projectile_radius: 4, pierce: 1, aoe_radius: 100, element: null };
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: staff });
  const cs = creaturesStub([mkCreature('c1', 32, 0, 500)]);
  const r = sim.step(0.4, ctx(cs));
  assert.equal(r.detonations.length, 1, 'a contact detonator still goes off on contact');
});
