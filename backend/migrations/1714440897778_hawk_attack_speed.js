/* eslint-disable camelcase */

// "of the Hawk" (a ranged-weapon suffix) said "+N% Attack Speed" but applied castSpeedMult, the
// spell-cast rule, so on a bow it did nothing it claimed and duplicated the Savant. It is the ranged
// counterpart of "of Celerity" (same group, so the two never stack), so it applies attackSpeedMult.
// seeds/data/affixTypes.js carries the same change for fresh databases.

exports.up = (pgm) => {
  pgm.sql(`UPDATE affix_types SET effect = jsonb_set(effect, '{rule}', '"attackSpeedMult"')
            WHERE key = 'of_the_hawk' AND effect ->> 'rule' = 'castSpeedMult';`);
};

exports.down = (pgm) => {
  pgm.sql(`UPDATE affix_types SET effect = jsonb_set(effect, '{rule}', '"castSpeedMult"')
            WHERE key = 'of_the_hawk' AND effect ->> 'rule' = 'attackSpeedMult';`);
};
