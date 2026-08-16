// Pure form-state helpers for ItemTypesAdmin.jsx, split out of the component
// file so they can be unit-tested directly (vitest runs in a plain Node
// environment here, with no jsdom/RTL) and so the component file can keep
// exporting only its default component (react-refresh/only-export-components).

// Mirrors backend/src/index.js's ITEM_ELEMENTS / ITEM_SLOTS exactly.
// SOMET-329: both lists are CATALOG data, fetched from /api/weapon-catalogs
// and passed into validateClient. These are the seeded fallbacks, used before
// the fetch resolves and if it fails — a form that validated against an empty
// list would reject every element the game actually has.
export const ELEMENTS = ['physical', 'arcane', 'fire', 'ice', 'lightning'];
export const ATTACK_ORIGINS = ['feet', 'middle', 'head'];

// The shape /api/weapon-catalogs returns, normalized for the form. Exported so
// the admin component and its tests agree on it.
export function emptyCatalogs() {
  return { attackOrigins: [], elements: [], projectileShapes: [], impactBehaviors: [] };
}

// Names from a fetched catalog, or the seeded fallback when it is empty.
export function catalogNames(rows, fallback) {
  if (!Array.isArray(rows) || rows.length === 0) return fallback;
  const names = rows.map((r) => r && r.name).filter((n) => typeof n === 'string' && n);
  return names.length > 0 ? names : fallback;
}

// Attack VFX binding moments (slice E, SOMET-162), and which weapon kinds can
// actually produce each one.
//
// `miss` is melee-only: a projectile cannot whiff at the moment of firing --
// the shot leaves regardless and its hit is resolved later in flight -- so
// offering the field would invite dead data. `trail` is the converse: it is
// what a projectile draws in flight and a melee swing has no use for.
export const VFX_MOMENTS = [
  { key: 'attack', label: 'Attack', appliesTo: 'any' },
  { key: 'impact', label: 'Impact', appliesTo: 'any' },
  { key: 'miss', label: 'Miss', appliesTo: 'melee' },
  { key: 'trail', label: 'Trail', appliesTo: 'projectile' },
];
export const SLOTS = ['main_hand', 'off_hand', 'head', 'chest', 'hands', 'feet', 'ring1', 'ring2'];

// ---------------------------------------------------------------------------
// Reserved item types (SOMET-284) -- a MIRROR of the backend, not a second rule.
//
// backend/src/index.js (SOMET-278) declares:
//     const RESERVED_ITEM_TYPE_NAMES  = new Set(['gold']);
//     const RESERVED_ITEM_CATEGORIES  = new Set(['currency']);
//     isReservedItemType(row) => NAMES.has(row.name) || CATEGORIES.has(row.category)
// and uses it to 409 a DELETE of such a row, and to 409 a PUT that changes its
// name or category. validateItemType() additionally RELAXES the category
// whitelist for a reserved row that keeps its own category.
//
// The API does NOT tell the client which rows are reserved: GET /api/item-types
// is a bare `SELECT * FROM item_types`, so there is no `reserved` field to read.
// Deriving it here from the same rule is therefore the only option available
// without a backend change -- but it does mean ONE rule now exists in TWO
// places, which is exactly the shape that produced the SOMET-153 village-spawn
// defect when the copies drifted. The better fix is a server-provided
// `reserved` boolean on each returned row; then this block collapses to
// `row.reserved` and cannot drift. Until then: if the backend constants change,
// change these in the same commit.
export const RESERVED_ITEM_TYPE_NAMES = ['gold'];
export const RESERVED_ITEM_CATEGORIES = ['currency'];

// `row` is the STORED item type (the row being edited), never form state --
// same keying as the backend, where a body-keyed check would be bypassed by
// simply sending a different name.
export function isReservedItemType(row) {
  return !!row
    && (RESERVED_ITEM_TYPE_NAMES.includes(row.name) || RESERVED_ITEM_CATEGORIES.includes(row.category));
}

