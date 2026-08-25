exports.shorthands = undefined;

// SOMET-471 (Progression B1) -- six playable classes, one per stat column in
// player_progression, plus entity_types.main_stat and the four new loadouts.
//
// SLOT. The B-group plan assigns this migration `1714440502000`. That slot is
// unused, but it is no longer USABLE: 1714440504000 (C1), ...505000 (D1),
// ...506000 (D2) and ...509000 (SOMET-486) have merged and been applied since
// the plan was written, and node-pg-migrate's checkOrder zips the run list
// positionally against the filenames and refuses outright --
//
//   Not run migration 1714440502000_six_classes_main_stat is preceding
//   already run migration 1714440504000_passive_tree
//
// -- on every database that has them, which is every database that is not
// brand new. scripts/repair-migration-order.js deliberately does not fix this
// case (it repairs the LEDGER, and here the ledger is right: this migration
// genuinely has not run), and `--no-check-order` would silence the real check
// along with it. So the slot moves forward to the next free one above the
// highest applied migration. A plan's reserved slot is a claim on a name, not
// a guarantee that the name still sorts last by the time the work lands.
//
// SECOND SOURCE OF TRUTH, READ THIS FIRST. Everything this file inserts is
// ALSO authored in backend/seeds/data/entityTypes.js (PLAYABLE_CLASSES and
// CLASS_LOADOUTS). That file is not documentation: seed-catalogs.js restores a
// class row that has gone missing from it, and playable_classes_db.test.js
// DELETES a class row mid-run and asserts the seeder puts it back. A change
// made here and not there is silently undone the next time a volume is
// rebuilt or that test runs -- SOMET-486 hit exactly this. The two files must
// agree on every column, and each one's header points at the other.
//
// RANGER IS KEPT AND DEMOTED, NEVER RENAMED INTO ARCHER. characters
// .entity_type_id is a plain reference with no ON DELETE (1714440092000), so
// live characters point straight at the Ranger row; renaming it would leave
// those characters playing a class whose stats, pools and starting loadout are
// not the ones they rolled, silently and with nothing to notice it. The legacy
// 'Player' row was handled exactly this way by 1714440091000 -- kept, marked
// not-playable -- and this follows that precedent rather than inventing a
// second one. is_playable gates character CREATION only (services/characters
// .js createCharacter), so every existing Ranger keeps playing exactly as
// before; they simply cannot be rolled fresh.
//
// main_stat is the passive tree's start position (spec 5.2), NULL for anything
// not playable -- which is every creature, the legacy 'Player' row, and the
// demoted Ranger. Note that services/passiveTreeStore.js resolves a start node
// through entity_types.NAME rather than through this column, deliberately, so
// nothing in Group C depends on it.
//
// ============================ THE POOL NUMBERS ============================
//
// Contract 6.11 splits class identity in two, and the split is strict:
//
//   OPTION 1 -- NUMBERS. A class's max_hp/max_mana live here, in entity_types,
//               and reach the game through characters.js's classPoolsFromRow.
//   OPTION 3 -- RULES.   A class's MECHANICAL identity (the Cultist's life-cost
//               affinity, the Druid's charm affinity) is granted by its
//               passive-tree start node, in seeds/data/passiveTree.js.
//
// Keeping them apart is what stops class identity being paid for twice. No
// number below is a payment for a rule, and no start node grants a pool.
//
// The budget is inherited from SOMET-486 (migration 1714440509000), which
// authored the three existing classes and is FROZEN here:
//
//     Warrior  100 hp / 100 mana  = 200   (frozen: every pre-486 character is
//                                          a Warrior and already has 100/100)
//     Ranger    85 hp / 115 mana  = 200   (frozen, and now not playable)
//     Mage      75 hp / 150 mana  = 225   (frozen)
//
// 486's rule, restated: a class trades HP for mana at par on a 200-point
// budget, and a class whose damage output is GATED ON SPENDING MANA gets +25,
// because mana is spent to act every fight while HP is only lost on being hit.
// The four new classes are authored against that, not against the pre-486
// entity_types values:
//
//   Monk      90 hp / 110 mana  = 200.  Ten HP traded for ten mana at par, on
//     the baseline budget. NOT given the caster premium even though it casts:
//     the Monk's identity is mana REGENERATION, and a class that refills its
//     pool faster is paid in throughput, not in pool size. Paying it in both
//     is the double-count 6.11 exists to prevent.
//
//   Cultist  110 hp / 90 mana   = 200.  The highest HP in the game, ten above
//     Warrior, traded for ten mana at par. Its life-cost casting is a START
//     NODE RULE, so this row is neither charged nor paid for it: a Cultist
//     with a discounted pool would be paying for its own identity, and one
//     with an inflated pool would be paid for it twice. The high HP is here
//     for a plainer reason -- CON is its main stat, and CON is the stat that
//     buys max HP, so the class whose sector is CON should start deepest in
//     the pool its sector deepens.
//
//   Archer    85 hp / 115 mana  = 200.  Ranger's pools, to the point. Archer
//     is the DEX archetype made playable again in Ranger's place; giving the
//     successor different numbers to the row it replaces would silently
//     rebalance the archetype under the players already living in it, which is
//     the same hazard the rename-refusal above is about.
//
//   Druid     90 hp / 135 mana  = 225.  The caster premium, the same +25 the
//     Mage has, because charm is a cast and a Druid with an empty pool has no
//     class. It sits 15 HP above the Mage and 15 mana below it -- the same
//     par trade 486 used for Ranger, applied along the 225 line rather than
//     the 200 one -- because a Druid fights beside a charmed creature rather
//     than alone at range, so it takes hits the Mage does not.
//
// All six land on distinct (hp, mana) pairs on purpose: identical pools are
// exactly the state SOMET-486 found the game in (100/100 for everybody), and
// class_pools_db.test.js asserts the six are distinct so that state cannot
// come back unnoticed.
//
// WHAT IS DELIBERATELY *NOT* TUNED HERE:
//
//   * The six stat columns. Each new class raises its own main stat to 12 and
//     leaves the other five at Warrior's 10, purely so the picker shows a
//     class's flavour. These columns are DISPLAY ONLY for a player:
//     createCharacter (services/characters.js) snapshots every class at
//     BASE_STAT on all six columns, deliberately, so class identity comes from
//     the tree and the loadout rather than from a different starting stat line.
//
//   * mana_regen_rate. The Monk is the "regenerates mana fastest" class and
//     the obvious move is to double this column for it. It would be INERT:
//     playerStats.js derives a player's manaRegen from MANA_REGEN_BASE and
//     wisdom, and has never read entity_types.mana_regen_rate. Writing a
//     number into a column nothing consults is how entity_types.max_mana sat
//     dead from SOMET-242 to SOMET-486. The Monk's regen identity is therefore
//     a start-node rule grant, in seeds/data/passiveTree.js, where it can
//     actually be consumed.

