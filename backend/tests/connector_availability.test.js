'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createConnectorProbe } = require('../src/services/connectorAvailability.js');

const PROVIDERS = {
  4: { id: 4, modality: 'image' },
  9: { id: 9, modality: 'sprite' },
};

function probeWith(overrides = {}) {
  const calls = [];
  const probe = createConnectorProbe({
    loadProvider: async (id) => PROVIDERS[id] || null,
    box: { checkAuth: async (p) => { calls.push(['box', p.id]); return { ok: true, status: 200 }; } },
    discovery: { fetchModels: async (p) => { calls.push(['models', p.id]); return { ok: false, status: 401, error: 'service answered 401' }; } },
    ...overrides,
  });
  return { probe, calls };
}

test('each modality is checked by its own authenticated read', async () => {
  const { probe, calls } = probeWith();
  assert.deepEqual(await probe(9), { available: true, reason: null });
  assert.deepEqual(await probe(4), { available: false, reason: 'service answered 401' });
  assert.deepEqual(calls, [['box', 9], ['models', 4]]);
});

test('a provider deleted since the list was read is unavailable, not a crash', async () => {
  const { probe } = probeWith();
  assert.deepEqual(await probe(77), { available: false, reason: 'provider no longer exists' });
});

test('a throwing check reports its message', async () => {
  const { probe } = probeWith({ box: { checkAuth: async () => { throw new Error('boom'); } } });
  assert.deepEqual(await probe(9), { available: false, reason: 'boom' });
});

test('a check that never answers is unavailable within the timeout', async () => {
  const { probe } = probeWith({ timeoutMs: 10, box: { checkAuth: () => new Promise(() => {}) } });
  assert.deepEqual(await probe(9), { available: false, reason: 'no answer within 0.01s' });
});

test('the answer is cached, then checked again once it expires', async () => {
  let t = 1000;
  const { probe, calls } = probeWith({ now: () => t, ttlMs: 100 });
  await probe(9);
  t += 99;
  await probe(9);
  assert.equal(calls.length, 1);
  t += 1;
  await probe(9);
  assert.equal(calls.length, 2);
});
