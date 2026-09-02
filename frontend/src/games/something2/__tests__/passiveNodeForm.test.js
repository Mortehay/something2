import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GRANT_TYPES, RULE_KEYS, KINDS, SECTORS, STATS, POOLS, ELEMENTS, STATUSES,
  nodeToForm, formToPayload, validateNodeForm, grantSummary,
} from '../passiveNodeForm.js';

const ROW = {
  id: 42, key: 'strength-r2-1-7', sector: 'strength', ring: 2, x: 12.5, y: -30.25,
  kind: 'notable', label: 'Great Sinew', start_class: null,
  grants: [{ type: 'stat', stat: 'strength', value: 8 }],
};

const here = path.dirname(fileURLToPath(import.meta.url));
const readBackend = (rel) => fs.readFileSync(path.resolve(here, '../../../../../backend', rel), 'utf8');

// The backend's vocabulary, read as SOURCE TEXT. vitest runs this project in a
// plain node environment and the backend is CommonJS with its own require
// graph, so importing it is not available -- the same route
// hotkeyRegistry.test.js and navRoutes.test.js take, for the same reason.
function arrayLiteral(source, name) {
  const m = source.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
  expect(m, `${name} not found in the backend source -- was it renamed?`).toBeTruthy();
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

function objectKeys(source, name) {
  const m = source.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\};`));
  expect(m, `${name} not found in the backend source -- was it renamed?`).toBeTruthy();
  return [...m[1].matchAll(/^ {2}(\w+):/gm)].map((x) => x[1]);
}

describe('vocabulary', () => {
  it('offers every grant type the backend accepts, and no start kind', () => {
    expect(GRANT_TYPES.map((g) => g.type)).toEqual(
      ['stat', 'resource', 'damage', 'resist', 'status', 'rule'],
    );
    // SOMET-517's greater tier. 'start' stays absent: a start node is granted,
    // not allocated, and must never be authorable in the admin form.
    expect(KINDS).toEqual(['minor', 'notable', 'greater', 'keystone']);
    expect(SECTORS).toEqual(
      ['core', 'strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'],
    );
    // Hand-written, so adding a rule stays a deliberate edit in three places:
    // the backend seed, the form, and here.
    expect(RULE_KEYS).toEqual([
      'lifeCostMultiplier', 'treeCharmBonus', 'cooldownFloor', 'regenLifeShare',
      'attackSpeedMult', 'castSpeedMult', 'meleeReachBonus', 'meleeArcBonus',
      'projectileCount', 'projectileSpeedMult', 'pierceBonus',
      'auraLeech', 'auraRadius', 'meleeDamageMult', 'meleeWaveShare',
    ]);
  });

  // A copied vocabulary that drifts is the quietest failure this editor can
  // have: an option the server rejects with no explanation, or a grant the
  // editor cannot express at all. Every list is checked, not just the type
  // names -- a misspelt STAT is exactly as inert as a misspelt type, and it is
  // the one that has actually shipped in this epic.
  describe('has not drifted from the backend', () => {
    const seed = readBackend('seeds/data/passiveTree.js');
    const damage = readBackend('src/authority/damage.js');

    it('grant types match seeds/data/passiveTree.js GRANT_TYPES', () => {
      expect(objectKeys(seed, 'GRANT_TYPES')).toEqual(GRANT_TYPES.map((g) => g.type));
    });

    it('rule keys match seeds/data/passiveTree.js RULE_KEYS', () => {
      expect(objectKeys(seed, 'RULE_KEYS').sort()).toEqual([...RULE_KEYS].sort());
    });

    it('stats match seeds/data/passiveTree.js STAT_KEYS', () => {
      expect(arrayLiteral(seed, 'STAT_KEYS')).toEqual(STATS);
    });

    it('resource pools match seeds/data/passiveTree.js RESOURCE_POOLS', () => {
      expect(arrayLiteral(seed, 'RESOURCE_POOLS')).toEqual(POOLS);
    });

    it('statuses match seeds/data/passiveTree.js STATUSES', () => {
      expect(arrayLiteral(seed, 'STATUSES')).toEqual(STATUSES);
    });

    it('elements match the damage authority, which is where the tree reads them from', () => {
      expect(arrayLiteral(damage, 'ELEMENTS')).toEqual(ELEMENTS);
    });

    it('kinds and sectors match the admin route module', () => {
      const routes = readBackend('src/api/passiveNodesRoutes.js');
      expect(arrayLiteral(routes, 'KINDS')).toEqual(KINDS);
      expect(arrayLiteral(routes, 'SECTORS')).toEqual(SECTORS);
    });
  });

  it('every grant type names a field the options list can fill', () => {
    for (const g of GRANT_TYPES) {
      expect(typeof g.field, `${g.type} needs a field`).toBe('string');
      expect(g.options.length, `${g.type} needs options`).toBeGreaterThan(0);
      expect(g.label.length).toBeGreaterThan(0);
    }
  });
});

describe('row <-> form', () => {
  it('round-trips a node through the form and back to a payload', () => {
    const form = nodeToForm(ROW);
    expect(form.label).toBe('Great Sinew');
    expect(form.kind).toBe('notable');
    expect(form.grants).toEqual([{ type: 'stat', stat: 'strength', value: 8 }]);
    expect(formToPayload(form)).toEqual({
      label: 'Great Sinew',
      kind: 'notable',
      grants: [{ type: 'stat', stat: 'strength', value: 8 }],
    });
  });

  it('sends only the three writable columns, never the structure', () => {
    const payload = formToPayload(nodeToForm(ROW));
    expect(Object.keys(payload).sort()).toEqual(['grants', 'kind', 'label']);
  });

  it('clones the grants so editing the form cannot mutate the cached row', () => {
    const form = nodeToForm(ROW);
    form.grants[0].value = 999;
    expect(ROW.grants[0].value).toBe(8);
  });

  it('coerces a text-input value to a number, keeping the sign', () => {
    const form = { label: 'x', kind: 'minor', grants: [{ type: 'resist', element: 'ice', value: '-15' }] };
    expect(formToPayload(form).grants[0].value).toBe(-15);
  });

  it('drops the fields a grant type does not use', () => {
    // Switching a grant from stat to damage in the form leaves `stat` behind;
    // sending it would store a row the backend validator passes but nothing
    // reads, which is indistinguishable from a working node in the UI.
    const form = { label: 'x', kind: 'minor', grants: [{ type: 'damage', stat: 'strength', element: 'fire', value: 12 }] };
    expect(formToPayload(form).grants[0]).toEqual({ type: 'damage', element: 'fire', value: 12 });
  });

  it('trims the label', () => {
    expect(formToPayload({ label: '  Padded  ', kind: 'minor', grants: [] }).label).toBe('Padded');
  });
});

describe('validation', () => {
  const ok = { label: 'Fine', kind: 'minor', grants: [{ type: 'stat', stat: 'wisdom', value: 2 }] };

  it('accepts a well-formed node', () => {
    expect(validateNodeForm(ok)).toEqual({ ok: true, errors: [] });
  });

  it('requires a label', () => {
    expect(validateNodeForm({ ...ok, label: '   ' }).errors).toEqual(['Label is required']);
  });

  it('rejects a kind the editor may not set', () => {
    expect(validateNodeForm({ ...ok, kind: 'start' }).errors)
      .toEqual(['A start node cannot be created or edited here']);
    expect(validateNodeForm({ ...ok, kind: 'legendary' }).errors)
      .toEqual(['Kind must be minor, notable or keystone']);
  });

  it('names the offending grant by its position', () => {
    const r = validateNodeForm({
      ...ok,
      grants: [
        { type: 'stat', stat: 'wisdom', value: 2 },
        { type: 'stat', stat: 'strenght', value: 2 },
        { type: 'damage', element: 'fire', value: 'abc' },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([
      'Grant 2: unknown stat "strenght"',
      'Grant 3: value must be a number',
    ]);
  });

  // One case per axis. A validator that only checks `stat` is exactly as broken
  // as one that checks nothing, for the other five grant types.
  it.each([
    [{ type: 'wat', value: 1 }, 'Grant 1: unknown type "wat"'],
    [{ type: 'resource', pool: 'health', value: 10 }, 'Grant 1: unknown resource pool "health"'],
    [{ type: 'damage', element: 'holy', value: 10 }, 'Grant 1: unknown element "holy"'],
    [{ type: 'resist', element: 'psychic', value: 10 }, 'Grant 1: unknown element "psychic"'],
    [{ type: 'status', status: 'poison', value: 10 }, 'Grant 1: unknown status "poison"'],
    [{ type: 'rule', rule: 'lifeCostMultiplyer', value: 1 }, 'Grant 1: unknown rule "lifeCostMultiplyer"'],
    [{ type: 'stat', value: 2 }, 'Grant 1: unknown stat "undefined"'],
  ])('rejects %j', (grant, message) => {
    const r = validateNodeForm({ ...ok, grants: [grant] });
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([message]);
  });

  // Every one of these is a finite number after Number(), and every one of them
  // means "the admin left the box alone".
  it.each([[''], [null], [undefined], [true], [[]], ['  ']])(
    'rejects %j as a value rather than storing it as 0', (value) => {
      const r = validateNodeForm({ ...ok, grants: [{ type: 'stat', stat: 'wisdom', value }] });
      expect(r.ok).toBe(false);
      expect(r.errors).toEqual(['Grant 1: value must be a number']);
    },
  );

  it('accepts 0 and a negative number, which are legitimate grant values', () => {
    expect(validateNodeForm({ ...ok, grants: [{ type: 'stat', stat: 'wisdom', value: 0 }] }).ok).toBe(true);
    expect(validateNodeForm({ ...ok, grants: [{ type: 'resist', element: 'ice', value: '-15' }] }).ok).toBe(true);
  });

  it('accepts an empty grant list — a node may deliberately grant nothing', () => {
    expect(validateNodeForm({ ...ok, grants: [] }).ok).toBe(true);
  });

  it('reports every problem at once rather than only the first', () => {
    const r = validateNodeForm({ label: '', kind: 'legendary', grants: [{ type: 'stat', stat: 'nope', value: 1 }] });
    expect(r.errors).toEqual([
      'Label is required',
      'Kind must be minor, notable or keystone',
      'Grant 1: unknown stat "nope"',
    ]);
  });
});

describe('grantSummary', () => {
  it('renders one readable line per grant for the browser list', () => {
    expect(grantSummary([
      { type: 'stat', stat: 'strength', value: 30 },
      { type: 'resource', pool: 'hp', value: 150 },
      { type: 'rule', rule: 'lifeCostMultiplier', value: 0.75 },
    ])).toBe('+30 strength, +150 max hp, lifeCostMultiplier x0.75');
  });

  it('renders the damage, resist and status forms', () => {
    expect(grantSummary([{ type: 'damage', element: 'fire', value: 35 }])).toBe('+35% fire damage');
    expect(grantSummary([{ type: 'resist', element: 'ice', value: -15 }])).toBe('-15% ice resistance');
    expect(grantSummary([{ type: 'status', status: 'burn', value: 1 }])).toBe('your hits burn');
  });

  it('says so when a node grants nothing', () => {
    expect(grantSummary([])).toBe('—');
    expect(grantSummary(null)).toBe('—');
  });
});
