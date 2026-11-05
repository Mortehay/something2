'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRunner } = require('./boardRunner');
const { execTools } = require('./updateJob');
const { createReleases } = require('./releases');
const { scratch } = require('./testkit');

const HOSTILE = 'fix $(touch PROBE) "quoted" \'single\' `touch PROBE2`; touch PROBE3 #';

// A temp git repo with the given subjects (oldest first); returns the shas oldest first.
function repo(t, subjects) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-rel-repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Ann Author');
  git('config', 'user.email', 'ann@example.com');
  const shas = subjects.map((s, i) => {
    fs.writeFileSync(path.join(dir, 'f.txt'), `${i}\n`);
    git('add', 'f.txt');
    git('commit', '-q', '-m', s);
    return git('rev-parse', 'HEAD');
  });
  return { dir, shas, git };
}

// A "board": a data dir on this machine, reached through a stub ssh that runs the command in bash for real.
// touching FAIL makes the stub behave like an unreachable board.
function rig(t, { gitDir, max, maxCommits, now } = {}) {
  const s = scratch(t);
  const board = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-board-'));
  t.after(() => fs.rmSync(board, { recursive: true, force: true }));
  s.stub('ssh', `[ -e "${board}/FAIL" ] && { echo 'ssh: connect timed out' >&2; exit 255; }\nexec bash -c "\${@: -1}"`);
  const env = { ...s.env, ORANGEPI_DATA_DIR: path.join(board, 'data') };
  const runner = createRunner({ root: s.root, env });
  const laptop = path.join(s.root, 'run', 'pi-releases.jsonl');
  const git = gitDir ? execTools({ root: gitDir, secrets: () => [] }).git : async () => ({ code: 128, stdout: '', stderr: 'no repo' });
  const logs = [];
  const rel = createReleases({ runner, git, file: laptop, max, maxCommits, now: now || (() => new Date('2026-11-05T12:00:00Z')), log: (m) => logs.push(m) });
  const boardFile = path.join(board, 'data', 'locks', 'releases.jsonl');
  const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return {
    s, board, rel, laptop, boardFile, logs, root: s.root,
    onBoard: () => lines(boardFile), onLaptop: () => lines(laptop),
    down: () => fs.writeFileSync(path.join(board, 'FAIL'), ''), up: () => fs.rmSync(path.join(board, 'FAIL'), { force: true }),
    marker: (sha) => { fs.mkdirSync(path.dirname(boardFile), { recursive: true }); fs.writeFileSync(path.join(path.dirname(boardFile), 'deployed-sha'), `${sha}\n`); },
  };
}

test('a release lists the commits since the previous one', async (t) => {
  const r = repo(t, ['first', 'second', 'third', 'fourth']);
  const x = rig(t, { gitDir: r.dir });
  const entry = await x.rel.afterUpdate({ version: r.shas[3], previous: r.shas[1], sourceBranch: 'main', buildBranch: 'orangepi', ciUrl: 'https://github.com/o/r/actions/runs/9', log: () => {} });
  assert.equal(entry.version, r.shas[3]);
  assert.equal(entry.previousVersion, r.shas[1]);
  assert.deepEqual(entry.commits.map((c) => c.subject), ['fourth', 'third']);
  assert.deepEqual(entry.commits.map((c) => c.sha), [r.shas[3], r.shas[2]]);
  assert.equal(entry.commits[0].author, 'Ann Author');
  assert.equal(entry.truncated, 0);
  assert.equal(entry.sourceBranch, 'main');
  assert.equal(entry.buildBranch, 'orangepi');
  assert.equal(entry.ciUrl, 'https://github.com/o/r/actions/runs/9');
  assert.equal(entry.at, '2026-11-05T12:00:00.000Z');
  assert.deepEqual(x.onBoard(), [entry]);
  assert.deepEqual(x.onLaptop(), [entry]);
});

