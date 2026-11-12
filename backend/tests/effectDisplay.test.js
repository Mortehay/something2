// SOMET-769: the display rules every effect table shares, and the bulk write. Pure + a fake db.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DISPLAYS, DEFAULT_DISPLAY, isDisplay, displayError, displayWrite, setDisplayForAll } = require('../src/services/effectDisplay.js');
const { setBuffDisplayForAll, VISUAL_BUFF_IDS } = require('../src/services/buffVisuals.js');

test('the two displays, sprite by default', () => {
  assert.deepEqual([...DISPLAYS], ['code', 'sprite']);
  assert.equal(DEFAULT_DISPLAY, 'sprite');
  assert.equal(isDisplay('code'), true);
  assert.equal(isDisplay('Sprite'), false);
});

test('a body without the key is fine; a present key must be code or sprite', () => {
  assert.equal(displayError({}), null);
  assert.equal(displayError(null), null);
  assert.equal(displayError({ display: 'code' }), null);
  assert.match(displayError({ display: 'both' }), /display must be one of code, sprite/);
  assert.match(displayError({ display: null }), /display must be one of/);
});

test('displayWrite: nothing for a save without the key, the default for an insert', () => {
  assert.deepEqual(displayWrite({}), { cols: [], vals: [] });
  assert.deepEqual(displayWrite({ display: 'code' }), { cols: ['display'], vals: ['code'] });
  assert.deepEqual(displayWrite({}, { withDefault: true }), { cols: ['display'], vals: ['sprite'] });
  assert.deepEqual(displayWrite({ display: 'code' }, { withDefault: true }), { cols: ['display'], vals: ['code'] });
});

function fakeDb(rowCount = 3) {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rowCount, rows: [] }; } };
}

test('setDisplayForAll writes one UPDATE on the kind\'s table, touching updated_at where the table has it', async () => {
  const db = fakeDb(7);
  assert.equal(await setDisplayForAll(db, 'vfx', 'code'), 7);
  assert.match(db.calls[0].sql, /^UPDATE vfx_effects SET display = \$1$/);
  assert.deepEqual(db.calls[0].params, ['code']);
  await setDisplayForAll(db, 'aura', 'sprite');
  assert.match(db.calls[1].sql, /^UPDATE aura_effects SET display = \$1, updated_at = now\(\)$/);
  await setDisplayForAll(db, 'status', 'sprite');
  assert.match(db.calls[2].sql, /^UPDATE status_visuals SET display = \$1, updated_at = now\(\)$/);
});

test('setDisplayForAll refuses an unknown kind or display before touching the db', async () => {
  const db = fakeDb();
  await assert.rejects(() => setDisplayForAll(db, 'vfx_effects', 'code'), /unknown effect kind/);
  await assert.rejects(() => setDisplayForAll(db, 'vfx', 'both'), /display must be one of/);
  assert.equal(db.calls.length, 0);
});

test('buff for-all first creates the missing rows from their defaults, then updates the table', async () => {
  const calls = [];
  const have = VISUAL_BUFF_IDS.slice(1); // every visual buff but the first has a row
  const db = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/^SELECT skill_id FROM buff_visuals/.test(sql)) return { rows: have.map((skill_id) => ({ skill_id })), rowCount: have.length };
      if (/^INSERT INTO buff_visuals/.test(sql)) return { rows: [{}], rowCount: 1 };
      return { rows: [], rowCount: VISUAL_BUFF_IDS.length };
    },
  };
  assert.equal(await setBuffDisplayForAll(db, 'code'), VISUAL_BUFF_IDS.length);
  const inserts = calls.filter((c) => /^INSERT INTO buff_visuals/.test(c.sql));
  assert.equal(inserts.length, 1);
  assert.ok(inserts[0].params.includes(VISUAL_BUFF_IDS[0]));
  assert.ok(inserts[0].params.includes('code'));
  assert.match(calls[calls.length - 1].sql, /^UPDATE buff_visuals SET display = \$1, updated_at = now\(\)$/);
  await assert.rejects(() => setBuffDisplayForAll(db, 'both'), { status: 400 });
});
