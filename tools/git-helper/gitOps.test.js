'use strict';
// Every repo here is a throwaway under os.tmpdir(); nothing touches the
// worktree or the shared checkout.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { createGitOps, GitRefusal } = require('./gitOps');
const { createServer } = require('./server');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
}
function write(root, rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}
function identify(dir) {
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

// bare origin + clone "a" (this PC) + clone "b" (the other PC)
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'git-helper-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const origin = path.join(base, 'origin.git');
  git(base, 'init', '--bare', '-b', 'main', origin);
  const a = path.join(base, 'a');
  const b = path.join(base, 'b');
  git(base, 'clone', origin, a);
  identify(a);
  git(a, 'checkout', '-b', 'main');
  write(a, 'backend/seeds/one.json', '{}\n');
  write(a, 'README.md', 'hi\n');
  git(a, 'add', '-A');
  git(a, 'commit', '-m', 'init');
  git(a, 'push', '-u', 'origin', 'main');
  git(base, 'clone', origin, b);
  identify(b);
  return { base, origin, a, b, ops: createGitOps({ root: a }) };
}
const refusal = (code) => (e) => e instanceof GitRefusal && e.code === code;

test('status reports branch, upstream, counts and split dirty paths', async (t) => {
  const { a, ops } = fixture(t);
  write(a, 'backend/seeds/one.json', '{"x":1}\n');
  write(a, 'backend/seeds/new/two.json', '{}\n');
  write(a, 'README.md', 'changed\n');
  write(a, 'untracked.txt', 'u\n');
  const s = await ops.status();
  assert.equal(s.branch, 'main');
  assert.equal(s.upstream, 'origin/main');
  assert.equal(s.ahead, 0);
  assert.equal(s.behind, 0);
  assert.deepEqual(s.seedsDirty.sort(), ['backend/seeds/new/two.json', 'backend/seeds/one.json']);
  assert.deepEqual(s.otherDirty.sort(), ['README.md', 'untracked.txt']);
  assert.equal(s.headSubject, 'init');
  assert.ok(s.lastFetchAt === null || !Number.isNaN(Date.parse(s.lastFetchAt)));
});

test('status lastFetchAt follows FETCH_HEAD and ahead/behind are counted', async (t) => {
  const { a, b, ops } = fixture(t);
  assert.equal((await ops.status()).lastFetchAt, null);
  write(b, 'other.txt', 'x\n');
  git(b, 'add', '-A'); git(b, 'commit', '-m', 'from b'); git(b, 'push');
  write(a, 'local.txt', 'y\n');
  git(a, 'add', '-A'); git(a, 'commit', '-m', 'local');
  await ops.fetch();
  const s = await ops.status();
  assert.equal(s.ahead, 1);
  assert.equal(s.behind, 1);
  assert.ok(Date.parse(s.lastFetchAt) > 0);
});

