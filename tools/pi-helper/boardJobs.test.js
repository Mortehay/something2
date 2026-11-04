'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createJobs } = require('./jobs');
const { createRunner } = require('./boardRunner');
const { tunnelJob, restartJob, seedJob, readSeedPreview, BoardOffline } = require('./boardJobs');
const { BOARD_SEED_GROUPS } = require('../../backend/src/services/seedSync/boardSeedGroups.js');
const { scratch } = require('./testkit');

const until = async (fn) => { for (let i = 0; i < 400 && !fn(); i += 1) await new Promise((r) => setTimeout(r, 5)); };
const result = (over = {}) => ({ code: 0, output: '', stdout: '', stderr: '', timedOut: false, ...over });
// A stub runner that records every script call.
function stubRunner(handler) {
  const calls = [];
  return {
    calls,
    script: async (name, args, opts = {}) => {
      calls.push({ name, args });
      const r = await handler(name, args);
      for (const l of String(r.output || '').split('\n').filter(Boolean)) if (opts.onLine) opts.onLine(l);
      return r;
    },
  };
}
async function runJob(kind, steps) {
  const jobs = createJobs();
  jobs.start(kind, steps);
  await until(() => jobs.current().state !== 'running');
  return jobs.current();
}

test('restart runs compose restart for backend and caddy only', async () => {
  const runner = stubRunner(() => result());
  const j = await runJob('restart', restartJob(runner));
  assert.equal(j.state, 'ok');
  assert.equal(runner.calls.length, 1);
  assert.deepEqual(runner.calls[0], { name: 'remote.sh', args: ['compose', 'restart', 'backend', 'caddy'] });
  assert.doesNotMatch(JSON.stringify(runner.calls), /cloudflared|ngrok/);
});

test('restart failure and timeout fail the job', async () => {
  assert.match((await runJob('restart', restartJob(stubRunner(() => result({ code: 1, output: 'no such service' }))))).error, /failed.*no such service/);
  assert.match((await runJob('restart', restartJob(stubRunner(() => result({ code: null, timedOut: true }))))).error, /120 seconds/);
});

test('seed runs seed-catalogs, then each group in order, with --resolve=git --git-wins', async () => {
  const runner = stubRunner((name, args) => (args.includes('preview') ? result({ stdout: `${args[4].slice(8)} preview {"add":0}\n` }) : result()));
  const j = await runJob('seed', seedJob(runner));
  assert.equal(j.state, 'ok');
  const applies = runner.calls.filter((c) => !c.args.includes('preview'));
  assert.deepEqual(applies[0].args, ['backend', 'node', 'scripts/seed-catalogs.js']);
  assert.deepEqual(applies.slice(1).map((c) => c.args), BOARD_SEED_GROUPS.map((g) => ['backend', 'node', 'scripts/seed-sync.js', 'seed', `--group=${g}`, '--resolve=git', '--git-wins']));
});

test('seed stops at the first refused group, naming the group and reason', async () => {
  const runner = stubRunner((name, args) => {
    if (args.includes('preview')) return result({ stdout: `${args[4].slice(8)} preview {"add":0}\n` });
    if (args.includes('--group=items')) return result({ code: 2, stdout: 'items refused:blocked_rows two rows are blocked\n' });
    return result();
  });
  const j = await runJob('seed', seedJob(runner));
  assert.equal(j.state, 'failed');
  assert.match(j.error, /items/);
  assert.match(j.error, /blocked_rows two rows are blocked/);
  const seeded = runner.calls.filter((c) => c.args.includes('seed')).map((c) => c.args[4]);
  assert.deepEqual(seeded, ['--group=ai_providers', '--group=tile_types', '--group=items']);
});

test('seed never names art, audio, maps or ai_provider_templates', async () => {
  // The stub echoes the group it was asked for, so the preview passes and every seed step really runs.
  const runner = stubRunner((n, args) => {
    const arg = args.find((a) => String(a).startsWith('--group='));
    return result({ stdout: arg ? `${arg.slice(8)} preview {}\n` : '' });
  });
  const j = await runJob('seed', seedJob(runner));
  assert.equal(j.state, 'ok', j.error);
  const seeded = runner.calls.filter((c) => c.args.includes('seed')).map((c) => c.args.find((a) => a.startsWith('--group=')).slice(8));
  assert.deepEqual(seeded, BOARD_SEED_GROUPS, 'the job ran every board group');
  const forbidden = ['art', 'audio', 'maps', 'ai_provider_templates'];
  assert.ok(runner.calls.length > BOARD_SEED_GROUPS.length);
  for (const c of runner.calls) {
    for (const bad of forbidden) {
      assert.ok(!c.args.some((a) => a === `--group=${bad}` || a === bad), `${bad} in ${c.args.join(' ')}`);
    }
  }
});

