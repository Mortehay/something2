const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// SOMET-401. This listener is reachable from the internet through the tunnel,
// and what it does is deploy. Everything here is about what happens to a
// request that should NOT deploy: the interesting cases are the rejections,
// so every one of them is exercised against a really running server rather
// than asserted about the source.

const SERVER = path.join(__dirname, '..', '..', 'compose', 'orangepi', 'deploy-hook', 'server.js');
const SECRET = 'test-secret-not-a-real-one';

function sign(body, secret = SECRET) {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

async function startServer(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-'));
  const marker = path.join(dir, 'deploy-ran');
  const script = path.join(dir, 'fake-deploy.sh');
  // Records that it ran, and with what -- so a test can prove nothing from
  // the request reached it.
  fs.writeFileSync(script, `#!/usr/bin/env bash\nprintf 'args:%s\\n' "$*" >> ${JSON.stringify(marker)}\nsleep "\${FAKE_DEPLOY_SECONDS:-0}"\nexit \${FAKE_DEPLOY_EXIT:-0}\n`);
  fs.chmodSync(script, 0o755);

  const port = 19000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, DEPLOY_HOOK_SECRET: SECRET, DEPLOY_HOOK_PORT: String(port), DEPLOY_SCRIPT: script, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (c) => { log += c; });
  child.stderr.on('data', (c) => { log += c; });

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      await fetch(`http://127.0.0.1:${port}/deploy-hook/health`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  return {
    port, child, marker, dir,
    log: () => log,
    stop() {
      child.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function post(port, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}/deploy-hook`, { method: 'POST', body, headers });
}

function freshBody(extra = {}) {
  return JSON.stringify({ timestamp: Date.now(), sha: 'abc123', ...extra });
}

test('the hook refuses to start without a secret', async (t) => {
  // A listener that ran unauthenticated "until the secret is configured"
  // would be a public deploy trigger that looks healthy the whole time.
  const server = await startServer({ DEPLOY_HOOK_SECRET: '' });
  // Registered immediately: a failing assertion below must not leave a
  // listener running, which would hang the whole test run rather than fail it.
  t.after(() => server.stop());
  await new Promise((r) => setTimeout(r, 300));
  assert.notStrictEqual(server.child.exitCode, null, 'the process should have exited');
  assert.notStrictEqual(server.child.exitCode, 0);
  assert.match(server.log(), /DEPLOY_HOOK_SECRET is not set/);
});

test('a correctly signed request starts a deploy', async (t) => {
  const server = await startServer();
  // Registered immediately: a failing assertion below must not leave a
  // listener running, which would hang the whole test run rather than fail it.
  t.after(() => server.stop());
  const body = freshBody();
  const res = await post(server.port, body, { 'x-deploy-signature': sign(body) });
  assert.strictEqual(res.status, 202);
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(fs.existsSync(server.marker), 'the deploy script should have run');
});

test('a request with no signature is rejected and deploys nothing', async (t) => {
  const server = await startServer();
  // Registered immediately: a failing assertion below must not leave a
  // listener running, which would hang the whole test run rather than fail it.
  t.after(() => server.stop());
  const res = await post(server.port, freshBody());
  assert.strictEqual(res.status, 401);
  await new Promise((r) => setTimeout(r, 300));
  // Rejecting means REJECTING: not logging and carrying on.
  assert.ok(!fs.existsSync(server.marker));
});

test('a request signed with the wrong secret is rejected', async (t) => {
  const server = await startServer();
  // Registered immediately: a failing assertion below must not leave a
  // listener running, which would hang the whole test run rather than fail it.
  t.after(() => server.stop());
  const body = freshBody();
  const res = await post(server.port, body, { 'x-deploy-signature': sign(body, 'the-wrong-secret') });
  assert.strictEqual(res.status, 401);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!fs.existsSync(server.marker));
});

test('a signature for a DIFFERENT body is rejected', async (t) => {
  // The signature must cover this request, not merely be a valid signature.
  const server = await startServer();
  // Registered immediately: a failing assertion below must not leave a
  // listener running, which would hang the whole test run rather than fail it.
  t.after(() => server.stop());
  const res = await post(server.port, freshBody({ sha: 'attacker' }), {
    'x-deploy-signature': sign(freshBody({ sha: 'legitimate' })),
  });
  assert.strictEqual(res.status, 401);
});

test('a correctly signed but stale request is rejected', async (t) => {
  // A captured request would otherwise be replayable forever, and replaying
  // it re-deploys whatever the branch tip happens to be at the time.
  const server = await startServer();
  // Registered immediately: a failing assertion below must not leave a
  // listener running, which would hang the whole test run rather than fail it.
  t.after(() => server.stop());
  const body = JSON.stringify({ timestamp: Date.now() - 60 * 60 * 1000, sha: 'abc123' });
  const res = await post(server.port, body, { 'x-deploy-signature': sign(body) });
  assert.strictEqual(res.status, 401);
  assert.match((await res.json()).error, /stale/);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!fs.existsSync(server.marker));
});

test('nothing from the request body reaches the deploy script', async (t) => {
  const server = await startServer();
  // Registered immediately: a failing assertion below must not leave a
  // listener running, which would hang the whole test run rather than fail it.
  t.after(() => server.stop());
  const body = freshBody({ sha: '$(touch /tmp/pwned)', ref: '; rm -rf /' });
  const res = await post(server.port, body, { 'x-deploy-signature': sign(body) });
  assert.strictEqual(res.status, 202);
  await new Promise((r) => setTimeout(r, 400));
  // The script is spawned with a fixed argv and no shell, and the body is
  // discarded after verification -- so the recorded arguments are empty.
  assert.strictEqual(fs.readFileSync(server.marker, 'utf8').trim(), 'args:');
  assert.ok(!fs.existsSync('/tmp/pwned'));
});

test('a second deploy while one is running is refused, not queued', async (t) => {
  // The authority is single-instance and a deploy is stop-then-start; two
  // overlapping deploys fight over the same containers.
  const server = await startServer({ FAKE_DEPLOY_SECONDS: '3' });
  // Registered immediately: a failing assertion below must not leave a
  // listener running, which would hang the whole test run rather than fail it.
  t.after(() => server.stop());
  const first = freshBody();
  const firstRes = await post(server.port, first, { 'x-deploy-signature': sign(first) });
  assert.strictEqual(firstRes.status, 202);

  const second = freshBody({ sha: 'second' });
  const secondRes = await post(server.port, second, { 'x-deploy-signature': sign(second) });
  assert.strictEqual(secondRes.status, 409);
  await new Promise((r) => setTimeout(r, 500));
  // One run, not two.
  assert.strictEqual(fs.readFileSync(server.marker, 'utf8').trim().split('\n').length, 1);
});

test('an oversized body is refused before it is buffered', async (t) => {
  // 4GB of RAM with a game running on it, and an endpoint anyone can reach.
  const server = await startServer();
  // Registered immediately: a failing assertion below must not leave a
  // listener running, which would hang the whole test run rather than fail it.
  t.after(() => server.stop());
  const res = await post(server.port, 'x'.repeat(200000), { 'x-deploy-signature': 'sha256=whatever' });
  assert.strictEqual(res.status, 413);
});

test('unknown paths and methods do not deploy', async (t) => {
  const server = await startServer();
  // Registered immediately: a failing assertion below must not leave a
  // listener running, which would hang the whole test run rather than fail it.
  t.after(() => server.stop());
  const body = freshBody();
  const signature = sign(body);
  assert.strictEqual((await fetch(`http://127.0.0.1:${server.port}/`)).status, 404);
  assert.strictEqual((await fetch(`http://127.0.0.1:${server.port}/deploy-hook`)).status, 404);
  // Neighbouring paths must not be routed to the deploy handler. (A
  // `/deploy-hook/../deploy-hook` probe is pointless here: fetch normalises
  // the `..` away before the request is sent, so it tests the client.)
  for (const url of ['/deploy-hook/health', '/deploy-hookX', '/deploy-hook/deploy']) {
    const res = await fetch(`http://127.0.0.1:${server.port}${url}`, {
      method: 'POST', body, headers: { 'x-deploy-signature': signature },
    });
    assert.strictEqual(res.status, 404, `${url} must not deploy`);
  }
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!fs.existsSync(server.marker));
});

test('the health endpoint reports deploy state without authentication', async (t) => {
  // Deliberately unauthenticated and deliberately read-only: it is what
  // `make pi-status` and a human debugging a failed deploy both read.
  const server = await startServer();
  // Registered immediately: a failing assertion below must not leave a
  // listener running, which would hang the whole test run rather than fail it.
  t.after(() => server.stop());
  const health = await (await fetch(`http://127.0.0.1:${server.port}/deploy-hook/health`)).json();
  assert.strictEqual(health.status, 'ok');
  assert.strictEqual(health.deploying, false);
});

test('a failed deploy is recorded rather than swallowed', async (t) => {
  const server = await startServer({ FAKE_DEPLOY_EXIT: '3' });
  // Registered immediately: a failing assertion below must not leave a
  // listener running, which would hang the whole test run rather than fail it.
  t.after(() => server.stop());
  const body = freshBody();
  await post(server.port, body, { 'x-deploy-signature': sign(body) });
  await new Promise((r) => setTimeout(r, 600));
  const health = await (await fetch(`http://127.0.0.1:${server.port}/deploy-hook/health`)).json();
  assert.strictEqual(health.last.code, 3);
});
