const test = require('node:test');
const assert = require('node:assert');
const { planRepair, suffixOf } = require('../scripts/repair-migration-order.js');

// SOMET-336. planRepair decides what to rewrite in the `pgmigrations` ledger.
// It is pure so it can be tested without a database -- which matters here more
// than usual, because the thing it edits is the record of what has already run
// against a SHARED database. A wrong decision does not fail loudly; it makes
// node-pg-migrate believe a migration ran that did not, or re-run one that
// did.
//
// Rows are written {id, name, run_on, run_on_text} -- the shape the script
// normalises to. `run_on` is epoch millis and exists ONLY to sort by;
// `run_on_text` is Postgres's own rendering of the column and is the value
// written back. They are carried as a pair because reconstructing the
// timestamp from the millis instead shifted every row by the server's UTC
// offset (a timestamptz assigned to a `timestamp without time zone` column).

const row = (id, name, run_on) => ({
  id, name, run_on, run_on_text: `text-for-${run_on}`,
});

// A healthy three-migration ledger: recorded order matches filename order.
const HEALTHY = () => ({
  recorded: [
    row(1, '100_alpha', 1000),
    row(2, '200_beta', 2000),
    row(3, '300_gamma', 3000),
  ],
  files: ['100_alpha', '200_beta', '300_gamma'],
});

test('a healthy ledger is a no-op -- no renames, no reorder', () => {
  const plan = planRepair(HEALTHY());
  assert.deepEqual(plan.renames, []);
  assert.deepEqual(plan.reorder, []);
  assert.deepEqual(plan.unrun, []);
  assert.deepEqual(plan.orphans, []);
  assert.equal(plan.alreadyOrdered, true);
  assert.equal(plan.ok, true);
});

test('an out-of-order ledger is reordered into filename order', () => {
  // beta ran BEFORE alpha (the real case: a later-timestamped branch applied
  // to the shared database first). Both ran; nothing is missing.
  const plan = planRepair({
    recorded: [row(1, '200_beta', 1000), row(2, '100_alpha', 2000), row(3, '300_gamma', 3000)],
    files: ['100_alpha', '200_beta', '300_gamma'],
  });
  assert.equal(plan.alreadyOrdered, false);
  assert.deepEqual(plan.reorder.map((r) => r.name), ['100_alpha', '200_beta', '300_gamma']);
  assert.deepEqual(plan.renames, [], 'reordering must not be mistaken for a rename');
});

test('the reorder preserves the exact multisets of ids and run_on values', () => {
  // The reorder must never INVENT a timestamp or an id -- it only changes
  // which row carries which. Asserting on the multisets is what makes that a
  // guarantee rather than an intention: fabricating a value shows up here even
  // if the resulting order happens to be correct.
  const before = {
    recorded: [row(7, '200_beta', 5000), row(3, '100_alpha', 9000), row(5, '300_gamma', 5000)],
    files: ['100_alpha', '200_beta', '300_gamma'],
  };
  const plan = planRepair(before);
  const sortedIn = (xs) => [...xs].sort((a, b) => a - b);
  assert.deepEqual(sortedIn(plan.reorder.map((r) => r.id)), sortedIn(before.recorded.map((r) => r.id)));
  assert.deepEqual(sortedIn(plan.reorder.map((r) => r.run_on)), sortedIn(before.recorded.map((r) => r.run_on)));
  // ...and the result really is non-decreasing on the (run_on, id) key that
  // node-pg-migrate sorts by.
  for (let i = 1; i < plan.reorder.length; i += 1) {
    const prev = plan.reorder[i - 1];
    const cur = plan.reorder[i];
    assert.ok(prev.run_on < cur.run_on || (prev.run_on === cur.run_on && prev.id < cur.id),
      `row ${i} does not follow row ${i - 1} on (run_on, id)`);
  }
});

test('run_on_text is permuted verbatim and stays paired with its own timestamp', () => {
  // The regression guard for a real defect. The first version of this script
  // rebuilt the timestamp in SQL as to_timestamp(ms / 1000), which yields a
  // timestamptz; storing that into `timestamp without time zone` converted it
  // to the server's local zone and moved every row by the UTC offset -- 3
  // hours on the machine it was run on. Writing back the text Postgres itself
  // produced cannot drift, and the pairing assertion is what stops a future
  // edit from sorting the two arrays independently.
  const before = {
    recorded: [row(7, '200_beta', 5000), row(3, '100_alpha', 9000), row(5, '300_gamma', 1000)],
    files: ['100_alpha', '200_beta', '300_gamma'],
  };
  const plan = planRepair(before);
  const texts = plan.reorder.map((r) => r.run_on_text);
  assert.deepEqual([...texts].sort(), [...before.recorded.map((r) => r.run_on_text)].sort(),
    'the set of run_on_text values must be preserved exactly, never regenerated');
  for (const r of plan.reorder) {
    assert.equal(r.run_on_text, `text-for-${r.run_on}`,
      'each run_on_text must still belong to the run_on it was read with');
  }
});

