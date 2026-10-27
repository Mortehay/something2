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

// The world kind must come from real rows: a village world reads as one, and a
// world with no fast travel and no village reads as a dungeon room.
test('world kind against real worlds and villages', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const village = (await pool.query(
      'SELECT w.name FROM worlds w JOIN villages v ON v.world_id = w.id WHERE w.allows_fast_travel ORDER BY w.name LIMIT 1')).rows[0];
    const room = (await pool.query(
      `SELECT w.name FROM worlds w WHERE NOT w.allows_fast_travel AND NOT w.is_entry AND w.width IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM villages v WHERE v.world_id = w.id)
         AND w.name !~ ': (Elite|End)$' ORDER BY w.name LIMIT 1`)).rows[0];
    assert.ok(village && room, 'scratch DB must have seeded maps (both specs)');
    const cat = await ctx.loadPromptCatalog(pool);
    assert.equal(ctx.worldKind(cat.worlds.get(village.name), village.name), 'overworld village');
    assert.equal(ctx.worldKind(cat.worlds.get(room.name), room.name), 'dungeon room');
    assert.match(ctx.buildContext(cat, 'world', room.name, 'music'), /; type: dungeon room;/);
  } finally { await pool.end(); }
});

// SOMET-605: literals captured from the scratch DB BEFORE the change.
test('SOMET-605: real ordinary creatures keep their exact prompt context', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const catalog = await ctx.loadPromptCatalog(pool);
    assert.equal(ctx.buildContext(catalog, 'creature', 'Slime', 'hurt', { cue: 'hit' }),
      'creature "Slime"; looks like: a translucent green slime blob; slot: hurt; sound cue: hit');
    assert.equal(ctx.buildContext(catalog, 'creature', 'Wolf', 'hurt', { cue: 'hit' }),
      'creature "Wolf"; looks like: a grey meadow wolf; slot: hurt; sound cue: hit');
    assert.equal(ctx.buildContext(catalog, 'creature', 'Titan Brute', 'hurt', { cue: 'hit' }),
      'creature "Titan Brute"; looks like: a hulking physical-touched titan creature; slot: hurt; sound cue: hit');
  } finally { await pool.end(); }
});

test('SOMET-605: the real Ignis row reaches the boss branch', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const catalog = await ctx.loadPromptCatalog(pool);
    const s = ctx.buildContext(catalog, 'creature', 'Ignis, the Magma Colossus', 'spawn');
    assert.match(s, /; boss tier: world; element: fire;/);
    assert.match(s, /slot: spawn \(/);
    assert.doesNotMatch(ctx.buildContext(catalog, 'creature', 'Slime', 'hurt', { cue: 'hit' }), /boss tier/);
  } finally { await pool.end(); }
});
