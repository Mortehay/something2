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
  const bad = await ops.pull();
  assert.equal(bad.ok, false);
  assert.equal(git(a, 'rev-parse', 'HEAD'), head, 'no merge commit, no rebase');
  assert.equal(git(a, 'rev-list', '--merges', '--count', 'HEAD'), '0');
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

test('push never force-updates, even for a branch named with a leading +', async (t) => {
  const { a, b, origin, ops } = fixture(t);
  git(a, 'checkout', '-b', '+main');
  git(a, 'push', '-u', 'origin', 'refs/heads/+main:refs/heads/+main');
  git(b, 'fetch', 'origin');
  git(b, 'checkout', '-b', '+main', '--track', 'origin/+main');
  write(b, 'b.txt', '1\n');
  git(b, 'add', '-A'); git(b, 'commit', '-m', 'other pc'); git(b, 'push', 'origin', 'refs/heads/+main:refs/heads/+main');
  // a's tracking ref is stale (no fetch), so the pre-check sees "ahead only"
  write(a, 'a.txt', '1\n');
  git(a, 'add', '-A'); git(a, 'commit', '-m', 'mine');
  const r = await ops.push();
  assert.equal(r.ok, false);
  assert.equal(git(origin, 'log', '-1', '--format=%s', 'refs/heads/+main'), 'other pc', 'origin not overwritten');
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