const STAT_NAMES = [
  'strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma',
];

// Expressed as deltas on top of the WARRIOR row, exactly as 1714440091000
// expressed Ranger and Mage as deltas on top of 'Player': a literal copy of
// the twelve inherited columns would be a second source of truth free to drift
// from the row it is supposed to match. `hp`/`mana` are written alongside
// `max_hp`/`max_mana` because these rows are TEMPLATES, and a template whose
// current pool disagrees with its max is a trap for the next reader even
// though nothing reads the current pool today (1714440509000 says the same).
const NEW_CLASSES = [
  {
    name: 'Monk', color: '#8e6b2f', mainStat: 'wisdom',
    set: { hp: 90, max_hp: 90, mana: 110, max_mana: 110, wisdom: 12 },
  },
  {
    name: 'Cultist', color: '#7b1f3a', mainStat: 'constitution',
    set: { hp: 110, max_hp: 110, mana: 90, max_mana: 90, constitution: 12 },
  },
  {
    name: 'Archer', color: '#1e8449', mainStat: 'dexterity',
    set: { hp: 85, max_hp: 85, mana: 115, max_mana: 115, dexterity: 12 },
  },
  {
    name: 'Druid', color: '#2f7d5b', mainStat: 'charisma',
    set: { hp: 90, max_hp: 90, mana: 135, max_mana: 135, charisma: 12 },
  },
];

