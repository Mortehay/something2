'use strict';
// Job factories: they return step lists for createJobs and know nothing of HTTP.
const path = require('node:path');
const { explainTunnelError } = require('./tunnelErrors');
const { BOARD_SEED_GROUPS } = require(path.resolve(__dirname, '../../backend/src/services/seedSync/boardSeedGroups.js'));

const TUNNEL_NAMES = ['cloudflare', 'ngrok'];
const TUNNEL_ACTIONS = ['start', 'stop', 'switch'];
const TUNNEL_STOP_MS = 120_000;
// Compose up, up to 60 s for an address, up to 60 s to answer, then republishing the page and the CI hook
// address; a switch adds a stop. Being killed part way leaves more to undo than waiting costs.
const TUNNEL_START_MS = 300_000;
const RESTART_MS = 120_000;
const SEED_MS = 300_000;
const PREVIEW_MS = 120_000;
// All groups in one call. The admin proxy gives the helper 150 s, so this answers (or gives up) before it.
const PREVIEW_ALL_MS = 140_000;
// Art is about 1,400 PNGs and audio about 7,000 clips (about 8,500 files on an SD card), uploaded one by one.
const MAP_MS = 30 * 60_000;
const SEED_ART_MS = 90 * 60_000;
const SEED_AUDIO_MS = 60 * 60_000;
// 13 sheets (26 small files, 2.8 MB) on an SD card: minutes, with room for a slow object store.
const SEED_SHEETS_MS = 10 * 60_000;

class BoardOffline extends Error {
  constructor(message) { super(message); this.code = 'board_offline'; }
}

