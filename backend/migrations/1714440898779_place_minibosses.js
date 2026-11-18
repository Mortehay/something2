/* eslint-disable camelcase */

// Put minibosses into the worlds that already exist. New and re-rolled worlds get them from population
// (services/minibossPool.js: a family's Line brings that family's minibosses at a low weight), but a world
// already seeded keeps its creatures until re-rolled and respawns each creature as what it was, so no
// miniboss would ever have appeared in the live data. This promotes a small, stable share of the plain
// "<Family> Line" creatures to their family's miniboss (an Elite one in the worlds named "Elite"/"End"),
// at the creature's own level, with hp / damage / defense scaled from the miniboss row.
//
// The share is chosen by a hash of the creature id, so running it twice, or on a copy, picks the same
// creatures; and only wild creatures (no home post, no portal to guard) are touched.

const { scaleCreature } = require('../src/services/creatureLevel');

const SHARE_PERCENT = 2;        // of the Line creatures in a world
const ELITE_SHARE_PERCENT = 1;  // of those worlds' Line creatures, an Elite miniboss where the family has one
const CREATURE_BASE_DAMAGE = 5; // mapService.CREATURE_BASE_DAMAGE

exports.up = async (pgm) => {
  const db = pgm.db;
  const minis = (await db.query(
    `SELECT name, hp, defense FROM entity_types WHERE is_creature = true AND boss_tier = 'miniboss'`)).rows;
  const byName = new Map(minis.map((m) => [m.name, m]));

  const lines = (await db.query(
    `SELECT wc.id, wc.type, wc.level, w.name AS world_name
       FROM world_creatures wc JOIN worlds w ON w.id = wc.world_id
      WHERE wc.type LIKE '% Line' AND wc.home_x IS NULL AND wc.blocks_portal_id IS NULL
        AND wc.charmed_by_character_id IS NULL`)).rows;

  let promoted = 0;
  for (const row of lines) {
    const family = row.type.replace(/ Line$/, '');
    // A stable 0..99 bucket from the id: same creatures every time.
    const bucket = Number(BigInt('0x' + String(row.id).replace(/-/g, '').slice(0, 12)) % 100n);
    if (bucket >= SHARE_PERCENT) continue;
    const elite = byName.get(`${family} Elite Miniboss`);
    const plain = byName.get(`${family} Miniboss`);
    const wantElite = elite && (bucket < ELITE_SHARE_PERCENT) && /Elite|End/.test(row.world_name);
    const target = wantElite ? elite : plain;
    if (!target) continue;
    const scaled = scaleCreature(
      { hp: target.hp || 10, damage: CREATURE_BASE_DAMAGE, defense: Number(target.defense ?? 0) || 0 }, Number(row.level) || 1);
    await db.query(
      'UPDATE world_creatures SET type = $2, hp = $3, damage = $4, defense = $5 WHERE id = $1',
      [row.id, target.name, scaled.hp, scaled.damage, scaled.defense],
    );
    promoted += 1;
  }
  console.log(`minibosses: promoted ${promoted} of ${lines.length} Line creatures`);
};

// Back to the plain Line of the family (a miniboss is "<Family> Miniboss" / "<Family> Elite Miniboss").
exports.down = async (pgm) => {
  await pgm.db.query(
    `UPDATE world_creatures SET type = regexp_replace(type, ' (Elite )?Miniboss$', ' Line')
      WHERE type ~ ' (Elite )?Miniboss$' AND home_x IS NULL AND blocks_portal_id IS NULL`);
};
