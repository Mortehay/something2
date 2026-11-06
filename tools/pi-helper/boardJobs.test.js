'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createJobs } = require('./jobs');
const { createRunner } = require('./boardRunner');
const { tunnelJob, restartJob, seedJob, mapsJob, readSeedPreview, BoardOffline, SEED_ART_MS, SEED_AUDIO_MS, MAP_SPECS } = require('./boardJobs');
const fs = require('node:fs');
const path = require('node:path');
const { BOARD_SEED_GROUPS } = require('../../backend/src/services/seedSync/boardSeedGroups.js');
const { scratch } = require('./testkit');

const until = async (fn) => { for (let i = 0; i < 400 && !fn(); i += 1) await new Promise((r) => setTimeout(r, 5)); };
const result = (over = {}) => ({ code: 0, output: '', stdout: '', stderr: '', timedOut: false, ...over });
const isCount = (args) => args[1] === 'sh';
const isArt = (args) => args.includes('scripts/seed-art.js');
const isAudio = (args) => args.includes('scripts/seed-audio.js');
const isSheets = (args) => args.includes('--kind=sprites');
// The file-count / script-presence probe answers like a current image.
const COUNTS = { stdout: 'art_pending=12\naudio_pending=2258\n' };
// The group ids of a preview call, whichever form it used (--groups=a,b or --group=a).
const groupsOf = (args) => {
  const many = args.find((a) => a.startsWith('--groups='));
  if (many) return many.slice(9).split(',');
  const one = args.find((a) => a.startsWith('--group='));
  return one ? [one.slice(8)] : [];
};
const previewOut = (args, body = '{"add":0}') => `${groupsOf(args).map((g) => `${g} preview ${body}`).join('\n')}\n`;
const isMany = (args) => args.some((a) => a.startsWith('--groups='));
// A stub runner that records every script call.
function stubRunner(handler) {
  const calls = [];
  return {
    calls,
    script: async (name, args, opts = {}) => {
      const call = { name, args };
      Object.defineProperty(call, 'timeoutMs', { value: opts.timeoutMs, enumerable: false }); // out of deepEqual
      calls.push(call);
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

const previewOrCounts = (name, args) => {
  if (isCount(args)) return result(COUNTS);
  if (args.includes('preview')) return result({ stdout: previewOut(args) });
  return result();
};

test('seed runs seed-catalogs, then each group in order, with --resolve=git --git-wins', async () => {
  const runner = stubRunner(previewOrCounts);
  const j = await runJob('seed', seedJob(runner));
  assert.equal(j.state, 'ok');
  const applies = runner.calls.filter((c) => !c.args.includes('preview') && !isCount(c.args));
  assert.deepEqual(applies[0].args, ['backend', 'node', 'scripts/seed-catalogs.js']);
  assert.deepEqual(applies.slice(1, 1 + BOARD_SEED_GROUPS.length).map((c) => c.args), BOARD_SEED_GROUPS.map((g) => ['backend', 'node', 'scripts/seed-sync.js', 'seed', `--group=${g}`, '--resolve=git', '--git-wins']));
});

test('seed stops at the first refused group, naming the group and reason', async () => {
  const runner = stubRunner((name, args) => {
    if (isCount(args)) return result(COUNTS);
    if (args.includes('preview')) return result({ stdout: previewOut(args) });
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

test('seed never names art, audio, maps or ai_provider_templates as a sync group', async () => {
  // The stub echoes the group it was asked for, so the preview passes and every seed step really runs.
  const runner = stubRunner((n, args) => {
    if (isCount(args)) return result(COUNTS);
    const arg = args.find((a) => String(a).startsWith('--group='));
    return result({ stdout: arg ? `${arg.slice(8)} preview {}\n` : '' });
  });
  const j = await runJob('seed', seedJob(runner));
  assert.equal(j.state, 'ok', j.error);
  const seeded = runner.calls.filter((c) => c.args.includes('seed')).map((c) => c.args.find((a) => a.startsWith('--group=')).slice(8));
  assert.deepEqual(seeded, BOARD_SEED_GROUPS, 'the job ran every board group');
  // Art and audio are separate scripts (not sync groups): they must not appear as one.
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
    if (isCount(args)) return result(COUNTS);
    const lines = groupsOf(args).map((g) => (g === 'items'
      ? 'items refused:drift tables differ'
      : `${g} preview {"add":1,"change":2,"remove":3,"overwrite":4,"blocked":5}`));
    return result({ code: lines.some((l) => /refused/.test(l)) ? 2 : 0, stdout: `${lines.join('\n')}\n` });
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
    assert.deepEqual(p, { needsUpdate: true, groups: [], files: null });
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
  const runner = stubRunner((n, args) => (isCount(args) ? result(COUNTS) : result({ stdout: previewOut(args, '{"add":1}'), output: 'unknown argument noise\n', stderr: 'unknown argument noise\n' })));
  assert.equal((await readSeedPreview(runner)).needsUpdate, false);
});

test('tunnel start: url becomes the step detail; failure uses explainTunnelError', async () => {
  const ok = stubRunner(() => result({ stdout: 'url=https://x.trycloudflare.com\nnote=hello\n' }));
  const j = await runJob('tunnel', tunnelJob(ok, 'cloudflare', 'start'));
  assert.equal(j.state, 'ok');
  assert.deepEqual(ok.calls[0], { name: 'tunnel.sh', args: ['start', 'cloudflare'] });
  assert.equal(j.steps[0].detail, 'https://x.trycloudflare.com · hello');
  const bad = stubRunner(() => result({ code: 1, stdout: 'error=ERR_NGROK_334\n' }));
  const f = await runJob('tunnel', tunnelJob(bad, 'ngrok', 'start'));
  assert.equal(f.state, 'failed');
  assert.match(f.error, /make tunnel/);
});

test('tunnel switch: a refusal says the old link keeps running and marks the limit', async () => {
  const noted = [];
  const bad = stubRunner(() => result({ code: 1, stdout: 'error=ERR_NGROK_725\n' }));
  const f = await runJob('tunnel', tunnelJob(bad, 'ngrok', 'switch', { onNgrokAnswer: (c) => noted.push(c) }));
  assert.equal(f.state, 'failed');
  assert.deepEqual(bad.calls[0], { name: 'tunnel.sh', args: ['switch', 'ngrok'] });
  assert.match(f.error, /used its bandwidth allowance/);
  assert.match(f.error, /next billing cycle/);
  assert.match(f.error, /the Cloudflare link keeps running/);
  assert.deepEqual(noted, ['ERR_NGROK_725']);
  const noted2 = [];
  const ok = stubRunner(() => result({ stdout: 'url=https://n.ngrok-free.dev\n' }));
  const j = await runJob('tunnel', tunnelJob(ok, 'ngrok', 'switch', { onNgrokAnswer: (c) => noted2.push(c) }));
  assert.equal(j.state, 'ok');
  assert.equal(j.steps[0].name, 'Switch to ngrok tunnel');
  assert.deepEqual(noted2, [null], 'it answered, so no limit is in force');
});

test('a warning from a finished tunnel job is shown on its step', async () => {
  const r = stubRunner(() => result({ stdout: 'url=https://n.ngrok-free.dev\nnote=the cloudflare link could not be stopped, so both are running\n' }));
  const j = await runJob('tunnel', tunnelJob(r, 'ngrok', 'switch'));
  assert.equal(j.state, 'ok');
  assert.match(j.steps[0].detail, /https:\/\/n\.ngrok-free\.dev · the cloudflare link could not be stopped, so both are running/);
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

// --- Art and audio in Seed from git (SOMET-722) ------------------------------

test('seed runs art, the sheets, then audio, after every catalog group; art and audio take no --force, --kind or --only', async () => {
  const runner = stubRunner(previewOrCounts);
  const j = await runJob('seed', seedJob(runner));
  assert.equal(j.state, 'ok', j.error);
  const applies = runner.calls.filter((c) => !c.args.includes('preview') && !isCount(c.args));
  const tail3 = applies.slice(-3);
  assert.deepEqual(tail3.map((c) => c.args), [['backend', 'node', 'scripts/seed-art.js'], ['backend', 'node', 'scripts/seed-art.js', '--kind=sprites'], ['backend', 'node', 'scripts/seed-audio.js']]);
  assert.equal(applies.length, 1 + BOARD_SEED_GROUPS.length + 3);
  for (const c of [tail3[0], tail3[2]]) assert.ok(!c.args.some((a) => /--force|--kind|--only/.test(a)), c.args.join(' '));
  assert.ok(!tail3[1].args.some((a) => /--force|--only/.test(a)), 'sheets never force');
  assert.deepEqual(j.steps.map((s) => s.name).slice(-3), ['Seed art', 'Seed animation sheets', 'Seed audio']);
  assert.equal(tail3[0].timeoutMs, 90 * 60 * 1000);
  assert.equal(tail3[1].timeoutMs, 10 * 60 * 1000);
  assert.equal(tail3[2].timeoutMs, 60 * 60 * 1000);
  assert.equal(SEED_ART_MS, 90 * 60 * 1000);
  assert.equal(SEED_AUDIO_MS, 60 * 60 * 1000);
});

test('a failing art step fails the job naming art, says catalogs stay applied, and skips audio', async () => {
  const runner = stubRunner((n, args) => (isArt(args) ? result({ code: 1, output: 'connect ECONNREFUSED minio:9000' }) : previewOrCounts(n, args)));
  const j = await runJob('seed', seedJob(runner));
  assert.equal(j.state, 'failed');
  assert.equal(j.steps.find((s) => s.state === 'failed').name, 'Seed art');
  assert.match(j.error, /Seeding art failed \(exit 1\): connect ECONNREFUSED minio:9000/);
  assert.match(j.error, /catalogs .*already applied stay applied/i);
  assert.ok(runner.calls.some((c) => c.args.includes('--group=items') && c.args.includes('seed')), 'catalogs ran before');
  assert.ok(!runner.calls.some((c) => isAudio(c.args)));
});

test('a failing audio step fails the job naming audio; art and catalogs stay applied', async () => {
  const runner = stubRunner((n, args) => (isAudio(args) ? result({ code: 1, output: 'no manifest' }) : previewOrCounts(n, args)));
  const j = await runJob('seed', seedJob(runner));
  assert.equal(j.state, 'failed');
  assert.equal(j.steps.find((s) => s.state === 'failed').name, 'Seed audio');
  assert.match(j.error, /Seeding audio failed \(exit 1\): no manifest/);
  assert.match(j.error, /art and the catalogs already applied stay applied/i);
});

test('art and audio timeouts say how long they were given', async () => {
  const art = await runJob('seed', seedJob(stubRunner((n, args) => (isArt(args) ? result({ code: null, timedOut: true }) : previewOrCounts(n, args)))));
  assert.match(art.error, /Seeding art did not finish within 90 minutes/);
  const audio = await runJob('seed', seedJob(stubRunner((n, args) => (isAudio(args) ? result({ code: null, timedOut: true }) : previewOrCounts(n, args)))));
  assert.match(audio.error, /Seeding audio did not finish within 60 minutes/);
});

test('seed reports what art and audio did as the step detail', async () => {
  const runner = stubRunner((n, args) => {
    if (isArt(args)) return result({ stdout: 'seeded 40 tile images (0 trimmed, 0 re-seeded over a missing object), 3 already had art, 0 awaiting a redraw, 0 not cut out, 1 missing files, 0 unknown subjects\nseeded 10 entity images (0 trimmed, 0 re-seeded over a missing object), 0 already had art, 0 awaiting a redraw, 0 not cut out, 0 missing files, 0 unknown subjects\n' });
    if (isAudio(args)) return result({ stdout: 'clips: 700 linked, 20 already present, 2 missing files\nbindings: 5 bound, 0 already present, 0 unknown subjects\n' });
    return previewOrCounts(n, args);
  });
  const j = await runJob('seed', seedJob(runner));
  assert.equal(j.state, 'ok');
  assert.equal(j.steps.find((s) => s.name === 'Seed art').detail, '50 linked, 1 missing files');
  assert.equal(j.steps.find((s) => s.name === 'Seed audio').detail, '700 linked, 20 already there, 2 missing files');
});

test('thousands of per-clip lines do not flood the job log, but failures and the summary stay', async () => {
  const lines = [];
  for (let i = 0; i < 7000; i += 1) lines.push(`  clip ${i}: already present`);
  lines.splice(100, 0, '  Bad clip: FAILED seeds/audio/x.ogg is in the manifest but not on disk');
  lines.push('clips: 7000 linked, 0 already present, 1 missing files', 'bindings: 3 bound, 0 already present, 0 unknown subjects');
  const runner = stubRunner((n, args) => (isAudio(args) ? result({ output: lines.join('\n'), stdout: lines.join('\n') }) : previewOrCounts(n, args)));
  const jobs = createJobs();
  jobs.start('seed', seedJob(runner));
  await until(() => jobs.current().state !== 'running');
  const { log } = jobs.current();
  assert.equal(jobs.current().state, 'ok');
  assert.ok(log.length < 4000, `log is ${log.length} bytes`);
  assert.ok(!/clip 5: already present/.test(log));
  assert.match(log, /Bad clip: FAILED/);
  assert.match(log, /clips: 7000 linked/);
  assert.match(log, /7000 items processed/);
});

test('many failure lines are capped, and the cap says how many were left out', async () => {
  const lines = [];
  for (let i = 0; i < 300; i += 1) lines.push(`  item ${i}: FAILED file is missing`);
  lines.push('seeded 1 tile images (0 trimmed, 0 re-seeded over a missing object), 0 already had art, 0 awaiting a redraw, 0 not cut out, 300 missing files, 0 unknown subjects');
  const runner = stubRunner((n, args) => (isArt(args) ? result({ output: lines.join('\n'), stdout: lines.join('\n') }) : previewOrCounts(n, args)));
  const jobs = createJobs();
  jobs.start('seed', seedJob(runner));
  await until(() => jobs.current().state !== 'running');
  const { log } = jobs.current();
  assert.match(log, /item 0: FAILED/);
  assert.ok(!/item 299: FAILED/.test(log));
  assert.match(log, /260 more lines were left out/);
  assert.match(log, /300 missing files/);
});

test('the preview carries what the seed would copy, from the seed\'s own plan rather than files on disk', async () => {
  const runner = stubRunner((n, args) => (isCount(args) ? result(COUNTS) : result({ stdout: previewOut(args) })));
  const p = await readSeedPreview(runner);
  assert.deepEqual(p.files, { art: 12, audio: 2258 });
  assert.equal(p.needsUpdate, false);
  const probe = runner.calls.find((c) => isCount(c.args));
  assert.equal(probe.name, 'remote.sh');
  assert.deepEqual(probe.args.slice(0, 3), ['backend', 'sh', '-c']);
  assert.match(probe.args[3], /node scripts\/seed-plan\.js/);
  assert.doesNotMatch(probe.args[3], /find seeds/);
});

test('a plan answer missing a number is a failure, never a preview that counts nothing', async () => {
  const bad = stubRunner((n, args) => (isCount(args) ? result({ stdout: 'art_pending=1\n' }) : result({ stdout: previewOut(args) })));
  await assert.rejects(() => readSeedPreview(bad), /file count.*failed/i);
});

test('a slow plan on a reachable board says it was slow, not that the board is offline', async () => {
  const slow = stubRunner((n, args) => (isCount(args) ? result({ code: null, timedOut: true }) : result({ stdout: previewOut(args) })));
  const err = await readSeedPreview(slow).catch((e) => e);
  assert.ok(!(err instanceof BoardOffline));
  assert.match(err.message, /did not finish within 120 seconds/);
});

test('the plan and the group preview run side by side, so together they fit the 150 s proxy limit', async () => {
  let countStarted = false;
  let previewStarted = false;
  const runner = stubRunner(async (n, args) => {
    if (isCount(args)) {
      countStarted = true;
      await until(() => previewStarted);
      return result(COUNTS);
    }
    previewStarted = true;
    await until(() => countStarted);
    return result({ stdout: previewOut(args) });
  });
  assert.equal((await readSeedPreview(runner)).files.audio, 2258);
  assert.equal(runner.calls.length, 2);
});

test('the helper reads the names scripts/seed-plan.js prints', () => {
  const script = fs.readFileSync(path.resolve(__dirname, '../../backend/scripts/seed-plan.js'), 'utf8');
  assert.match(script, /art_pending=\$\{art\.pending\}\\naudio_pending=\$\{audio\.pending\}/);
  assert.match(COUNTS.stdout, /^art_pending=\d+\naudio_pending=\d+\n$/);
});

test('the seed job checks for the plan script without running the plan', async () => {
  const runner = stubRunner(previewOrCounts);
  await runJob('seed', seedJob(runner));
  const probes = runner.calls.filter((c) => isCount(c.args));
  assert.equal(probes.length, 1);
  assert.doesNotMatch(probes[0].args[3], /node scripts/);
});

test('the audio step names files no list holds, and stays quiet when there are none', async () => {
  const run = async (stdout) => {
    const r = stubRunner((n, args) => {
      if (isCount(args)) return result(COUNTS);
      if (isAudio(args)) return result({ stdout });
      return result({ stdout: previewOut(args) });
    });
    return (await runJob('seed', seedJob(r))).steps.find((s) => s.name === 'Seed audio').detail;
  };
  assert.equal(await run('clips: 5 linked, 1 already present, 0 missing files, 3 files not listed\nbindings: 1 bound, 0 already present, 0 unknown subjects\n'),
    '5 linked, 1 already there, 0 missing files, 3 files not listed');
  assert.equal(await run('clips: 5 linked, 1 already present, 0 missing files, 0 files not listed\nbindings: 1 bound, 0 already present, 0 unknown subjects\n'),
    '5 linked, 1 already there, 0 missing files');
});

test('an image without the art and audio scripts needs an update, before anything is applied', async () => {
  const missing = (n, args) => (isCount(args) ? result({ code: 3, stdout: 'missing-scripts\n' }) : result({ stdout: previewOut(args) }));
  assert.deepEqual(await readSeedPreview(stubRunner(missing)), { needsUpdate: true, groups: [], files: null });
  const runner = stubRunner(missing);
  const j = await runJob('seed', seedJob(runner));
  assert.equal(j.state, 'failed');
  assert.match(j.error, /Update the board first/);
  assert.equal(runner.calls.filter((c) => c.args.includes('seed-catalogs.js') || c.args.includes('seed')).length, 0);
});

test('an unreachable board while counting files is BoardOffline; any other failure says so', async () => {
  const off = stubRunner((n, args) => (isCount(args) ? result({ code: 255, output: 'ssh: connect timed out' }) : result({ stdout: previewOut(args) })));
  await assert.rejects(() => readSeedPreview(off), BoardOffline);
  const bad = stubRunner((n, args) => (isCount(args) ? result({ code: 1, stdout: 'garbage\n', output: 'sh: boom' }) : result({ stdout: previewOut(args) })));
  await assert.rejects(() => readSeedPreview(bad), /file count.*failed.*boom/i);
});

// --- Apply maps (SOMET-722) ---------------------------------------------------

const MAP_CALLS = [
  { name: 'remote.sh', args: ['backend', 'sh', '-c', 'SPEC=p5-descent node scripts/seed-map.js'] },
  { name: 'remote.sh', args: ['backend', 'sh', '-c', 'SPEC=vale-region node scripts/seed-map.js'] },
  { name: 'remote.sh', args: ['compose', 'restart', 'backend', 'caddy'] },
];

test('apply maps runs p5-descent, then vale-region, then restarts backend and caddy only', async () => {
  const runner = stubRunner(() => result());
  const j = await runJob('maps', mapsJob(runner));
  assert.equal(j.state, 'ok', j.error);
  assert.deepEqual(runner.calls, MAP_CALLS);
  assert.deepEqual(j.steps.map((s) => s.name), ['p5-descent', 'vale-region', 'restart']);
  assert.deepEqual(MAP_SPECS, ['p5-descent', 'vale-region']);
  assert.doesNotMatch(JSON.stringify(runner.calls), /cloudflared|ngrok|--force|KEEP_ENTRY/);
});

test('apply maps takes no arguments: whatever is passed, the list and the order are fixed', async () => {
  const runner = stubRunner(() => result());
  await runJob('maps', mapsJob(runner, 'x; rm -rf /', { spec: 'evil' }));
  assert.deepEqual(runner.calls, MAP_CALLS);
});

test('a failed first map stops the job: nothing else runs, and it says that map was not applied', async () => {
  const runner = stubRunner((n, args) => (args.join(' ').includes('SPEC=p5-descent') ? result({ code: 1, output: 'invalid spec "p5-descent":\n  - bad biome' }) : result()));
  const j = await runJob('maps', mapsJob(runner));
  assert.equal(j.state, 'failed');
  assert.equal(runner.calls.length, 1);
  assert.equal(j.steps.find((s) => s.state === 'failed').name, 'p5-descent');
  assert.match(j.error, /p5-descent failed \(exit 1\)/);
  assert.match(j.error, /nothing from it was applied/i);
  assert.match(j.error, /not restarted/i);
});

test('vale-region failing after p5-descent says p5-descent holds the entry world and to run it again', async () => {
  const runner = stubRunner((n, args) => (args.join(' ').includes('SPEC=vale-region') ? result({ code: 1, output: 'boom' }) : result()));
  const j = await runJob('maps', mapsJob(runner));
  assert.equal(j.state, 'failed');
  assert.equal(runner.calls.length, 2, 'no restart');
  assert.match(j.error, /vale-region failed \(exit 1\): boom/);
  assert.match(j.error, /p5-descent was applied/);
  assert.match(j.error, /entry world/);
  assert.match(j.error, /Apply maps again/);
});

test('a failed restart says both maps are applied and the game still runs the old terrain', async () => {
  const runner = stubRunner((n, args) => (args[0] === 'compose' ? result({ code: 1, output: 'no such service' }) : result()));
  const j = await runJob('maps', mapsJob(runner));
  assert.equal(j.state, 'failed');
  assert.equal(j.steps.find((s) => s.state === 'failed').name, 'restart');
  assert.match(j.error, /Both maps are applied/);
  assert.match(j.error, /no such service/);
  assert.match(j.error, /Restart/);
});

test('map timeouts name the map and the minutes', async () => {
  const j = await runJob('maps', mapsJob(stubRunner((n, args) => (args.join(' ').includes('SPEC=vale-region') ? result({ code: null, timedOut: true }) : result()))));
  assert.match(j.error, /vale-region did not finish within 30 minutes/);
});

test('map applies and the restart use these time limits', async () => {
  const runner = stubRunner(() => result());
  await runJob('maps', mapsJob(runner));
  assert.deepEqual(runner.calls.map((c) => c.timeoutMs), [30 * 60_000, 30 * 60_000, 120_000]);
});

// --- Wording after a timeout, and bindings that wait (SOMET-722) -----------------------------------------
test('seed and maps timeouts say the work may still be running on the board', async () => {
  const still = /It may still be running on the board\. Wait a few minutes and check before trying again\./;
  const art = await runJob('seed', seedJob(stubRunner((n, args) => (isArt(args) ? result({ code: null, timedOut: true }) : previewOrCounts(n, args)))));
  assert.match(art.error, still);
  const audio = await runJob('seed', seedJob(stubRunner((n, args) => (isAudio(args) ? result({ code: null, timedOut: true }) : previewOrCounts(n, args)))));
  assert.match(audio.error, still);
  const maps = await runJob('maps', mapsJob(stubRunner((n, args) => (args.join(' ').includes('SPEC=p5-descent') ? result({ code: null, timedOut: true }) : result()))));
  assert.match(maps.error, still);
  assert.doesNotMatch(maps.error, /Nothing from it was applied/);
});

test('the audio step says how many bindings name absent subjects, promising no fix, and the restart message names the button', async () => {
  const audioOut = 'clips: 5 linked, 0 already present, 0 missing files\nbindings: 1 bound, 0 already present, 226 unknown subjects\n';
  const j = await runJob('seed', seedJob(stubRunner((n, args) => (isAudio(args) ? result({ stdout: audioOut, output: audioOut }) : previewOrCounts(n, args)))));
  const audio = j.steps.find((s) => s.name === 'Seed audio');
  assert.match(audio.detail, /5 linked/);
  assert.match(audio.detail, /226 sound bindings name worlds or other subjects that aren't on the board\. If the maps have not been applied, run Seed from git again after Apply maps; any left after that are not used\./);
  const none = 'clips: 5 linked, 0 already present, 0 missing files\nbindings: 1 bound, 0 already present, 0 unknown subjects\n';
  const k = await runJob('seed', seedJob(stubRunner((n, args) => (isAudio(args) ? result({ stdout: none, output: none }) : previewOrCounts(n, args)))));
  assert.doesNotMatch(k.steps.find((s) => s.name === 'Seed audio').detail, /sound bindings/);
});

test('seed uploads the animation sheets right after art: one fixed command, art-only kinds untouched', async () => {
  const runner = stubRunner(previewOrCounts);
  const j = await runJob('seed', seedJob(runner));
  assert.equal(j.state, 'ok');
  assert.deepEqual(j.steps.map((s) => s.name).slice(-3), ['Seed art', 'Seed animation sheets', 'Seed audio']);
  const art = runner.calls.filter((c) => isArt(c.args));
  assert.deepEqual(art.map((c) => c.args), [
    ['backend', 'node', 'scripts/seed-art.js'],
    ['backend', 'node', 'scripts/seed-art.js', '--kind=sprites'],
  ]);
});

test('the animation sheets step reports what it linked, and fails by name with the earlier steps kept', async () => {
  const ok = stubRunner((n, args) => (isSheets(args)
    ? result({ stdout: '  Bat: seeded\nseeded 10 sprite sheets on entity_types (0 already had a sheet, 0 re-seeded over a missing object), 0 missing files, 0 unknown subjects\nseeded 3 sprite sheets on character_appearances (0 already had a sheet, 0 re-seeded over a missing object), 1 missing files, 0 unknown subjects\n' })
    : previewOrCounts(n, args)));
  const j = await runJob('seed', seedJob(ok));
  assert.equal(j.steps.find((s) => s.name === 'Seed animation sheets').detail, '13 linked, 1 missing files');
  const bad = await runJob('seed', seedJob(stubRunner((n, args) => (isSheets(args) ? result({ code: 1, output: 'boom' }) : previewOrCounts(n, args)))));
  assert.equal(bad.state, 'failed');
  assert.equal(bad.steps.find((s) => s.state === 'failed').name, 'Seed animation sheets');
  assert.match(bad.error, /Seeding animation sheets failed \(exit 1\): boom/);
  assert.match(bad.error, /art and the catalogs already applied stay applied/i);
  const slow = await runJob('seed', seedJob(stubRunner((n, args) => (isSheets(args) ? result({ code: null, timedOut: true }) : previewOrCounts(n, args)))));
  assert.match(slow.error, /Seeding animation sheets did not finish within 10 minutes/);
});

const ALL_ARG = `--groups=${BOARD_SEED_GROUPS.join(',')}`;
const PREVIEW_TAIL = ['--resolve=git', '--git-wins'];

test('the seed preview is ONE call for every group, then the file count', async () => {
  const runner = stubRunner(previewOrCounts);
  const p = await readSeedPreview(runner);
  assert.equal(p.needsUpdate, false);
  assert.deepEqual(p.groups.map((g) => g.group), BOARD_SEED_GROUPS);
  const previews = runner.calls.filter((c) => c.args.includes('preview'));
  assert.equal(previews.length, 1);
  assert.deepEqual(previews[0].args, ['backend', 'node', 'scripts/seed-sync.js', 'preview', ALL_ARG, ...PREVIEW_TAIL]);
  assert.equal(runner.calls.length, 2, 'the preview and the file count, nothing else');
  assert.ok(previews[0].timeoutMs <= 140_000, 'answers before the 150 s limit of the admin proxy');
});

test('an older image that rejects --groups falls back to one call per group, same result', async () => {
  const runner = stubRunner((n, args) => {
    if (isCount(args)) return result(COUNTS);
    if (isMany(args)) return result({ code: 1, output: `unknown argument: ${ALL_ARG}\n`, stderr: `unknown argument: ${ALL_ARG}\n` });
    return result({ stdout: previewOut(args, '{"add":2}') });
  });
  const p = await readSeedPreview(runner);
  assert.equal(p.needsUpdate, false);
  assert.deepEqual(p.groups.map((g) => g.group), BOARD_SEED_GROUPS);
  assert.ok(p.groups.every((g) => g.add === 2));
  const previews = runner.calls.filter((c) => c.args.includes('preview'));
  assert.equal(previews.length, 1 + BOARD_SEED_GROUPS.length);
  assert.deepEqual(previews.slice(1).map((c) => c.args[4]), BOARD_SEED_GROUPS.map((g) => `--group=${g}`));
});

test('an image with no preview at all is still needsUpdate, after one failed multi call and one per-group probe', async () => {
  const runner = stubRunner(() => result({ code: 1, output: OLD, stderr: OLD }));
  assert.deepEqual(await readSeedPreview(runner), { needsUpdate: true, groups: [], files: null });
  assert.equal(runner.calls.filter((c) => !isCount(c.args)).length, 2);
});

test('refusals are read per group out of the one answer, and the other groups keep their numbers', async () => {
  const runner = stubRunner((n, args) => (isCount(args) ? result(COUNTS) : result({
    code: 2,
    stdout: [
      'ai_providers preview {"add":1}',
      'items refused:drift tables differ',
      'tile_types preview {"add":0,"change":4}',
      ...BOARD_SEED_GROUPS.filter((g) => !['ai_providers', 'items', 'tile_types', 'quests'].includes(g)).map((g) => `${g} preview {"add":0}`),
      'quests refused:bad_file quests.json: invalid JSON',
    ].join('\n'),
    output: 'warn items schema_older {}\nprogress art upload 1/2\n',
  })));
  const p = await readSeedPreview(runner);
  const by = Object.fromEntries(p.groups.map((g) => [g.group, g]));
  assert.equal(by.items.refused, 'drift tables differ');
  assert.equal(by.quests.refused, 'bad_file quests.json: invalid JSON');
  assert.equal(by.tile_types.change, 4);
  assert.equal(by.ai_providers.add, 1);
  assert.equal(by.ai_providers.refused, null);
  assert.equal(runner.calls.filter((c) => c.args.includes('preview')).length, 1);
});

test('a group the one answer has no line for is asked for on its own; a group that errored fails the preview naming it', async () => {
  const runner = stubRunner((n, args) => {
    if (isCount(args)) return result(COUNTS);
    if (isMany(args)) return result({ stdout: previewOut(['--groups=' + BOARD_SEED_GROUPS.filter((g) => g !== 'biomes').join(',')]) });
    return result({ stdout: previewOut(args, '{"add":9}') });
  });
  const p = await readSeedPreview(runner);
  assert.equal(p.groups.find((g) => g.group === 'biomes').add, 9);
  assert.equal(runner.calls.filter((c) => c.args.includes('preview')).length, 2);
  const err = stubRunner((n, args) => (isCount(args) ? result(COUNTS) : result({
    code: 1,
    stdout: `${BOARD_SEED_GROUPS.map((g) => (g === 'biomes' ? 'biomes error relation "biomes" does not exist' : `${g} preview {"add":0}`)).join('\n')}\n`,
  })));
  await assert.rejects(() => readSeedPreview(err), /biomes.*does not exist/);
});

test('the board not being reached during the one call is BoardOffline', async () => {
  for (const r of [result({ code: 255, output: 'ssh: connect timed out' }), result({ code: null, timedOut: true })]) {
    await assert.rejects(() => readSeedPreview(stubRunner(() => r)), BoardOffline);
  }
});
