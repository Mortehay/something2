exports.shorthands = undefined;

// The three playable classes, plus the per-class starting loadout that
// replaces items.js's hardcoded STARTING_LOADOUT.
//
// WARRIOR IS AN EXACT STAT CLONE OF 'Player' (1714440006000). This is not a
// stylistic choice: the next migration backfills every existing player's state
// onto a Warrior character, so any deviation here silently rebalances every
// account that exists today. Warrior is therefore defined as a SELECT from the
// Player row rather than a literal copy of its numbers -- a literal copy is a
// second source of truth that can drift from the row it is supposed to match.
// Ranger and Mage deviate, and they deviate from Warrior.
//
// The legacy 'Player' row stays (other code references it) but is marked
// not-playable so it cannot be chosen at character creation.

// name -> the deltas applied on top of the Player clone. Anything absent is
// inherited unchanged.
const CLASS_DELTAS = [
  { name: 'Warrior', color: '#b03a2e', set: {} },
  { name: 'Ranger',  color: '#1e8449', set: { hp: 85, max_hp: 85, dexterity: 12 } },
  { name: 'Mage',    color: '#5b2c94', set: { hp: 75, max_hp: 75, intelligence: 12, mana: 70, max_mana: 70 } },
];

// class name -> [[item_types.name, quantity], ...]. Every item name here is
// verified to exist in the catalog: there is no shield in item_types (no
// off_hand item exists at all), so the Warrior carries a one-handed sword and
// armour rather than the sword+shield a fantasy default would suggest.
const CLASS_LOADOUTS = {
  Warrior: [['short sword', 1], ['leather-vest', 1]],
  Ranger:  [['bow', 1], ['arrow', 20], ['leather-vest', 1]],
  Mage:    [['apprentice staff', 1], ['arcane-ward', 1]],
};

const INHERITED_COLUMNS = [
  'strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma',
  'hp', 'max_hp', 'hp_regen_rate', 'mana', 'max_mana', 'mana_regen_rate',
];

// Column expression for the SELECT-from-Player below: the class's override if
// it has one, otherwise the inherited value from the Player row.
function col(name, set) {
  return Object.prototype.hasOwnProperty.call(set, name) ? String(set[name]) : `p.${name}`;
}

exports.up = (pgm) => {
  pgm.addColumns('entity_types', {
    is_playable: { type: 'boolean', notNull: true, default: false },
  });

  for (const cls of CLASS_DELTAS) {
    pgm.sql(`
      INSERT INTO entity_types (
        name, color, walkable, spawn_tiles, chance, is_playable,
        ${INHERITED_COLUMNS.join(', ')}
      )
      SELECT
        '${cls.name}', '${cls.color}', p.walkable, p.spawn_tiles, 0, true,
        ${INHERITED_COLUMNS.map((c) => col(c, cls.set)).join(', ')}
      FROM entity_types p WHERE p.name = 'Player'
      ON CONFLICT (name) DO NOTHING
    `);
  }

  // Belt and braces: if this migration ever runs against a database whose
  // 'Player' row is missing, the SELECTs above insert nothing and the next
  // migration's backfill would fail on a missing Warrior. Fail here, loudly,
  // rather than three files later.
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM entity_types WHERE name = 'Warrior') THEN
        RAISE EXCEPTION 'Warrior was not created: the Player entity type is missing';
      END IF;
    END $$;
  `);

  pgm.createTable('class_loadouts', {
    id: 'id',
    entity_type_id: { type: 'integer', notNull: true, references: 'entity_types', onDelete: 'CASCADE' },
    item_type_id: { type: 'integer', notNull: true, references: 'item_types', onDelete: 'CASCADE' },
    quantity: { type: 'integer', notNull: true, default: 1 },
  });
  pgm.addConstraint('class_loadouts', 'class_loadouts_quantity_check', 'CHECK (quantity >= 1)');
  // One row per (class, item): a duplicate would silently double a grant.
  pgm.addConstraint('class_loadouts', 'class_loadouts_unique', { unique: ['entity_type_id', 'item_type_id'] });

  for (const [className, rows] of Object.entries(CLASS_LOADOUTS)) {
    for (const [itemName, qty] of rows) {
      // Guarded by the join: a catalog missing this item inserts nothing
      // rather than failing the whole migration on a NULL fk.
      pgm.sql(`
        INSERT INTO class_loadouts (entity_type_id, item_type_id, quantity)
        SELECT e.id, i.id, ${qty}
          FROM entity_types e, item_types i
         WHERE e.name = '${className}' AND i.name = '${itemName.replace(/'/g, "''")}'
        ON CONFLICT (entity_type_id, item_type_id) DO NOTHING
      `);
    }
  }
};

exports.down = (pgm) => {
  pgm.dropTable('class_loadouts');
  pgm.sql("DELETE FROM entity_types WHERE name IN ('Warrior', 'Ranger', 'Mage')");
  pgm.dropColumns('entity_types', ['is_playable']);
};

exports.CLASS_DELTAS = CLASS_DELTAS;
exports.CLASS_LOADOUTS = CLASS_LOADOUTS;
