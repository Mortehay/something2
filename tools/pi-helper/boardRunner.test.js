'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRunner, redact } = require('./boardRunner');
const { scratch } = require('./testkit');

test('script refuses a name outside the allow-list', async (t) => {
  const s = scratch(t);
  const r = createRunner({ root: s.root, env: s.env });
  await assert.rejects(() => r.script('rm.sh', []), /not allowed/);
  await assert.rejects(() => r.script('../x.sh', []), /not allowed/);
});

test('script kills the child at the timeout and reports code null', async (t) => {
  const s = scratch(t);
  s.script('backup.sh', 'sleep 30 & echo $! > "$REPO_ROOT/grandchild.pid"; wait');
  const r = createRunner({ root: s.root, env: s.env });
  const t0 = Date.now();
  const res = await r.script('backup.sh', [], { timeoutMs: 300 });
  assert.equal(res.code, null);
  assert.ok(Date.now() - t0 < 5000);
  // the grandchild (like ssh under a script) died with the group
  const pid = Number(require('node:fs').readFileSync(`${s.root}/grandchild.pid`, 'utf8'));
  await new Promise((x) => setTimeout(x, 100));
  assert.throws(() => process.kill(pid, 0));
});

test('script runs from the repo root with REPO_ROOT set, and a non-zero exit resolves', async (t) => {
  const s = scratch(t);
  s.script('remote.sh', 'echo "root=$REPO_ROOT cwd=$PWD arg=$1"; read -r x && echo stdin-open; exit 3');
  const r = createRunner({ root: s.root, env: s.env });
  const res = await r.script('remote.sh', ['a']);
  assert.equal(res.code, 3);
  assert.match(res.output, new RegExp(`root=${s.root} cwd=${s.root} arg=a`));
  assert.doesNotMatch(res.output, /stdin-open/);
});

test('output is redacted', async (t) => {
  const s = scratch(t, { envText: 'ORANGEPI_PASSWORD=hunter2-pass\nNGROK_AUTHTOKEN=tok_abcdef123\nPLAIN=visible\nSHORT_KEY=ab\nEMPTY_TOKEN=\n' });
  s.script('deploy.sh', 'echo "pw=hunter2-pass"; echo "tok=tok_abcdef123" >&2; echo plain=visible');
  const r = createRunner({ root: s.root, env: s.env });
  const lines = [];
  const res = await r.script('deploy.sh', [], { onLine: (l) => lines.push(l) });
  for (const text of [res.output, lines.join('\n')]) {
    assert.doesNotMatch(text, /hunter2-pass|tok_abcdef123/);
  }
  assert.match(res.output, /plain=visible/);
  assert.ok(lines.length >= 3);
});

test('secrets: longest first, skips empty and short values, re-reads the file', async (t) => {
  const s = scratch(t, { envText: 'A_PASSWORD=abcd\nB_SECRET=abcdefgh\nC_TOKEN=\nD_KEY=xyz\nE_NAME=notasecret\n' });
  const r = createRunner({ root: s.root, env: s.env });
  assert.deepEqual(r.secrets(), ['abcdefgh', 'abcd']);
  require('node:fs').writeFileSync(`${s.root}/.env`, 'F_TOKEN="quoted-value"\n');
  assert.deepEqual(r.secrets(), ['quoted-value']);
  assert.equal(redact('xabcdefghx abcd', ['abcdefgh', 'abcd']), 'x***x ***');
});

test('ssh uses BatchMode, ConnectTimeout=5, login@address and redacts', async (t) => {
  const s = scratch(t, { envText: 'ORANGEPI_PASSWORD=sshsecret99\n' });
  s.stub('ssh', 'echo "ARGS: $*"; echo sshsecret99');
  const r = createRunner({ root: s.root, env: s.env });
  const res = await r.ssh('uptime');
  assert.equal(res.code, 0);
  assert.match(res.output, /BatchMode=yes/);
  assert.match(res.output, /ConnectTimeout=5/);
  assert.match(res.output, /tester@203\.0\.113\.9 uptime/);
  assert.doesNotMatch(res.output, /sshsecret99/);
});

test('run returns stdout and stderr separately, both redacted', async (t) => {
  const s = scratch(t, { envText: 'X_SECRET=sekrit-value\n' });
  s.script('deploy.sh', 'echo out-sekrit-value; echo err-sekrit-value >&2');
  const res = await createRunner({ root: s.root, env: s.env }).script('deploy.sh');
  assert.equal(res.stdout, 'out-***\n');
  assert.equal(res.stderr, 'err-***\n');
});

test('busyCount tracks live children and abort kills their groups', async (t) => {
  const s = scratch(t);
  s.script('backup.sh', 'sleep 30 & echo $! > "$REPO_ROOT/gc.pid"; wait');
  const r = createRunner({ root: s.root, env: s.env });
  const p = r.script('backup.sh', [], { timeoutMs: 60_000 });
  await new Promise((x) => setTimeout(x, 300));
  assert.equal(r.busyCount(), 1);
  r.abort();
  const res = await p;
  assert.notEqual(res.code, 0);
  assert.equal(r.busyCount(), 0);
  const pid = Number(require('node:fs').readFileSync(`${s.root}/gc.pid`, 'utf8'));
  await new Promise((x) => setTimeout(x, 100));
  assert.throws(() => process.kill(pid, 0));
});
