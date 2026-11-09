// backend/tests/boss_distinct_kits.test.js
// The four world bosses' kits (migration 1714440874000) are built to be DIFFERENT, not four
// renamings of one shape. This pins that: each boss has five or six attacks, no two of a boss's
// attacks share a mechanic signature, the mechanics a boss is known for belong to it alone, and
// the data is well formed (kinds, telegraphs, element, phase gates, the names the phase and ward
// cues point at).
const test = require('node:test');
const assert = require('node:assert');
const m874 = require('../migrations/1714440874000_world_boss_distinct_kits.js');
const m873 = require('../migrations/1714440873000_world_boss_attack_kits.js');
const m731 = require('../migrations/1714440731000_boss_skill_kits.js');
const { resolveSkill, creatureSkillError, KINDS } = require('../src/services/creatureSkills.js');
const { PHASE_SKILLS, WARD_SKILLS, phaseSkillFor, wardSkillFor } = require('../src/authority/bossSkillRules.js');

const IGNIS = 'Ignis, the Magma Colossus';
const GLACIUS = 'Glacius, the Frost Leviathan';
const GORGON = 'Gorgon, the Thunder Titan';
const ABYSSOR = 'Abyssor, the Voidreaver';
const ELEMENT = { [IGNIS]: 'fire', [GLACIUS]: 'ice', [GORGON]: 'lightning', [ABYSSOR]: 'arcane' };

// Skills that existed before this migration and are bound unchanged (kind, element).
const BASE = {
  'Magma Slam': ['slam', 'fire'], 'Cinder Brood': ['summon', 'fire'],
  'Permafrost Nova': ['nova', 'ice'], 'Glacial Lance': ['projectile', 'ice'],
  'Thunder Slam': ['slam', 'lightning'], 'Static Pulse': ['nova', 'lightning'],
  'Void Bolt': ['projectile', 'arcane'],
};

// name -> the skill row as the DB will hold it after every migration, in the shape resolveSkill reads.
function catalog() {
  const rows = new Map();
  for (const s of m731.SKILLS) rows.set(s.name, { name: s.name, kind: s.kind, telegraph_ms: s.telegraph_ms, cooldown_ms: s.cooldown_ms, radius: s.radius, range: s.range, damage_mult: s.damage_mult, element: s.element, vfx: s.vfx, params: null });
  for (const [name, kind, tele, cd, radius, range, mult, element, vfx, params] of m873.SKILLS) rows.set(name, { name, kind, telegraph_ms: tele, cooldown_ms: cd, radius, range, damage_mult: mult, element, vfx, params });
  for (const [name, kind, tele, cd, radius, range, mult, element, vfx, params] of m874.SKILLS) rows.set(name, { name, kind, telegraph_ms: tele, cooldown_ms: cd, radius, range, damage_mult: mult, element, vfx, params });
  for (const [name, patch] of m874.PARAM_PATCHES) rows.get(name).params = { ...(rows.get(name).params || {}), ...patch };
  for (const name of m874.OBSOLETE) rows.delete(name);
  return rows;
}
const CATALOG = catalog();
// The six originals that are not in an exported table: name -> minimal row.
for (const [name, [kind, element]] of Object.entries(BASE)) {
  if (!CATALOG.has(name)) CATALOG.set(name, { name, kind, element, telegraph_ms: 1000, cooldown_ms: 8000, radius: 100, range: 300, damage_mult: 2, params: null, vfx: null });
}

const kitOf = (boss) => m874.BINDINGS.filter((b) => b[0] === boss).sort((a, b) => a[2] - b[2])
  .map(([, skill, slot, minPhase]) => ({ skill, slot, minPhase, row: CATALOG.get(skill), r: resolveSkill({ ...CATALOG.get(skill), min_phase: minPhase, power_scale: 1 }) }));

