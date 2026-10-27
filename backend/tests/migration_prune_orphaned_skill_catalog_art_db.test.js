// Migration 1714440740000: catalog_art can hold a 'skill' row for an id
// that was renamed or removed from seeds/data/skills.js -- dru_charm_creature
// was one such orphan (never a real Druid skill; the orphaned row made
// /api/game-art report 301 skill keys against a 300-skill catalog). Runs the
// migration's SQL against real rows inside a transaction that is always
// rolled back, so the database ends as it started.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { PRUNE_SQL } = require('../migrations/1714440740000_prune_orphaned_skill_catalog_art');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

test('prunes the orphaned dru_charm_creature skill art row and leaves a real one alone', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  const tag = `prune-${process.pid}-${Date.now()}`;
  const realKey = `${tag}-cul_plague_globule`;
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO catalog_art (subject_kind, subject_key, image) VALUES
         ('skill', 'dru_charm_creature', 'objects/dru_charm_creature/seeded/static.png'),
         ('skill', $1, 'objects/cul_plague_globule/seeded/static.png'),
         ('passive_label', 'dru_charm_creature', 'objects/dru_charm_creature_label/seeded/static.png')`,
      [realKey],
    );

    await client.query(PRUNE_SQL);

    const { rows } = await client.query(
      `SELECT subject_kind, subject_key FROM catalog_art
        WHERE subject_key IN ('dru_charm_creature', $1) ORDER BY subject_kind`,
      [realKey],
    );
    const remaining = rows.map((r) => `${r.subject_kind}:${r.subject_key}`);
    assert.deepStrictEqual(remaining, [`passive_label:dru_charm_creature`, `skill:${realKey}`],
      'only the skill-kind orphan is deleted; a same-key passive_label row and a real skill row survive');
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
