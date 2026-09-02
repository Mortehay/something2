// frontend/src/games/something2/passiveNodeForm.js
//
// PURE form <-> payload mapping and validation for the admin node editor, kept
// out of the component for the same reason biomeForm.js and behaviorForm.js
// are: the rules are unit tests here, and the component only renders them.
//
// The vocabulary below is a deliberate SECOND copy of the backend's (in
// backend/seeds/data/passiveTree.js, which backend/src/api/passiveNodesRoutes.js
// reads directly). The frontend cannot require CommonJS from the backend tree,
// so the copy is unavoidable -- what is avoidable is the DRIFT, and
// __tests__/passiveNodeForm.test.js compares every list here against the
// backend's source text on every run. That guard is not ceremony: a stat name
// that exists here and not there is a dropdown option the admin can pick, the
// server rejects, and nobody can explain; a stat name that exists there and not
// here is a grant the editor silently cannot express.

// SOMET-517 added `greater`. 'start' is deliberately absent: a start node is
// structural, granted rather than allocated, and must not be authorable here.
export const KINDS = ['minor', 'notable', 'greater', 'keystone'];
export const SECTORS = ['core', 'strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
export const STATS = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
export const POOLS = ['hp', 'mana', 'stamina'];
export const ELEMENTS = ['physical', 'arcane', 'fire', 'ice', 'lightning'];
export const STATUSES = ['burn', 'chill', 'shock'];
// Mirrors backend/seeds/data/passiveTree.js RULE_KEYS; passiveNodeForm.test.js
// asserts the two lists agree, so a rule the backend understands but this form
// omits is a rule no admin can author. Grew from 4 to 13 across SOMET-514..522.
export const RULE_KEYS = [
  'lifeCostMultiplier', 'treeCharmBonus', 'cooldownFloor', 'regenLifeShare',
  'attackSpeedMult', 'castSpeedMult', 'meleeReachBonus', 'meleeArcBonus',
  'projectileCount', 'projectileSpeedMult', 'pierceBonus',
  'auraLeech', 'auraRadius', 'meleeDamageMult', 'meleeWaveShare',
];

// `field` is the extra key this grant type carries, and `options` is what the
// editor's dropdown for it offers. One table drives the form, the payload
// mapping and the validator, so a new grant type is one entry rather than three.
export const GRANT_TYPES = [
  { type: 'stat', field: 'stat', options: STATS, label: 'Stat' },
  { type: 'resource', field: 'pool', options: POOLS, label: 'Resource' },
  { type: 'damage', field: 'element', options: ELEMENTS, label: 'Damage' },
  { type: 'resist', field: 'element', options: ELEMENTS, label: 'Resistance' },
  { type: 'status', field: 'status', options: STATUSES, label: 'Status on hit' },
  { type: 'rule', field: 'rule', options: RULE_KEYS, label: 'Rule' },
];

// The noun each field is called in an error message, so "unknown stat" and
// "unknown resource pool" read like English rather than like a field name.
const FIELD_NOUN = {
  stat: 'stat', pool: 'resource pool', element: 'element', status: 'status', rule: 'rule',
};

const byType = new Map(GRANT_TYPES.map((g) => [g.type, g]));

export function nodeToForm(row) {
  return {
    id: row.id,
    key: row.key,
    sector: row.sector,
    ring: row.ring,
    label: row.label,
    kind: row.kind,
    // Cloned: the form is edited in place and the query cache's row must not
    // move under it.
    grants: (row.grants || []).map((g) => ({ ...g })),
  };
}

export function formToPayload(form) {
  return {
    label: String(form.label || '').trim(),
    kind: form.kind,
    grants: (form.grants || []).map((g) => {
      const def = byType.get(g.type);
      // Only the fields this type uses. Switching a grant's type in the form
      // leaves the previous type's field behind, and a stored `stat` on a
      // `damage` grant is a row that validates and does nothing.
      const out = { type: g.type, value: Number(g.value) };
      if (def) out[def.field] = g[def.field];
      return out;
    }),
  };
}

// A value must be a real number or a string that is one. `Number(v)` alone is
// not enough -- Number(null), Number(''), Number([]) are all 0 and Number(true)
// is 1 -- so a check built on Number.isFinite(Number(v)) accepts four ways of
// saying "I left this blank" and turns them into a grant of 0.
function isNumericValue(v) {
  if (typeof v === 'number') return Number.isFinite(v);
  return typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v));
}

export function validateNodeForm(form) {
  const errors = [];
  if (!String(form.label || '').trim()) errors.push('Label is required');
  if (form.kind === 'start') errors.push('A start node cannot be created or edited here');
  else if (!KINDS.includes(form.kind)) errors.push('Kind must be minor, notable or keystone');

  (form.grants || []).forEach((g, i) => {
    const n = i + 1;
    const def = g && byType.get(g.type);
    if (!def) { errors.push(`Grant ${n}: unknown type "${g && g.type}"`); return; }
    if (!isNumericValue(g.value)) {
      errors.push(`Grant ${n}: value must be a number`);
      return;
    }
    const v = g[def.field];
    if (!def.options.includes(v)) {
      errors.push(`Grant ${n}: unknown ${FIELD_NOUN[def.field]} "${v}"`);
    }
  });

  return { ok: errors.length === 0, errors };
}

// The one-line rendering used by the browser list. Kept in the same wording as
// the tree overlay's tooltip so an admin reads the sentence the player will.
export function grantSummary(grants) {
  if (!grants || grants.length === 0) return '—';
  return grants.map((g) => {
    const sign = Number(g.value) < 0 ? '' : '+';
    switch (g.type) {
      case 'stat': return `${sign}${g.value} ${g.stat}`;
      case 'resource': return `${sign}${g.value} max ${g.pool}`;
      case 'damage': return `${sign}${g.value}% ${g.element} damage`;
      case 'resist': return `${sign}${g.value}% ${g.element} resistance`;
      case 'status': return `your hits ${g.status}`;
      case 'rule': return `${g.rule} x${g.value}`;
      default: return String(g.type);
    }
  }).join(', ');
}