test('a renumbered migration is detected as a rename, not as an unrun migration', () => {
  // The 42P07 case. The migration ran under 200_beta; a timestamp collision was
  // resolved by renaming the file to 250_beta. Treating 250_beta as unrun makes
  // migrate:up re-apply a CREATE TABLE against the table it already created.
  const plan = planRepair({
    recorded: [row(1, '100_alpha', 1000), row(2, '200_beta', 2000)],
    files: ['100_alpha', '250_beta'],
  });
  assert.deepEqual(plan.renames, [{ from: '200_beta', to: '250_beta' }]);
  assert.deepEqual(plan.unrun, [], 'the renamed file must NOT be reported as never-run');
  assert.deepEqual(plan.orphans, [], 'the old recorded name must NOT be reported as an orphan');
  assert.equal(plan.ok, true);
});

test('a genuinely new migration is reported as unrun and never renamed away', () => {
  // This is the case checkOrder exists for. The right outcome is migrate:up
  // applying it -- so the script must leave it entirely alone rather than
  // inventing a ledger row that would skip it forever.
  const plan = planRepair({
    recorded: [row(1, '100_alpha', 1000)],
    files: ['100_alpha', '200_beta'],
  });
  assert.deepEqual(plan.unrun, ['200_beta']);
  assert.deepEqual(plan.renames, []);
  assert.equal(plan.ok, true, 'an unrun migration is normal, not a reason to refuse');
});

test('a recorded migration with no file is reported as an orphan and left alone', () => {
  // Applied from a branch that has not merged. Deleting the row would let it
  // be applied a SECOND time once that branch lands, against schema changes
  // that are already present.
  const plan = planRepair({
    recorded: [row(1, '100_alpha', 1000), row(2, '900_from_another_branch', 2000)],
    files: ['100_alpha'],
  });
  assert.deepEqual(plan.orphans, ['900_from_another_branch']);
  assert.deepEqual(plan.renames, []);
});

test('an ambiguous rename BLOCKS the repair rather than guessing', () => {
  // Two unmatched files share the suffix. Picking either would write a claim
  // into the ledger that some migration has run when it may not have -- the
  // single most damaging thing this script could do, and unrecoverable
  // without the backup.
  const plan = planRepair({
    recorded: [row(1, '200_beta', 1000)],
    files: ['250_beta', '260_beta'],
  });
  assert.equal(plan.ok, false);
  assert.ok(plan.blocked.some((b) => /ambiguous rename/.test(b)), plan.blocked.join('\n'));
  assert.deepEqual(plan.renames, [], 'nothing may be renamed once ambiguity is detected');
});

test('two recorded names competing for one renamed file also BLOCK', () => {
  // The mirror of the case above, and the one a suffix-keyed lookup gets wrong
  // if it only guards the file side.
  const plan = planRepair({
    recorded: [row(1, '200_beta', 1000), row(2, '210_beta', 2000)],
    files: ['250_beta'],
  });
  assert.equal(plan.ok, false);
  assert.ok(plan.blocked.some((b) => /ambiguous rename/.test(b)), plan.blocked.join('\n'));
  assert.deepEqual(plan.renames, []);
});

test('duplicate recorded names BLOCK the repair', () => {
  const plan = planRepair({
    recorded: [row(1, '100_alpha', 1000), row(2, '100_alpha', 2000)],
    files: ['100_alpha'],
  });
  assert.equal(plan.ok, false);
  assert.ok(plan.blocked.some((b) => /duplicate names/.test(b)), plan.blocked.join('\n'));
});

test('a rename is applied BEFORE the order is judged', () => {
  // Order matters: 250_beta sorts after 300_gamma's neighbours differently
  // than 200_beta does. Judging the order against the pre-rename names would
  // plan a reorder that is wrong the moment the rename lands.
  const plan = planRepair({
    recorded: [row(1, '100_alpha', 1000), row(2, '200_beta', 2000), row(3, '300_gamma', 3000)],
    files: ['100_alpha', '300_gamma', '400_beta'],
  });
  assert.deepEqual(plan.renames, [{ from: '200_beta', to: '400_beta' }]);
  // After renaming, filename order is alpha, gamma, beta -- and the recorded
  // order (alpha, beta, gamma) no longer matches, so a reorder IS required.
  assert.equal(plan.alreadyOrdered, false);
  assert.deepEqual(plan.reorder.map((r) => r.name), ['100_alpha', '300_gamma', '400_beta']);
});

test('suffixOf splits on the FIRST underscore after the timestamp only', () => {
  // Migration names carry underscores in their descriptive half
  // ("1714440320000_entry_spawn_is_village_spawn"), so a naive split would
  // truncate the suffix and make unrelated migrations look like renames of
  // each other.
  assert.equal(suffixOf('1714440320000_entry_spawn_is_village_spawn'), 'entry_spawn_is_village_spawn');
  assert.equal(suffixOf('1714440330000_creature_respawns'), 'creature_respawns');
  assert.equal(suffixOf('no_leading_timestamp'), null);
});