test('commits are capped and the rest counted', async (t) => {
  const r = repo(t, ['a', 'b', 'c', 'd', 'e']);
  const x = rig(t, { gitDir: r.dir, maxCommits: 2 });
  const entry = await x.rel.afterUpdate({ version: r.shas[4], previous: r.shas[0], sourceBranch: 'main', buildBranch: 'orangepi', ciUrl: null, log: () => {} });
  assert.deepEqual(entry.commits.map((c) => c.subject), ['e', 'd']);
  assert.equal(entry.truncated, 2);
});

test('the first release says so, and an unknown previous commit lists nothing but does not fail', async (t) => {
  const r = repo(t, ['a', 'b']);
  const x = rig(t, { gitDir: r.dir });
  const first = await x.rel.afterUpdate({ version: r.shas[1], previous: null, sourceBranch: 'main', buildBranch: 'orangepi', ciUrl: null, log: () => {} });
  assert.deepEqual(first.commits, []);
  assert.equal(first.previousVersion, null);
  assert.match(first.note, /first/i);
  const unknown = await x.rel.afterUpdate({ version: r.shas[1], previous: 'e'.repeat(40), sourceBranch: 'main', buildBranch: 'orangepi', ciUrl: null, log: () => {} });
  assert.deepEqual(unknown.commits, []);
  assert.match(unknown.note, /not in this checkout/);
  assert.equal(x.onBoard().length, 2);
});

test('nothing is recorded when the board was already at that commit', async (t) => {
  const r = repo(t, ['a']);
  const x = rig(t, { gitDir: r.dir });
  assert.equal(await x.rel.afterUpdate({ version: r.shas[0], previous: r.shas[0], sourceBranch: 'main', buildBranch: 'orangepi', log: () => {} }), null);
  assert.deepEqual(x.onBoard(), []);
  assert.deepEqual(x.onLaptop(), []);
});

test('a hostile commit subject never reaches a shell', async (t) => {
  const r = repo(t, ['base', HOSTILE]);
  const x = rig(t, { gitDir: r.dir });
  // PROBE would be created in the cwd of the ssh stub (the helper root) or the board's home
  const entry = await x.rel.afterUpdate({ version: r.shas[1], previous: r.shas[0], sourceBranch: 'main', buildBranch: 'orangepi', ciUrl: null, log: () => {} });
  assert.equal(entry.commits[0].subject, HOSTILE);
  assert.equal(x.onBoard()[0].commits[0].subject, HOSTILE);
  for (const d of [x.root, x.board, path.join(x.board, 'data'), path.join(x.board, 'data', 'locks'), r.dir, process.cwd()]) {
    for (const n of ['PROBE', 'PROBE2', 'PROBE3', 'x']) assert.equal(fs.existsSync(path.join(d, n)), false, `${n} in ${d}`);
  }
  // and the subject is not on the command line either
  assert.doesNotMatch(fs.readFileSync(path.join(x.s.root, 'bin', 'ssh'), 'utf8'), /touch PROBE/);
});

test('the board keeps the last N releases', async (t) => {
  const r = repo(t, ['a', 'b', 'c', 'd', 'e']);
  const x = rig(t, { gitDir: r.dir, max: 3 });
  for (let i = 1; i < 5; i += 1) await x.rel.afterUpdate({ version: r.shas[i], previous: r.shas[i - 1], sourceBranch: 'main', buildBranch: 'orangepi', ciUrl: null, log: () => {} });
  assert.deepEqual(x.onBoard().map((e) => e.version), r.shas.slice(2, 5));
  assert.deepEqual(x.onLaptop().map((e) => e.version), r.shas.slice(2, 5));
});