test('commit stages only backend/seeds and leaves other dirt untouched', async (t) => {
  const { a, ops } = fixture(t);
  write(a, 'backend/seeds/one.json', '{"x":1}\n');
  write(a, 'backend/seeds/added.json', '{}\n');
  write(a, 'README.md', 'changed\n');
  write(a, 'untracked.txt', 'u\n');
  write(a, 'staged-by-user.txt', 's\n');
  git(a, 'add', 'staged-by-user.txt');
  const r = await ops.commit({ message: 'seed export: items from pc' });
  assert.equal(r.ok, true);
  assert.equal(r.op, 'commit');
  assert.deepEqual(git(a, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(),
    ['backend/seeds/added.json', 'backend/seeds/one.json']);
  const s = await ops.status();
  assert.deepEqual(s.seedsDirty, []);
  assert.deepEqual(s.otherDirty.sort(), ['README.md', 'staged-by-user.txt', 'untracked.txt']);
  assert.equal(git(a, 'diff', '--cached', '--name-only'), 'staged-by-user.txt');
});

test('commit message is committed literally (quotes, newlines, $(), leading dash)', async (t) => {
  const { a, ops } = fixture(t);
  const nasty = [
    `it's "quoted" $(touch ${a}/pwned) \`touch ${a}/pwned2\` ; touch ${a}/pwned3`,
    '--amend',
    '-m evil',
    'line one\n\nline three with --amend and $HOME',
  ];
  for (const [i, message] of nasty.entries()) {
    write(a, 'backend/seeds/one.json', `{"i":${i}}\n`);
    const before = git(a, 'rev-list', '--count', 'HEAD');
    await ops.commit({ message });
    assert.equal(git(a, 'rev-list', '--count', 'HEAD'), String(Number(before) + 1), 'a new commit, not an amend');
    assert.equal(git(a, 'log', '-1', '--format=%B').replace(/\n+$/, ''), message.replace(/\n+$/, ''));
  }
  for (const f of ['pwned', 'pwned2', 'pwned3']) assert.equal(fs.existsSync(path.join(a, f)), false);
});

test('commit refuses an empty message and nothing_to_commit', async (t) => {
  const { a, ops } = fixture(t);
  write(a, 'backend/seeds/one.json', '{"x":1}\n');
  await assert.rejects(ops.commit({ message: '  ' }), (e) => e instanceof GitRefusal && e.code === 'bad_request');
  await ops.commit({ message: 'm' });
  write(a, 'README.md', 'only non-seed dirt\n');
  await assert.rejects(ops.commit({ message: 'm2' }), refusal('nothing_to_commit'));
  assert.equal(git(a, 'log', '-1', '--format=%s'), 'm');
});

test('pull is refused when dirty anywhere and changes nothing', async (t) => {
  const { a, b, ops } = fixture(t);
  write(b, 'other.txt', 'x\n');
  git(b, 'add', '-A'); git(b, 'commit', '-m', 'from b'); git(b, 'push');
  write(a, 'untracked.txt', 'u\n');
  const head = git(a, 'rev-parse', 'HEAD');
  await assert.rejects(ops.pull(), refusal('dirty'));
  assert.equal(git(a, 'rev-parse', 'HEAD'), head);
  assert.equal(fs.existsSync(path.join(a, 'other.txt')), false);
  assert.equal(fs.readFileSync(path.join(a, 'untracked.txt'), 'utf8'), 'u\n');
});

test('pull fast-forwards when clean, and never merges a diverged branch (--ff-only)', async (t) => {
  const { a, b, ops } = fixture(t);
  write(b, 'other.txt', 'x\n');
  git(b, 'add', '-A'); git(b, 'commit', '-m', 'from b'); git(b, 'push');
  const r = await ops.pull();
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(a, 'other.txt'), 'utf8'), 'x\n');

  write(b, 'b2.txt', '1\n');
  git(b, 'add', '-A'); git(b, 'commit', '-m', 'b2'); git(b, 'push');
  write(a, 'a2.txt', '1\n');
  git(a, 'add', '-A'); git(a, 'commit', '-m', 'a2');
  const head = git(a, 'rev-parse', 'HEAD');
  await assert.rejects(ops.pull(), refusal('diverged')); // fetch-first sees it despite the stale ref
  assert.equal(git(a, 'rev-parse', 'HEAD'), head, 'no merge commit, no rebase');
  assert.equal(git(a, 'rev-list', '--merges', '--count', 'HEAD'), '0');
});

test('pull is refused when diverged, before running git pull', async (t) => {
  const { a, b, ops } = fixture(t);
  write(b, 'b3.txt', '1\n');
  git(b, 'add', '-A'); git(b, 'commit', '-m', 'b3'); git(b, 'push');
  write(a, 'a3.txt', '1\n');
  git(a, 'add', '-A'); git(a, 'commit', '-m', 'a3');
  git(a, 'fetch');
  const head = git(a, 'rev-parse', 'HEAD');
  await assert.rejects(ops.pull(), (e) => refusal('diverged')(e) && /terminal/i.test(e.message));
  assert.equal(git(a, 'rev-parse', 'HEAD'), head);
});

test('push sends the current branch; refused when behind or diverged', async (t) => {
  const { a, b, origin, ops } = fixture(t);
  write(a, 'local.txt', 'y\n');
  git(a, 'add', '-A'); git(a, 'commit', '-m', 'local');
  const r = await ops.push();
  assert.equal(r.ok, true);
  assert.equal(git(origin, 'log', '-1', '--format=%s', 'main'), 'local');

  // other PC pushes; we only know after a fetch
  git(b, 'pull', '--ff-only');
  write(b, 'b.txt', '1\n');
  git(b, 'add', '-A'); git(b, 'commit', '-m', 'b'); git(b, 'push');
  await ops.fetch();
  await assert.rejects(ops.push(), (e) => refusal('behind')(e) && /pull first/i.test(e.message));

  write(a, 'a3.txt', '1\n');
  git(a, 'add', '-A'); git(a, 'commit', '-m', 'a3');
  await assert.rejects(ops.push(), refusal('diverged'));
  assert.equal(git(origin, 'log', '-1', '--format=%s', 'main'), 'b', 'origin untouched');
});

