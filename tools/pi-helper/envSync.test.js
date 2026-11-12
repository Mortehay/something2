'use strict';
// .env sync (email accounts, Task 15). Fake runners only: nothing here reaches a board. Every value below is fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { BoardOffline } = require('./boardJobs');
const { BadRequest } = require('../helper-core/helperServer');
const { scratch } = require('./testkit');
const { LOCKED_KEYS, isLocked, readLocalEnv, envStatus, copyEnvKeys, copyInFlight, EnvSyncFailed } = require('./envSync');
const { BusyError } = require('./jobs');

const sha = (v) => crypto.createHash('sha256').update(v, 'utf8').digest('hex');
const result = (over = {}) => ({ code: 0, output: '', stdout: '', stderr: '', timedOut: false, ...over });
const SECRET = 'fake-smtp-pass-zq81 xk';
const LOCAL = [
  'SMTP_HOST=smtp.example.test',
  `SMTP_PASS="${SECRET}"`,
  'SMTP_USER=fake@example.test',
  'SMTP_PORT=587',
  'JWT_SECRET=fake-local-jwt-secret-value',
  'POSTGRES_PASSWORD=fake-local-pg-password',
  'EMPTY_ONE=',
  '# a comment',
].join('\n');

// A runner that answers `env-sync.sh hashes` with the given board map and records every call (args, opts).
function fakeRunner(board, { onWrite } = {}) {
  const calls = [];
  return {
    calls,
    secrets: () => [],
    script: async (name, args, opts = {}) => {
      calls.push({ name, args, opts });
      if (args[0] === 'hashes') return result({ stdout: Object.entries(board).map(([k, v]) => `${k} ${sha(v)}\n`).join('') });
      if (args[0] === 'write') return onWrite ? onWrite(args[1], opts.input) : result({ stdout: `wrote ${args[1]}\n` });
      return result({ code: 2 });
    },
  };
}

// Everything printed to the console while fn runs, so a test can prove no value or hash went there.
async function captureConsole(fn) {
  const seen = [];
  const keep = {};
  for (const k of ['log', 'error', 'warn', 'info', 'debug']) {
    keep[k] = console[k];
    console[k] = (...a) => { seen.push(a.map(String).join(' ')); };
  }
  try { return { value: await fn(), seen }; } catch (e) { return { error: e, seen }; } finally { Object.assign(console, keep); }
}

test('locked keys: the exact list plus the board-specific families', () => {
  assert.deepEqual(LOCKED_KEYS, ['DATABASE_URL', 'TEST_DATABASE_URL', 'REDIS_URL', 'CORS_ORIGINS', 'PUBLIC_URL', 'APP_URL', 'JWT_SECRET', 'TRUST_PROXY', 'REGISTRATION_MODE', 'MIGRATE_ON_BOOT', 'BOARD_TAB_ENABLED',
    'DEPLOY_HOOK_SECRET', 'ALLOW_LOCALHOST_API_URL', 'GIT_REPOSITORY',
    'TRUST_CF_CONNECTING_IP', 'NGROK_DOMAIN', 'NGROK_AUTHTOKEN']);
  for (const k of LOCKED_KEYS) assert.equal(isLocked(k), true, k);
  // A PC git credential (GIT_*) or compose setting (COMPOSE_*) never goes to the board.
  for (const k of ['POSTGRES_PASSWORD', 'MINIO_ROOT_USER', 'ORANGEPI_ADDRESS', 'BOARD_X', 'PI_LOCAL', 'GIT_TOKEN', 'GIT_REPOSITORY', 'COMPOSE_PROFILES', 'DEPLOY_HOOK_SECRET']) assert.equal(isLocked(k), true, k);
  for (const k of ['SMTP_HOST', 'SMTP_PASS', 'PIXEL', 'DATABASE_URL_X']) assert.equal(isLocked(k), false, k);
  // A key the board writer refuses cannot be copied either.
  assert.equal(isLocked('lower_case'), true);
});

test('readLocalEnv parses the repo .env into a Map, quotes stripped; a missing file is empty', (t) => {
  const s = scratch(t, { envText: LOCAL });
  const m = readLocalEnv(s.root);
  assert.ok(m instanceof Map);
  assert.equal(m.get('SMTP_PASS'), SECRET);
  assert.equal(m.get('EMPTY_ONE'), '');
  fs.rmSync(`${s.root}/.env`);
  assert.equal(readLocalEnv(s.root).size, 0);
});

