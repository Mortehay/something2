const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const {
  describeAll, selectSubjects, flagValue, unknownFlags,
} = require('../scripts/describe-subjects.js');
const descriptions = require('../src/services/artPromptDescriptions.js');

// SOMET-552. The batch authoring pass.
//
// WHAT ACTUALLY MATTERS HERE is not that it can write a description -- slice 1
// proved that against a live model. It is the loop AROUND the model:
//
//   * a killed run continues instead of restarting (530 subjects, hours, on a
//     machine that gets rebooted),
//   * a subject that already has ART is never re-described, because that would
//     silently change what its next regeneration produces,
//   * a run with the describer down stops instead of writing 530 identical
//     failures into a log and finishing looking like it tried.
//
// All three are properties of code that never calls the model, so the model is
// injected. A test that shelled out to qwen on CPU would take an hour and
// would still not pin any of the three.

const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

function dbTest(name, body) {
  test(name, async (t) => {
    if (!process.env.TEST_DATABASE_URL) {
      const msg = 'TEST_DATABASE_URL not set -- skipping to avoid mutating a real database';
      if (process.env.CI) assert.fail(msg);
      t.skip(msg);
      return;
    }
    const pool = new Pool({ connectionString: DB_URL, max: 4, connectionTimeoutMillis: 3000 });
    t.after(async () => { await pool.end().catch(() => {}); });
    // These run over REAL catalogue subjects, so they cannot clean up by key
    // prefix the way the unit-scale tests do. Deleting by "rows that did not
    // exist when I started" removes exactly what this test wrote and nothing a
    // peer left behind -- the same mistake, wiping a concurrent run's rows in
    // teardown, has been made in this suite before.
    const before = await pool.query('SELECT coalesce(max(id), 0) AS id FROM art_prompt_descriptions');
    const floor = before.rows[0].id;
    try {
      await body(t, pool, floor);
    } finally {
      await pool.query('DELETE FROM art_prompt_descriptions WHERE id > $1', [floor])
        .catch(() => {});
    }
  });
}

// A describer that answers instantly and records what it was asked.
function fakeDescriber(answer = 'winged boot') {
  const seen = [];
  const fn = async (subject, opts) => {
    seen.push({ key: subject.key, length: opts.length, prompt: subject.basePrompt });
    return { text: typeof answer === 'function' ? answer(subject) : answer, model: 'fake', length: opts.length };
  };
  fn.seen = seen;
  return fn;
}

const quiet = () => {};

// --- the pure selection rules ---------------------------------------------

const SUBJECTS = [
  { kind: 'skill', key: 'a', name: 'A', basePrompt: 'a fireball', hasArt: false },
  { kind: 'skill', key: 'b', name: 'B', basePrompt: 'a frost nova', hasArt: true },
  { kind: 'skill', key: 'c', name: 'C', basePrompt: 'a war cry', hasArt: false },
  { kind: 'skill', key: 'd', name: 'D', basePrompt: '', hasArt: false },
];

test('a subject that already has a description is skipped -- this is the resume', () => {
  const active = new Map([['a', { text: 'x', source_prompt: 'a fireball' }]]);
  const { todo, skipped } = selectSubjects(SUBJECTS, active, {});
  assert.deepEqual(todo.map((s) => s.key), ['c']);
  assert.equal(skipped.described, 1);
  assert.equal(skipped.hasArt, 1, 'b already has art');
  assert.equal(skipped.noPrompt, 1, 'd has no subject phrase to describe');
});

test('a subject that already has ART is never re-described by default', () => {
  const { todo } = selectSubjects(SUBJECTS, new Map(), {});
  assert.ok(!todo.some((s) => s.key === 'b'),
    're-describing a subject with art would silently change its next regeneration');
  const withArt = selectSubjects(SUBJECTS, new Map(), { withArt: true });
  assert.ok(withArt.todo.some((s) => s.key === 'b'), '--with-art is how you ask for it');
});

test('a STALE description is skipped by default and picked up by --stale', () => {
  // The catalogue now says something else than when this was written.
  const active = new Map([['a', { text: 'x', source_prompt: 'a DIFFERENT thing' }]]);
  assert.deepEqual(selectSubjects(SUBJECTS, active, {}).todo.map((s) => s.key), ['c']);

  const { todo, skipped } = selectSubjects(SUBJECTS, active, { includeStale: true });
  assert.deepEqual(todo.map((s) => s.key), ['a', 'c']);
  assert.equal(skipped.stale, 0);
  assert.equal(todo[0].stale, true, 'the run must be able to say it is replacing a stale one');
});

test('--redo overrides every skip, including art', () => {
  const active = new Map([['a', { text: 'x', source_prompt: 'a fireball' }]]);
  const { todo } = selectSubjects(SUBJECTS, active, { redo: true });
  assert.deepEqual(todo.map((s) => s.key), ['a', 'b', 'c'],
    'only the subject with no prompt at all stays out');
});

test('the limit caps the run', () => {
  const { todo } = selectSubjects(SUBJECTS, new Map(), { limit: 1 });
  assert.equal(todo.length, 1);
});

