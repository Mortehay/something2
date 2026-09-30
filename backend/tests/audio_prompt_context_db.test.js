// backend/tests/audio_prompt_context_db.test.js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const ctx = require('../src/services/audioPromptContext');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

test('audioPromptContext against real catalog rows', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const creature = (await pool.query('SELECT name FROM entity_types WHERE is_creature ORDER BY name LIMIT 1')).rows[0];
  assert.ok(creature, 'scratch DB must have seeded catalogs (Task 1 Step 2)');
  const ids = [];
  t.after(async () => {
    try { if (ids.length) await pool.query('DELETE FROM art_prompt_descriptions WHERE id = ANY($1)', [ids]); } finally { await pool.end(); }
  });

  const before = await ctx.contextFor(pool, 'creature', creature.name, 'hurt', { cue: 'hit' });
  assert.ok(before && before.startsWith(`creature "${creature.name}"`), before);
  assert.equal(/pixel art|transparent background/i.test(before), false, `styling leaked: ${before}`);

  // Deactivate any existing active description for the duration? No -- only
  // insert one if none exists, so the shared state is never altered.
  const existing = await pool.query(
    "SELECT text FROM art_prompt_descriptions WHERE subject_kind = 'entity' AND subject_key = $1 AND active", [creature.name]);
  let expected = existing.rows[0] && existing.rows[0].text;
  if (!expected) {
    expected = `ctx-test-${process.pid} mossy hide`;
    ids.push((await pool.query(
      "INSERT INTO art_prompt_descriptions (subject_kind, subject_key, text) VALUES ('entity', $1, $2) RETURNING id",
      [creature.name, expected])).rows[0].id);
  }
  const after = await ctx.contextFor(pool, 'creature', creature.name, 'hurt', { cue: 'hit' });
  assert.ok(after.includes(`looks like: ${expected}`), `art description not used: ${after}`);
  if (ids.length) assert.equal(ctx.isStale({ source_input: before }, after), true, 'a new art description makes the prompt stale');
});
