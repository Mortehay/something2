const test = require('node:test');
const assert = require('node:assert');
const { canonicalValue, canonicalRow, rowHash, stableStringify, deterministicUuid } = require('../src/services/seedSync/canonical.js');

test('canonical normalizes numeric strings, dates and jsonb key order', () => {
  assert.strictEqual(canonicalValue('0.50', 'numeric'), 0.5);
  assert.strictEqual(canonicalValue(null, 'numeric'), null);
  assert.strictEqual(canonicalValue(new Date('2026-10-18T00:00:00Z'), 'timestamp with time zone'), '2026-10-18T00:00:00.000Z');
  assert.strictEqual(canonicalValue('9007', 'bigint'), 9007);
  assert.strictEqual(canonicalValue('2026-10-18', 'date'), '2026-10-18');
  assert.strictEqual(
    stableStringify(canonicalValue({ b: 1, a: { d: 1, c: 2 } }, 'jsonb')),
    stableStringify({ a: { c: 2, d: 1 }, b: 1 }),
  );
  assert.deepStrictEqual(canonicalValue([{ b: 1, a: 2 }, 3], 'jsonb').map((x) => (typeof x === 'object' ? Object.keys(x) : x)), [['a', 'b'], 3]);
  assert.strictEqual(canonicalValue('x', 'text'), 'x');
});

test('rowHash ignores key order', () => {
  assert.strictEqual(rowHash({ a: 1, b: 2 }), rowHash({ b: 2, a: 1 }));
  assert.notStrictEqual(rowHash({ a: 1 }), rowHash({ a: 2 }));
});

test('deterministicUuid is stable and uuid-shaped', () => {
  const u = deterministicUuid('quests', 'k');
  assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.strictEqual(u, deterministicUuid('quests', 'k'));
  assert.notStrictEqual(u, deterministicUuid('quests', 'k2'));
});

test('canonicalRow keeps only listed columns plus sync_uuid, sorted', () => {
  const cols = [{ name: 'zeta', dataType: 'text' }, { name: 'alpha', dataType: 'numeric' }];
  const r = canonicalRow({ id: 5, zeta: 'z', alpha: '1.0', sync_uuid: 'u' }, cols);
  assert.deepStrictEqual(Object.keys(r), ['alpha', 'sync_uuid', 'zeta']);
  assert.strictEqual(r.alpha, 1);
});

test('date and timestamp-without-tz Dates use LOCAL parts (TZ independent); timestamptz is absolute', () => {
  assert.strictEqual(canonicalValue(new Date(2026, 9, 18, 0, 0, 0), 'date'), '2026-10-18');
  assert.strictEqual(canonicalValue(new Date(2026, 9, 18, 0, 0, 0), 'timestamp without time zone'), '2026-10-18T00:00:00.000');
  assert.strictEqual(canonicalValue(new Date(2026, 0, 5, 23, 59, 58, 7), 'timestamp without time zone'), '2026-01-05T23:59:58.007');
  assert.strictEqual(canonicalValue(new Date('2026-10-18T12:34:56.789Z'), 'timestamp with time zone'), '2026-10-18T12:34:56.789Z');
  assert.strictEqual(canonicalValue('2026-10-18 01:02:03', 'timestamp without time zone'), '2026-10-18 01:02:03');
});
