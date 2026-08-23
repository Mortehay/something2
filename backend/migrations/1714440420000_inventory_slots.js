// Per-CHARACTER carry limit. A column rather than a constant because the cap
// is meant to grow (bags, class perks) without a schema change and without a
// second source of truth: authority/items.js reads this value and nothing
// else. 48 matches the inventory panel's page size, so a default-capacity
// character is exactly one page.
exports.up = (pgm) => {
  pgm.addColumn('characters', {
    inventory_slots: { type: 'integer', notNull: true, default: 48 },
  });
  pgm.addConstraint('characters', 'characters_inventory_slots_positive',
    'CHECK (inventory_slots > 0)');
};

exports.down = (pgm) => {
  pgm.dropConstraint('characters', 'characters_inventory_slots_positive');
  pgm.dropColumn('characters', 'inventory_slots');
};
