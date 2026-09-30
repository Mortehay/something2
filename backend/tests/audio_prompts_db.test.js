const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const store = require('../src/services/audioPrompts');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

test('audioPrompts store', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const key = `ap-${process.pid}-${Date.now()}`;
  t.after(async () => {
    try { await pool.query('DELETE FROM audio_prompts WHERE subject_key = $1', [key]); } finally { await pool.end(); }
  });

  assert.equal(await store.getActive(pool, 'world', key, 'music'), null);

  const a = await store.save(pool, 'world', key, 'music', {
    style: 'village', text: '  calm lute  ', sourceInput: 'ctx-1', model: 'qwen', via: 'box',
  });
  assert.equal(a.text, 'calm lute', 'trimmed');
  assert.deepEqual([a.style, a.source_input, a.model, a.via], ['village', 'ctx-1', 'qwen', 'box']);

  const b = await store.save(pool, 'world', key, 'music', { style: 'village', text: '' }, { expectActiveId: a.id });
  assert.equal(b.text, '', "'' is stored, not turned into null");
  assert.equal(b.source_input, null, 'hand-written row has no source_input');
  assert.equal((await store.getActive(pool, 'world', key, 'music')).id, b.id);

  const long = await store.save(pool, 'world', key, 'music', { text: 'x'.repeat(1200) });
  assert.equal(long.text.length, store.MAX_PROMPT_TEXT);

  await assert.rejects(
    store.save(pool, 'world', key, 'music', { text: 'stale edit' }, { expectActiveId: a.id }),
    (err) => err.status === 409, 'an edit based on a superseded row is refused');

  // Race: two saves with no expectActiveId at the same time -- both may not
  // win, and the loser must be a 409, never a 500.
  const results = await Promise.allSettled([
    store.save(pool, 'world', key, 'ambience', { text: 'one' }),
    store.save(pool, 'world', key, 'ambience', { text: 'two' }),
  ]);
  for (const r of results) if (r.status === 'rejected') assert.equal(r.reason.status, 409, r.reason.message);
  const active = await pool.query(
    "SELECT count(*)::int AS n FROM audio_prompts WHERE subject_key = $1 AND slot = 'ambience' AND active", [key]);
  assert.equal(active.rows[0].n, 1);

  const bySlot = await store.listForSubject(pool, 'world', key);
  assert.equal(bySlot.music.active.id, long.id);
  // Only `a` and `b` were ever committed as superseded; the 409 above never
  // wrote a row (a conflict is refused, not recorded), so history is 2.
  assert.equal(bySlot.music.history.length, 2, 'two superseded music rows');
  assert.ok((await store.listAllActive(pool)).some((r) => r.subject_key === key && r.slot === 'music'));
});

// A PoolClient (from pool.connect()) is a pg Client under the hood. save()
// must recognize that and run on it directly -- not call .connect() again
// (which throws on an already-connected Client) -- and must leave
// transaction control (COMMIT/ROLLBACK) to the caller.
test('audioPrompts store: caller-owned client', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const key = `ap-client-${process.pid}-${Date.now()}`;
  t.after(async () => {
    try { await pool.query('DELETE FROM audio_prompts WHERE subject_key = $1', [key]); } finally { await pool.end(); }
  });

  const c = await pool.connect();
  await c.query('BEGIN');
  const first = await store.save(c, 'world', key, 'music', { text: 'one' });
  const second = await store.save(c, 'world', key, 'music', { text: 'two' }, { expectActiveId: first.id });
  await c.query('COMMIT');
  c.release();

  const active = await pool.query(
    "SELECT count(*)::int AS n FROM audio_prompts WHERE subject_key = $1 AND slot = 'music' AND active", [key]);
  assert.equal(active.rows[0].n, 1, 'exactly one active row after commit');
  const bySlot = await store.listForSubject(pool, 'world', key);
  assert.equal(bySlot.music.active.id, second.id);
  assert.equal(bySlot.music.history.length, 1, 'one superseded row');

  // A stale expectActiveId must still be refused with 409 while a
  // caller-owned transaction is open -- and since the caller owns the
  // transaction, save() must NOT roll it back itself; that's on the caller.
  const c2 = await pool.connect();
  await c2.query('BEGIN');
  await assert.rejects(
    store.save(c2, 'world', key, 'music', { text: 'stale' }, { expectActiveId: first.id }),
    (err) => err.status === 409, 'stale expectActiveId is refused inside the caller-owned transaction');
  await c2.query('ROLLBACK');
  c2.release();

  const activeAfter = await pool.query(
    "SELECT count(*)::int AS n FROM audio_prompts WHERE subject_key = $1 AND slot = 'music' AND active", [key]);
  assert.equal(activeAfter.rows[0].n, 1, 'still exactly one active row after the rollback');
});