test('push fetches first: a stale tracking ref cannot hide that origin moved (leading + branch too)', async (t) => {
  const { a, b, origin, ops } = fixture(t);
  git(a, 'checkout', '-b', '+main');
  git(a, 'push', '-u', 'origin', 'refs/heads/+main:refs/heads/+main');
  git(b, 'fetch', 'origin');
  git(b, 'checkout', '-b', '+main', '--track', 'origin/+main');
  write(b, 'b.txt', '1\n');
  git(b, 'add', '-A'); git(b, 'commit', '-m', 'other pc'); git(b, 'push', 'origin', 'refs/heads/+main:refs/heads/+main');
  // a's tracking ref is stale (no fetch); a pre-fetch check would see "ahead only"
  assert.equal(git(a, 'rev-list', '--count', 'refs/remotes/origin/+main..HEAD'), '0');
  write(a, 'a.txt', '1\n');
  git(a, 'add', '-A'); git(a, 'commit', '-m', 'mine');
  await assert.rejects(ops.push(), refusal('diverged'));
  assert.equal(git(origin, 'log', '-1', '--format=%s', 'refs/heads/+main'), 'other pc', 'origin not overwritten');
});

test('push is refused behind when origin moved and the local tracking ref was stale', async (t) => {
  const { a, b, origin, ops } = fixture(t);
  write(b, 'b.txt', '1\n');
  git(b, 'add', '-A'); git(b, 'commit', '-m', 'other pc'); git(b, 'push');
  const stale = git(a, 'rev-parse', 'refs/remotes/origin/main');
  await assert.rejects(ops.push(), refusal('behind'));
  assert.notEqual(git(a, 'rev-parse', 'refs/remotes/origin/main'), stale, 'push fetched');
  assert.equal(git(origin, 'log', '-1', '--format=%s', 'main'), 'other pc');
});

test('push gets no_upstream when origin has no such branch', async (t) => {
  const { a, ops } = fixture(t);
  git(a, 'checkout', '-b', 'fresh');
  git(a, 'branch', '--set-upstream-to=origin/main', 'fresh');
  await assert.rejects(ops.push(), refusal('no_upstream'));
});

test('push reports a fetch failure as a git failure', async (t) => {
  const { a, ops } = fixture(t);
  git(a, 'remote', 'set-url', 'origin', path.join(os.tmpdir(), 'git-helper-no-such-remote.git'));
  const r = await ops.push();
  assert.equal(r.ok, false);
  assert.equal(r.op, 'push');
  assert.ok(r.output.length > 0);
});

test('pull decides diverged from fresh counts (stale tracking ref)', async (t) => {
  const { a, b, ops } = fixture(t);
  write(b, 'b3.txt', '1\n');
  git(b, 'add', '-A'); git(b, 'commit', '-m', 'b3'); git(b, 'push');
  write(a, 'a3.txt', '1\n');
  git(a, 'add', '-A'); git(a, 'commit', '-m', 'a3'); // no fetch in a
  const head = git(a, 'rev-parse', 'HEAD');
  await assert.rejects(ops.pull(), refusal('diverged'));
  assert.equal(git(a, 'rev-parse', 'HEAD'), head);
});

test('commit message is stored byte-exact (--cleanup=verbatim)', async (t) => {
  const { a, ops } = fixture(t);
  write(a, 'backend/seeds/one.json', '{"x":2}\n');
  const msg = 'subject  \n\n\nbody with trailing   \n# not a comment\n\n';
  await ops.commit({ message: msg });
  assert.equal(execFileSync('git', ['log', '-1', '--format=%B'], { cwd: a, encoding: 'utf8' }), `${msg}\n`);
});

test('no upstream is a refusal for pull and push', async (t) => {
  const { a, ops } = fixture(t);
  git(a, 'checkout', '-b', 'lonely');
  await assert.rejects(ops.pull(), refusal('no_upstream'));
  await assert.rejects(ops.push(), refusal('no_upstream'));
});

