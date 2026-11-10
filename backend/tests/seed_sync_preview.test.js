const test = require('node:test');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert');
const { summarizePreview } = require('../scripts/seed-sync.js');
const { BOARD_SEED_GROUPS } = require('../src/services/seedSync/boardSeedGroups.js');
const { GROUPS } = require('../src/services/seedSync/registry.js');

let n = 0;
const row = (over) => ({ syncUuid: `u${n += 1}`, table: 't', key: 'k', kind: 'changed', defaultDecision: 'git', blockedReason: null, ...over });

test('summarizePreview counts by decision', () => {
  const rows = [
    row({ kind: 'new', defaultDecision: 'git' }),
    row({ kind: 'deleted_in_git', defaultDecision: 'delete' }),
    row({ kind: 'changed', defaultDecision: 'git' }),
    row({ kind: 'edited_here', defaultDecision: null }),
  ];
  assert.deepStrictEqual(summarizePreview(rows, 'git'), { add: 1, change: 1, remove: 1, overwrite: 1, blocked: 0 });
});

test('summarizePreview counts a row once, and a kept-local row as nothing', () => {
  const rows = [
    row({ kind: 'not_exported', defaultDecision: 'local' }),
    row({ kind: 'only_here', defaultDecision: 'local' }),
    row({ kind: 'edited_here', defaultDecision: null }),
  ];
  assert.deepStrictEqual(summarizePreview(rows, 'local'), { add: 0, change: 0, remove: 0, overwrite: 0, blocked: 0 });
});

test('summarizePreview never counts a blocked row as removed; it counts it as blocked', () => {
  const rows = [
    row({ kind: 'deleted_in_git', defaultDecision: 'delete', blockedReason: 'in_use' }),
    row({ kind: 'new', defaultDecision: 'git', blockedReason: 'owner_missing' }),
    // asset-blocked git row: decide() yields 'git' for the red row, apply forbids it
    row({ kind: 'changed', defaultDecision: null, blockedReason: 'asset_missing', allowedDecisions: ['local'] }),
  ];
  assert.deepStrictEqual(summarizePreview(rows, 'git'), { add: 0, change: 0, remove: 0, overwrite: 0, blocked: 3 });
});

test('summarizePreview: a key clash degrades to local (not refused), a kept-local blocked row counts nothing', () => {
  const rows = [
    row({ kind: 'new', defaultDecision: null, blockedReason: 'key already used by a local row', allowedDecisions: ['local'] }),
    row({ kind: 'deleted_in_git', defaultDecision: 'local', blockedReason: 'in_use', allowedDecisions: ['local'] }),
  ];
  assert.deepStrictEqual(summarizePreview(rows, 'git'), { add: 0, change: 0, remove: 0, overwrite: 0, blocked: 0 });
});

test('summarizePreview counts missing_ref / invalid_value warnings as blocked', () => {
  const warnings = [{ code: 'missing_ref' }, { code: 'invalid_value' }, { code: 'schema_older' }, { code: 'dangling_name' }];
  assert.deepStrictEqual(summarizePreview([], 'git', warnings), { add: 0, change: 0, remove: 0, overwrite: 0, blocked: 2 });
});

test('summarizePreview without --resolve leaves undecided rows uncounted', () => {
  assert.deepStrictEqual(summarizePreview([row({ kind: 'edited_here', defaultDecision: null })], null),
    { add: 0, change: 0, remove: 0, overwrite: 0, blocked: 0 });
});

test('BOARD_SEED_GROUPS is the ordered board list and all ids are registered', () => {
  assert.deepStrictEqual(BOARD_SEED_GROUPS, ['ai_providers', 'tile_types', 'items', 'attack_effects', 'aura_effects',
    'buff_visuals', 'creature_behaviors', 'entities', 'biomes', 'skill_tree', 'progression', 'quests']);
  const ids = new Set(GROUPS.map((g) => g.id));
  for (const g of BOARD_SEED_GROUPS) assert.ok(ids.has(g), g);
});

test('summarizePreview counts git-wins rows as overwrite', () => {
  const rows = [
    row({ kind: 'not_exported', defaultDecision: 'local', allowedDecisions: ['git', 'local'] }),
    row({ kind: 'only_here', defaultDecision: 'local', allowedDecisions: ['delete', 'local'] }),
    row({ kind: 'deleted_in_git', defaultDecision: 'local', blockedReason: 'in_use', allowedDecisions: ['local'] }),
  ];
  assert.deepStrictEqual(summarizePreview(rows, 'git', [], { gitWins: true }), { add: 0, change: 0, remove: 0, overwrite: 1, blocked: 0 });
  assert.deepStrictEqual(summarizePreview(rows, 'git'), { add: 0, change: 0, remove: 0, overwrite: 0, blocked: 0 });
});

