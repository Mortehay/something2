/* eslint-disable camelcase */
exports.shorthands = undefined;

// SOMET-480 (progression epic, Group D / T12). Per-instance rarity and rolled
// affixes.
//
// WHY world_items CARRIES A DENORMALISED COPY. dropItem (authority/loot.js)
// DELETEs the player_items row and INSERTs a world_items row; claimItem
// INSERTs a BRAND NEW player_items row from it. Without carried columns, a
// rolled foxy item comes back white on any drop-and-repick. The stone system
// hit the same wall and resolved it by REFUSING to drop stones, which is not
// an option for ordinary gear. A denormalised copy is acceptable here
// precisely because the row's maximum lifetime is 180 seconds (T14) and
// nothing else joins to it.
//
// soulbound rides the same path, and REPLACES the outright drop refusal
// loot.js currently applies to bound gear: the refusal existed only because
// world_items had nowhere to put the flag. Carrying it is strictly better --
// starting gear becomes droppable again without becoming launderable.

const RARITIES = ['white', 'blue', 'yellow', 'foxy'];

// The six stat columns player_progression carries. Every affix below whose
// effect is {type:'stat'} must name one of these, or it is a live catalog row
// that grants a stat nobody has -- inert, and silently so. Enforced below.
const STATS = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];

// The slot vocabulary items.js's SLOTS defines. An allowed_slots entry outside
// it can never match, so it would make the affix unrollable.
const SLOTS = ['main_hand', 'off_hand', 'head', 'chest', 'hands', 'feet', 'ring1', 'ring2'];

// Status riders authority/effects.js actually governs. A debuff naming
// anything else would be inert; a debuff naming SHOCK would be a
// permanent-lock exploit unless it went through applyShockInterrupt's
// non-refreshing immunity window, which a passive weapon rider does not.
const SAFE_DEBUFF_STATUSES = ['burn', 'chill'];

// [key, label, kind, effect, min_value, max_value, min_item_level, max_item_level, allowed_slots, min_rarity, weight]
const AFFIXES = [
  ['of_might',    'of Might',    'buff', { type: 'stat', stat: 'strength' },     1, 12, 1, null, [], 'blue', 100],
  ['of_grace',    'of Grace',    'buff', { type: 'stat', stat: 'dexterity' },    1, 12, 1, null, [], 'blue', 100],
  ['of_vigor',    'of Vigor',    'buff', { type: 'stat', stat: 'constitution' }, 1, 12, 1, null, [], 'blue', 100],
  ['of_insight',  'of Insight',  'buff', { type: 'stat', stat: 'intelligence' }, 1, 12, 1, null, [], 'blue', 100],
  ['of_clarity',  'of Clarity',  'buff', { type: 'stat', stat: 'wisdom' },       1, 12, 1, null, [], 'blue', 100],
  ['of_presence', 'of Presence', 'buff', { type: 'stat', stat: 'charisma' },     1, 12, 1, null, [], 'blue', 100],
  ['of_the_bear', 'of the Bear', 'buff', { type: 'resource', pool: 'hp' },   5, 60, 10, null, ['chest', 'head', 'feet'], 'blue', 80],
  ['of_the_well', 'of the Well', 'buff', { type: 'resource', pool: 'mana' }, 5, 60, 10, null, ['ring1', 'ring2', 'off_hand'], 'blue', 80],
  ['flaming',     'Flaming',     'buff', { type: 'damage', element: 'fire' }, 1, 25, 20, null, ['main_hand'], 'yellow', 60],
  ['freezing',    'Freezing',    'buff', { type: 'damage', element: 'ice' },  1, 25, 20, null, ['main_hand'], 'yellow', 60],
  ['warded',      'Warded',      'buff', { type: 'resist', element: 'arcane' }, 0.02, 0.25, 20, null, ['chest', 'head', 'off_hand'], 'yellow', 60],
  // The ONE debuff. It rides the existing status system in
  // authority/effects.js, which supplies refresh-not-stack semantics and the
  // anti-chain-lock immunity window; a new debuff kind that does not obey
  // those becomes a permanent-lock exploit. 'chill' is chosen because it is
  // already an authored status with those guarantees AND because it only
  // SLOWS -- it does not remove control, which is the property effects.js's
  // header says refresh semantics cannot safely carry.
  ['cursed',      'Cursed',      'debuff', { type: 'status', status: 'chill' }, 1, 4, 40, null, ['main_hand'], 'foxy', 40],
];

