// refreshAmberConfig (server.js): settings + approved variants into amber.js.
// Fake pools only, no DB.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { refreshAmberConfig } = require('../src/authority/server.js');
const { setAmberConfig, getAmberConfig } = require('../src/authority/amber.js');

function fakePool({ settings = [], variants = null }) {
  return {
    query: async (sql) => {
      if (/FROM game_settings/.test(sql)) return { rows: settings };
      if (/FROM status_visuals/.test(sql)) {
        if (variants === null) throw new Error('relation "status_visuals" does not exist');
        return { rows: variants.map((v) => ({ variant: v })) };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test('reads both settings and the approved variants', async () => {
  setAmberConfig({ maxMs: 1, afterReadyMs: 1, variants: [] });
  await refreshAmberConfig(fakePool({
    settings: [{ key: 'amber_max_seconds', value: 45 }, { key: 'amber_after_ready_seconds', value: 5 }],
    variants: [2, 7],
  }));
  assert.deepEqual(getAmberConfig(), { maxMs: 45000, afterReadyMs: 5000, variants: [2, 7] });
});

test('no rows and no status_visuals table: defaults, no variants', async () => {
  setAmberConfig({ maxMs: 1, afterReadyMs: 1, variants: [9] });
  await refreshAmberConfig(fakePool({}));
  assert.deepEqual(getAmberConfig(), { maxMs: 30000, afterReadyMs: 10000, variants: [] });
});

test('an invalid stored value falls back to that key\'s default', async () => {
  await refreshAmberConfig(fakePool({
    settings: [{ key: 'amber_max_seconds', value: 0 }, { key: 'amber_after_ready_seconds', value: 'x' }],
    variants: [],
  }));
  assert.deepEqual(getAmberConfig(), { maxMs: 30000, afterReadyMs: 10000, variants: [] });
});

test('a failing settings read never throws', async () => {
  await refreshAmberConfig({ query: async () => { throw new Error('down'); } });
  assert.equal(getAmberConfig().maxMs, 30000);
});
