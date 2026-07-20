// The JS-side mirror of the weapon/ammo catalog that lives in the migrations.
//
// Extracted from authority_items_catalog.test.js so that OTHER suites can
// derive real catalog numbers instead of hardcoding them. That matters for the
// shock-interrupt invariant in authority_effects.test.js: SHOCK_IMMUNITY_MS
// must exceed the fastest lightning weapon's cooldown, and a hardcoded 1100
// there would silently stop tracking the catalog the moment someone rebalances
// the storm staff.
//
// This file is a plain fixture module, NOT a test file — requiring it from a
// suite must not execute a second copy of the catalog tests.
//
// `the live item_types catalog matches SEED_ROWS` in
// authority_items_catalog.test.js is what keeps this honest against the real
// database. Without that test this is just a hand-written copy defending
// itself.

// SEED_ROWS mirrors the migration's VALUES lists exactly — the 4 original
// weapons from 1714440016000_create_weapon_types.js (with stamina_cost
// backfilled per 1714440019000_weapon_catalog.js) plus the 18 new weapons
// from 1714440019000_weapon_catalog.js, with stamina_cost rebalanced per
// 1714440020000_rebalance_stamina.js, plus the ammo/aoe columns and the 3
// ammo rows from 1714440021000_aoe_ammo.js. 22 weapons + 3 ammo = 25 rows.
// Keep in sync with the migrations.
const SEED_ROWS = [
  // --- original 4, from 1714440016000 (+ stamina backfill/rebalance) ---
  { id: 1, name: 'dagger', category: 'weapon', kind: 'melee', damage: 8, cooldown: 0.30,
    reach: 80, arc_width: 0.6, range: null, projectile_speed: null, projectile_radius: null,
    pierce: null, mana_cost: 0, stamina_cost: 0, element: null,
    stackable: false, ammo_type_id: null, aoe_radius: null },
  { id: 2, name: 'halberd', category: 'weapon', kind: 'melee', damage: 18, cooldown: 0.90,
    reach: 190, arc_width: 1.8, range: null, projectile_speed: null, projectile_radius: null,
    pierce: null, mana_cost: 0, stamina_cost: 15, element: null,
    stackable: false, ammo_type_id: null, aoe_radius: null },
  { id: 3, name: 'bow', category: 'weapon', kind: 'projectile', damage: 12, cooldown: 0.60,
    reach: null, arc_width: null, range: 700, projectile_speed: 900, projectile_radius: 8,
    pierce: 1, mana_cost: 0, stamina_cost: 8, element: null,
    stackable: false, ammo_type_id: 101, ammo_type_name: 'arrow', aoe_radius: null },
  { id: 4, name: 'magic-bolt', category: 'weapon', kind: 'projectile', damage: 14, cooldown: 0.70,
    reach: null, arc_width: null, range: 600, projectile_speed: 700, projectile_radius: 12,
    pierce: 1, mana_cost: 15, stamina_cost: 0, element: 'arcane',
    stackable: false, ammo_type_id: null, aoe_radius: null },
  // --- 18 new, from 1714440019000 (stamina_cost rebalanced per 1714440020000) ---
  { id: 7, name: 'knife', category: 'weapon', kind: 'melee', damage: 6, cooldown: 0.25,
    reach: 70, arc_width: 0.5, range: null, projectile_speed: null, projectile_radius: null,
    pierce: null, mana_cost: 0, stamina_cost: 0, element: null,
    stackable: false, ammo_type_id: null, aoe_radius: null },
  { id: 8, name: 'stick', category: 'weapon', kind: 'melee', damage: 7, cooldown: 0.35,
    reach: 90, arc_width: 0.7, range: null, projectile_speed: null, projectile_radius: null,
    pierce: null, mana_cost: 0, stamina_cost: 0, element: null,
    stackable: false, ammo_type_id: null, aoe_radius: null },
  { id: 9, name: 'club', category: 'weapon', kind: 'melee', damage: 10, cooldown: 0.45,
    reach: 85, arc_width: 0.8, range: null, projectile_speed: null, projectile_radius: null,
    pierce: null, mana_cost: 0, stamina_cost: 6, element: null,
    stackable: false, ammo_type_id: null, aoe_radius: null },
  { id: 10, name: 'short sword', category: 'weapon', kind: 'melee', damage: 11, cooldown: 0.45,
    reach: 100, arc_width: 0.9, range: null, projectile_speed: null, projectile_radius: null,
    pierce: null, mana_cost: 0, stamina_cost: 6, element: null,
    stackable: false, ammo_type_id: null, aoe_radius: null },
  { id: 11, name: 'mid club', category: 'weapon', kind: 'melee', damage: 14, cooldown: 0.60,
    reach: 115, arc_width: 1.0, range: null, projectile_speed: null, projectile_radius: null,
    pierce: null, mana_cost: 0, stamina_cost: 9, element: null,
    stackable: false, ammo_type_id: null, aoe_radius: null },
  { id: 12, name: 'long sword', category: 'weapon', kind: 'melee', damage: 15, cooldown: 0.65,
    reach: 140, arc_width: 1.2, range: null, projectile_speed: null, projectile_radius: null,
    pierce: null, mana_cost: 0, stamina_cost: 9, element: null,
    stackable: false, ammo_type_id: null, aoe_radius: null },
  { id: 13, name: 'morning star', category: 'weapon', kind: 'melee', damage: 17, cooldown: 0.75,
    reach: 130, arc_width: 1.6, range: null, projectile_speed: null, projectile_radius: null,
    pierce: null, mana_cost: 0, stamina_cost: 12, element: null,
    stackable: false, ammo_type_id: null, aoe_radius: null },
  { id: 14, name: 'two-handed sword', category: 'weapon', kind: 'melee', damage: 22, cooldown: 1.00,
    reach: 170, arc_width: 1.4, range: null, projectile_speed: null, projectile_radius: null,
    pierce: null, mana_cost: 0, stamina_cost: 18, element: null,
    stackable: false, ammo_type_id: null, aoe_radius: null },
  { id: 15, name: 'scythe', category: 'weapon', kind: 'melee', damage: 20, cooldown: 0.95,
    reach: 175, arc_width: 2.0, range: null, projectile_speed: null, projectile_radius: null,
    pierce: null, mana_cost: 0, stamina_cost: 16, element: null,
    stackable: false, ammo_type_id: null, aoe_radius: null },
  { id: 16, name: 'pike', category: 'weapon', kind: 'melee', damage: 19, cooldown: 0.85,
    reach: 200, arc_width: 0.5, range: null, projectile_speed: null, projectile_radius: null,
    pierce: null, mana_cost: 0, stamina_cost: 14, element: null,
    stackable: false, ammo_type_id: null, aoe_radius: null },
  // darts deliberately get NO ammo — the weak-but-free option.
  { id: 17, name: 'darts', category: 'weapon', kind: 'projectile', damage: 7, cooldown: 0.35,
    reach: null, arc_width: null, range: 350, projectile_speed: 800, projectile_radius: 6,
    pierce: 1, mana_cost: 0, stamina_cost: 4, element: null,
    stackable: false, ammo_type_id: null, aoe_radius: null },
  { id: 18, name: 'sling', category: 'weapon', kind: 'projectile', damage: 8, cooldown: 0.50,
    reach: null, arc_width: null, range: 450, projectile_speed: 700, projectile_radius: 8,
    pierce: 1, mana_cost: 0, stamina_cost: 6, element: null,
    stackable: false, ammo_type_id: 103, ammo_type_name: 'stone', aoe_radius: null },
  { id: 19, name: 'arbalest', category: 'weapon', kind: 'projectile', damage: 20, cooldown: 1.20,
    reach: null, arc_width: null, range: 850, projectile_speed: 1100, projectile_radius: 8,
    pierce: 2, mana_cost: 0, stamina_cost: 15, element: null,
    stackable: false, ammo_type_id: 102, ammo_type_name: 'bolt', aoe_radius: null },
  { id: 20, name: 'apprentice staff', category: 'weapon', kind: 'projectile', damage: 10, cooldown: 0.55,
    reach: null, arc_width: null, range: 500, projectile_speed: 650, projectile_radius: 10,
    pierce: 1, mana_cost: 8, stamina_cost: 0, element: 'arcane',
    stackable: false, ammo_type_id: null, aoe_radius: null },
  { id: 21, name: 'frost staff', category: 'weapon', kind: 'projectile', damage: 13, cooldown: 0.70,
    reach: null, arc_width: null, range: 620, projectile_speed: 650, projectile_radius: 12,
    pierce: 1, mana_cost: 16, stamina_cost: 0, element: 'ice',
    stackable: false, ammo_type_id: null, aoe_radius: null },
  { id: 22, name: 'flame staff', category: 'weapon', kind: 'projectile', damage: 16, cooldown: 0.80,
    reach: null, arc_width: null, range: 550, projectile_speed: 600, projectile_radius: 14,
    pierce: 1, mana_cost: 18, stamina_cost: 0, element: 'fire',
    stackable: false, ammo_type_id: null, aoe_radius: 90 },
  // Rebalanced in 3b-3c: lightning carries all three status riders
  // (vulnerability, interrupt, mana drain), so the storm staff pays for them by
  // becoming the worst staff in the game by damage-per-mana. An invariant test
  // enforces that ordering — see the elemental invariants suite.
  { id: 23, name: 'storm staff', category: 'weapon', kind: 'projectile', damage: 14, cooldown: 1.10,
    reach: null, arc_width: null, range: 700, projectile_speed: 1000, projectile_radius: 10,
    pierce: 1, mana_cost: 34, stamina_cost: 0, element: 'lightning',
    stackable: false, ammo_type_id: null, aoe_radius: 70 },
  { id: 24, name: 'archmage staff', category: 'weapon', kind: 'projectile', damage: 24, cooldown: 1.10,
    reach: null, arc_width: null, range: 800, projectile_speed: 850, projectile_radius: 14,
    pierce: 1, mana_cost: 32, stamina_cost: 0, element: 'arcane',
    stackable: false, ammo_type_id: null, aoe_radius: 110 },
  // --- 3 ammo rows, from 1714440021000_aoe_ammo.js ---
  { id: 101, name: 'arrow', category: 'ammo', kind: null, damage: 0, cooldown: 0,
    reach: null, arc_width: null, range: null, projectile_speed: null, projectile_radius: null,
    pierce: null, mana_cost: 0, stamina_cost: 0, element: null,
    stackable: true, ammo_type_id: null, aoe_radius: null },
  { id: 102, name: 'bolt', category: 'ammo', kind: null, damage: 0, cooldown: 0,
    reach: null, arc_width: null, range: null, projectile_speed: null, projectile_radius: null,
    pierce: null, mana_cost: 0, stamina_cost: 0, element: null,
    stackable: true, ammo_type_id: null, aoe_radius: null },
  { id: 103, name: 'stone', category: 'ammo', kind: null, damage: 0, cooldown: 0,
    reach: null, arc_width: null, range: null, projectile_speed: null, projectile_radius: null,
    pierce: null, mana_cost: 0, stamina_cost: 0, element: null,
    stackable: true, ammo_type_id: null, aoe_radius: null },
];

// The fastest (lowest) cooldown, in MILLISECONDS, of any weapon carrying
// `element`. Returns null when no weapon carries it. Catalog cooldowns are in
// SECONDS; every caller wanting ms has to convert, so it is done once here.
function fastestCooldownMsForElement(element) {
  const cds = SEED_ROWS
    .filter((r) => r.category === 'weapon' && r.element === element)
    .map((r) => r.cooldown * 1000);
  return cds.length ? Math.min(...cds) : null;
}

module.exports = { SEED_ROWS, fastestCooldownMsForElement };