test('status: passed, different, not passed, board only and locked (no comparison), sorted, no value or hash in it', async (t) => {
  const s = scratch(t, { envText: LOCAL });
  const runner = fakeRunner({ SMTP_HOST: 'smtp.example.test', SMTP_USER: 'other@example.test', JWT_SECRET: 'fake-board-jwt', ONLY_ON_BOARD: 'x', POSTGRES_PASSWORD: 'fake-board-pg' });
  const { value: out, seen } = await captureConsole(() => envStatus(runner, s.root));
  assert.deepEqual(runner.calls.map((c) => [c.name, c.args]), [['env-sync.sh', ['hashes']]]);
  assert.deepEqual(out, { keys: [
    { key: 'EMPTY_ONE', status: 'not_passed', locked: false },
    { key: 'JWT_SECRET', status: 'locked', locked: true },
    { key: 'ONLY_ON_BOARD', status: 'board_only', locked: false },
    { key: 'POSTGRES_PASSWORD', status: 'locked', locked: true },
    { key: 'SMTP_HOST', status: 'passed', locked: false },
    { key: 'SMTP_PASS', status: 'not_passed', locked: false },
    { key: 'SMTP_PORT', status: 'not_passed', locked: false },
    { key: 'SMTP_USER', status: 'different', locked: false },
  ] });
  const text = JSON.stringify(out) + seen.join('\n');
  for (const v of [SECRET, 'smtp.example.test', sha('smtp.example.test'), sha(SECRET)]) assert.ok(!text.includes(v), v);
});

test('status: lines that are not KEY <sha256> are ignored', async (t) => {
  const s = scratch(t, { envText: 'A_KEY=1\n' });
  const runner = { secrets: () => [], script: async () => result({ stdout: `A_KEY ${sha('1')}\nnoise line\nB_KEY nothex\nC_KEY ${sha('2')} extra\n` }) };
  assert.deepEqual((await envStatus(runner, s.root)).keys, [{ key: 'A_KEY', status: 'passed', locked: false }]);
});

test('status: an unreachable board is BoardOffline; another failure names the exit code and never the hashes', async (t) => {
  const s = scratch(t, { envText: LOCAL });
  for (const r of [result({ code: 255 }), result({ code: null, timedOut: true }), result({ code: 78 })]) {
    await assert.rejects(envStatus({ secrets: () => [], script: async () => r }, s.root), BoardOffline);
  }
  const partial = result({ code: 3, stdout: `SMTP_HOST ${sha('smtp.example.test')}\n`, stderr: `the board's .env is missing\n`, output: `SMTP_HOST ${sha('smtp.example.test')}\nthe board's .env is missing\n` });
  await assert.rejects(envStatus({ secrets: () => [], script: async () => partial }, s.root), (e) => e instanceof EnvSyncFailed
    && /exit 3/.test(e.message) && /missing/.test(e.message) && !e.message.includes(sha('smtp.example.test')));
});

test('copy: each value goes on stdin only, never in the arguments; locked, missing and empty keys are skipped', async (t) => {
  const s = scratch(t, { envText: LOCAL });
  const runner = fakeRunner({});
  const { value: out, seen } = await captureConsole(() => copyEnvKeys(runner, s.root, ['SMTP_PASS', 'SMTP_HOST', 'JWT_SECRET', 'POSTGRES_PASSWORD', 'NOT_HERE', 'EMPTY_ONE', 'SMTP_PASS']));
  assert.deepEqual(out, {
    written: ['SMTP_PASS', 'SMTP_HOST'],
    skipped: [{ key: 'JWT_SECRET', reason: 'locked' }, { key: 'POSTGRES_PASSWORD', reason: 'locked' }, { key: 'NOT_HERE', reason: 'not_local' }, { key: 'EMPTY_ONE', reason: 'empty' }],
  });
  const writes = runner.calls.filter((c) => c.args[0] === 'write');
  assert.deepEqual(writes.map((c) => [c.name, c.args]), [['env-sync.sh', ['write', 'SMTP_PASS']], ['env-sync.sh', ['write', 'SMTP_HOST']]]);
  assert.equal(writes[0].opts.input, `${SECRET}\n`);
  assert.equal(writes[1].opts.input, 'smtp.example.test\n');
  // Locked keys are never written, whatever was asked.
  assert.ok(!runner.calls.some((c) => c.args.includes('JWT_SECRET') || c.args.includes('POSTGRES_PASSWORD')));
  for (const c of runner.calls) assert.ok(!c.args.some((a) => a.includes(SECRET) || a.includes('fake-local')), JSON.stringify(c.args));
  const text = JSON.stringify(out) + seen.join('\n');
  for (const v of [SECRET, sha(SECRET), 'smtp.example.test']) assert.ok(!text.includes(v), v);
});

