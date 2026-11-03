exports.shorthands = undefined;

// Skill gems become SERVER state.
//
// Until now buying a gem only subtracted gold in the browser and remembered the skill
// in localStorage: the server never knew who owned what, so gold could be duplicated by
// reloading, and any skill could be cast by editing a key in the browser. This table is
// the record of what a character has actually bought.
//
// `characters.gems_imported` guards a ONE-TIME import of the gems players already hold
// in their browsers (see authority/gems.js importLegacyGems): a character may claim its
// old local list exactly once, and only the gems it currently qualifies for are granted.

exports.up = (pgm) => {
  pgm.createTable('character_gems', {
    character_id: { type: 'integer', notNull: true, references: 'characters', onDelete: 'CASCADE' },
    skill_id: { type: 'text', notNull: true },
    // What was paid, 0 for a gem granted by the legacy import. Kept for support and for
    // any future refund rule; nothing reads it in play.
    price_paid: { type: 'integer', notNull: true, default: 0 },
    acquired_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  }, {
    constraints: { primaryKey: ['character_id', 'skill_id'] },
  });
  pgm.addConstraint('character_gems', 'character_gems_price_check', 'CHECK (price_paid >= 0)');

  pgm.addColumns('characters', {
    gems_imported: { type: 'boolean', notNull: true, default: false },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('characters', ['gems_imported']);
  pgm.dropTable('character_gems');
};
