// backend/tests/migration_aura_effects.test.js
const test = require('node:test');
const assert = require('node:assert');

// Records the SQL the migration issues, so the shape is asserted without a
// live DB (same pattern as migration_vfx_effects.test.js). The DB test next to
// this one proves the SQL actually runs.
function fakePgm() {
  const sql = [];
  return { sql: (s) => sql.push(s), calls: sql };
}
const mig = require('../migrations/1714440680000_aura_effects.js');
const upSql = () => { const p = fakePgm(); mig.up(p); return p.calls.join('\n'); };

test('creates aura_effects with every spec §3.2 column', () => {
  const s = upSql();
  for (const col of ['name', 'target_side', 'radius', 'damage_mult', 'defense_mult', 'speed_mult',
    'dot_dps', 'dot_element', 'tick_ms', 'shape', 'color', 'pulse_ms', 'particle_count',
    'particle_spread', 'particle_speed', 'particle_gravity', 'particle_lifetime_ms', 'particle_size']) {
    assert.match(s, new RegExp(`\\b${col}\\b`), `missing column ${col}`);
  }
  assert.match(s, /CREATE TABLE aura_effects/);
});

test('every enum and bound is a CHECK, with the spec vocabulary written literally', () => {
  const s = upSql();
  assert.match(s, /target_side IN \('allies', 'enemies'\)/);
  assert.match(s, /shape IN \('ring', 'disc', 'particles'\)/);
  assert.match(s, /radius > 0 AND radius <= 2000/);
  assert.match(s, /tick_ms BETWEEN 100 AND 5000/);
  assert.match(s, /damage_mult > 0/);
  assert.match(s, /particle_count >= 0 AND particle_count <= 64/);
  assert.match(s, /REFERENCES elements\(name\)/);
  // An allies-side aura with a DoT would damage its own pack.
  assert.match(s, /target_side = 'enemies' OR dot_dps = 0/);
});

test('entity_types.auras is added IF NOT EXISTS (S1 adds the same column)', () => {
  assert.match(upSql(), /ALTER TABLE entity_types ADD COLUMN IF NOT EXISTS auras jsonb/);
});

test('pack_leader is copied from Champion and bound to every Champion entity', () => {
  const s = upSql();
  assert.match(s, /FROM creature_behaviors WHERE name = 'Champion' AND aura_radius > 0/);
  assert.match(s, /'pack_leader'/);
  assert.match(s, /b\.name = 'Champion'/);
  assert.match(s, /NOT \(COALESCE\(e\.auras, '\[\]'::jsonb\) \? 'pack_leader'\)/);
});

test('down drops the table but never the shared auras column', () => {
  const p = fakePgm(); mig.down(p); const s = p.calls.join('\n');
  assert.match(s, /DROP TABLE IF EXISTS aura_effects/);
  // S1 owns entity_types.auras too; dropping it here would destroy S1's data.
  assert.doesNotMatch(s, /DROP COLUMN[\s\S]*auras/);
});
