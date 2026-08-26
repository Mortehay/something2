/* eslint-disable camelcase */
exports.shorthands = undefined;

// Prunes high-tier (> tier 1) weapons and armor from the merchant base catalog
// so general merchants only sell base starter equipment, while higher tiers drop from creatures in the wild.

exports.up = async (pgm) => {
  await pgm.db.query(
    `DELETE FROM merchant_stock ms
      USING item_types it
      WHERE ms.item_type_id = it.id
        AND ms.seller_user_id IS NULL
        AND it.tier IS NOT NULL
        AND it.tier > 1`,
  );
};

exports.down = async (pgm) => {
  // No-op
};