test('copy: locked names from every class are skipped, never written', async (t) => {
  const exact = ['DEPLOY_HOOK_SECRET', 'TRUST_CF_CONNECTING_IP', 'NGROK_DOMAIN', 'NGROK_AUTHTOKEN', 'JWT_SECRET', 'DATABASE_URL'];
  const prefixed = ['GIT_TOKEN', 'COMPOSE_PROFILES', 'POSTGRES_PASSWORD', 'MINIO_ROOT_USER', 'ORANGEPI_ADDRESS', 'BOARD_X', 'PI_LOCAL'];
  const all = [...exact, ...prefixed];
  // Every one of them present locally with a value, so only the lock can be the reason it is skipped.
  const s = scratch(t, { envText: [...all.map((k) => `${k}=fake-${k.toLowerCase()}`), 'SMTP_HOST=smtp.example.test'].join('\n') });
  const runner = fakeRunner({});
  const out = await copyEnvKeys(runner, s.root, [...all, 'SMTP_HOST']);
  assert.deepEqual(out.written, ['SMTP_HOST']);
  assert.deepEqual(out.skipped, all.map((key) => ({ key, reason: 'locked' })));
  assert.deepEqual(runner.calls.filter((c) => c.args[0] === 'write').map((c) => c.args[1]), ['SMTP_HOST']);
});

test('copy: a failed write names the key and the exit code, never the value, even if the board echoed it', async (t) => {
  const s = scratch(t, { envText: LOCAL });
  const runner = fakeRunner({}, { onWrite: (key, input) => (key === 'SMTP_PASS'
    ? result({ code: 1, stderr: `oops: ${input} ${sha(SECRET)}\n`, output: `oops: ${input} ${sha(SECRET)}\n` })
    : result()) });
  const { error, seen } = await captureConsole(() => copyEnvKeys(runner, s.root, ['SMTP_HOST', 'SMTP_PASS']));
  assert.ok(error instanceof EnvSyncFailed, String(error));
  assert.match(error.message, /SMTP_PASS/);
  assert.match(error.message, /exit 1/);
  assert.match(error.message, /SMTP_HOST/, 'says what was written before the failure');
  for (const v of [SECRET, 'fake-smtp-pass', sha(SECRET)]) assert.ok(!(error.message + seen.join('\n')).includes(v), v);
});

test('copy: an unreachable board is BoardOffline, and says what was written before', async (t) => {
  const s = scratch(t, { envText: LOCAL });
  await assert.rejects(copyEnvKeys(fakeRunner({}, { onWrite: () => result({ code: 255 }) }), s.root, ['SMTP_HOST']), BoardOffline);
  const runner = fakeRunner({}, { onWrite: (key) => (key === 'SMTP_USER' ? result({ code: null, timedOut: true }) : result()) });
  await assert.rejects(copyEnvKeys(runner, s.root, ['SMTP_HOST', 'SMTP_USER']), (e) => e instanceof BoardOffline && /SMTP_HOST/.test(e.message) && !e.message.includes(SECRET));
});

test('copy: keys must be a non-empty array of KEY names; nothing reaches the board otherwise', async (t) => {
  const s = scratch(t, { envText: LOCAL });
  const runner = fakeRunner({});
  for (const keys of [undefined, null, 'SMTP_HOST', {}, [], [5], ['smtp_host'], ['SMTP HOST'], ['A=B'], ['A;ls'], ['-x'], ['A\nB'], Array.from({ length: 201 }, () => 'A')]) {
    await assert.rejects(copyEnvKeys(runner, s.root, keys), BadRequest, JSON.stringify(keys));
  }
  assert.equal(runner.calls.length, 0);
});

test('copy: one copy at a time; a second one while the first is in flight is busy, and the lock is released after', async (t) => {
  const s = scratch(t, { envText: LOCAL });
  let release;
  const gate = new Promise((r) => { release = r; });
  const runner = fakeRunner({}, { onWrite: async () => { await gate; return result(); } });
  assert.equal(copyInFlight(), false);
  const first = copyEnvKeys(runner, s.root, ['SMTP_HOST']);
  assert.equal(copyInFlight(), true, 'taken synchronously, before the first await');
  await assert.rejects(copyEnvKeys(runner, s.root, ['SMTP_USER']), (e) => e instanceof BusyError);
  release();
  assert.deepEqual((await first).written, ['SMTP_HOST']);
  assert.equal(copyInFlight(), false);
  // Released after a failure too.
  await assert.rejects(copyEnvKeys(fakeRunner({}, { onWrite: () => result({ code: 1 }) }), s.root, ['SMTP_HOST']), EnvSyncFailed);
  assert.equal(copyInFlight(), false);
  assert.equal(runner.calls.filter((c) => c.args[0] === 'write').length, 1, 'the refused copy wrote nothing');
});