// Authoring guard, run at migration time rather than left to a comment: a
// typo'd stat, slot or status here would seed a catalog row that looks alive
// and can never do anything.
function assertCatalogSane() {
  const seen = new Set();
  for (const [key, label, kind, effect, minV, maxV, minL, maxL, slots, minR] of AFFIXES) {
    if (seen.has(key)) throw new Error(`duplicate affix key '${key}'`);
    seen.add(key);
    if (!label) throw new Error(`affix '${key}' has no label`);
    if (kind !== 'buff' && kind !== 'debuff') throw new Error(`affix '${key}' has kind '${kind}'`);
    if (maxV < minV) throw new Error(`affix '${key}' has max_value < min_value`);
    if (minL < 1) throw new Error(`affix '${key}' has min_item_level < 1`);
    if (maxL != null && maxL < minL) throw new Error(`affix '${key}' has max_item_level < min_item_level`);
    for (const s of slots) if (!SLOTS.includes(s)) throw new Error(`affix '${key}' names unknown slot '${s}'`);
    if (effect.type === 'stat' && !STATS.includes(effect.stat)) {
      throw new Error(`affix '${key}' grants unknown stat '${effect.stat}'`);
    }
    if (kind === 'debuff') {
      // 'white' is not admissible anywhere (see the CHECK below), and a debuff
      // that is not foxy-authored contradicts spec 6.1 at the catalog level
      // even though authority/affixes.js refuses it again at roll time.
      if (minR !== 'foxy') throw new Error(`debuff '${key}' must be authored min_rarity foxy`);
      if (effect.type !== 'status') throw new Error(`debuff '${key}' must carry a status effect`);
      if (!SAFE_DEBUFF_STATUSES.includes(effect.status)) {
        throw new Error(
          `debuff '${key}' names status '${effect.status}', which is not one effects.js can carry `
          + 'under refresh-not-stack semantics without becoming a permanent lock',
        );
      }
    }
  }
}

function lit(s) { return `'${String(s).replace(/'/g, "''")}'`; }