const OLD = "usage: seed-sync.js status|export|seed [--group=g|--all] [--resolve=git|local]\n";

test('readSeedPreview parses rows and refusals', async () => {
  const runner = stubRunner((n, args) => {
    const g = args[4].slice(8);
    if (g === 'items') return result({ code: 2, stdout: 'items refused:drift tables differ\n' });
    return result({ stdout: `${g} preview {"add":1,"change":2,"remove":3,"overwrite":4,"blocked":5}\n` });
  });
  const p = await readSeedPreview(runner);
  assert.equal(p.needsUpdate, false);
  assert.deepEqual(p.groups.map((g) => g.group), BOARD_SEED_GROUPS);
  assert.deepEqual(p.groups[0], { group: 'ai_providers', add: 1, change: 2, remove: 3, overwrite: 4, blocked: 5, refused: null });
  assert.equal(p.groups.find((g) => g.group === 'items').refused, 'drift tables differ');
});

test('readSeedPreview reports needsUpdate when the board seed-sync.js does not know preview', async () => {
  for (const out of [OLD, 'unknown argument: --git-wins\n', "Error: Cannot find module '/app/scripts/seed-sync.js'\n"]) {
    const p = await readSeedPreview(stubRunner(() => result({ code: 1, output: out, stderr: out })));
    assert.deepEqual(p, { needsUpdate: true, groups: [] });
  }
});

test('an unreachable board is BoardOffline, not needsUpdate', async () => {
  for (const r of [result({ code: 255, output: 'ssh: connect timed out' }), result({ code: null, timedOut: true })]) {
    await assert.rejects(() => readSeedPreview(stubRunner(() => r)), BoardOffline);
  }
});

test('applying while needsUpdate fails with an update-first sentence and seeds nothing', async () => {
  const runner = stubRunner(() => result({ code: 1, output: OLD }));
  const j = await runJob('seed', seedJob(runner));
  assert.equal(j.state, 'failed');
  assert.match(j.error, /Update the board first/);
  assert.equal(runner.calls.filter((c) => c.args.includes('seed-catalogs.js') || c.args.includes('seed')).length, 0);
});

test('preview parses only stdout', async () => {
  const runner = stubRunner((n, args) => result({ stdout: `${args[4].slice(8)} preview {"add":1}\n`, output: 'unknown argument noise\n', stderr: 'unknown argument noise\n' }));
  assert.equal((await readSeedPreview(runner)).needsUpdate, false);
});

test('tunnel start: url becomes the step detail; failure uses explainTunnelError', async () => {
  const ok = stubRunner(() => result({ stdout: 'url=https://x.trycloudflare.com\nnote=hello\n' }));
  const j = await runJob('tunnel', tunnelJob(ok, 'cloudflare', 'start'));
  assert.equal(j.state, 'ok');
  assert.deepEqual(ok.calls[0], { name: 'tunnel.sh', args: ['start', 'cloudflare'] });
  assert.equal(j.steps[0].detail, 'https://x.trycloudflare.com');
  const bad = stubRunner(() => result({ code: 1, stdout: 'error=ERR_NGROK_334\n' }));
  const f = await runJob('tunnel', tunnelJob(bad, 'ngrok', 'start'));
  assert.equal(f.state, 'failed');
  assert.match(f.error, /make tunnel/);
});

test('tunnel stop failure and unknown names/actions', async () => {
  const f = await runJob('tunnel', tunnelJob(stubRunner(() => result({ code: 1, stdout: 'error=compose_rm_failed\n' })), 'ngrok', 'stop'));
  assert.match(f.error, /failed to stop \(compose_rm_failed\)/);
  assert.throws(() => tunnelJob(stubRunner(() => result()), 'x; rm -rf /', 'start'), /Unknown tunnel/);
  assert.throws(() => tunnelJob(stubRunner(() => result()), 'ngrok', 'status'), /Unknown tunnel/);
});

test('job log carries redacted runner lines; abort kills the real runner and fails the job', async (t) => {
  const s = scratch(t, { envText: 'NGROK_AUTHTOKEN=tok_abcdef123\n' });
  s.script('tunnel.sh', 'echo "leak tok_abcdef123"; sleep 30 & wait');
  const runner = createRunner({ root: s.root, env: s.env });
  const jobs = createJobs();
  jobs.start('tunnel', tunnelJob(runner, 'ngrok', 'start'));
  await until(() => /leak/.test(jobs.current().log));
  assert.doesNotMatch(jobs.current().log, /tok_abcdef123/);
  assert.match(jobs.current().log, /leak \*\*\*/);
  jobs.abort();
  runner.abort();
  await until(() => jobs.current().state !== 'running');
  assert.equal(jobs.current().state, 'failed');
  assert.equal(jobs.current().error, 'The helper was stopped during this action.');
});