// What a skill DOES, as one string: its kind plus every parameter that changes how it plays.
function signature(r) {
  const parts = [r.kind];
  if (r.hazard) parts.push(`hazard:${r.hazard.pattern}${r.hazard.slowPct > 0 ? ':slow' : ''}`);
  if (r.mark) parts.push(`mark:${r.mark.all ? 'all' : r.mark.targets}`);
  if (r.shelter) parts.push('shelter');
  if (r.waves > 1) parts.push(`waves:${r.waves}`);
  if (r.zones) parts.push(`zones:${r.zones.length > 1 ? 'many' : 'one'}`);
  if (r.status) {
    if (r.status.rootS > 0) parts.push('root');
    if (r.status.slowPct > 0) parts.push('slow');
    if (r.status.silenceS > 0) parts.push('silence');
  }
  if (r.pull > 0) parts.push('pull');
  if (r.projectileCount > 1) parts.push('fan');
  if (r.hits > 1) parts.push('jumps');
  if (r.innerRadius > 0) parts.push('hole');
  return parts.join('+');
}
const mechanics = (boss) => new Set(kitOf(boss).flatMap(({ r }) => signature(r).split('+')));

test('every boss has five or six attacks, bound to slots 1..n with no gap', () => {
  for (const boss of Object.keys(ELEMENT)) {
    const kit = kitOf(boss);
    assert.ok(kit.length >= 5 && kit.length <= 6, `${boss}: ${kit.length} attacks`);
    assert.deepEqual(kit.map((k) => k.slot), kit.map((_, i) => i + 1), `${boss}: slots`);
    for (const k of kit) assert.ok(k.row, `${boss}: ${k.skill} exists in the catalog`);
  }
});

test('within a boss no two attacks play the same: every mechanic signature is unique', () => {
  for (const boss of Object.keys(ELEMENT)) {
    const sigs = kitOf(boss).map(({ skill, r }) => [signature(r), skill]);
    const seen = new Map();
    for (const [sig, skill] of sigs) {
      assert.ok(!seen.has(sig), `${boss}: ${skill} and ${seen.get(sig)} are both "${sig}"`);
      seen.set(sig, skill);
    }
  }
});

test('no attack is shared between two bosses, by name or by exact mechanic signature', () => {
  const byName = new Map();
  const bySig = new Map();
  for (const boss of Object.keys(ELEMENT)) {
    for (const { skill, r } of kitOf(boss)) {
      assert.ok(!byName.has(skill), `${skill} is in ${byName.get(skill)} and ${boss}`);
      byName.set(skill, boss);
      const sig = signature(r);
      // the plain filler attacks (a slam, a nova, a projectile) may coincide; anything with a
      // real mechanic on top of its kind may not
      if (sig.includes('+') || ['zone', 'mark', 'shelter', 'chain', 'charge', 'blink'].includes(sig)) {
        assert.ok(!bySig.has(sig) || bySig.get(sig) === boss, `${boss}: "${sig}" is also ${bySig.get(sig)}'s`);
        bySig.set(sig, boss);
      }
    }
  }
});

test('each boss owns its mechanic family', () => {
  const i = mechanics(IGNIS); const g = mechanics(GLACIUS); const o = mechanics(GORGON); const a = mechanics(ABYSSOR);
  // Ignis: ground that stays, delayed blasts, one safe circle
  for (const k of ['zone', 'mark', 'shelter', 'hazard:targets', 'hazard:ring']) assert.ok(i.has(k), `Ignis ${k}`);
  // Glacius: control
  for (const k of ['root', 'slow', 'zone']) assert.ok(g.has(k), `Glacius ${k}`);
  // Gorgon: speed and chains
  for (const k of ['chain', 'charge', 'mark', 'waves:4']) assert.ok(o.has(k), `Gorgon ${k}`);
  // Abyssor: space and mind
  for (const k of ['silence', 'pull', 'blink', 'fan']) assert.ok(a.has(k), `Abyssor ${k}`);
  // ...and the signature mechanics are not anyone else's
  for (const [k, owner, others] of [
    ['root', 'Glacius', [i, o, a]], ['silence', 'Abyssor', [i, g, o]], ['shelter', 'Ignis', [g, o, a]],
    ['chain', 'Gorgon', [i, g, a]], ['charge', 'Gorgon', [i, g, a]], ['blink', 'Abyssor', [i, g, o]],
    ['pull', 'Abyssor', [i, g, o]], ['waves:4', 'Gorgon', [i, g, a]], ['hazard:ring', 'Ignis', [g, o, a]],
  ]) {
    for (const set of others) assert.ok(!set.has(k), `${k} belongs to ${owner} alone`);
  }
  // marks: Ignis marks one, Gorgon marks everyone: different answers
  assert.ok(i.has('mark:1') && o.has('mark:all'));
});

