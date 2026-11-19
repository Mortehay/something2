// SOMET-630. The dungeon boss level curve lands every shipped boss post on the approved
// targets. No DB: the posts come from the checked-in map specs, the rows from seeds/data,
// the level from the same dungeonBossLevel the game uses, and the stats from scaleBoss.
//
// The player side is bossLevelCurve.referencePlayer, read off the live gear ladder. It is
// a model, and says so; what this file pins is that the CURVE and the ROWS agree with the
// approved bands for that model at every post -- a retuned row, a re-banded floor or a
// changed gear tier that breaks one fails here instead of shipping.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const curve = require('../src/services/bossLevelCurve.js');
const { scaleCreature } = require('../src/services/creatureLevel.js');
const { dungeonBossLevel } = require('../src/authority/dungeonBosses.js');
const { DUNGEON_BOSSES } = require('../seeds/data/dungeonBosses.js');
const { AURA_EFFECTS } = require('../seeds/data/auraEffects.js');
const migration = require('../migrations/1714440899800_dungeon_boss_level_curve.js');

// The approved bands (2026-11-19). The curve aims at their middle; these are the edges.
const BANDS = {
  dungeon_end: { ttk: [90, 150], ttdMin: 8 },
  dungeon_elite: { ttk: [45, 90], ttdMin: 12 },
};

const MAPS = path.join(__dirname, '..', 'seeds', 'maps');
function bossPosts() {
  const posts = [];
  for (const f of fs.readdirSync(MAPS).filter((x) => x.endsWith('.map.json'))) {
    const spec = JSON.parse(fs.readFileSync(path.join(MAPS, f), 'utf8'));
    for (const w of spec.worlds) {
      if (!w.boss) continue;
      const row = DUNGEON_BOSSES.find((b) => b.name === w.boss.entity);
      if (!row) continue; // a world-tier post boss: bossBalance owns it
      const [lo, hi] = w.level_band || [1, 1];
      posts.push({ where: `${f}:${w.name}`, row, level: dungeonBossLevel(row.boss_tier, lo, hi) });
    }
  }
  return posts;
}

// Seconds to kill the boss / to be killed by it, for the reference player at `level`.
function fight(stats, row, level) {
  const t = curve.TARGETS[row.boss_tier];
  const p = curve.referencePlayer(level);
  const resist = (row.resistances && row.resistances.physical) || 0;
  const playerDps = curve.mitigated(p.hit, stats.defense, resist) * p.attacksPerSecond;
  const bossDps = curve.mitigated(stats.damage * t.hitMult, p.defense) / t.cooldownS;
  return { ttk: stats.hp / playerDps, ttd: p.hp / bossDps };
}
const base = (row) => ({ hp: row.hp, damage: row.base_damage, defense: row.defense });

test('the shipped specs hold dungeon boss posts of both tiers, across a wide level range', () => {
  const posts = bossPosts();
  assert.ok(posts.length >= 15, `only ${posts.length} posts found -- the walk lost its subject`);
  assert.ok(posts.some((p) => p.row.boss_tier === 'dungeon_end'));
  assert.ok(posts.some((p) => p.row.boss_tier === 'dungeon_elite'));
  const levels = posts.map((p) => p.level);
  assert.ok(Math.min(...levels) <= 10 && Math.max(...levels) >= 100, `levels ${Math.min(...levels)}-${Math.max(...levels)}`);
});

test('every dungeon boss post lands inside its tier\'s time-to-kill and time-to-die bands', () => {
  const misses = [];
  for (const { where, row, level } of bossPosts()) {
    const b = BANDS[row.boss_tier];
    const f = fight(curve.scaleBoss(base(row), row.boss_tier, level), row, level);
    if (f.ttk < b.ttk[0] || f.ttk > b.ttk[1] || f.ttd < b.ttdMin) {
      misses.push(`${where} ${row.name} L${level}: kill ${f.ttk.toFixed(0)}s, die ${f.ttd.toFixed(1)}s`);
    }
  }
  assert.deepEqual(misses, []);
});

