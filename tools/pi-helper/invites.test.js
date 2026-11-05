'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRunner } = require('./boardRunner');
const { BoardOffline } = require('./boardJobs');
const { BadRequest } = require('../helper-core/helperServer');
const { scratch } = require('./testkit');
const { listInvites, mintInvites, revokeInvite, CODE_RE, NOTE_MAX } = require('./invites');
const { ALPHABET } = require('../../backend/scripts/invite-codes.js');

const result = (over = {}) => ({ code: 0, output: '', stdout: '', stderr: '', timedOut: false, ...over });
function stubRunner(handler) {
  const calls = [];
  return { calls, script: async (name, args) => { calls.push({ name, args }); return handler(name, args); } };
}
const SCRIPT = ['backend', 'node', 'scripts/invite-codes.js'];
const rejectsBad = (p, re) => assert.rejects(p, (e) => e instanceof BadRequest && re.test(e.message));

test('the code format is the script alphabet and length', () => {
  assert.ok(CODE_RE.test('ABCD-EFGH-JKMN'));
  for (const bad of ['', 'ABCD-EFGH', 'abcd-efgh-jkmn', 'ABCD-EFGH-JKMO', 'ABCD-EFGH-JKM1', 'ABCD-EFGH-JKMN\n', 'ABCD-EFGH-JKMN; ls', '--note']) {
    assert.equal(CODE_RE.test(bad), false, bad);
  }
  for (const ch of ALPHABET) assert.ok(CODE_RE.test(`${ch}${ch}${ch}${ch}-${ch}${ch}${ch}${ch}-${ch}${ch}${ch}${ch}`));
  assert.equal(CODE_RE.source.includes(ALPHABET), true, 'same alphabet as scripts/invite-codes.js');
});

test('list asks for the JSON list and returns newest first, capped', async () => {
  const invites = Array.from({ length: 250 }, (_, i) => ({ code: 'AAAA-AAAA-AAAA', note: null, createdAt: '2026-11-0' + (i % 9 + 1), usedAt: null, usedBy: null, status: 'unused' }));
  const runner = stubRunner(() => result({ stdout: `${JSON.stringify({ invites })}\n` }));
  const out = await listInvites(runner);
  assert.deepEqual(runner.calls, [{ name: 'remote.sh', args: [...SCRIPT, 'list', '--all', '--json'] }]);
  assert.equal(out.invites.length, 200);
  assert.equal(out.total, 250);
});

test('an older board image (no --json) says to update', async () => {
  const runner = stubRunner(() => result({ stdout: 'ABCD-EFGH-JKMN  unused  (for alice)\n' }));
  assert.deepEqual(await listInvites(runner), { needsUpdate: true, invites: [], total: 0 });
  const empty = stubRunner(() => result({ stdout: 'no invite codes\n' }));
  assert.equal((await listInvites(empty)).needsUpdate, true);
});

test('the board not being reached is board_offline, other failures are errors', async () => {
  await assert.rejects(listInvites(stubRunner(() => result({ code: 255 }))), BoardOffline);
  await assert.rejects(listInvites(stubRunner(() => result({ timedOut: true, code: null }))), BoardOffline);
  await assert.rejects(listInvites(stubRunner(() => result({ code: 1, output: 'connection refused' }))), /connection refused/);
});

test('mint passes the count and note as separate fixed arguments', async () => {
  const runner = stubRunner(() => result({ stdout: '{"codes":["ABCD-EFGH-JKMN","ABCD-EFGH-JKMP"],"requested":2}\n' }));
  const out = await mintInvites(runner, { count: 2, note: ' for alice ' });
  assert.deepEqual(runner.calls[0].args, [...SCRIPT, 'mint', '2', '--json', '--note', 'for alice']);
  assert.deepEqual(out, { codes: ['ABCD-EFGH-JKMN', 'ABCD-EFGH-JKMP'], requested: 2, partial: false });
  await mintInvites(runner, { count: 1 });
  assert.deepEqual(runner.calls[1].args, [...SCRIPT, 'mint', '1', '--json']);
  await mintInvites(runner, { count: 1, note: '   ' });
  assert.deepEqual(runner.calls[2].args, [...SCRIPT, 'mint', '1', '--json']);
});