test('git-wins is refused without --resolve=git', () => {
  for (const flags of [['--resolve=local'], []]) {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'seed-sync.js'), 'seed', '--group=quests', ...flags, '--git-wins'],
      { env: { ...process.env, DATABASE_URL: '' }, encoding: 'utf8' });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /--git-wins needs --resolve=git/);
  }
});

// SOMET-734. Several groups in one process (the board boots node once per call).
const { parseArgs, targets } = require('../scripts/seed-sync.js');

test('preview takes repeated --group and --groups=a,b,c, in the order given, without duplicates', () => {
  assert.deepStrictEqual(parseArgs(['preview', '--group=items', '--group=quests', '--resolve=git']).groups, ['items', 'quests']);
  assert.deepStrictEqual(parseArgs(['preview', '--groups=quests,items,quests', '--resolve=git', '--git-wins']).groups, ['quests', 'items']);
  assert.deepStrictEqual(parseArgs(['preview', '--group=items', '--groups=quests,biomes']).groups, ['items', 'quests', 'biomes']);
  assert.strictEqual(parseArgs(['preview', '--group=items']).group, 'items', 'one group still sets .group');
});

test('several groups are for preview only, and --all, empty ids and a missing group stay errors', () => {
  for (const cmd of ['seed', 'export', 'status']) {
    assert.throws(() => parseArgs([cmd, '--groups=items,quests']), /preview only/, cmd);
    assert.throws(() => parseArgs([cmd, '--group=items', '--group=quests']), /preview only/, cmd);
  }
  assert.throws(() => parseArgs(['preview', '--all', '--groups=items,quests']), /not both/);
  assert.throws(() => parseArgs(['preview', '--groups=items,,quests']), /comma-separated/);
  assert.throws(() => parseArgs(['preview', '--groups=']), /comma-separated/);
  assert.throws(() => parseArgs(['preview']), /needs --group/);
  assert.throws(() => parseArgs(['preview', '--groups=a', '--bogus']), /unknown argument: --bogus/);
});

test('targets checks every id before anything runs', () => {
  assert.deepStrictEqual(targets(parseArgs(['preview', '--groups=quests,items'])), ['quests', 'items']);
  assert.throws(() => targets(parseArgs(['preview', '--groups=items,nope'])), /unknown group/);
  assert.strictEqual(targets(parseArgs(['preview', '--all'])).length > 5, true);
});

test('the real CLI prints one line per group in one process, the same lines as one call per group', () => {
  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'seed-sync.js'), 'preview', ...args, '--resolve=git', '--git-wins'],
    { env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL }, encoding: 'utf8' });
  if (!process.env.TEST_DATABASE_URL) return; // read-only against the scratch database; nothing to compare without one
  const groups = ['ai_providers', 'items', 'quests'];
  const one = groups.map((g) => run(`--group=${g}`).stdout.trim());
  const many = run(`--groups=${groups.join(',')}`);
  assert.strictEqual(many.status, 0, many.stderr);
  assert.deepStrictEqual(many.stdout.trim().split('\n'), one);
  assert.deepStrictEqual(run(...groups.map((g) => `--group=${g}`)).stdout.trim().split('\n'), one);
  const bad = run('--groups=items,nope');
  assert.strictEqual(bad.status, 1);
  assert.strictEqual(bad.stdout, '', 'an unknown group stops the run before any line');
});

test('a refused group is one line and the others still print; exit 2', () => {
  if (!process.env.TEST_DATABASE_URL) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-multi-'));
  try {
    fs.copyFileSync(path.join(__dirname, '..', 'seeds', 'sync', 'items.json'), path.join(dir, 'items.json'));
    fs.writeFileSync(path.join(dir, 'quests.json'), '{ not json');
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'seed-sync.js'), 'preview', '--groups=items,quests,items', '--resolve=git'],
      { env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, SEED_SYNC_DIR: dir }, encoding: 'utf8' });
    const lines = r.stdout.trim().split('\n');
    assert.strictEqual(lines.length, 2, r.stdout);
    assert.match(lines[0], /^items preview \{/);
    assert.match(lines[1], /^quests refused:bad_file /);
    assert.strictEqual(r.status, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
