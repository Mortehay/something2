/* eslint-disable camelcase */
// Affix expansion (Path of Exile 1 as the model). See seeds/data/affixTypes.js for what each column means.
//
//  * affix_types gains placement (prefix | suffix), allowed_tags (the item families it may roll on, [] = any) and
//    group_key (one affix per group on an item).
//  * the twelve original affixes keep their rows; they only get a placement and, where two affixes are the same
//    stat, a group, so they cooperate with the new ones.
//  * the new affixes are inserted fill-only (ON CONFLICT (key) DO NOTHING, sync_uuid by the seed-sync convention
//    md5('s2sync:affix_types:<key>')), so re-running this against a database that already has them, or has
//    edited them in the admin, changes nothing.
//
// Items that already dropped keep exactly the affixes they rolled: those rows reference affix_types by id and
// nothing here touches them.
exports.shorthands = undefined;

const { NEW_AFFIXES, LEGACY } = require('../seeds/data/affixTypes.js');

const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const arr = (a) => `ARRAY[${a.map(lit).join(', ')}]::text[]`;

exports.up = (pgm) => {
  pgm.addColumns('affix_types', {
    placement: { type: 'text', notNull: true, default: 'suffix' },
    allowed_tags: { type: 'text[]', notNull: true, default: '{}' },
    group_key: { type: 'text', notNull: false },
  });
  pgm.addConstraint('affix_types', 'affix_types_placement_check', "CHECK (placement IN ('prefix', 'suffix'))");

  for (const [key, v] of Object.entries(LEGACY)) {
    pgm.sql(`UPDATE affix_types SET placement = ${lit(v.placement)}, group_key = ${lit(v.group || null)}${v.weight ? `, weight = ${v.weight}` : ''} WHERE key = ${lit(key)}`);
  }

  for (const a of NEW_AFFIXES) {
    const first = a.tiers[0];
    const last = a.tiers[a.tiers.length - 1];
    pgm.sql(`INSERT INTO affix_types
               (key, label, kind, effect, min_value, max_value, min_item_level, max_item_level,
                allowed_slots, min_rarity, weight, placement, allowed_tags, group_key, sync_uuid)
             VALUES (${lit(a.key)}, ${lit(a.label)}, 'buff', ${lit(JSON.stringify(a.effect))}::jsonb,
                     ${first.min}, ${last.max}, ${first.ilvl}, NULL,
                     ${arr(a.slots)}, ${lit(a.rarity)}, ${a.weight}, ${lit(a.placement)}, ${arr(a.tags)}, ${lit(a.group)},
                     md5('s2sync:affix_types:' || ${lit(a.key)})::uuid)
             ON CONFLICT (key) DO NOTHING`);
  }
};

// What the originals weighed before this migration (migration 1714440507000), so down() restores them.
const ORIGINAL_WEIGHT = {
  of_might: 100, of_grace: 100, of_vigor: 100, of_insight: 100, of_clarity: 100, of_presence: 100,
  of_the_bear: 80, of_the_well: 80, flaming: 60, freezing: 60, warded: 60, cursed: 40,
};

exports.down = (pgm) => {
  for (const [key, weight] of Object.entries(ORIGINAL_WEIGHT)) pgm.sql(`UPDATE affix_types SET weight = ${weight} WHERE key = ${lit(key)}`);
  pgm.sql(`DELETE FROM affix_types WHERE key IN (${NEW_AFFIXES.map((a) => lit(a.key)).join(', ')})`);
  pgm.dropConstraint('affix_types', 'affix_types_placement_check');
  pgm.dropColumns('affix_types', ['placement', 'allowed_tags', 'group_key']);
};
