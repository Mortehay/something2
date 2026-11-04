'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRunner } = require('./boardRunner');
const { readStatus } = require('./status');
const { scratch } = require('./testkit');

test('readStatus reports offline quickly', async (t) => {
  const s = scratch(t);
  s.stub('ssh', 'exit 255');
  s.stub('git', 'exit 1');
  const t0 = Date.now();
  const st = await readStatus(createRunner({ root: s.root, env: s.env }));
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(st.online, false);
  assert.equal(st.commit, null);
  assert.equal(st.host, '203.0.113.9');
  assert.equal(st.tunnels.ngrok.state, 'off');
});

test('readStatus does not run tunnel.sh when the probe fails', async (t) => {
  const s = scratch(t);
  s.stub('ssh', 'exit 255');
  s.stub('git', 'exit 1');
  s.script('tunnel.sh', 'touch "$REPO_ROOT/tunnel-ran"');
  await readStatus(createRunner({ root: s.root, env: s.env }));
  assert.equal(fs.existsSync(`${s.root}/tunnel-ran`), false);
});

function online(s) {
  s.stub('ssh', 'echo commit=abc12345; echo health=200');
  s.stub('git', `echo "$@" >> "$REPO_ROOT/git.log"
case "$1" in rev-list) echo 4;; esac`);
  s.script('tunnel.sh', `case "$2" in
cloudflare) printf 'state=on\\nurl=https://x.trycloudflare.com\\nverified=yes\\nage=120\\n';;
ngrok) printf 'state=off\\nurl=\\nverified=no\\nage=\\n';;
esac`);
}

test('readStatus parses commit, tunnels and behindMain', async (t) => {
  const s = scratch(t);
  online(s);
  const st = await readStatus(createRunner({ root: s.root, env: s.env }));
  assert.equal(st.online, true);
  assert.equal(st.commit, 'abc12345');
  assert.equal(st.behindMain, 4);
  assert.equal(st.healthCode, 200);
  assert.deepEqual(st.tunnels.cloudflare, { state: 'on', url: 'https://x.trycloudflare.com', verified: true, ageSeconds: 120 });
  assert.deepEqual(st.tunnels.ngrok, { state: 'off', url: null, verified: false, ageSeconds: null });
  assert.match(fs.readFileSync(`${s.root}/git.log`, 'utf8'), /rev-list --count abc12345\.\.origin\/main/);
});

test('behindMain is null when the commit is unknown locally', async (t) => {
  const s = scratch(t);
  online(s);
  s.stub('git', 'exit 128');
  const st = await readStatus(createRunner({ root: s.root, env: s.env }));
  assert.equal(st.behindMain, null);
  assert.equal(st.commit, 'abc12345');
});

test('git fetch runs at most once per 5 minutes', async (t) => {
  const s = scratch(t);
  online(s);
  const r = createRunner({ root: s.root, env: s.env });
  await readStatus(r);
  await readStatus(r);
  const fetches = fs.readFileSync(`${s.root}/git.log`, 'utf8').split('\n').filter((l) => l.startsWith('fetch'));
  assert.deepEqual(fetches, ['fetch origin main orangepi']);
});

function tunnelRunner(s, body) {
  online(s);
  s.script('tunnel.sh', body);
  return createRunner({ root: s.root, env: s.env });
}

test('state=on, verified=no with a url gives url null', async (t) => {
  const s = scratch(t);
  const st = await readStatus(tunnelRunner(s, "printf 'state=on\\nurl=https://u.example\\nverified=no\\nage=5\\n'"));
  assert.deepEqual(st.tunnels.cloudflare, { state: 'on', url: null, verified: false, ageSeconds: 5 });
});

test('verified=yes without a url gives verified false', async (t) => {
  const s = scratch(t);
  const st = await readStatus(tunnelRunner(s, "printf 'state=on\\nurl=\\nverified=yes\\nage=5\\n'"));
  assert.equal(st.tunnels.ngrok.verified, false);
  assert.equal(st.tunnels.ngrok.url, null);
});

test('stderr never shadows parsed stdout (tunnel.sh and ssh)', async (t) => {
  const s = scratch(t);
  online(s);
  s.stub('ssh', 'echo commit=deadbeef >&2; echo commit=abc12345; echo health=200');
  s.script('tunnel.sh', "echo 'url=https://evil.example' >&2; printf 'state=on\\nurl=https://good.example\\nverified=yes\\nage=1\\n'");
  const st = await readStatus(createRunner({ root: s.root, env: s.env }));
  assert.equal(st.commit, 'abc12345');
  assert.equal(st.tunnels.cloudflare.url, 'https://good.example');
});

test('stderr-only url does not become the url', async (t) => {
  const s = scratch(t);
  const st = await readStatus(tunnelRunner(s, "echo 'url=https://evil.example' >&2; printf 'state=on\\nverified=yes\\n'"));
  assert.equal(st.tunnels.cloudflare.url, null);
  assert.equal(st.tunnels.cloudflare.verified, false);
});

test('missing ORANGEPI_LOGIN/ADDRESS reads as offline, with a sentence from ssh()', async (t) => {
  const s = scratch(t);
  s.stub('ssh', 'echo should-not-run; exit 0');
  s.stub('git', 'exit 1');
  const r = createRunner({ root: s.root, env: { PATH: s.env.PATH } });
  const res = await r.ssh('true');
  assert.equal(res.code, 78);
  assert.match(res.stderr, /ORANGEPI_LOGIN and ORANGEPI_ADDRESS must both be set/);
  assert.doesNotMatch(res.output, /should-not-run|undefined@/);
  assert.equal((await readStatus(r)).online, false);
});

test('a failing or killed tunnel.sh status is unknown, not off', async (t) => {
  const s = scratch(t);
  const failing = await readStatus(tunnelRunner(s, 'exit 3'));
  assert.deepEqual(failing.tunnels.cloudflare, { state: 'unknown', url: null, verified: false, ageSeconds: null });
  const s2 = scratch(t);
  const slow = await readStatus(tunnelRunner(s2, 'sleep 5'), { tunnelMs: 200 });
  assert.equal(slow.tunnels.ngrok.state, 'unknown');
  assert.equal(slow.online, true);
});