test('a concurrent mutating call gets busy', async (t) => {
  const { a, ops } = fixture(t);
  write(a, 'backend/seeds/one.json', '{"x":1}\n');
  const first = ops.commit({ message: 'one' });
  await assert.rejects(ops.fetch(), refusal('busy'));
  await first;
  await ops.fetch(); // lock released
});

test('unreachable remote fails fast with output instead of hanging', async (t) => {
  const { a, ops } = fixture(t);
  git(a, 'remote', 'set-url', 'origin', path.join(os.tmpdir(), 'git-helper-no-such-remote.git'));
  const r = await ops.fetch();
  assert.equal(r.ok, false);
  assert.ok(r.output.length > 0);
});

// ---- server level --------------------------------------------------------
function request(sock, method, urlPath, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (token) headers['X-Git-Helper-Token'] = token;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({ socketPath: sock, method, path: urlPath, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('server: token required, files modes, routes, SIGTERM-style close removes socket', async (t) => {
  const { a } = fixture(t);
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-helper-run-'));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const sock = path.join(runDir, 'git-helper.sock');
  fs.writeFileSync(sock, 'stale'); // stale socket file is removed on start
  const h = await createServer({ root: a, runDir }).start();
  const token = fs.readFileSync(path.join(runDir, 'git-helper.token'), 'utf8').trim();
  assert.ok(token.length >= 32);
  assert.equal(fs.statSync(path.join(runDir, 'git-helper.token')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(runDir).mode & 0o777, 0o700);

  assert.equal((await request(sock, 'GET', '/status')).status, 401);
  assert.equal((await request(sock, 'GET', '/status', { token: 'wrong' })).status, 401);
  assert.equal((await request(sock, 'POST', '/commit', { body: { message: 'x' } })).status, 401);
  assert.equal(git(a, 'rev-list', '--count', 'HEAD'), '1');

  const ok = await request(sock, 'GET', '/status', { token });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.branch, 'main');
  const refused = await request(sock, 'POST', '/commit', { token, body: { message: 'x' } });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error, 'nothing_to_commit');
  assert.equal((await request(sock, 'GET', '/nope', { token })).status, 404);
  assert.equal((await request(sock, 'POST', '/exec', { token, body: {} })).status, 404);

  await h.close();
  assert.equal(fs.existsSync(sock), false);
});

test('server refuses to start outside a git work tree', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-helper-notrepo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(createServer({ root: dir, runDir: path.join(dir, 'run') }).start(), /not a git work tree/);
});

test('server refuses a unix socket path over the sun_path limit and creates nothing', async (t) => {
  const { spawnSync } = require('node:child_process');
  const { a } = fixture(t);
  const long = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-'));
  t.after(() => fs.rmSync(long, { recursive: true, force: true }));
  const runDir = path.join(long, 'x'.repeat(100));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, GIT_HELPER_ROOT: a, GIT_HELPER_RUN_DIR: runDir, GIT_HELPER_PORT: '' },
    encoding: 'utf8', timeout: 15000,
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /git-helper\.sock/);
  assert.match(r.stderr, /GIT_HELPER_RUN_DIR/);
  assert.match(r.stderr, /GIT_HELPER_PORT/);
  assert.match(r.stderr, /107/);
  assert.equal(fs.existsSync(runDir), false, 'no run dir, token or socket is created');
  assert.deepEqual(fs.readdirSync(long), [], 'no stray (truncated) socket anywhere under the tmp dir');
});

// ---- drain / live-socket (spawned servers) --------------------------------
const { spawn } = require('node:child_process');
const net = require('node:net');

// Spawned helpers must never outlive the test run, even if a test hangs or the runner dies.
const spawned = new Set();
process.on('exit', () => { for (const c of spawned) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });
const SPAWN_TEST = { timeout: 20000 };

