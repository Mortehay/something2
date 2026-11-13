// Amber Stance settings: pure assertValid / DEFAULTS checks (no DB).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, assertValid } = require('../src/services/gameSettings.js');

test('amber defaults are 30 s cap and 10 s after ready', () => {
  assert.equal(DEFAULTS.amber_max_seconds, 30);
  assert.equal(DEFAULTS.amber_after_ready_seconds, 10);
});

test('amber_max_seconds accepts 1..300 integers only', () => {
  assertValid('amber_max_seconds', 30);
  assertValid('amber_max_seconds', 1);
  assertValid('amber_max_seconds', 300);
  for (const bad of [0, -1, 301, 2.5, '30', null, NaN]) {
    assert.throws(() => assertValid('amber_max_seconds', bad), /amber_max_seconds/, String(bad));
  }
});

test('amber_after_ready_seconds accepts 0..300 integers only', () => {
  assertValid('amber_after_ready_seconds', 0);
  assertValid('amber_after_ready_seconds', 10);
  assertValid('amber_after_ready_seconds', 300);
  for (const bad of [-1, 301, 2.5, '10', null, NaN]) {
    assert.throws(() => assertValid('amber_after_ready_seconds', bad), /amber_after_ready_seconds/, String(bad));
  }
});

test('image_auto_shrink is a boolean, default true', () => {
  assert.equal(DEFAULTS.image_auto_shrink, true);
  assertValid('image_auto_shrink', true);
  assertValid('image_auto_shrink', false);
  for (const bad of [0, 1, 'true', null, undefined]) {
    assert.throws(() => assertValid('image_auto_shrink', bad), /image_auto_shrink/, String(bad));
  }
});

test('the defaults pass their own validator', () => {
  assertValid('amber_max_seconds', DEFAULTS.amber_max_seconds);
  assertValid('amber_after_ready_seconds', DEFAULTS.amber_after_ready_seconds);
});
