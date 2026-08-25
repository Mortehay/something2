exports.shorthands = undefined;

// Level cap 50 -> 150, the new XP curve, and the removal of the stat-point
// system (design doc sections 3.2, 3.3, 4).
//
// THE FLOOR TABLE IS EMBEDDED, NOT REQUIRED FROM playerStats.js. A migration
// must replay identically forever; importing the live service would make this
// backfill re-level characters differently the day the curve is retuned. The
// 150 numbers below are generated from round(18 * L^1.33) at authoring time
// and then frozen.
const XP_BASE = 18;
const XP_EXPONENT = 1.33;
const PASSIVE_POINTS_PER_LEVEL = 1; // game_settings.passive_points_per_level's
// default. Read as a literal, not from the table: the backfill must not depend
// on a value an admin can change between two runs of the same migration.

const MAX_LEVEL = 150;
const FLOORS = (() => {
  const out = [null, 0];
  for (let l = 2; l <= MAX_LEVEL; l++) {
    out[l] = out[l - 1] + Math.round(XP_BASE * Math.pow(l - 1, XP_EXPONENT));
  }
  return out;
})();

exports.up = (pgm) => {
  // 1. The new points column, before anything reads or writes it.
  pgm.addColumns('player_progression', {
    passive_points: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.addConstraint('player_progression', 'player_progression_passive_points_check',
    'CHECK (passive_points >= 0)');

  // 2. Raise the cap BEFORE re-levelling, or a character who re-levels above
  //    50 violates the old constraint mid-migration.
  pgm.dropConstraint('player_progression', 'player_progression_level_check');
  pgm.addConstraint('player_progression', 'player_progression_level_check',
    `CHECK (level >= 1 AND level <= ${MAX_LEVEL})`);

  // 3. Re-level every character from its RAW experience. Experience is never
  //    touched -- what a player earned they keep; only the level the curve
  //    maps it to changes.
  const floorRows = [];
  for (let l = 1; l <= MAX_LEVEL; l++) floorRows.push(`(${l}, ${FLOORS[l]})`);
  pgm.sql(`
    UPDATE player_progression p
       SET level = (
             SELECT max(f.level) FROM (VALUES ${floorRows.join(',')}) AS f(level, xp_floor)
              WHERE f.xp_floor <= p.experience
           )
  `);

  // 4. Grant passive points, THEN reset the stat columns. Order matters twice:
  //    the grant reads the NEW level from step 3, and it reads the stat
  //    columns before step 5 flattens them.
  //
  //    Per the design doc: passive_points_per_level x (level - 1), plus every
  //    stat point previously ALLOCATED above the base, plus whatever was still
  //    unspent. The unspent term is included so a character who levelled but
  //    never opened the sheet is not silently poorer than one who did.
  pgm.sql(`
    UPDATE player_progression
       SET passive_points = passive_points
             + GREATEST(level - 1, 0) * ${PASSIVE_POINTS_PER_LEVEL}
             + (strength - 5) + (dexterity - 5) + (constitution - 5)
             + (intelligence - 5) + (wisdom - 5) + (charisma - 5)
             + stat_points,
           updated_at = now()
  `);

  // 5. The six stat columns become a class-base snapshot (design doc 3.3).
  //    Every character alive today was created with all six at the base, and
  //    nothing but the now-deleted allocateStat ever raised them, so the base
  //    IS 5 for every existing row.
  //
  //    THE BASE IS 5 FOR EVERY CLASS, DELIBERATELY (contract 6.1). Copying
  //    entity_types' stats in here instead -- Warrior 10s, Ranger DEX 12 --
  //    would silently rebalance every character in the database: every formula
  //    in playerStats.js is an identity at BASE_STAT, so a CON of 10 makes
  //    maxHp = 100 + 10*(10-5) = 150, i.e. +50 max HP for everyone, with no
  //    test noticing. Class identity comes from the tree start position and
  //    the starting loadout, not from different base stats. Per-class bases
  //    are a future revision's problem; the column exists so that revision can
  //    happen without retroactively changing characters that already exist.
  pgm.sql(`
    UPDATE player_progression
       SET strength = 5, dexterity = 5, constitution = 5,
           intelligence = 5, wisdom = 5, charisma = 5
  `);

  // 6. Now the old column can go, along with its CHECK.
  pgm.dropConstraint('player_progression', 'player_progression_points_check');
  pgm.dropColumns('player_progression', ['stat_points']);
};

// LOSSY BY DESIGN. Re-levelling and the stat reset cannot be undone: the
// pre-migration level was a function of a curve this file replaced, and the
// allocation that produced each stat column is not recorded anywhere. `down`
// restores the SHAPE (so a bad deploy can be unwound) by recomputing the old
// linear level from the same untouched experience and returning the passive
// points as stat points; it does not restore anyone's exact allocation.
exports.down = (pgm) => {
  pgm.addColumns('player_progression', {
    stat_points: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.sql('UPDATE player_progression SET stat_points = passive_points');
  pgm.addConstraint('player_progression', 'player_progression_points_check',
    'CHECK (stat_points >= 0)');

  // Old curve: xpToNext(L) = 100 * L, so the floor is 100*(L-1)*L/2 and the
  // level is the greatest L <= 50 whose floor is <= experience.
  const oldRows = [];
  for (let l = 1; l <= 50; l++) oldRows.push(`(${l}, ${(100 * (l - 1) * l) / 2})`);
  pgm.sql(`
    UPDATE player_progression p
       SET level = (
             SELECT max(f.level) FROM (VALUES ${oldRows.join(',')}) AS f(level, xp_floor)
              WHERE f.xp_floor <= p.experience
           )
  `);

  pgm.dropConstraint('player_progression', 'player_progression_level_check');
  pgm.addConstraint('player_progression', 'player_progression_level_check',
    'CHECK (level >= 1 AND level <= 50)');

  pgm.dropConstraint('player_progression', 'player_progression_passive_points_check');
  pgm.dropColumns('player_progression', ['passive_points']);
};
