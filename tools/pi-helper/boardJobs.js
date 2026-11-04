'use strict';
// Job factories: they return step lists for createJobs and know nothing of HTTP.
const path = require('node:path');
const { explainTunnelError } = require('./tunnelErrors');
const { BOARD_SEED_GROUPS } = require(path.resolve(__dirname, '../../backend/src/services/seedSync/boardSeedGroups.js'));

const TUNNEL_NAMES = ['cloudflare', 'ngrok'];
const TUNNEL_ACTIONS = ['start', 'stop'];
const TUNNEL_MS = 120_000;
const RESTART_MS = 120_000;
const SEED_MS = 300_000;
const PREVIEW_MS = 120_000;

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

function tunnelJob(runner, name, action) {
  // Exact match from a fixed list; the name is never built from anything else.
  const tunnel = TUNNEL_NAMES.find((n) => n === name);
  const act = TUNNEL_ACTIONS.find((a) => a === action);
  if (!tunnel || !act) throw new Error('Unknown tunnel or action.');
  return [{
    name: `${act === 'start' ? 'Start' : 'Stop'} ${tunnel} tunnel`,
    run: async ({ step, log }) => {
      const r = await runner.script('tunnel.sh', [act, tunnel], { timeoutMs: TUNNEL_MS, onLine: log });
      const out = kv(r.stdout);
      if (r.timedOut) throw new Error(`The tunnel ${act} did not finish within ${TUNNEL_MS / 1000} seconds.`);
      if (r.code !== 0) {
        if (act === 'start') throw new Error(explainTunnelError(out.error || ''));
        throw new Error(`The tunnel failed to stop (${out.error || `exit ${r.code}`}).`);
      }
      if (out.url) step(out.url);
      else if (act === 'stop') step('stopped');
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
const OLD_TOOLING = /unknown argument|usage:/i;

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

async function readSeedPreview(runner) {
  const first = await previewGroup(runner, BOARD_SEED_GROUPS[0]);
  if (first.oldTooling) return { needsUpdate: true, groups: [] };
  const groups = [first.row];
  for (const g of BOARD_SEED_GROUPS.slice(1)) {
    const p = await previewGroup(runner, g);
    if (p.oldTooling) return { needsUpdate: true, groups: [] };
    groups.push(p.row);
  }
  return { needsUpdate: false, groups };
}

const UPDATE_FIRST = 'The board has older seed tooling than this checkout. Update the board first, then seed from git.';

function seedJob(runner) {
  const steps = [{
    name: 'Check the board seed tooling',
    run: async ({ log }) => {
      const p = await previewGroup(runner, BOARD_SEED_GROUPS[0], log);
      if (p.oldTooling) throw new Error(UPDATE_FIRST);
    },
  }, {
    name: 'Seed catalogs',
    run: async ({ log }) => {
      const r = await runner.script('remote.sh', ['backend', 'node', 'scripts/seed-catalogs.js'], { timeoutMs: SEED_MS, onLine: log });
      if (r.timedOut) throw new Error(`Seeding catalogs did not finish within ${SEED_MS / 1000} seconds.`);
      if (r.code !== 0) throw new Error(`Seeding catalogs failed (exit ${r.code}): ${tail(r.output)}`);
    },
  }];
  for (const g of BOARD_SEED_GROUPS) {
    steps.push({
      name: `Seed ${g}`,
      run: async ({ step, log }) => {
        const r = await seedCmd(runner, groupArgs('seed', g), SEED_MS, log);
        if (r.timedOut) throw new Error(`Seeding ${g} did not finish within ${SEED_MS / 1000} seconds.`);
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
  return steps;
}

module.exports = { tunnelJob, restartJob, seedJob, readSeedPreview, BoardOffline, TUNNEL_NAMES };
