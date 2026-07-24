'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalizeClaim, fingerprint, validate } = require('../lib/finding.js');

function valid(overrides) {
  return Object.assign({
    id: 'F-001',
    surface: 'backend-api',
    file: 'backend/src/index.js:42',
    lens: 'security',
    severity: 'P0',
    source: 'static',
    claim: 'Route does not check authorization.',
    failure_scenario: 'A player token reaches POST /maps and creates a map.',
    proposed_fix: 'Wrap the route in requireAdmin(pool).',
    verification: 'Call POST /maps with a player token; expect 403.',
    status: 'open',
    plane_id: null,
  }, overrides);
}

test('normalizeClaim collapses case, whitespace and punctuation', () => {
  assert.strictEqual(
    normalizeClaim('  Route  does NOT check\tauthorization!! '),
    'route does not check authorization'
  );
});

test('fingerprint is a 40 char hex string', () => {
  assert.match(fingerprint(valid()), /^[0-9a-f]{40}$/);
});

test('fingerprint is stable across line number changes', () => {
  const a = fingerprint(valid({ file: 'backend/src/index.js:42' }));
  const b = fingerprint(valid({ file: 'backend/src/index.js:915' }));
  assert.strictEqual(a, b);
});

test('fingerprint is stable across cosmetic claim rewording', () => {
  const a = fingerprint(valid({ claim: 'Route does not check authorization.' }));
  const b = fingerprint(valid({ claim: 'route  does not check AUTHORIZATION' }));
  assert.strictEqual(a, b);
});

test('fingerprint differs when the file differs', () => {
  const a = fingerprint(valid({ file: 'backend/src/index.js:42' }));
  const b = fingerprint(valid({ file: 'backend/src/authority/loot.js:42' }));
  assert.notStrictEqual(a, b);
});

test('fingerprint differs when the lens differs', () => {
  assert.notStrictEqual(
    fingerprint(valid({ lens: 'security' })),
    fingerprint(valid({ lens: 'dry' }))
  );
});

test('validate accepts a well formed finding', () => {
  assert.deepStrictEqual(validate(valid()), []);
});

test('validate rejects an unknown severity', () => {
  const errors = validate(valid({ severity: 'P9' }));
  assert.ok(errors.some((e) => e.includes('severity')));
});

test('validate rejects an unknown surface', () => {
  const errors = validate(valid({ surface: 'engine' }));
  assert.ok(errors.some((e) => e.includes('surface')));
});

test('validate requires a non-empty failure_scenario', () => {
  const errors = validate(valid({ failure_scenario: '   ' }));
  assert.ok(errors.some((e) => e.includes('failure_scenario')));
});

test('validate caps a finding with no consequence at P3', () => {
  // The verification bar: severity above P3 demands a failure scenario that
  // names both a trigger and an outcome. A bare structural remark cannot be P0.
  const errors = validate(valid({
    severity: 'P0',
    failure_scenario: 'Violates SRP.',
  }));
  assert.ok(errors.some((e) => e.includes('P3')));
});

test('validate accepts a bare structural remark at P3', () => {
  assert.deepStrictEqual(
    validate(valid({ severity: 'P3', failure_scenario: 'Violates SRP.' })),
    []
  );
});

test('validate rejects a file path without a line number', () => {
  const errors = validate(valid({ file: 'backend/src/index.js' }));
  assert.ok(errors.some((e) => e.includes('file')));
});