test('every attack is well formed', () => {
  for (const boss of Object.keys(ELEMENT)) {
    for (const { skill, row, r, minPhase } of kitOf(boss)) {
      assert.ok(KINDS.includes(row.kind), `${skill}: kind`);
      assert.equal(row.element, ELEMENT[boss], `${skill}: element is ${boss}'s`);
      assert.ok(row.telegraph_ms >= 0 && row.telegraph_ms <= 3000, `${skill}: telegraph`);
      assert.ok(row.cooldown_ms > 0, `${skill}: cooldown`);
      assert.ok(minPhase >= 1 && minPhase <= 4, `${skill}: phase`);
      if (m874.SKILLS.some((s) => s[0] === skill)) {
        const e = creatureSkillError({ ...row, name: skill });
        assert.equal(e, null, `${skill}: ${e}`);
        assert.ok(row.vfx && row.vfx.telegraph && row.vfx.cast && row.vfx.impact, `${skill}: its effects are named`);
      }
      if (r.ultimate) assert.ok(row.telegraph_ms >= 1500, `${skill}: an ultimate gives time to read it`);
      // a mark needs time to run away; a shelter time to get there
      if (row.kind === 'mark' || row.kind === 'shelter') assert.ok(row.telegraph_ms >= 2500, `${skill}: time to react`);
    }
  }
});

test('every effect an attack names exists', () => {
  const known = new Set([...m874.EFFECTS, ...m873.EFFECTS].map((e) => e[0]));
  const obsolete = new Set(); // names removed by 874 must not be named by a kept skill
  for (const n of ['boss_lava_ring', 'boss_meteor', 'boss_blazing_charge', 'boss_magma_cataclysm', 'boss_frost_breath', 'boss_glacier_blink', 'boss_frozen_cataclysm', 'boss_overload', 'boss_storm_cataclysm', 'boss_rift_rain', 'boss_void_cataclysm']) obsolete.add(n);
  for (const boss of Object.keys(ELEMENT)) {
    for (const { skill, row } of kitOf(boss)) {
      if (!row.vfx) continue;
      for (const moment of ['telegraph', 'cast']) {
        const name = row.vfx[moment];
        if (name.startsWith('boss_')) {
          assert.ok(known.has(name), `${skill}: ${name} exists`);
          assert.ok(!obsolete.has(name), `${skill}: ${name} was removed by the migration`);
        }
      }
    }
  }
});

test('the ultimate comes first in priority, the plain filler last, and the gates rise with the slots', () => {
  for (const boss of Object.keys(ELEMENT)) {
    const kit = kitOf(boss);
    assert.ok(kit[0].r.ultimate, `${boss}: slot 1 is the ultimate`);
    assert.equal(kit[0].minPhase, 4);
    assert.equal(kit[kit.length - 1].minPhase, 1, `${boss}: the last slot is available from the start`);
    for (let i = 1; i < kit.length; i += 1) {
      assert.ok(kit[i].minPhase <= kit[i - 1].minPhase, `${boss}: ${kit[i].skill} (phase ${kit[i].minPhase}) is not later than ${kit[i - 1].skill}`);
    }
    assert.ok(!kit.some((k) => k.r.requiresEnrage), `${boss}: no enrage-only duplicate`);
  }
});

test('phase and ward cues name skills the boss owns, and are not ordinary filler', () => {
  assert.deepEqual(Object.keys(PHASE_SKILLS).sort(), Object.keys(ELEMENT).sort());
  assert.deepEqual(Object.keys(WARD_SKILLS).sort(), Object.keys(ELEMENT).sort());
  for (const boss of Object.keys(ELEMENT)) {
    const own = new Set(kitOf(boss).map((k) => k.skill));
    for (const phase of [3, 4]) assert.ok(own.has(phaseSkillFor(boss, phase)), `${boss}: phase ${phase} cue`);
    assert.ok(own.has(wardSkillFor(boss)), `${boss}: ward cue`);
    assert.equal(phaseSkillFor(boss, 4), kitOf(boss)[0].skill, `${boss}: phase 4 opens with the ultimate`);
  }
  assert.equal(phaseSkillFor('Nobody', 3), null);
  assert.equal(wardSkillFor('Nobody'), null);
});

test('the obsolete skills of the previous migration are all gone from every kit', () => {
  const bound = new Set(m874.BINDINGS.map((b) => b[1]));
  for (const name of m874.OBSOLETE) assert.ok(!bound.has(name), `${name} is still bound`);
});