test('a failed board write is logged, kept on the laptop, and retried at the next refresh', async (t) => {
  const r = repo(t, ['a', 'b']);
  const x = rig(t, { gitDir: r.dir });
  x.down();
  const jobLog = [];
  const entry = await x.rel.afterUpdate({ version: r.shas[1], previous: r.shas[0], sourceBranch: 'main', buildBranch: 'orangepi', ciUrl: null, log: (m) => jobLog.push(m) });
  assert.ok(entry);
  assert.match(jobLog.join('\n'), /could not be written to the board/);
  assert.deepEqual(x.onBoard(), []);
  assert.equal(x.onLaptop().length, 1);
  assert.equal((await x.rel.list()).source, 'laptop');
  x.up();
  await x.rel.sync();
  assert.deepEqual(x.onBoard(), [entry]);
  await x.rel.sync();
  assert.equal(x.onBoard().length, 1, 'not written twice');
  assert.equal((await x.rel.list()).source, 'board');
});

test('a hook deploy is recorded on the next refresh', async (t) => {
  const r = repo(t, ['a', 'b', 'c']);
  const x = rig(t, { gitDir: r.dir });
  await x.rel.afterUpdate({ version: r.shas[0], previous: null, sourceBranch: 'main', buildBranch: 'orangepi', ciUrl: null, log: () => {} });
  x.marker(r.shas[0]);
  await x.rel.sync();
  assert.equal(x.onBoard().length, 1, 'the board is at the last release: nothing to add');
  x.marker(r.shas[2]); // CI deployed it through the hook
  await x.rel.sync();
  const [, hook] = x.onBoard();
  assert.equal(hook.version, r.shas[2]);
  assert.equal(hook.previousVersion, r.shas[0]);
  assert.equal(hook.viaHook, true);
  assert.equal(hook.at, '2026-11-05T12:00:00.000Z');
  assert.deepEqual(hook.commits.map((c) => c.subject), ['c', 'b']);
  assert.equal(x.onLaptop().length, 2);
  await x.rel.sync();
  assert.equal(x.onBoard().length, 2, 'recorded once');
  assert.equal(x.rel.currentVersion(), r.shas[2]);
});

test('a refresh does nothing while an action is running or the board is unreachable', async (t) => {
  const r = repo(t, ['a', 'b']);
  let busy = true;
  const x = rig(t, { gitDir: r.dir });
  x.rel.setBusy(() => busy);
  x.marker(r.shas[1]);
  await x.rel.sync();
  assert.deepEqual(x.onBoard(), []);
  busy = false;
  x.down();
  await x.rel.sync();
  assert.deepEqual(x.onLaptop(), []);
  x.up();
  await x.rel.sync();
  assert.equal(x.onBoard().length, 1);
});

test('GET /releases: newest first from the board, from the laptop when it is unreachable', async (t) => {
  const r = repo(t, ['a', 'b', 'c']);
  let n = 0;
  const x = rig(t, { gitDir: r.dir, now: () => new Date(Date.UTC(2026, 10, 5, 12, n++)) });
  await x.rel.afterUpdate({ version: r.shas[1], previous: r.shas[0], sourceBranch: 'main', buildBranch: 'orangepi', ciUrl: null, log: () => {} });
  await x.rel.afterUpdate({ version: r.shas[2], previous: r.shas[1], sourceBranch: 'main', buildBranch: 'orangepi', ciUrl: null, log: () => {} });
  const live = await x.rel.list();
  assert.equal(live.source, 'board');
  assert.deepEqual(live.releases.map((e) => e.version), [r.shas[2], r.shas[1]]);
  x.down();
  const off = await x.rel.list({ fresh: true });
  assert.equal(off.source, 'laptop');
  assert.deepEqual(off.releases.map((e) => e.version), [r.shas[2], r.shas[1]]);
});

test('a corrupt line in either copy is skipped', async (t) => {
  const r = repo(t, ['a', 'b']);
  const x = rig(t, { gitDir: r.dir });
  await x.rel.afterUpdate({ version: r.shas[1], previous: r.shas[0], sourceBranch: 'main', buildBranch: 'orangepi', ciUrl: null, log: () => {} });
  fs.appendFileSync(x.boardFile, 'garbage\n{"version":"nothex"}\n');
  fs.appendFileSync(x.laptop, '{"version":"abc');
  const l = await x.rel.list({ fresh: true });
  assert.equal(l.releases.length, 1);
});