// A `git` on PATH that can stall fetches (touching `mark` once the stall is over)
// and record every push argv in `pushLog`, then runs the real git.
function shimDir(t, sleepSecs, { mark, pushLog } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-shim-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const lines = ['#!/bin/sh'];
  if (sleepSecs) lines.push(`case " $* " in *" fetch "*) sleep ${sleepSecs}${mark ? `; touch '${mark}'` : ''};; esac`);
  if (pushLog) lines.push(`case "$1" in push) echo "$@" >> '${pushLog}';; esac`);
  lines.push(`exec ${real} "$@"`);
  fs.writeFileSync(path.join(dir, 'git'), `${lines.join('\n')}\n`, { mode: 0o755 });
  return dir;
}
function runDirFor(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
function startChild(t, { root, runDir, shim, extraEnv = {} }) {
  const env = { ...process.env, GIT_HELPER_ROOT: root, GIT_HELPER_RUN_DIR: runDir, GIT_HELPER_PORT: '', ...extraEnv };
  if (shim) env.PATH = `${shim}:${process.env.PATH}`;
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  spawned.add(child);
  child.once('exit', () => spawned.delete(child));
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const ready = new Promise((resolve) => {
    const iv = setInterval(() => { if (/listening/.test(out) || child.exitCode !== null) { clearInterval(iv); resolve(); } }, 20);
  });
  return { child, exited, ready, out: () => out, err: () => err };
}

test('drain: SIGTERM lets the in-flight op finish and flush, then exits 0 and removes the socket', SPAWN_TEST, async (t) => {
  const { a } = fixture(t);
  const runDir = runDirFor(t);
  const sock = path.join(runDir, 'git-helper.sock');
  const s = startChild(t, { root: a, runDir, shim: shimDir(t, 1.5) });
  await s.ready;
  const token = fs.readFileSync(path.join(runDir, 'git-helper.token'), 'utf8').trim();
  const inflight = request(sock, 'POST', '/fetch', { token, body: {} });
  await new Promise((r) => setTimeout(r, 400));
  // a request whose headers finish only after the drain began gets 503
  const late = net.connect(sock);
  let lateBuf = '';
  late.on('data', (c) => { lateBuf += c; });
  late.write(`GET /status HTTP/1.1\r\nHost: x\r\nX-Git-Helper-Token: ${token}\r\nConnection: close\r\n`);
  await new Promise((r) => setTimeout(r, 100));
  s.child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  late.write('\r\n');
  const res = await inflight;
  assert.equal(res.status, 200);
  assert.equal(res.json.op, 'fetch');
  assert.equal(await s.exited, 0);
  assert.equal(fs.existsSync(sock), false);
  assert.match(lateBuf, /^HTTP\/1\.1 503/);
  assert.match(lateBuf, /shutting_down/);
});

test('drain cap: a stuck op is killed and the helper exits 1', SPAWN_TEST, async (t) => {
  const { a } = fixture(t);
  const runDir = runDirFor(t);
  const sock = path.join(runDir, 'git-helper.sock');
  const s = startChild(t, { root: a, runDir, shim: shimDir(t, 5), extraEnv: { GIT_HELPER_DRAIN_MS: '500' } });
  await s.ready;
  const token = fs.readFileSync(path.join(runDir, 'git-helper.token'), 'utf8').trim();
  request(sock, 'POST', '/fetch', { token, body: {} }).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  const t0 = Date.now();
  s.child.kill('SIGTERM');
  assert.equal(await s.exited, 1);
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(fs.existsSync(sock), false);
});

test('second start is refused while the first is live; token and socket stay intact', SPAWN_TEST, async (t) => {
  const { a } = fixture(t);
  const runDir = runDirFor(t);
  const sock = path.join(runDir, 'git-helper.sock');
  const first = startChild(t, { root: a, runDir });
  await first.ready;
  const tokenFile = path.join(runDir, 'git-helper.token');
  const before = fs.readFileSync(tokenFile, 'utf8');
  const second = startChild(t, { root: a, runDir });
  assert.equal(await second.exited, 1);
  assert.match(second.err(), /a git helper is already listening on .*git-helper\.sock/);
  assert.equal(fs.readFileSync(tokenFile, 'utf8'), before);
  assert.equal((await request(sock, 'GET', '/status', { token: before.trim() })).status, 200);
  first.child.kill('SIGTERM');
  assert.equal(await first.exited, 0);
});

test('a stale socket (dead listener) is replaced on start', SPAWN_TEST, async (t) => {
  const { a } = fixture(t);
  const runDir = runDirFor(t);
  const sock = path.join(runDir, 'git-helper.sock');
  // a listener that is SIGKILLed leaves the socket inode behind with nobody home
  const dead = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(sock)}, () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'inherit'] });
  spawned.add(dead);
  t.after(() => { if (dead.exitCode === null) dead.kill('SIGKILL'); });
  await new Promise((r) => dead.stdout.once('data', r));
  dead.kill('SIGKILL');
  await new Promise((r) => dead.on('exit', r));
  assert.equal(fs.statSync(sock).isSocket(), true);
  const s = startChild(t, { root: a, runDir });
  await s.ready;
  assert.equal(s.child.exitCode, null);
  const token = fs.readFileSync(path.join(runDir, 'git-helper.token'), 'utf8').trim();
  assert.equal((await request(sock, 'GET', '/status', { token })).status, 200);
  s.child.kill('SIGTERM');
  assert.equal(await s.exited, 0);
});