// class name -> [[item_types.name, quantity], ...]. Every name here exists in
// the catalog (1714440017000 and 1714440019000): 'stick', 'club', 'apprentice
// staff', 'bow', 'arrow' and 'leather-vest'. There is still no off_hand item
// in item_types at all, so nobody gets a shield. The INSERTs below cross-join
// on these names and insert nothing if either side is missing, so a typo here
// is a class with no gear rather than a failed migration -- which is why
// six_classes_db.test.js asserts the resolved join, not the row count.
const CLASS_LOADOUTS = {
  Monk: [['stick', 1], ['leather-vest', 1]],
  Cultist: [['apprentice staff', 1], ['leather-vest', 1]],
  Archer: [['bow', 1], ['arrow', 20], ['leather-vest', 1]],
  Druid: [['club', 1], ['leather-vest', 1]],
};

const INHERITED_COLUMNS = [
  'strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma',
  'hp', 'max_hp', 'hp_regen_rate', 'mana', 'max_mana', 'mana_regen_rate',
];

// Column expression for the SELECT-from-Warrior below: the class's override if
// it has one, otherwise the inherited value from the Warrior row.
function col(name, set) {
  return Object.prototype.hasOwnProperty.call(set, name) ? String(set[name]) : `w.${name}`;
}

exports.up = (pgm) => {
  pgm.addColumns('entity_types', { main_stat: { type: 'text' } });
  pgm.addConstraint('entity_types', 'entity_types_main_stat_check',
    `CHECK (main_stat IS NULL OR main_stat IN (${STAT_NAMES.map((s) => `'${s}'`).join(', ')}))`);

  pgm.sql("UPDATE entity_types SET main_stat = 'strength'     WHERE name = 'Warrior'");
  pgm.sql("UPDATE entity_types SET main_stat = 'intelligence' WHERE name = 'Mage'");
  // Ranger keeps a NULL main_stat: it has no tree start position because it is
  // no longer a class anyone can roll, and Archer holds the DEX sector.
  pgm.sql("UPDATE entity_types SET is_playable = false WHERE name = 'Ranger'");

  for (const cls of NEW_CLASSES) {
    pgm.sql(`
      INSERT INTO entity_types (
        name, color, walkable, spawn_tiles, chance, is_playable, main_stat,
        ${INHERITED_COLUMNS.join(', ')}
      )
      SELECT
        '${cls.name}', '${cls.color}', w.walkable, w.spawn_tiles, 0, true, '${cls.mainStat}',
        ${INHERITED_COLUMNS.map((c) => col(c, cls.set)).join(', ')}
      FROM entity_types w WHERE w.name = 'Warrior'
      ON CONFLICT (name) DO NOTHING
    `);
  }

  // Belt and braces, in the shape 1714440091000 and 1714440509000 already use.
  // A database whose Warrior row is missing would make every SELECT above
  // insert nothing, and the failure would surface much later as an empty class
  // picker rather than here.
  pgm.sql(`
    DO $$
    DECLARE n integer;
    BEGIN
      SELECT count(*) INTO n FROM entity_types WHERE is_playable = true;
      IF n <> 6 THEN
        RAISE EXCEPTION 'expected exactly 6 playable classes, found %', n;
      END IF;
      SELECT count(*) INTO n FROM entity_types WHERE is_playable = true AND main_stat IS NULL;
      IF n <> 0 THEN
        RAISE EXCEPTION '% playable class(es) have no main_stat', n;
      END IF;
    END $$;
  `);

  for (const [className, rows] of Object.entries(CLASS_LOADOUTS)) {
    for (const [itemName, qty] of rows) {
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

// The four new rows are deleted rather than demoted: nothing predates them, so
// unlike Ranger there is no character to protect. If one HAS been rolled the
// characters_entity_type_id_fkey refuses the delete, loudly, which is the
// constraint doing its job -- a down migration must not orphan a character.
// class_loadouts rows cascade with the entity_types row.
exports.down = (pgm) => {
  pgm.sql("DELETE FROM entity_types WHERE name IN ('Monk', 'Cultist', 'Archer', 'Druid')");
  pgm.sql("UPDATE entity_types SET is_playable = true WHERE name = 'Ranger'");
  pgm.dropConstraint('entity_types', 'entity_types_main_stat_check');
  pgm.dropColumns('entity_types', ['main_stat']);
};

exports.NEW_CLASSES = NEW_CLASSES;
exports.CLASS_LOADOUTS = CLASS_LOADOUTS;