exports.up = (pgm) => {
  assertCatalogSane();

  pgm.createTable('affix_types', {
    id: 'id',
    key: { type: 'text', notNull: true, unique: true },
    label: { type: 'text', notNull: true },
    kind: { type: 'text', notNull: true, default: 'buff' },
    effect: { type: 'jsonb', notNull: true },
    min_value: { type: 'double precision', notNull: true },
    max_value: { type: 'double precision', notNull: true },
    min_item_level: { type: 'integer', notNull: true, default: 1 },
    max_item_level: { type: 'integer' },
    allowed_slots: { type: 'text[]', notNull: true, default: pgm.func("'{}'::text[]") },
    min_rarity: { type: 'text', notNull: true, default: 'blue' },
    weight: { type: 'integer', notNull: true, default: 100 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('affix_types', 'affix_types_kind_check', "CHECK (kind IN ('buff','debuff'))");
  // 'white' is deliberately NOT admissible: a white item has no affixes at all
  // (spec 6.1), so an affix whose minimum is white could never appear and
  // would read as a live catalog entry that silently does nothing.
  pgm.addConstraint('affix_types', 'affix_types_min_rarity_check',
    "CHECK (min_rarity IN ('blue','yellow','foxy'))");
  pgm.addConstraint('affix_types', 'affix_types_value_range_check',
    'CHECK (max_value >= min_value)');
  // A zero or negative weight makes a row unpickable; the roller would skip it
  // forever with nothing failing loudly.
  pgm.addConstraint('affix_types', 'affix_types_weight_check', 'CHECK (weight > 0)');
  pgm.addConstraint('affix_types', 'affix_types_level_window_check',
    'CHECK (min_item_level >= 1 AND (max_item_level IS NULL OR max_item_level >= min_item_level))');
  // A debuff is only ever eligible at foxy (spec 6.1, enforced again in
  // authority/affixes.js#eligibleAffixes). Authoring one at a lower minimum
  // produces a row whose min_rarity is a lie about when it can appear.
  pgm.addConstraint('affix_types', 'affix_types_debuff_is_foxy_check',
    "CHECK (kind <> 'debuff' OR min_rarity = 'foxy')");

  pgm.createTable('player_item_affixes', {
    player_item_id: { type: 'uuid', notNull: true, references: 'player_items', onDelete: 'CASCADE' },
    idx: { type: 'smallint', notNull: true },
    affix_type_id: { type: 'integer', notNull: true, references: 'affix_types', onDelete: 'RESTRICT' },
    // double precision, NOT real. authority/affixes.js rounds a rolled value to
    // two decimals so "the rolled number and the stored number are the same
    // number" -- but two decimals is not representable in float4 (3.13 stores
    // as 3.130000114440918), so `real` would quietly break exactly the
    // property the rounding exists to provide, and the drop-and-repick round
    // trip would return a value that is close to, but not equal to, the one
    // that was rolled. world_items.affixes is jsonb, which is exact; this
    // column is the only place the value could have lost precision.
    value: { type: 'double precision', notNull: true },
  }, { constraints: { primaryKey: ['player_item_id', 'idx'] } });
  // 0..8 -- foxy's ceiling is nine affixes.
  pgm.addConstraint('player_item_affixes', 'player_item_affixes_idx_check',
    'CHECK (idx >= 0 AND idx <= 8)');
  // One affix TYPE at most once per instance: the roller samples without
  // replacement, and this is the backstop that keeps a future caller honest.
  pgm.addConstraint('player_item_affixes', 'player_item_affixes_unique_type',
    { unique: ['player_item_id', 'affix_type_id'] });

  // ON DELETE RESTRICT on affix_type_id, not CASCADE: deleting a catalog affix
  // must not silently strip a stat off gear players are wearing. The admin
  // DELETE route (index.js) reports the conflict instead.

  const rarityList = RARITIES.map((r) => lit(r)).join(',');
  pgm.addColumns('player_items', {
    rarity: { type: 'text', notNull: true, default: 'white' },
    item_level: { type: 'integer', notNull: true, default: 1 },
  });
  pgm.addConstraint('player_items', 'player_items_rarity_check', `CHECK (rarity IN (${rarityList}))`);
  pgm.addConstraint('player_items', 'player_items_item_level_check',
    'CHECK (item_level >= 1 AND item_level <= 150)');

  pgm.addColumns('world_items', {
    rarity: { type: 'text', notNull: true, default: 'white' },
    item_level: { type: 'integer', notNull: true, default: 1 },
    affixes: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    soulbound: { type: 'boolean', notNull: true, default: false },
  });
  pgm.addConstraint('world_items', 'world_items_rarity_check', `CHECK (rarity IN (${rarityList}))`);
  pgm.addConstraint('world_items', 'world_items_item_level_check',
    'CHECK (item_level >= 1 AND item_level <= 150)');
  // jsonb is otherwise free to hold an object or a scalar; the carry path
  // builds an array and claimItem expands one.
  pgm.addConstraint('world_items', 'world_items_affixes_array_check',
    "CHECK (jsonb_typeof(affixes) = 'array')");

  for (const [key, label, kind, effect, minV, maxV, minL, maxL, slots, minR, weight] of AFFIXES) {
    pgm.sql(`
      INSERT INTO affix_types
        (key, label, kind, effect, min_value, max_value, min_item_level, max_item_level,
         allowed_slots, min_rarity, weight)
      VALUES (
        ${lit(key)}, ${lit(label)}, ${lit(kind)}, ${lit(JSON.stringify(effect))}::jsonb,
        ${minV}, ${maxV}, ${minL}, ${maxL == null ? 'NULL' : maxL},
        ARRAY[${slots.map((s) => lit(s)).join(',')}]::text[],
        ${lit(minR)}, ${weight})
      ON CONFLICT (key) DO NOTHING
    `);
  }
};

exports.down = (pgm) => {
  pgm.dropConstraint('world_items', 'world_items_affixes_array_check');
  pgm.dropConstraint('world_items', 'world_items_item_level_check');
  pgm.dropConstraint('world_items', 'world_items_rarity_check');
  pgm.dropColumns('world_items', ['rarity', 'item_level', 'affixes', 'soulbound']);
  pgm.dropConstraint('player_items', 'player_items_item_level_check');
  pgm.dropConstraint('player_items', 'player_items_rarity_check');
  pgm.dropColumns('player_items', ['rarity', 'item_level']);
  pgm.dropTable('player_item_affixes');
  pgm.dropTable('affix_types');
};

exports.AFFIXES = AFFIXES;
