// SOMET-500 / SOMET-502 -- the display identity of the ONE player_items
// instance that a CONTAINER row holds.
//
// Two containers hold instances rather than snapshotting them:
//
//   merchant_stock  <- player_items.merchant_stock_id  (SOMET-484)
//   account_items   <- player_items.account_item_id    (SOMET-498)
//
// Both of those tickets made the ROUND TRIP lossless and both deliberately
// stopped there, so the shelf a player is looking at said nothing about what
// was on it: a yellow helm sold to a merchant was listed as an ordinary
// catalogue line, and a foxy sword in the bank was drawn exactly like a white
// one. Fixing them one at a time means two more copies of the same LEFT JOIN
// LATERAL and the same "rarity, item level, affixes joined to their catalog
// rows" projection -- items.js#loadInventory already owns the character-held
// version, so this file is what stops that count reaching four.
//
// SAME COLUMN SET, SAME ORDER, SAME KEY NAMES as loadInventory's
// jsonb_build_object, and that is the point rather than a nicety: both tickets'
// acceptance criteria say the shelf must show what the inventory grid shows for
// the SAME instance, so a second projection that merely looks similar is the
// defect, not the fix.
//
// WHY `instance_id` IS SELECTED AND THEN ONLY TESTED FOR NULL. A container row
// may legitimately hold nothing:
//
//   * the generated base catalogue (merchant_stock.seller_user_id IS NULL) is
//     infinite stock conjured from item_types and is PERMANENTLY
//     instance-less -- see 1714440512000's closing note;
//   * a merchant buyback row created before 1714440512000 existed.
//
// Such a row has no rarity to show and must keep rendering exactly as it did
// before this module existed. `rarity` alone cannot express that: a LEFT JOIN
// that matched nothing and an instance whose grade is genuinely 'white' both
// arrive as a NULL-ish rarity, and defaulting to 'white' would be a claim
// ("this item is ordinary") where the honest answer is silence ("nobody knows
// what this is until you buy it"). The id is the only column that separates
// them, so it is the one the branch is written against.

const HELD_BY = {
  // Keys are the CONTAINER, values are the pointer column on player_items and
  // the container's id expression. Hardcoded pairs rather than caller-supplied
  // strings so no query fragment in this file is ever assembled from an
  // argument -- there is no interpolation a caller can reach.
  merchant_stock: { column: 'merchant_stock_id', containerId: 'ms.id' },
  account_item: { column: 'account_item_id', containerId: 'ai.id' },
};

// The columns heldInstanceDisplay reads. Spliced into the container's own
// SELECT list; the join below is what puts them there.
const HELD_INSTANCE_COLUMNS = 'held.instance_id, held.rarity, held.item_level, held.affixes';

// The join that hydrates them. LATERAL + GROUP BY rather than a plain LEFT JOIN
// on player_item_affixes, because the container query already has its own
// grouping (or none) and folding an affix aggregate into it would force every
// caller to restate its GROUP BY.
//
// The FILTER is load-bearing for the same reason it is in loadInventory: a
// plain jsonb_agg over the LEFT JOIN emits [{"affixTypeId":null,...}] for an
// unaffixed instance, and a null-bearing entry is worse than an empty list --
// every consumer sums it as 0 and the panel captions it "unknown".
function heldInstanceJoin(container) {
  const spec = HELD_BY[container];
  if (!spec) throw new Error(`heldInstanceJoin: unknown container '${container}'`);
  return `LEFT JOIN LATERAL (
    SELECT pi.id AS instance_id, pi.rarity, pi.item_level,
           COALESCE(jsonb_agg(
             jsonb_build_object('affixTypeId', pia.affix_type_id, 'key', at.key,
                                'label', at.label,
                                'value', pia.value, 'effect', at.effect)
             ORDER BY pia.idx
           ) FILTER (WHERE pia.player_item_id IS NOT NULL), '[]'::jsonb) AS affixes
      FROM player_items pi
      LEFT JOIN player_item_affixes pia ON pia.player_item_id = pi.id
      LEFT JOIN affix_types at ON at.id = pia.affix_type_id
     WHERE pi.${spec.column} = ${spec.containerId}
     GROUP BY pi.id
  ) held ON true`;
}

// base + the held instance's display identity, or `base` untouched when the row
// holds nothing. Returning the SAME object shape as before for an
// instance-less row is what keeps a legacy listing byte-identical on the wire:
// the client's rarityBorderColor falls back to the panel's own neutral for an
// absent grade, so an added-but-empty `rarity: null` would be indistinguishable
// in the panel yet a visible change in every wire assertion.
function withHeldInstance(base, row) {
  if (!row || row.instance_id == null) return base;
  return {
    ...base,
    rarity: row.rarity || 'white',
    itemLevel: Number(row.item_level ?? 1),
    affixes: Array.isArray(row.affixes) ? row.affixes : [],
  };
}

module.exports = { HELD_INSTANCE_COLUMNS, heldInstanceJoin, withHeldInstance };