test('drain waits for the git op even when the client gave up mid-request', SPAWN_TEST, async (t) => {
  const { a } = fixture(t);
  const runDir = runDirFor(t);
  const mark = path.join(runDir, 'fetch-finished');
  const sock = path.join(runDir, 'git-helper.sock');
  const s = startChild(t, { root: a, runDir, shim: shimDir(t, 1.5, { mark }) });
  await s.ready;
  const token = fs.readFileSync(path.join(runDir, 'git-helper.token'), 'utf8').trim();
  const req = http.request({ socketPath: sock, method: 'POST', path: '/fetch', headers: { 'X-Git-Helper-Token': token } });
  req.on('error', () => {});
  req.end();
  await new Promise((r) => setTimeout(r, 400));
  req.destroy(); // backend client timed out: response is gone, git child is not
  await new Promise((r) => setTimeout(r, 100));
  s.child.kill('SIGTERM');
  assert.equal(await s.exited, 0);
  assert.equal(fs.existsSync(mark), true, 'helper waited for the git child instead of exiting under it');
});

test('drain cap with a client that already left: the git child is aborted, exit 1', SPAWN_TEST, async (t) => {
  const { a } = fixture(t);
  const runDir = runDirFor(t);
  const mark = path.join(runDir, 'fetch-finished');
  const sock = path.join(runDir, 'git-helper.sock');
  const s = startChild(t, { root: a, runDir, shim: shimDir(t, 5, { mark }), extraEnv: { GIT_HELPER_DRAIN_MS: '500' } });
  await s.ready;
  const token = fs.readFileSync(path.join(runDir, 'git-helper.token'), 'utf8').trim();
  const req = http.request({ socketPath: sock, method: 'POST', path: '/fetch', headers: { 'X-Git-Helper-Token': token } });
  req.on('error', () => {});
  req.end();
  await new Promise((r) => setTimeout(r, 400));
  req.destroy();
  await new Promise((r) => setTimeout(r, 100));
  s.child.kill('SIGTERM');
  assert.equal(await s.exited, 1);
  assert.equal(fs.existsSync(mark), false);
});

test('push and pull share one op deadline and fail with a clear timeout', async (t) => {
  const { a } = fixture(t);
  const prev = process.env.PATH;
  process.env.PATH = `${shimDir(t, 3)}:${prev}`;
  t.after(() => { process.env.PATH = prev; });
  const ops = createGitOps({ root: a, opDeadlineMs: 800 });
  const t0 = Date.now();
  const r = await ops.push();
  assert.equal(r.ok, false);
  assert.match(r.output, /timed out/);
  assert.ok(Date.now() - t0 < 2500, 'killed at the deadline, not after the 3s stall');
  const p = await ops.pull();
  assert.equal(p.ok, false);
  assert.match(p.output, /timed out/);
});