// True when this edit is "a reserved row keeping the category it already has" —
// the one case in which the backend accepts a category outside
// weapon/armor/ammo. Mirrors validateItemType()'s `keepsReservedCategory`.
// Note it is keyed on the reserved CATEGORY only, like the backend: a reserved
// *name* on an ordinary category (were that ever to exist) gets no relaxation.
function keepsReservedCategory(category, existing) {
  return !!existing
    && RESERVED_ITEM_CATEGORIES.includes(existing.category)
    && category === existing.category;
}

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
    // SOMET-326. '' is "unset", which the backend stores as NULL and
    // authority/attackOrigin.js resolves to the kind default (middle) --
    // i.e. exactly how every weapon rendered before this slice.
    attack_origin: '',
    // SOMET-329. '' is "no named shape/behaviour" — the hand-tuned
    // projectile_radius / aoe_radius+pierce columns stay authoritative.
    projectile_shape_id: '',
    impact_behavior_id: '',
    stackable: false,
    ...WEAPON_DEFAULTS,
    slot: '',
    defense: '',
    value: 0,
    resistanceRows: [],
    vfx: {},
  };
}

export function formFromType(t) {
  const rows = Object.entries(t.resistances || {}).map(([element, value]) => ({ element, value: String(value) }));
  return {
    name: t.name,
    category: t.category,
    element: t.element || '',
    attack_origin: t.attack_origin || '',
    projectile_shape_id: t.projectile_shape_id ?? '',
    impact_behavior_id: t.impact_behavior_id ?? '',
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
    // SOMET-284: carried purely so buildPayload can hand it back untouched.
    // The form has no icon input, but PUT /api/item-types/:id writes
    // `icon = b.icon ?? null` unconditionally -- so before this, saving ANY
    // item through this editor erased an icon set out of band. Reserved rows
    // are the ones that matter most: the ticket keeps gold's icon editable,
    // and a form that silently blanks it is the same class of lie.
    icon: t.icon ?? null,
    resistanceRows: rows,
    // Stored bindings, so opening the editor shows what is actually bound
    // rather than an empty dropdown that would overwrite it on save.
    vfx: t.vfx || {},
  };
}

// Mirrors backend/src/index.js's validateItemType() so the user sees the
// same problem before submitting instead of only on the 400 round-trip.
//
// `existing` is the stored row being edited (null on create), and it only ever
// RELAXES the rules -- exactly as it does in validateItemType(). Without it a
// reserved row (`gold`, category `currency`) was rejected here before the
// request was ever sent, so the row the backend had just made *editable* stayed
// uneditable through the UI (SOMET-284).
// SOMET-329: `catalogs` is the fetched option catalog. Optional and defaulted,
// so every existing caller and test keeps working against the seeded lists.
export function validateClient(f, existing = null, catalogs = null) {
  const elements = catalogNames(catalogs && catalogs.elements, ELEMENTS);
  const origins = catalogNames(catalogs && catalogs.attackOrigins, ATTACK_ORIGINS);
  const keepsReserved = keepsReservedCategory(f.category, existing);
  if (!f.name.trim()) return 'Name is required';
  if (!keepsReserved && !['weapon', 'armor', 'ammo'].includes(f.category)) return "category must be 'weapon', 'armor' or 'ammo'";
  if (f.element && !elements.includes(f.element)) return `element must be one of ${elements.join(', ')}`;
  if (f.attack_origin && !origins.includes(f.attack_origin)) {
    return `attack origin must be one of ${origins.join(', ')}`;
  }
  if (f.category === 'armor' && f.slot && !SLOTS.includes(f.slot)) return `slot must be one of ${SLOTS.join(', ')}`;
  // Mirrors validateItemType's `value` check (F-003/F-047): a non-negative integer, or unset.
  if (f.value !== '' && f.value != null) {
    const v = num(f.value);
    if (v == null || !Number.isInteger(v) || v < 0) return 'value must be a non-negative whole number';
  }

  // Every branch below is gated on `!keepsReserved` for the same reason the
  // backend gates its copy: a reserved (currency) row has none of these shapes,
  // and the final `else` would otherwise demand 'armor needs slot and defense'
  // of the gold row. The shared checks above and the resistance check below
  // still run for it.
  if (!keepsReserved && f.category === 'weapon') {
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
  } else if (!keepsReserved && f.category === 'ammo') {
    if (!f.stackable) return 'ammo must be stackable';
  } else if (!keepsReserved) {
    if (f.slot === '' || f.slot == null || f.defense === '' || f.defense == null) return 'armor needs slot and defense';
  }

  // SOMET-79: two resistance rows naming the same element used to be accepted,
  // and buildPayload writes them into an object keyed by element -- so the
  // later row silently overwrote the earlier one and the author's first value
  // vanished on save with no indication. Refusing is the honest option: the
  // form cannot know which of the two the author meant.
  const seen = new Set();
  for (const row of f.resistanceRows || []) {
    if (!row.element) continue;
    if (seen.has(row.element)) return `resistances list ${row.element} twice — remove one row`;
    seen.add(row.element);
  }
  return null;
}