test('mint validates strictly and never reaches the board on a bad value', async () => {
  const runner = stubRunner(() => result());
  for (const count of [0, 21, -1, 1.5, '3', null, undefined, NaN, Infinity, [], {}]) {
    await rejectsBad(mintInvites(runner, { count }), /count/);
  }
  for (const note of ['x'.repeat(NOTE_MAX + 1), 'a\nb', 'a\u0000b', 'a\tb', 'a‮b', 5, {}, ['x']]) {
    await rejectsBad(mintInvites(runner, { count: 1, note }), /note/);
  }
  await rejectsBad(mintInvites(runner, null), /count/);
  assert.equal(runner.calls.length, 0);
  // exactly at the limits
  await mintInvites(stubRunner(() => result({ stdout: '{"codes":[],"requested":20}' })), { count: 20, note: 'x'.repeat(NOTE_MAX) });
});

test('mint reports a partial batch', async () => {
  const runner = stubRunner(() => result({ stdout: '{"codes":["ABCD-EFGH-JKMN"],"requested":3}\n' }));
  assert.equal((await mintInvites(runner, { count: 3 })).partial, true);
});

test('an older image still minted: the codes it printed are not lost', async () => {
  const runner = stubRunner(() => result({ stdout: 'ABCD-EFGH-JKMN\nABCD-EFGH-JKMP\n' }));
  const out = await mintInvites(runner, { count: 2 });
  assert.deepEqual(out.codes, ['ABCD-EFGH-JKMN', 'ABCD-EFGH-JKMP']);
  await assert.rejects(mintInvites(stubRunner(() => result({ stdout: 'garbage\n' })), { count: 1 }), /unexpected/i);
});

test('revoke validates the code and passes it alone', async () => {
  const runner = stubRunner(() => result({ stdout: '{"revoked":"ABCD-EFGH-JKMN"}\n' }));
  assert.deepEqual(await revokeInvite(runner, { code: 'ABCD-EFGH-JKMN' }), { revoked: 'ABCD-EFGH-JKMN' });
  assert.deepEqual(runner.calls[0].args, [...SCRIPT, 'revoke', 'ABCD-EFGH-JKMN', '--json']);
  for (const code of ['--note', 'abcd-efgh-jkmn', 'ABCD-EFGH-JKMN --json', 'ABCD-EFGH-JKM1', '', null, 5, undefined]) {
    await rejectsBad(revokeInvite(runner, { code }), /code/);
  }
  await rejectsBad(revokeInvite(runner, null), /code/);
  assert.equal(runner.calls.length, 1);
  const none = stubRunner(() => result({ stdout: '{"revoked":null}\n' }));
  assert.deepEqual(await revokeInvite(none, { code: 'ABCD-EFGH-JKMN' }), { revoked: null });
  const old = stubRunner(() => result({ stdout: 'revoked ABCD-EFGH-JKMN\n' }));
  assert.deepEqual(await revokeInvite(old, { code: 'ABCD-EFGH-JKMN' }), { revoked: 'ABCD-EFGH-JKMN' });
});

// The real remote.sh and the real runner, ssh replaced by PI_LOCAL (bash -c of the same string ssh would send)
// and docker by a stub that writes each argument it receives on its own line.
test('a hostile note stays one inert argument all the way through remote.sh', async (t) => {
  const s = scratch(t);
  const scripts = path.resolve(__dirname, '../../compose/orangepi/scripts');
  for (const f of ['remote.sh', 'lib.sh']) fs.copyFileSync(path.join(scripts, f), path.join(s.root, 'compose/orangepi/scripts', f));
  const argv = path.join(s.root, 'argv.txt');
  const pwned = path.join(s.root, 'PWNED');
  s.stub('docker', `printf '<%s>\\n' "$@" > ${JSON.stringify(argv)}; echo '{"codes":["ABCD-EFGH-JKMN"],"requested":1}'`);
  const env = { ...s.env, PI_LOCAL: '1', ORANGEPI_DATA_DIR: s.root, ORANGEPI_APP_DIR: s.root };
  const runner = createRunner({ root: s.root, env, controlDir: path.join(s.root, 'ctl') });
  const note = 'a"b\' $(touch PWNED); `touch PWNED` | tee PWNED && x \\ #z';
  const out = await mintInvites(runner, { count: 1, note });
  assert.deepEqual(out.codes, ['ABCD-EFGH-JKMN']);
  assert.equal(fs.existsSync(pwned), false, 'the note was executed');
  const lines = fs.readFileSync(argv, 'utf8').split('\n').filter(Boolean);
  const tailArgs = lines.slice(lines.indexOf('<exec>'));
  assert.deepEqual(tailArgs, ['<exec>', '<-T>', '<backend>', '<node>', '<scripts/invite-codes.js>', '<mint>', '<1>', '<--json>', '<--note>', `<${note}>`]);
});
