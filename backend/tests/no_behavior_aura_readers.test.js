// SOMET-604: the aura moved to aura_effects/entity_types.auras. Any surviving
// reader of creature_behaviors.aura_* is either dead code or (worse) a second
// source of truth. Scans REAL files (never a copy) across backend runtime,
// scripts, seeds and frontend. Migrations are history and are excluded.
//
// NOT scanned for bare `auraRadius`: that is also the PLAYER leech-aura rule
// key (statComposition.js, world.js, passiveTree.js). The behaviour half of
// that name is pinned directly through DEFAULT_BEHAVIOR/resolveBehavior below.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SCAN = ['backend/src', 'backend/scripts', 'backend/seeds/data', 'frontend/src'];
const BANNED = /\baura_(radius|damage_mult|defense_mult|speed_mult)\b|\baura(DamageMult|DefenseMult|SpeedMult)\b/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['node_modules', '__tests__', 'dist'].includes(e.name)) walk(p, out); }
    else if (/\.(js|jsx|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = SCAN.flatMap((d) => walk(path.join(ROOT, d)));

test('the scan actually covers the files that used to read aura_* (anti-vacuity)', () => {
  for (const f of ['backend/src/authority/creatures.js', 'backend/src/authority/server.js',
    'backend/src/services/creatureBehaviors.js', 'backend/src/index.js',
    'backend/scripts/seed-catalogs.js', 'frontend/src/games/something2/behaviorForm.js']) {
    assert.ok(files.includes(path.join(ROOT, f)), `scan misses ${f}`);
  }
  assert.ok(BANNED.test('b.aura_radius') && BANNED.test('auraDamageMult'), 'pattern cannot fire');
});

test('nothing outside migrations names creature_behaviors.aura_* or its camelCase mapping', () => {
  const hits = [];
  for (const f of files) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (BANNED.test(line)) hits.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepStrictEqual(hits, []);
});

test('the behaviour resolver no longer carries an aura', () => {
  const { DEFAULT_BEHAVIOR, resolveBehavior } = require('../src/services/creatureBehaviors.js');
  assert.strictEqual('auraRadius' in DEFAULT_BEHAVIOR, false);
  assert.strictEqual('auraRadius' in resolveBehavior({ behavior_name: 'Champion', aura_radius: 260 }), false);
});
