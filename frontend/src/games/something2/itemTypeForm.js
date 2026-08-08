// Pure form-state helpers for ItemTypesAdmin.jsx, split out of the component
// file so they can be unit-tested directly (vitest runs in a plain Node
// environment here, with no jsdom/RTL) and so the component file can keep
// exporting only its default component (react-refresh/only-export-components).

// Mirrors backend/src/index.js's ITEM_ELEMENTS / ITEM_SLOTS exactly.
export const ELEMENTS = ['physical', 'arcane', 'fire', 'ice', 'lightning'];
export const SLOTS = ['main_hand', 'off_hand', 'head', 'chest', 'hands', 'feet', 'ring1', 'ring2'];

export function num(v, fallback = null) {
  if (v === '' || v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const WEAPON_DEFAULTS = {
  kind: 'melee',
  damage: 10,
  cooldown: 0.5,
  two_handed: false,
  mana_cost: 0,
  stamina_cost: 0,
  reach: 60,
  arc_width: 0.5,
  range: '',
  projectile_speed: '',
  projectile_radius: '',
  pierce: '',
  ammo_type_id: '',
  aoe_radius: '',
  // SOMET-253 Task 9: 0 is the correct default for a NEW weapon here --
  // opposite direction from cooldown, where 0 would mean "fires every tick".
  // A weapon with no shove is simply harmless, not silently broken.
  knockback: 0,
};

export const ARMOR_DEFAULTS = {
  slot: 'chest',
  defense: 1,
};

// The backend rejects a non-stackable ammo type outright, so the form starts
// ammo off already stackable rather than letting the user submit an invalid one.
export const AMMO_DEFAULTS = {
  stackable: true,
  kind: '',
};

export function emptyForm() {
  return {
    name: '',
    category: 'weapon',
    element: '',
    stackable: false,
    ...WEAPON_DEFAULTS,
    slot: '',
    defense: '',
    value: 0,
    resistanceRows: [],
  };
}

export function formFromType(t) {
  const rows = Object.entries(t.resistances || {}).map(([element, value]) => ({ element, value: String(value) }));
  return {
    name: t.name,
    category: t.category,
    element: t.element || '',
    kind: t.kind || 'melee',
    damage: t.damage ?? 0,
    cooldown: t.cooldown ?? 0,
    two_handed: !!t.two_handed,
    mana_cost: t.mana_cost ?? 0,
    stamina_cost: t.stamina_cost ?? 0,
    reach: t.reach ?? '',
    arc_width: t.arc_width ?? '',
    range: t.range ?? '',
    projectile_speed: t.projectile_speed ?? '',
    projectile_radius: t.projectile_radius ?? '',
    pierce: t.pierce ?? '',
    knockback: t.knockback ?? 0,
    stackable: !!t.stackable,
    ammo_type_id: t.ammo_type_id ?? '',
    aoe_radius: t.aoe_radius ?? '',
    slot: t.slot || '',
    defense: t.defense ?? '',
    // F-047/SOMET-227: the backend has stored+returned item_types.value since
    // F-003, but this form never read or sent it, so every item created here
    // landed at the column default of 0 (worthless to sell, excluded from the
    // village base catalog's value > 0 filter).
    value: t.value ?? 0,
    resistanceRows: rows,
  };
}

// Mirrors backend/src/index.js's validateItemType() so the user sees the
// same problem before submitting instead of only on the 400 round-trip.
export function validateClient(f) {
  if (!f.name.trim()) return 'Name is required';
  if (!['weapon', 'armor', 'ammo'].includes(f.category)) return "category must be 'weapon', 'armor' or 'ammo'";
  if (f.element && !ELEMENTS.includes(f.element)) return `element must be one of ${ELEMENTS.join(', ')}`;
  if (f.category === 'armor' && f.slot && !SLOTS.includes(f.slot)) return `slot must be one of ${SLOTS.join(', ')}`;
  // Mirrors validateItemType's `value` check (F-003/F-047): a non-negative integer, or unset.
  if (f.value !== '' && f.value != null) {
    const v = num(f.value);
    if (v == null || !Number.isInteger(v) || v < 0) return 'value must be a non-negative whole number';
  }

  if (f.category === 'weapon') {
    if (!['melee', 'projectile'].includes(f.kind)) return "weapon kind must be 'melee' or 'projectile'";
    if (f.kind === 'melee' && (f.reach === '' || f.reach == null || f.arc_width === '' || f.arc_width == null)) {
      return 'melee weapons need reach and arc_width';
    }
    if (f.kind === 'projectile' && (f.range === '' || f.range == null || f.projectile_speed === '' || f.projectile_speed == null || f.projectile_radius === '' || f.projectile_radius == null)) {
      return 'projectile weapons need range, projectile_speed and projectile_radius';
    }
    // Mirrors the DB CHECK: a detonating projectile cannot also pierce.
    if (num(f.aoe_radius) != null && num(f.pierce, 0) > 1) {
      return 'aoe_radius and pierce > 1 are mutually exclusive';
    }
    // Mirrors item_types_knockback_check (SOMET-253 Task 9).
    const kb = num(f.knockback, 0);
    if (kb == null || kb < 0) return 'knockback must be a non-negative number';
  } else if (f.category === 'ammo') {
    if (!f.stackable) return 'ammo must be stackable';
  } else {
    if (f.slot === '' || f.slot == null || f.defense === '' || f.defense == null) return 'armor needs slot and defense';
  }
  return null;
}

// Builds the API payload from form state. Category-inapplicable fields are
// always nulled/zeroed here (not just left over from whatever the form last
// showed) so switching weapon -> armor never sends a stale `kind`, and
// switching melee <-> projectile never sends stale geometry.
export function buildPayload(f) {
  const base = {
    name: f.name.trim(),
    category: f.category,
    element: f.element || null,
    // F-047/SOMET-227: sent on every category so gold value survives a
    // category switch instead of only being wired for one of the three forms.
    value: num(f.value, 0),
  };

  if (f.category === 'weapon') {
    return {
      ...base,
      kind: f.kind,
      damage: num(f.damage, 0),
      cooldown: num(f.cooldown, 0),
      two_handed: !!f.two_handed,
      mana_cost: num(f.mana_cost, 0),
      stamina_cost: num(f.stamina_cost, 0),
      reach: f.kind === 'melee' ? num(f.reach) : null,
      arc_width: f.kind === 'melee' ? num(f.arc_width) : null,
      range: f.kind === 'projectile' ? num(f.range) : null,
      projectile_speed: f.kind === 'projectile' ? num(f.projectile_speed) : null,
      projectile_radius: f.kind === 'projectile' ? num(f.projectile_radius) : null,
      pierce: f.kind === 'projectile' ? num(f.pierce) : null,
      // Only a projectile weapon may consume ammo (backend + DB CHECK), and a
      // blast radius is meaningless on a melee swing.
      ammo_type_id: f.kind === 'projectile' ? num(f.ammo_type_id) : null,
      aoe_radius: f.kind === 'projectile' ? num(f.aoe_radius) : null,
      // Not kind-gated like reach/range above: the column itself carries no
      // such gate (see item_types_knockback_check), and this task only
      // wires it into the melee branch, but a projectile weapon is free to
      // carry a value a later task can read.
      knockback: num(f.knockback, 0),
      stackable: !!f.stackable,
      slot: null,
      defense: null,
      resistances: {},
    };
  }

  if (f.category === 'ammo') {
    return {
      ...base,
      kind: null,
      damage: 0,
      cooldown: 0,
      two_handed: false,
      mana_cost: 0,
      stamina_cost: 0,
      reach: null,
      arc_width: null,
      range: null,
      projectile_speed: null,
      projectile_radius: null,
      pierce: null,
      ammo_type_id: null,
      aoe_radius: null,
      knockback: 0,
      stackable: true,
      slot: null,
      defense: null,
      resistances: {},
    };
  }

  const resistances = {};
  for (const row of f.resistanceRows) {
    if (row.element) resistances[row.element] = num(row.value, 0);
  }
  return {
    ...base,
    kind: null,
    damage: 0,
    cooldown: 0,
    two_handed: false,
    mana_cost: 0,
    stamina_cost: 0,
    reach: null,
    arc_width: null,
    range: null,
    projectile_speed: null,
    projectile_radius: null,
    pierce: null,
    ammo_type_id: null,
    aoe_radius: null,
    knockback: 0,
    stackable: !!f.stackable,
    slot: f.slot,
    defense: num(f.defense, 0),
    resistances,
  };
}
