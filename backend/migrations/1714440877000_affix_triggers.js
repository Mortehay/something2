/* eslint-disable camelcase */
// Trigger affixes (on-hit ignite/chill/shock, on-kill restores and buffs, when-hit ward and heal). Same shape and the
// same fill-only rule as 1714440876000: ON CONFLICT (key) DO NOTHING, sync_uuid by the seed-sync convention.
exports.shorthands = undefined;

const { TRIGGER_AFFIXES } = require('../seeds/data/affixTypes.js');

const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const arr = (a) => `ARRAY[${a.map(lit).join(', ')}]::text[]`;

exports.up = (pgm) => {
  for (const a of TRIGGER_AFFIXES) {
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

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM affix_types WHERE key IN (${TRIGGER_AFFIXES.map((a) => lit(a.key)).join(', ')})`);
};
