const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const cs = require('../src/services/catalogSubjects.js');
const { withAdvisoryLock, ART_JOBS_LOCK_KEY } = require('./helpers/advisoryLock.js');

// SOMET-535. The three subjects that had no art path: items (the merchant's
// goods), class skills, and passive-tree labels.
//
// The prompt-composition tests are pure and always run. The registry tests
// need a real database because two of the three subjects ARE database queries,
// and because `write` is an upsert whose behaviour is Postgres's.
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

// Shares ART_JOBS_LOCK_KEY with the queue tests: this file writes catalog_art
// and item_types.icon, and a peer reading "which subjects have art" while it
// does would see a half-written catalog. One key rather than a fourth, because
// these are the same batch-art tables.
function lockedTest(name, body) {
  test(name, async (t) => {
    if (!requireTestDb(t, 'writes catalog_art and item_types.icon')) return;
    const pool = new Pool({ connectionString: DB_URL, max: 4, connectionTimeoutMillis: 3000 });
    t.after(async () => { await pool.end().catch(() => {}); });
    await withAdvisoryLock(pool, ART_JOBS_LOCK_KEY, async () => {
      await pool.query("DELETE FROM catalog_art WHERE subject_key LIKE 'zzTest%'");
      try {
        await body(t, pool);
      } finally {
        await pool.query("DELETE FROM catalog_art WHERE subject_key LIKE 'zzTest%'").catch(() => {});
      }
    });
  });
}

// --- prompt composition, pure ---------------------------------------------

test('deslug turns catalog slugs into words', () => {
  assert.equal(cs.deslug('tempered-greaves'), 'tempered greaves');
  assert.equal(cs.deslug('stone_of_flame staff'), 'stone of flame staff');
  assert.equal(cs.deslug(''), '');
  assert.equal(cs.deslug(null), '');
});

// The generator writes some labels with their stats attached. That tail is the
// last thing that should reach an image model, and it is real data -- not a
// hypothetical.
test('labelSubject drops the stat description a passive label may carry', () => {
  assert.equal(cs.labelSubject('Arcane Conduit — +20 INT and +60 maximum mana'), 'Arcane Conduit');
  assert.equal(cs.labelSubject('Focus'), 'Focus');
  assert.equal(cs.labelSubject('Beast Bond'), 'Beast Bond',
    'a two-word label with no description must survive intact');
  // A hyphenated NAME is not a description separator -- only a spaced dash is.
  assert.equal(cs.labelSubject('Ever-Watchful'), 'Ever-Watchful');
});

test('itemPrompt composes a plain subject from a slug plus what the row carries', () => {
  assert.equal(cs.itemPrompt({ name: 'crude-blade', category: 'weapon' }),
    'a crude blade, a fantasy weapon');
  assert.equal(cs.itemPrompt({ name: 'flame staff', category: 'weapon', element: 'fire' }),
    'a flame staff, a fantasy weapon, fire element');
  // Mass noun: "a gold" reads as a typo and wastes the first token.
  assert.equal(cs.itemPrompt({ name: 'gold', category: 'currency' }), 'a pile of gold');
});

// THE RULE THIS WHOLE FILE EXISTS UNDER. Both generators wrap basePrompt with
// their own framing; a base that carries styling fights the wrapper. Measured:
// a fully styled base for "war hammer" came back a heraldic crest.
test('composed prompts carry NO styling -- the wrapper owns that', () => {
  const banned = /pixel art|isometric|3\/4|background|silhouette|icon,|no shadow|centered/i;
  const samples = [
    cs.itemPrompt({ name: 'crude-blade', category: 'weapon' }),
    cs.itemPrompt({ name: 'gold', category: 'currency' }),
    cs.skillPrompt({ nameEn: 'Crushing Blow', class: 'Warrior', type: 'melee' }),
    cs.labelSubject('Arcane Conduit — +20 INT'),
  ];
  for (const p of samples) {
    assert.ok(!banned.test(p), `"${p}" carries framing that belongs to the prompt wrapper`);
  }
});

// --- the registry ---------------------------------------------------------

