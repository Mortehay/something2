// backend/migrations/1714440702000_backfill_worlds_dungeon_boss.js
//
// SOMET-609 (S9, final review I-1). 1714440700000 added worlds.dungeon_boss
// with "no backfill: seed-map fills it". But no deployed DB is ever re-seeded
// with seed-map: the staging deploy runs migrate + seed-catalogs only, and the
// shared dev DB only gets migrations. Without this migration every deployed
// DB has the six boss entity rows and zero placed bosses (place() returns null
// silently).
//
// Sets the boss block on the six p5-descent End/Elite worlds BY NAME, only
// WHERE dungeon_boss IS NULL, so an admin edit (or a later seed-map, which
// writes the same values) is never overwritten. Also skipped when the boss
// entity row is missing or not boss-tier (renamed or deleted before this
// ran), so it never writes a reference place() would refuse.
//
// Frozen literals: this file must not require the generator (a later edit
// there would silently rewrite history). dungeon_boss_backfill_parity.test.js
// pins them equal to generateSpec()'s boss blocks today.
exports.shorthands = undefined;

const DUNGEON_BOSSES = [
  { world: 'The Catacombs: End', boss: { entity: 'The Bone Regent', x: 4950, y: 5450, respawn_s: 900 } },
  { world: 'The Catacombs: Elite', boss: { entity: 'Ossuary Warden', x: 4950, y: 4850, respawn_s: 600 } },
  { world: 'The Emberhive: End', boss: { entity: 'The Ember Queen', x: 8150, y: 8650, respawn_s: 900 } },
  { world: 'The Emberhive: Elite', boss: { entity: 'Cinder Matriarch', x: 8150, y: 8050, respawn_s: 600 } },
  { world: 'The Umbral Gate: End', boss: { entity: 'The Umbral Gatekeeper', x: 11350, y: 11850, respawn_s: 900 } },
  { world: 'The Umbral Gate: Elite', boss: { entity: 'Shade Herald', x: 11350, y: 11250, respawn_s: 600 } },
];

const sqlString = (s) => `'${s.replace(/'/g, "''")}'`;

exports.DUNGEON_BOSSES = DUNGEON_BOSSES;

exports.up = (pgm) => {
  for (const { world, boss } of DUNGEON_BOSSES) {
    pgm.sql(`
      UPDATE worlds SET dungeon_boss = ${sqlString(JSON.stringify(boss))}::jsonb
      WHERE name = ${sqlString(world)}
        AND dungeon_boss IS NULL
        AND EXISTS (SELECT 1 FROM entity_types
                    WHERE name = ${sqlString(boss.entity)} AND boss_tier IS NOT NULL);
    `);
  }
};

// Clears only a value still equal to this migration's literal: an admin edit
// survives a down.
exports.down = (pgm) => {
  for (const { world, boss } of DUNGEON_BOSSES) {
    pgm.sql(`
      UPDATE worlds SET dungeon_boss = NULL
      WHERE name = ${sqlString(world)}
        AND dungeon_boss = ${sqlString(JSON.stringify(boss))}::jsonb;
    `);
  }
};
