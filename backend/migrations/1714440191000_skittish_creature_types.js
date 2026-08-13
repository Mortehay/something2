exports.shorthands = undefined;

// SOMET-290 Task 4: three P4 bestiary types adopt the Skittish profile
// (Task 1's 1714440190000_skittish_chase_style.js) -- Woodland Swarm, Beast
// Swarm, Highland Swarm.
//
// FIX ROUND 1: the original version of this migration flagged the four
// LEGACY types (Wolf/Slime/Skeleton/Bat, seeds/data/entityTypes.js). That was
// wrong on two counts, caught only because it was applied against the real
// dev DB rather than a fixture: those four are placed across the whole
// game -- flipping Bat and Slime would have made 94 already-live creatures
// (67 Slime, 27 Bat placements) flee instead of fight, an unasked-for change
// to shipped content; and it broke two pre-existing invariant tests
// (entity_types_seed.test.js, legacyCreatureGoldRung.test.js) that assert all
// four legacy types share one profile. The original migration was UN-APPLIED
// by hand against the dev DB (not by running this file's own down -- the
// ledger row was deleted directly) before this rewrite, which is why this
// timestamp is reused rather than superseded by a new one.
//
// The three types below are chosen instead: all `is_creature`, all at the
// lowest bestiary rung (Swarm -- template.js RUNGS[0], hp 8), all Surface-tier
// wildlife lines with no elemental framing (Beast/Meadow, Woodland/Deep
// Forest) or a plain physical one (Highland/Highlands) -- see template.js's
// LINES array. Between them they had exactly 2 live placements (both
// Highland Swarm) at the time this migration was written, so this is a
// near-zero-footprint change: SOMET-289's pens will place them explicitly,
// nothing shipped changes underneath a player today.
//
// RUNG IS NOT LEVEL BAND, and these three do NOT share one. bestiary/derive.js
// deriveLevelBand(tier, rungIndex) places a rung inside its LINE's tier span,
// so a Swarm on a tier-II line outranks a Swarm on a tier-I line. Read from
// seeds/data/bestiaryP4.js:
//
//   Woodland Swarm  levels 1-2   (Deep Forest, tier I)
//   Beast Swarm     levels 1-2   (Meadow,      tier I)
//   Highland Swarm  levels 8-10  (Highlands,   tier II)
//
// Woodland Swarm and Beast Swarm are the starting-zone pair -- those are the
// two that belong in a level-1 practice pen. Highland Swarm is a LATER-REGION
// creature that happens to share the profile, and a level 8-10 skittish
// creature is perfectly legitimate; it is simply not starting-zone content.
// SOMET-289 picks its pen creatures from this set and must pick by level band,
// not by "it has the Skittish profile" -- dropping a Highland Swarm into a
// level-1 pen would put an 8-10 in front of a new player.
//
// behavior_id is set from a SUBSELECT on creature_behaviors.name, never a
// hardcoded id: a literal id is only correct in the one database it was read
// from, and this checkout points at the shared dev database, not a fixture
// one this migration could assume the shape of.
//
// PREVIOUS VALUE, for the down migration's auditability: verified directly
// against the live database before writing this migration --
//   SELECT e.name, e.behavior_id, b.name FROM entity_types e
//     LEFT JOIN creature_behaviors b ON b.id = e.behavior_id
//     WHERE e.name IN ('Woodland Swarm','Beast Swarm','Highland Swarm');
// returned behavior_id 1 ('Swarm') for all three rows -- expected, since
// every bestiary creature at the Swarm rung shares that one behaviour
// (gen-p4-bestiary.js sets `behavior_name: rung.name` for every row). down
// restores that by NAME ('Swarm'), not by the literal id 1, for the same
// portability reason the up migration resolves 'Skittish' by name.
exports.up = (pgm) => {
  pgm.sql(`
    UPDATE entity_types
    SET behavior_id = (SELECT id FROM creature_behaviors WHERE name = 'Skittish')
    WHERE name IN ('Woodland Swarm', 'Beast Swarm', 'Highland Swarm')
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE entity_types
    SET behavior_id = (SELECT id FROM creature_behaviors WHERE name = 'Swarm')
    WHERE name IN ('Woodland Swarm', 'Beast Swarm', 'Highland Swarm')
  `);
};