function kv(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const tail = (text) => String(text || '').trim().split('\n').filter(Boolean).slice(-3).join(' | ');
// ssh itself failing (255), no ORANGEPI_* (78), no ssh binary (127) or a timeout: the board was not reached.
const unreachable = (r) => r.timedOut || r.code === 255 || r.code === 78 || r.code === 127;

const TUNNEL_STEP = { start: 'Start', stop: 'Stop', switch: 'Switch to' };

function tunnelJob(runner, name, action, { onNgrokAnswer = () => {} } = {}) {
  // Exact match from a fixed list; the name is never built from anything else.
  const tunnel = TUNNEL_NAMES.find((n) => n === name);
  const act = TUNNEL_ACTIONS.find((a) => a === action);
  if (!tunnel || !act) throw new Error('Unknown tunnel or action.');
  return [{
    name: `${TUNNEL_STEP[act]} ${tunnel} tunnel`,
    run: async ({ step, log }) => {
      const timeoutMs = act === 'stop' ? TUNNEL_STOP_MS : TUNNEL_START_MS;
      const r = await runner.script('tunnel.sh', [act, tunnel], { timeoutMs, onLine: log });
      const out = kv(r.stdout);
      if (r.timedOut) throw new Error(`The tunnel ${act} did not finish within ${timeoutMs / 1000} seconds.`);
      if (out.error && out.error.startsWith('ERR_NGROK_')) onNgrokAnswer(out.error);
      if (r.code !== 0) {
        const other = tunnel === 'ngrok' ? 'Cloudflare' : 'ngrok';
        if (act === 'switch') throw new Error(`${explainTunnelError(out.error || '')} Nothing was switched: the ${other} link keeps running.`);
        if (act === 'start') throw new Error(explainTunnelError(out.error || ''));
        throw new Error(`The tunnel failed to stop (${out.error || `exit ${r.code}`}).`);
      }
      if (tunnel === 'ngrok' && act !== 'stop') onNgrokAnswer(null); // it answered through ngrok, so no limit is in force
      const said = out.url || (act === 'stop' ? 'stopped' : null);
      // The note is shown, not only logged: "both links are running" must not sit under a plain "completed".
      if (said || out.note) step([said, out.note].filter(Boolean).join(' · '));
      if (out.note) log(`note: ${out.note}`);
    },
  }];
}

function restartJob(runner) {
  return [{
    name: 'Restart backend and caddy',
    run: async ({ log }) => {
      const r = await runner.script('remote.sh', ['compose', 'restart', 'backend', 'caddy'], { timeoutMs: RESTART_MS, onLine: log });
      if (r.timedOut) throw new Error(`The restart did not finish within ${RESTART_MS / 1000} seconds.`);
      if (r.code !== 0) throw new Error(`The restart failed (exit ${r.code}): ${tail(r.output)}`);
    },
  }];
}

const seedCmd = (runner, args, timeoutMs, onLine) =>
  runner.script('remote.sh', ['backend', 'node', 'scripts/seed-sync.js', ...args], { timeoutMs, onLine });

const groupArgs = (cmd, g) => [cmd, `--group=${g}`, '--resolve=git', '--git-wins'];

// The board's seed-sync.js predates `preview` / `--git-wins`: it prints usage or "unknown argument".
// A board that has never been updated has no seed-sync.js at all: node says "Cannot find module".
const OLD_TOOLING = /unknown argument|usage:|Cannot find module.*seed-sync/i;

function parsePreviewLine(stdout, group) {
  for (const line of String(stdout).split('\n')) {
    const m = line.match(/^(\S+) preview (\{.*\})\s*$/);
    if (m && m[1] === group) {
      try {
        const n = JSON.parse(m[2]);
        return { group, add: n.add || 0, change: n.change || 0, remove: n.remove || 0, overwrite: n.overwrite || 0, blocked: n.blocked || 0, refused: null };
      } catch { /* fall through */ }
    }
    const rf = line.match(/^(\S+) refused:(\S+)\s*(.*)$/);
    if (rf && rf[1] === group) {
      return { group, add: 0, change: 0, remove: 0, overwrite: 0, blocked: 0, refused: `${rf[2]} ${rf[3]}`.trim() };
    }
  }
  return null;
}

// Resolves { oldTooling: true } | { row }. Throws BoardOffline when the board was not reached.
async function previewGroup(runner, group, onLine) {
  const r = await seedCmd(runner, groupArgs('preview', group), PREVIEW_MS, onLine);
  const row = parsePreviewLine(r.stdout, group);
  if (row) return { row };
  if (OLD_TOOLING.test(r.output)) return { oldTooling: true };
  if (unreachable(r)) throw new BoardOffline('The board could not be reached to read the seed preview.');
  throw new Error(`The seed preview for ${group} failed (exit ${r.code}): ${tail(r.output)}`);
}

// One call into the running image: how many art and audio files would a seed really copy, of how many it holds?
// scripts/seed-plan.js answers with the seed's own rules, because counting files on disk promised "7,202 audio files,
// an hour or more" for a run that copied nothing and took 4 minutes. An image without that script is older than the
// art, audio and sheets steps this job relies on, or than the seed's sound list: it prints `missing-scripts`.
const FILE_COUNT_SCRIPT = 'test -f scripts/seed-plan.js || { echo missing-scripts; exit 3; }; node scripts/seed-plan.js';

// Resolves { oldTooling: true } | { files: { art, audio, artTotal, audioTotal } }. Throws BoardOffline when the board was not reached.
async function countSeedFiles(runner, onLine) {
  const r = await runner.script('remote.sh', ['backend', 'sh', '-c', FILE_COUNT_SCRIPT], { timeoutMs: PREVIEW_MS, onLine });
  if (/^missing-scripts$/m.test(r.stdout)) return { oldTooling: true };
  const out = kv(r.stdout);
  const fields = [out.art_pending, out.audio_pending, out.art_total, out.audio_total];
  if (r.code === 0 && fields.every((v) => /^\d+$/.test(v || ''))) {
    const [art, audio, artTotal, audioTotal] = fields.map(Number);
    return { files: { art, audio, artTotal, audioTotal } };
  }
  if (unreachable(r)) throw new BoardOffline('The board could not be reached to count the art and audio files.');
  throw new Error(`The file count for the seed preview failed (exit ${r.code}): ${tail(r.output)}`);
}

// `<group> error <message>`: the group failed in a way that is not a refusal.
function parseErrorLine(stdout, group) {
  for (const line of String(stdout).split('\n')) {
    const m = line.match(/^(\S+) error (.*)$/);
    if (m && m[1] === group) return m[2].trim();
  }
  return null;
}

// Every group in ONE call: seed-sync.js boots node and a pool once for the whole list instead of once per group
// (11 boots cost 103 s on the Pi). Resolves { oldTooling: true } | { rows: Map(group -> row), missing: [group] }.
// An image from before --groups answers `unknown argument` and the caller falls back to one call per group.
async function previewAll(runner, groups, onLine) {
  const args = ['preview', `--groups=${groups.join(',')}`, '--resolve=git', '--git-wins'];
  const r = await seedCmd(runner, args, PREVIEW_ALL_MS, onLine);
  const rows = new Map();
  for (const g of groups) {
    const row = parsePreviewLine(r.stdout, g);
    if (row) { rows.set(g, row); continue; }
    const err = parseErrorLine(r.stdout, g);
    if (err !== null) throw new Error(`The seed preview for ${g} failed (exit ${r.code}): ${err}`);
  }
  if (unreachable(r)) throw new BoardOffline('The board could not be reached to read the seed preview.');
  if (rows.size === 0 && OLD_TOOLING.test(r.output)) return { oldTooling: true };
  if (rows.size === 0 && r.code !== 0 && r.code !== 2) throw new Error(`The seed preview failed (exit ${r.code}): ${tail(r.output)}`);
  return { rows, missing: groups.filter((g) => !rows.has(g)) };
}

async function readSeedPreview(runner) {
  const all = await previewAll(runner, BOARD_SEED_GROUPS);
  const byGroup = new Map();
  if (all.oldTooling) {
    // No --groups on this image: ask one group at a time, as before. A board that has no preview at all says so
    // on the first of them.
    for (const g of BOARD_SEED_GROUPS) {
      const p = await previewGroup(runner, g);
      if (p.oldTooling) return { needsUpdate: true, groups: [], files: null };
      byGroup.set(g, p.row);
    }
  } else {
    for (const [g, row] of all.rows) byGroup.set(g, row);
    // A group the answer had no line for: ask for it alone rather than show a hole.
    for (const g of all.missing) {
      const p = await previewGroup(runner, g);
      if (p.oldTooling) return { needsUpdate: true, groups: [], files: null };
      byGroup.set(g, p.row);
    }
  }
  const groups = BOARD_SEED_GROUPS.map((g) => byGroup.get(g));
  const counted = await countSeedFiles(runner);
  if (counted.oldTooling) return { needsUpdate: true, groups: [], files: null };
  return { needsUpdate: false, groups, files: counted.files };
}

// The runner kills the ssh session on a timeout, but `compose exec -T` usually keeps running on the board,
// so a timed-out seed can still commit after the message was shown. Never say "nothing was applied" there.
const STILL_RUNNING = 'It may still be running on the board. Wait a few minutes and check before trying again.';

const UPDATE_FIRST = 'The board has older seed tooling than this checkout. Update the board first, then seed from git.';

function seedJob(runner) {
  const steps = [{
    name: 'Check the board seed tooling',
    run: async ({ log }) => {
      const p = await previewGroup(runner, BOARD_SEED_GROUPS[0], log);
      if (p.oldTooling) throw new Error(UPDATE_FIRST);
      // Before anything is applied: an image without the art and audio scripts would otherwise fail
      // only after the catalogs had been seeded.
      const c = await countSeedFiles(runner, log);
      if (c.oldTooling) throw new Error(UPDATE_FIRST);
    },
  }, {
    name: 'Seed catalogs',
    run: async ({ log }) => {
      const r = await runner.script('remote.sh', ['backend', 'node', 'scripts/seed-catalogs.js'], { timeoutMs: SEED_MS, onLine: log });
      if (r.timedOut) throw new Error(`Seeding catalogs did not finish within ${SEED_MS / 1000} seconds. ${STILL_RUNNING}`);
      if (r.code !== 0) throw new Error(`Seeding catalogs failed (exit ${r.code}): ${tail(r.output)}`);
    },
  }];
  for (const g of BOARD_SEED_GROUPS) {
    steps.push({
      name: `Seed ${g}`,
      run: async ({ step, log }) => {
        const r = await seedCmd(runner, groupArgs('seed', g), SEED_MS, log);
        if (r.timedOut) throw new Error(`Seeding ${g} did not finish within ${SEED_MS / 1000} seconds. ${STILL_RUNNING}`);
        if (r.code === 2) {
          const row = String(r.stdout).split('\n').map((l) => l.match(/^(\S+) refused:(\S+)\s*(.*)$/)).find((m) => m && m[1] === g);
          const why = row ? `${row[2]} ${row[3]}`.trim() : tail(r.output);
          step(`refused: ${why}`);
          throw new Error(`The ${g} group was refused: ${why}`);
        }
        if (r.code !== 0) throw new Error(`Seeding ${g} failed (exit ${r.code}): ${tail(r.output)}`);
      },
    });
  }
  steps.push(
    mediaStep(runner, { name: 'Seed art', script: 'scripts/seed-art.js', what: 'art', ms: SEED_ART_MS, minutes: 90, applied: 'The catalogs already applied stay applied.', detail: artDetail }),
    mediaStep(runner, { name: 'Seed animation sheets', script: 'scripts/seed-art.js', args: ['--kind=sprites'], what: 'animation sheets', ms: SEED_SHEETS_MS, minutes: 10, applied: 'Art and the catalogs already applied stay applied.', detail: sheetsDetail }),
    mediaStep(runner, { name: 'Seed audio', script: 'scripts/seed-audio.js', what: 'audio', ms: SEED_AUDIO_MS, minutes: 60, applied: 'Art and the catalogs already applied stay applied.', detail: audioDetail }),
  );
  return steps;
}

// seed-art.js prints one line per kind and a per-item line for the ones it seeds, skips or fails; seed-audio.js
// prints one line per clip and binding. Neither is worth thousands of lines in a 16 KB log, so routine lines are
// counted (a progress line every 250), the first 40 other lines are kept, and the summary lines always are.
const ROUTINE = /^\s+.+: (already present|seeded|bound)$/;
const SUMMARY = /^(seeded \d+ |clips: |bindings: )/;
function thinned(log, { every = 250, keep = 40 } = {}) {
  let routine = 0;
  let kept = 0;
  let dropped = 0;
  return {
    onLine(line) {
      if (SUMMARY.test(line)) { log(line); return; }
      if (ROUTINE.test(line)) {
        routine += 1;
        if (routine % every === 0) log(`... ${routine} items processed`);
        return;
      }
      if (kept < keep) { kept += 1; log(line); } else dropped += 1;
    },
    done() {
      if (routine) log(`${routine} items processed in total`);
      if (dropped) log(`${dropped} more lines were left out`);
    },
  };
}

function artDetail(stdout) {
  let linked = 0;
  let missing = 0;
  for (const line of String(stdout).split('\n')) {
    const m = line.match(/^seeded (\d+) \S+ images .*?(\d+) missing files/);
    if (m) { linked += Number(m[1]); missing += Number(m[2]); }
  }
  return `${linked} linked, ${missing} missing files`;
}

// seed-art.js --kind=sprites prints one line per table: how many sheets it linked and how many files were missing.
function sheetsDetail(stdout) {
  let linked = 0;
  let missing = 0;
  let seen = false;
  for (const line of String(stdout).split('\n')) {
    const m = line.match(/^seeded (\d+) sprite sheets .*?(\d+) missing files/);
    if (m) { seen = true; linked += Number(m[1]); missing += Number(m[2]); }
  }
  return seen ? `${linked} linked, ${missing} missing files` : null;
}

function audioDetail(stdout) {
  const m = String(stdout).match(/^clips: (\d+) linked, (\d+) already present, (\d+) missing files/m);
  if (!m) return null;
  const stray = String(stdout).match(/^clips: .*?(\d+) files not listed/m);
  const unlisted = stray && Number(stray[1]) > 0 ? `, ${stray[1]} files not listed` : '';
  const base = `${m[1]} linked, ${m[2]} already there, ${m[3]} missing files${unlisted}`;
  // seedAudio skips a binding whose subject is not in the database: a world the maps have not created yet, or a
  // subject git still names that nothing creates (git held 68 bindings for fixture worlds that no longer exist), so
  // never promise that another seed clears them.
  const b = String(stdout).match(/^bindings: \d+ bound, \d+ already present, (\d+) unknown subjects/m);
  const waiting = b ? Number(b[1]) : 0;
  return waiting > 0
    ? `${base}. ${waiting} sound bindings name worlds or other subjects that aren't on the board. If the maps have not been applied, run Seed from git again after Apply maps; any left after that are not used.`
    : base;
}

// A failure here fails the job and names the step, but the rows already seeded are committed, not rolled back.
function mediaStep(runner, { name, script, args = [], what, ms, minutes, applied, detail }) {
  return {
    name,
    run: async ({ step, log }) => {
      const thin = thinned(log);
      const r = await runner.script('remote.sh', ['backend', 'node', script, ...args], { timeoutMs: ms, onLine: thin.onLine });
      thin.done();
      if (r.timedOut) throw new Error(`Seeding ${what} did not finish within ${minutes} minutes. ${applied} ${STILL_RUNNING}`);
      if (r.code !== 0) throw new Error(`Seeding ${what} failed (exit ${r.code}): ${tail(r.output)}. ${applied}`);
      const d = detail(r.stdout);
      if (d) step(d);
    },
  };
}

// The laptop's maps, as a FIXED list in a fixed order, never read from a request: vale-region must be LAST because
// p5-descent otherwise takes the entry world. Each apply is one transaction on the board (a map that fails halfway
// leaves nothing of itself behind), but the first can be committed when the second fails. The restart is needed
// because the running backend keeps the old terrain and world copies in memory (see the header of seed-map.js).
const MAP_SPECS = ['p5-descent', 'vale-region'];

function mapsJob(runner) {
  const steps = MAP_SPECS.map((spec, i) => ({
    name: spec,
    run: async ({ log }) => {
      const r = await runner.script('remote.sh', ['backend', 'sh', '-c', `SPEC=${spec} node scripts/seed-map.js`], { timeoutMs: MAP_MS, onLine: log });
      const after = i === 0
        ? 'The game was not restarted. Nothing from it was applied.'
        : `The game was not restarted. ${MAP_SPECS[0]} was applied and holds the entry world until ${spec} is, so press Apply maps again.`;
      if (r.timedOut) throw new Error(`Applying ${spec} did not finish within ${MAP_MS / 60_000} minutes. The game was not restarted. ${STILL_RUNNING}`);
      if (r.code !== 0) throw new Error(`Applying ${spec} failed (exit ${r.code}): ${tail(r.output)}. ${after}`);
    },
  }));
  steps.push({
    name: 'restart',
    run: async ({ log }) => {
      const r = await runner.script('remote.sh', ['compose', 'restart', 'backend', 'caddy'], { timeoutMs: RESTART_MS, onLine: log });
      const applied = 'Both maps are applied, but the game still runs the old terrain until it restarts: press Restart under Last action.';
      if (r.timedOut) throw new Error(`The restart did not finish within ${RESTART_MS / 1000} seconds. ${applied}`);
      if (r.code !== 0) throw new Error(`The restart failed (exit ${r.code}): ${tail(r.output)}. ${applied}`);
    },
  });
  return steps;
}

module.exports = { tunnelJob, restartJob, seedJob, mapsJob, MAP_SPECS, readSeedPreview, BoardOffline, TUNNEL_NAMES, SEED_ART_MS, SEED_AUDIO_MS };