test('push reaches git with the fully qualified non-force refspec (+branch)', async (t) => {
  const { a, origin } = fixture(t);
  const pushLog = path.join(os.tmpdir(), `gh-pushlog-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(pushLog, { force: true }));
  const prev = process.env.PATH;
  process.env.PATH = `${shimDir(t, 0, { pushLog })}:${prev}`;
  t.after(() => { process.env.PATH = prev; });
  git(a, 'checkout', '-b', '+main');
  git(a, 'push', '-u', 'origin', 'refs/heads/+main:refs/heads/+main');
  write(a, 'a.txt', '1\n');
  git(a, 'add', '-A'); git(a, 'commit', '-m', 'mine');
  const before = fs.existsSync(pushLog) ? fs.readFileSync(pushLog, 'utf8') : '';
  const r = await createGitOps({ root: a }).push();
  assert.equal(r.ok, true);
  const added = fs.readFileSync(pushLog, 'utf8').slice(before.length).trim().split('\n');
  assert.deepEqual(added, ['push origin refs/heads/+main:refs/heads/+main']);
  assert.equal(git(origin, 'log', '-1', '--format=%s', 'refs/heads/+main'), 'mine');
});

test('origin/<branch> model: a branch pushed without -u is ahead of origin/<branch>, push lands', async (t) => {
  const { a, origin, ops } = fixture(t);
  git(a, 'checkout', '-b', 'bar');
  git(a, 'push', 'origin', 'refs/heads/bar:refs/heads/bar'); // no -u
  write(a, 'bar.txt', '1\n');
  git(a, 'add', '-A'); git(a, 'commit', '-m', 'bar one');
  const s = await ops.status();
  assert.equal(s.upstream, 'origin/bar');
  assert.equal(s.ahead, 1);
  assert.equal(s.behind, 0);
  const r = await ops.push();
  assert.equal(r.ok, true);
  assert.equal(git(origin, 'log', '-1', '--format=%s', 'refs/heads/bar'), 'bar one');
  assert.equal((await ops.status()).ahead, 0);
});

test('origin/<branch> model: a branch auto-tracking main without origin/<branch> has no upstream; nothing moves', async (t) => {
  const { a, b, origin, ops } = fixture(t);
  git(a, 'checkout', '-b', 'foo', 'origin/main'); // tracks origin/main, no origin/foo
  write(b, 'b.txt', '1\n');
  git(b, 'add', '-A'); git(b, 'commit', '-m', 'main moved'); git(b, 'push');
  const s = await ops.status();
  assert.equal(s.upstream, null);
  assert.equal(s.ahead, 0);
  const head = git(a, 'rev-parse', 'HEAD');
  await assert.rejects(ops.pull(), refusal('no_upstream'));
  assert.equal(git(a, 'rev-parse', 'HEAD'), head, 'pull did not follow @{u}');
  await assert.rejects(ops.push(), refusal('no_upstream'));
  assert.equal(git(origin, 'rev-parse', '--verify', '-q', 'refs/heads/main'), git(b, 'rev-parse', 'HEAD'));
});

test('pull on a detached HEAD is refused', async (t) => {
  const { a, ops } = fixture(t);
  git(a, 'checkout', '-q', '--detach');
  await assert.rejects(ops.pull(), refusal('no_upstream'));
});

test('a landed push is never reported failed because the trailing status failed', async (t) => {
  const { a, origin } = fixture(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-shim-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh\ncase "$1" in status) echo boom >&2; exit 2;; esac\nexec ${real} "$@"\n`, { mode: 0o755 });
  const prev = process.env.PATH;
  process.env.PATH = `${dir}:${prev}`;
  t.after(() => { process.env.PATH = prev; });
  write(a, 'local.txt', 'y\n');
  git(a, 'add', '-A'); git(a, 'commit', '-m', 'landed');
  const r = await createGitOps({ root: a }).push();
  assert.equal(r.ok, true);
  assert.equal(r.status, null);
  assert.match(r.note, /Status could not be refreshed/);
  assert.equal(git(origin, 'log', '-1', '--format=%s', 'main'), 'landed');
  // over HTTP the op's own ok decides the status code
  const runDir = runDirFor(t);
  const sock = path.join(runDir, 'git-helper.sock');
  const h = await createServer({ root: a, runDir }).start();
  t.after(() => h.close());
  const token = fs.readFileSync(path.join(runDir, 'git-helper.token'), 'utf8').trim();
  write(a, 'local2.txt', 'y\n');
  git(a, 'add', '-A'); git(a, 'commit', '-m', 'landed2');
  const res = await request(sock, 'POST', '/push', { token, body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.json.status, null);
});

test('abort() makes runGit refuse to spawn new children', async (t) => {
  const { a, ops } = fixture(t);
  ops.abort();
  await assert.rejects(ops.status(), /git status failed: aborted/);
  const r = await ops.fetch();
  assert.equal(r.ok, false);
  assert.match(r.output, /aborted/);
});
