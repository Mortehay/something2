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
