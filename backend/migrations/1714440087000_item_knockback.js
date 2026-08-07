// SOMET-253 Task 9: give PLAYER weapons the same knockback stat creature
// abilities got in Task 6 (creature_abilities.knockback,
// 1714440083000_creature_abilities.js). This is the mirror column on the
// item side -- world.attack's melee branch (world.js) reads item_types.kind
// = 'melee' weapons through this field, the player-vs-player loop included.
//
// notNull default 0 so every existing row (weapons AND armor/ammo, which
// never read this field) is unaffected -- 0 is the harmless "no shove"
// default here, unlike a cooldown field where 0 would mean "fires every
// tick". A NEW weapon created through the admin form also defaults to 0:
// see itemTypeForm.js's WEAPON_DEFAULTS.
exports.up = (pgm) => {
  pgm.addColumn('item_types', {
    knockback: { type: 'real', notNull: true, default: 0 },
  });
  pgm.addConstraint('item_types', 'item_types_knockback_check', 'CHECK (knockback >= 0)');

  // Give the existing melee weapons a modest live value so the mechanic has
  // a real consumer -- otherwise every seeded weapon would carry 0 and the
  // player-side shove could never fire outside a hand-built test fixture.
  // 30 is roughly a fifth of the dagger's 80-unit reach: noticeable without
  // being a launcher. Projectile weapons and armor/ammo are untouched (stay
  // at the column default, 0) -- Task 9's brief scopes this to the melee
  // branch only.
  pgm.sql(`UPDATE item_types SET knockback = 30 WHERE kind = 'melee'`);
};

exports.down = (pgm) => {
  pgm.dropConstraint('item_types', 'item_types_knockback_check');
  pgm.dropColumn('item_types', 'knockback');
};