// --- the loop, against a real database -------------------------------------

dbTest('a second run continues instead of restarting: the database is the cursor',
  async (t, pool) => {
    const describe = fakeDescriber();
    const first = await describeAll(pool, {
      kinds: ['skill'], describe, log: quiet, limit: 3,
    });
    assert.equal(first.written, 3);
    assert.equal(describe.seen.length, 3);

    const again = fakeDescriber();
    const second = await describeAll(pool, {
      kinds: ['skill'], describe: again, log: quiet, limit: 3,
    });
    // NOT "asks for nothing" -- a resumed run with work left does more work.
    // The property is that it never spends a minute of CPU on a subject that
    // is already done, and moves on to the next ones instead.
    const asked = again.seen.map((c) => c.key);
    const done = describe.seen.map((c) => c.key);
    assert.equal(asked.length, 3);
    assert.deepEqual(asked.filter((k) => done.includes(k)), [],
      'the model must not be asked again about a subject that already has a description');
    assert.equal(second.skipped.described, 3, 'and the three already written are counted as skipped');
  });

dbTest('what it writes is what the prompt then uses, with its source recorded',
  async (t, pool) => {
    const describe = fakeDescriber('winged boot');
    await describeAll(pool, { kinds: ['skill'], describe, log: quiet, limit: 1 });
    const key = describe.seen[0].key;

    const active = await descriptions.getActive(pool, 'skill', key);
    assert.equal(active.text, 'winged boot');
    assert.equal(active.model, 'fake');
    assert.equal(active.source_prompt, describe.seen[0].prompt,
      'without the catalogue phrase it was written from, staleness is unknowable');

    // The end of the wire: the phrase the dispatcher would build a prompt from.
    const used = await descriptions.subjectPhrase(pool, 'skill', key, active.source_prompt);
    assert.equal(used.phrase, 'winged boot');
    assert.equal(used.stale, false);

    // And the same subject read against a CHANGED catalogue phrase is stale --
    // still used, but no longer silently.
    const drifted = await descriptions.subjectPhrase(
      pool, 'skill', key, 'something the catalogue says now',
    );
    assert.equal(drifted.phrase, 'winged boot', 'a stale description is still used');
    assert.equal(drifted.stale, true, 'and is reported as stale');
  });

dbTest('a dry run asks the model and stores nothing', async (t, pool, floor) => {
  const describe = fakeDescriber();
  const stats = await describeAll(pool, {
    kinds: ['skill'], describe, log: quiet, limit: 2, dryRun: true,
  });
  assert.equal(stats.written, 2);
  assert.equal(describe.seen.length, 2);
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM art_prompt_descriptions WHERE id > $1', [floor],
  );
  assert.equal(rows[0].n, 0, 'a dry run that writes rows is not a dry run');
});

dbTest('it gives up when the describer is down instead of failing 300 times',
  async (t, pool) => {
    const down = async () => { throw new Error('fetch failed'); };
    const stats = await describeAll(pool, { kinds: ['skill'], describe: down, log: quiet });
    assert.equal(stats.abortedAfter, 5);
    assert.equal(stats.failed, 5, 'five attempts, not one per subject in the catalogue');
    assert.match(stats.lastError, /fetch failed/);
  });

// An empty answer from the model is REFUSED by the store (replace() returns
// null). Counting that as written is how a run reports success and leaves the
// subject on the template.
dbTest('an unstorable answer counts as a failure, not as a write', async (t, pool) => {
  const blank = async (subject, opts) => ({ text: '   ', model: 'fake', length: opts.length });
  const stats = await describeAll(pool, {
    kinds: ['skill'], describe: blank, log: quiet, limit: 3,
  });
  assert.equal(stats.written, 0);
  assert.ok(stats.failed >= 3);
});

// --- the flags -------------------------------------------------------------
//
// MEASURED, not imagined: `make art-describe DRY=1 LIMIT=20 KIND=skill` passes
// `--kind skill --limit 20`, and the first version of this script read only
// `--kind=skill`. It printed a plausible header and started describing the
// WHOLE catalogue with no limit. Nothing failed; it was just doing something
// else than it was asked.
test('a flag written with a space is the same flag as one written with =', () => {
  assert.equal(flagValue(['--kind=skill'], 'kind', 'D'), 'skill');
  assert.equal(flagValue(['--kind', 'skill'], 'kind', 'D'), 'skill');
  assert.equal(flagValue(['--limit', '20'], 'limit', '0'), '20');
});

test('a value-less flag does not swallow the next flag', () => {
  assert.equal(flagValue(['--kind', '--dry-run'], 'kind', 'D'), 'D',
    'taking "--dry-run" as the kind would run over a kind that does not exist');
  assert.equal(flagValue([], 'kind', 'D'), 'D');
});

test('a mistyped flag is refused rather than ignored', () => {
  assert.deepEqual(unknownFlags(['--kind', 'skill', '--limt', '5']), ['limt'],
    'an ignored --limt is how a "20 subjects" run describes the whole catalogue');
  assert.deepEqual(unknownFlags(['--kind=skill', '--dry-run', '--stale', '--limit=5']), []);
});
