const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const desc = require('../src/services/artPromptDescriptions.js');

// SOMET-551. The written description that replaces the catalogue template.
//
// THE ASSERTION THAT MATTERS MOST IS THE ONE ABOUT NOTHING CHANGING. 87 items
// already have art generated from the template; if storing this feature
// silently altered the prompt for subjects that have no description, a later
// regeneration would produce a different image for a reason nobody could see.
// So "no description leaves the phrase exactly as it was" is tested first and
// is the case a careless refactor breaks.
//
// A vacuous test here would assert that a row is stored. Storage is the easy
// half; what matters is which phrase comes OUT.
const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

function requireTestDb(t, why) {
  if (!process.env.TEST_DATABASE_URL) {
    const msg = `TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (${why})`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return false;
  }
  return true;
}

function dbTest(name, body) {
  test(name, async (t) => {
    if (!requireTestDb(t, 'writes art_prompt_descriptions')) return;
    const pool = new Pool({ connectionString: DB_URL, max: 4, connectionTimeoutMillis: 3000 });
    t.after(async () => { await pool.end().catch(() => {}); });
    await pool.query("DELETE FROM art_prompt_descriptions WHERE subject_key LIKE 'ds_%'");
    try {
      await body(t, pool);
    } finally {
      await pool.query("DELETE FROM art_prompt_descriptions WHERE subject_key LIKE 'ds_%'")
        .catch(() => {});
    }
  });
}

dbTest('with NO description the catalogue phrase is returned untouched', async (t, pool) => {
  const out = await desc.subjectPhrase(pool, 'item', 'ds_none', 'a sword, a fantasy weapon');
  assert.equal(out.phrase, 'a sword, a fantasy weapon',
    'a subject with no description must compose exactly as it does today');
  assert.equal(out.promptModel, null,
    'null prompt_model is the useful fact: this subject has never been described');
});

dbTest('a stored description replaces the catalogue phrase', async (t, pool) => {
  await desc.replace(pool, 'item', 'ds_wand', {
    text: 'gnarled wooden wand tipped with a blue crystal', length: 'short', model: 'test-model',
  });
  const out = await desc.subjectPhrase(pool, 'item', 'ds_wand', 'a wand, a fantasy weapon');
  assert.equal(out.phrase, 'gnarled wooden wand tipped with a blue crystal');
  assert.equal(out.promptModel, 'test-model', 'the history must be able to say who wrote it');
});

// A re-run is a NEW row, not an overwrite: art_generations records the prompt
// that produced an image, and the description in force then must stay readable.
dbTest('a re-run replaces the active one and keeps the old readable', async (t, pool) => {
  const first = await desc.replace(pool, 'item', 'ds_hist', { text: 'first take', model: 'm1' });
  const second = await desc.replace(pool, 'item', 'ds_hist', { text: 'second take', model: 'm2' });
  assert.notEqual(first.id, second.id, 'a re-run must not overwrite the row');

  const active = await desc.getActive(pool, 'item', 'ds_hist');
  assert.equal(active.text, 'second take');

  const all = await desc.listAll(pool, 'item', 'ds_hist');
  assert.equal(all.length, 2, 'the earlier description must remain readable');
  assert.equal(all.find((r) => r.id === first.id).active, false);
});

// Enforced by a partial unique index rather than by the code path, because two
// concurrent re-runs would otherwise leave two actives and the composed prompt
// would depend on which row came back first.
dbTest('only ONE description can be active for a subject', async (t, pool) => {
  await desc.replace(pool, 'item', 'ds_one', { text: 'a' });
  await desc.replace(pool, 'item', 'ds_one', { text: 'b' });
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM art_prompt_descriptions WHERE subject_key = 'ds_one' AND active",
  );
  assert.equal(rows[0].n, 1);

  // And the database refuses a second active even if something bypasses replace().
  await assert.rejects(
    () => pool.query(
      `INSERT INTO art_prompt_descriptions (subject_kind, subject_key, text, active)
       VALUES ('item', 'ds_one', 'sneaky', true)`,
    ),
    /duplicate key|unique/i,
    'the index, not the code path, is what makes one-active true',
  );
});

dbTest('clearing drops back to the catalogue template', async (t, pool) => {
  await desc.replace(pool, 'item', 'ds_clear', { text: 'written phrase' });
  assert.equal(await desc.clear(pool, 'item', 'ds_clear'), true);

  const out = await desc.subjectPhrase(pool, 'item', 'ds_clear', 'a fallback, a fantasy weapon');
  assert.equal(out.phrase, 'a fallback, a fantasy weapon',
    'clearing must restore the template, not leave the subject with a dead description');
  // Clearing twice is not an error, it is a no-op with nothing to do.
  assert.equal(await desc.clear(pool, 'item', 'ds_clear'), false);
  // But the cleared text stays readable for the history.
  assert.equal((await desc.listAll(pool, 'item', 'ds_clear')).length, 1);
});

dbTest('an empty description is refused rather than stored', async (t, pool) => {
  assert.equal(await desc.replace(pool, 'item', 'ds_empty', { text: '   ' }), null);
  assert.equal((await desc.listAll(pool, 'item', 'ds_empty')).length, 0);
});

dbTest('an over-long description is capped, not rejected', async (t, pool) => {
  const saved = await desc.replace(pool, 'item', 'ds_long', { text: 'x'.repeat(2000) });
  assert.equal(saved.text.length, desc.MAX_TEXT);
});