test('the old creature curve misses those bands, so the test above can fail', () => {
  // The pre-SOMET-630 rows on the pre-SOMET-630 curve: one-shots at depth, five-minute
  // slogs at the top. If this ever passes, the band test has stopped measuring anything.
  let misses = 0;
  for (const { row, level } of bossPosts()) {
    const old = migration.BOSSES.find(([n]) => n === row.name);
    const stats = scaleCreature({ hp: old[2], defense: old[3], damage: old[4] }, level);
    const f = fight(stats, row, level);
    const b = BANDS[row.boss_tier];
    if (f.ttk < b.ttk[0] || f.ttk > b.ttk[1] || f.ttd < b.ttdMin) misses += 1;
  }
  assert.ok(misses >= 10, `only ${misses} posts missed on the old curve`);
});

test('scaleBoss: level 1 returns the row as authored; an admin\'s x2 hp is x2 at every level', () => {
  const row = { hp: 1000, damage: 20, defense: 3 };
  assert.deepEqual(curve.scaleBoss(row, 'dungeon_end', 1), { hp: 1000, damage: 20, defense: 3 });
  for (const L of [1, 25, 70, 150]) {
    const one = curve.scaleBoss(row, 'dungeon_end', L).hp;
    const two = curve.scaleBoss({ ...row, hp: 2000 }, 'dungeon_end', L).hp;
    assert.ok(Math.abs(two - 2 * one) <= 1, `L${L}: ${two} vs 2x${one}`);
  }
});

test('scaleBoss grows with level and never shrinks', () => {
  for (const tier of Object.keys(curve.TARGETS)) {
    let prev = curve.scaleBoss({ hp: 1000, damage: 20, defense: 3 }, tier, 1);
    for (let L = 2; L <= curve.MAX_LEVEL; L += 1) {
      const s = curve.scaleBoss({ hp: 1000, damage: 20, defense: 3 }, tier, L);
      assert.ok(s.hp >= prev.hp && s.damage >= prev.damage && s.defense >= prev.defense, `${tier} L${L}`);
      prev = s;
    }
  }
});

test('scaleBoss: a bad level reads as 1, past the cap reads as the cap; an unknown tier throws', () => {
  const row = { hp: 1000, damage: 20, defense: 3 };
  for (const bad of [0, -3, 2.5, NaN, null, undefined]) {
    assert.deepEqual(curve.scaleBoss(row, 'dungeon_elite', bad), curve.scaleBoss(row, 'dungeon_elite', 1), String(bad));
  }
  assert.deepEqual(curve.scaleBoss(row, 'dungeon_end', 999), curve.scaleBoss(row, 'dungeon_end', curve.MAX_LEVEL));
  assert.throws(() => curve.scaleBoss(row, 'miniboss', 10), /no level curve/);
});

test('the six rows, the migration and referenceBase all say the same thing', () => {
  for (const row of DUNGEON_BOSSES) {
    const ref = curve.referenceBase(row.boss_tier);
    assert.deepEqual({ hp: row.hp, base_damage: row.base_damage, defense: row.defense }, ref, row.name);
    const [, applied] = migration.BOSSES.find(([n]) => n === row.name);
    assert.deepEqual(applied, ref, `${row.name}: migration literal drifted from the curve`);
  }
  assert.deepEqual(migration.TIER_VALUES.dungeon_end, curve.referenceBase('dungeon_end'));
  assert.deepEqual(migration.TIER_VALUES.dungeon_elite, curve.referenceBase('dungeon_elite'));
});

test('ignis_inferno bites through level-100 gear: ~20/s net, not the 1/s floor', () => {
  const a = AURA_EFFECTS.find((x) => x.name === 'ignis_inferno');
  const tickDamage = a.dot_dps * (a.tick_ms / 1000);
  const p100 = curve.referencePlayer(100);
  const net = curve.mitigated(tickDamage, p100.defense) / (a.tick_ms / 1000);
  assert.ok(net >= 15 && net <= 30, `net ${net.toFixed(1)}/s at defense ${p100.defense.toFixed(1)}`);
  // A level-100 player standing in it the whole time lives for more than 30 s from the aura alone.
  assert.ok(p100.hp / net > 30, `dead in ${(p100.hp / net).toFixed(0)} s from the aura alone`);
});
