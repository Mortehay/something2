/* eslint-disable camelcase */
exports.shorthands = undefined;

// SOMET-478 (progression epic, Group D / T10). Equipment gains a level gate
// and one gate per stat.
//
// Every default is the IDENTITY value, not a ladder value: the live catalog
// already carries weapons, armor and stones, plus whatever an admin authored,
// and a non-identity default would retroactively make somebody's equipped gear
// illegal the moment this migration ran. The base gear ladder (T11) sets real
// numbers on the rows it inserts; nothing here changes an existing row.
const REQ_STATS = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];

exports.up = (pgm) => {
  pgm.addColumns('item_types', {
    req_level: { type: 'integer', notNull: true, default: 1 },
    item_level: { type: 'integer', notNull: true, default: 1 },
    tier: { type: 'smallint', notNull: true, default: 1 },
    ...Object.fromEntries(REQ_STATS.map((s) => [`req_${s}`, { type: 'integer', notNull: true, default: 0 }])),
  });

  // 150 is MAX_LEVEL (progressionConstants.js, raised by T2). A req_level of 0
  // is meaningless and a req_level above the cap is unwearable by anyone --
  // both are authoring mistakes that must fail on write, not at equip time.
  pgm.addConstraint('item_types', 'item_types_req_level_check',
    'CHECK (req_level >= 1 AND req_level <= 150)');
  pgm.addConstraint('item_types', 'item_types_req_stats_check',
    `CHECK (${REQ_STATS.map((s) => `req_${s} >= 0`).join(' AND ')})`);
  pgm.addConstraint('item_types', 'item_types_item_level_check',
    'CHECK (item_level >= 1 AND item_level <= 150)');
  pgm.addConstraint('item_types', 'item_types_tier_check',
    'CHECK (tier >= 1 AND tier <= 10)');
};

exports.down = (pgm) => {
  pgm.dropConstraint('item_types', 'item_types_tier_check');
  pgm.dropConstraint('item_types', 'item_types_item_level_check');
  pgm.dropConstraint('item_types', 'item_types_req_stats_check');
  pgm.dropConstraint('item_types', 'item_types_req_level_check');
  pgm.dropColumns('item_types', ['req_level', 'item_level', 'tier', ...REQ_STATS.map((s) => `req_${s}`)]);
};