// Drops empty selections so an unbound moment is ABSENT from the jsonb rather
// than stored as "", which would resolve to nothing and silently defeat the
// kind-level fallback that exists to keep an unbound weapon visible.
function cleanVfx(vfx) {
  const out = {};
  for (const [k, v] of Object.entries(vfx || {})) {
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  return out;
}

// Builds the API payload from form state. Category-inapplicable fields are
// always nulled/zeroed here (not just left over from whatever the form last
// showed) so switching weapon -> armor never sends a stale `kind`, and
// switching melee <-> projectile never sends stale geometry.
//
// `existing` is the stored row on an update (null on create). It exists for one
// reason: a reserved row's category must ROUND-TRIP untouched. Without it the
// `currency` category fell through to the armor branch below, which sends
// `slot: f.slot` (the empty string for gold) and `defense: 0` -- and the PUT
// answers 400 "slot must be one of ..." or, if the category had been coerced to
// one the select offers, 409 "cannot rename or recategorize reserved item
// type". Both are the same bug: the form rewriting a field it must preserve.
export function buildPayload(f, existing = null) {
  const keepsReserved = keepsReservedCategory(f.category, existing);
  const base = {
    name: f.name.trim(),
    category: f.category,
    element: f.element || null,
    // Round-tripped, never authored here (see formFromType). `?? null` keeps
    // the create path identical to before: emptyForm() carries no icon.
    icon: f.icon ?? null,
    // F-047/SOMET-227: sent on every category so gold value survives a
    // category switch instead of only being wired for one of the three forms.
    value: num(f.value, 0),
  };

  // Checked BEFORE the category branches: a reserved row is none of the three
  // shapes, and every combat/armor field on it stays at its stored zero-value.
  // `stackable` and `value` are the two that carry real data here (gold is
  // stackable, and its value is editable), so both come from the form.
  if (keepsReserved) {
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
      // null, NOT '' -- the backend rejects a non-null slot outside ITEM_SLOTS,
      // and '' is non-null.
      slot: null,
      defense: null,
      resistances: {},
      vfx: cleanVfx(f.vfx),
    };
  }

  if (f.category === 'weapon') {
    return {
      ...base,
      kind: f.kind,
      // SOMET-326. Not kind-gated: both melee and projectile weapons launch
      // their visuals from somewhere on the body, and the column carries no
      // gate either. '' -> null is "unset", which resolves to the kind default.
      attack_origin: f.attack_origin || null,
      // SOMET-329. Shape is projectile-only (a melee swing has no projectile
      // to size), impact behaviour likewise — both kind-gated the same way
      // range/reach already are, so switching a weapon to melee cannot leave
      // a stale projectile setting silently attached to it.
      projectile_shape_id: f.kind === 'projectile' ? num(f.projectile_shape_id) : null,
      impact_behavior_id: f.kind === 'projectile' ? num(f.impact_behavior_id) : null,
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
      vfx: cleanVfx(f.vfx),
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
      vfx: cleanVfx(f.vfx),
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
    vfx: cleanVfx(f.vfx),
  };
}