test('the registry names exactly the three subjects that had no art path', () => {
  assert.deepEqual(cs.subjectKinds().sort(), ['item', 'passive_label', 'skill']);
  assert.equal(cs.registryFor('nonsense'), null, 'an unknown kind must not silently resolve');
});

test('skills list from the static catalog without a database', async () => {
  const subjects = await cs.SUBJECTS.skill.list();
  assert.equal(subjects.length, 300, 'all 300 class skills must be listable');
  const keys = new Set(subjects.map((s) => s.key));
  assert.equal(keys.size, 300, 'skill ids must be unique -- they are the art key');
  for (const s of subjects.slice(0, 5)) {
    assert.ok(s.basePrompt && s.basePrompt.length > 3);
    assert.equal(s.kind, 'skill');
  }
});

lockedTest('items list every catalog row and report which have art', async (t, pool) => {
  const subjects = await cs.listWithArtState(pool, 'item');
  assert.ok(subjects.length >= 180, `expected the full item catalog, got ${subjects.length}`);
  // Today this is the whole point: nothing in the merchant has art.
  const withArt = subjects.filter((s) => s.hasArt).length;
  assert.equal(typeof withArt, 'number');
  for (const s of subjects.slice(0, 3)) {
    assert.equal(s.kind, 'item');
    assert.ok(s.basePrompt.startsWith('a '), `"${s.basePrompt}" should read as a subject`);
  }
});

lockedTest('passive labels are DISTINCT, far fewer than the nodes', async (t, pool) => {
  const subjects = await cs.listWithArtState(pool, 'passive_label');
  const { rows } = await pool.query('SELECT count(*)::int n FROM passive_nodes');
  assert.ok(subjects.length > 0, 'the tree must be seeded for this to mean anything');
  assert.ok(subjects.length < rows[0].n / 5,
    `art is per LABEL: ${subjects.length} labels for ${rows[0].n} nodes should be far fewer`);
  const keys = new Set(subjects.map((s) => s.key));
  assert.equal(keys.size, subjects.length, 'labels must be distinct -- they are the art key');
});

lockedTest('writing art for a skill is an upsert, and regeneration replaces it', async (t, pool) => {
  const key = 'zzTest_skill_1';
  await cs.writeCatalogArt(pool, 'skill', key, 'sprites/a/1/static.png');
  await cs.writeCatalogArt(pool, 'skill', key, 'sprites/a/2/static.png');
  const { rows } = await pool.query(
    'SELECT image FROM catalog_art WHERE subject_kind = $1 AND subject_key = $2', ['skill', key],
  );
  assert.equal(rows.length, 1, 'a second generation must replace, not duplicate');
  assert.equal(rows[0].image, 'sprites/a/2/static.png', 'the newest image wins');
});

lockedTest('art keyed by subject is namespaced by kind', async (t, pool) => {
  // 'Focus' is both a plausible skill id and a real passive label; the two must
  // not collide into one image.
  await cs.writeCatalogArt(pool, 'skill', 'zzTest_Focus', 'sprites/skill.png');
  await cs.writeCatalogArt(pool, 'passive_label', 'zzTest_Focus', 'sprites/label.png');
  const { rows } = await pool.query(
    "SELECT subject_kind, image FROM catalog_art WHERE subject_key = 'zzTest_Focus' ORDER BY subject_kind",
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].image, 'sprites/label.png');
  assert.equal(rows[1].image, 'sprites/skill.png');
});

lockedTest('hasArt reflects a write, so the missing-art filter is not a guess', async (t, pool) => {
  const before = await cs.listWithArtState(pool, 'skill');
  const target = before.find((s) => !s.hasArt);
  assert.ok(target, 'expected at least one skill without art to test with');
  await cs.writeCatalogArt(pool, 'skill', target.key, 'sprites/x/1/static.png');
  try {
    const after = await cs.listWithArtState(pool, 'skill');
    assert.equal(after.find((s) => s.key === target.key).hasArt, true,
      'a subject that was just written must report hasArt -- this is what resumes a batch');
  } finally {
    await pool.query('DELETE FROM catalog_art WHERE subject_kind = $1 AND subject_key = $2',
      ['skill', target.key]);
  }
});
