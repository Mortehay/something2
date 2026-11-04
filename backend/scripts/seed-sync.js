#!/usr/bin/env node
// Headless Seed/Export (SOMET-639): the admin tab's engine without a browser.
//
//   node scripts/seed-sync.js status [--group=g]
//   node scripts/seed-sync.js export --group=g | --all
//   (Maps export here never pushes to the GPU box; the admin tab's export does.)
//   node scripts/seed-sync.js seed   --group=g | --all [--resolve=git|local]
//   node scripts/seed-sync.js preview --group=g | --all [--resolve=git|local]
//   seed and preview also take --git-wins (only with --resolve=git): a row kept local by default
//     because it differs from git is taken from git too; never a delete.
//     (writes nothing; `<group> preview {"add":n,"change":n,"remove":n,"overwrite":n,"blocked":n}`)
//
// Output: one stable line per group, `<group> <ok|refused:<code>|error> <details>`
// (status lines are `<group> <status> <localEdits> <gitChanges>`). Preview
// warnings go to stderr as `warn <group> <code> <json>`. Binary groups (art,
// audio) report asset progress to stderr as `progress <group> <phase>
// <done>/<total>`, at most one line per 250 ms plus the last one.
// Exit: 0 ok, 2 when any group was refused, 1 on any unexpected error.
//
// Like seed-gear-ladder.js this refuses to run without an explicit
// DATABASE_URL and deliberately does NOT load .env (a dotenv fallback would
// make the guard unfireable and quietly target the shared dev database).
const { Pool } = require('pg');
const { GROUPS, getGroup } = require('../src/services/seedSync/registry.js');
const { diffGroup } = require('../src/services/seedSync/diffGroup.js');
const { exportGroup } = require('../src/services/seedSync/exportGroup.js');
const { previewSeed, applySeed } = require('../src/services/seedSync/applySeed.js');
const { SyncRefused, SyncFileError } = require('../src/services/seedSync/errors.js');

const DELETE_KINDS = new Set(['deleted_in_git', 'only_here']);
const CREATE_KINDS = new Set(['new', 'deleted_here']);

// Mirrors the UI's allowedDecisions (frontend seedExportModel.js).
function allowedDecisions(row) {
  if (DELETE_KINDS.has(row.kind)) return row.blockedReason ? ['local'] : ['delete', 'local'];
  if (CREATE_KINDS.has(row.kind) && row.blockedReason) return ['local'];
  return ['git', 'local'];
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { cmd, all: false, group: null, resolve: null, gitWins: false };
  for (const a of rest) {
    if (a === '--all') opts.all = true;
    else if (a === '--git-wins') opts.gitWins = true;
    else if (a.startsWith('--group=')) opts.group = a.slice(8);
    else if (a.startsWith('--resolve=')) opts.resolve = a.slice(10);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!['status', 'export', 'seed', 'preview'].includes(cmd)) throw new Error('usage: seed-sync.js status|export|seed|preview [--group=g|--all] [--resolve=git|local]');
  if (opts.resolve !== null && !['git', 'local'].includes(opts.resolve)) throw new Error('--resolve must be git or local');
  if (opts.cmd !== 'status' && !opts.all && !opts.group) throw new Error(`${cmd} needs --group=<id> or --all`);
  if (opts.gitWins && !['seed', 'preview'].includes(cmd)) throw new Error('--git-wins applies to seed and preview only');
  if (opts.gitWins && opts.resolve !== 'git') throw new Error('--git-wins needs --resolve=git');
  if (opts.all && opts.group) throw new Error('use --group or --all, not both');
  return opts;
}

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

function targets(opts) {
  if (opts.group) { getGroup(opts.group); return [opts.group]; }
  return GROUPS.map((g) => g.id);
}

// Decisions for one preview: defaults, red rows from --resolve, and never a
// decision the engine/UI forbids. Returns { decisions } or { undecided }.
function decide(rows, resolve, { gitWins = false } = {}) {
  const decisions = {};
  const notes = [];
  let undecided = 0;
  for (const r of rows) {
    if (r.defaultDecision != null) {
      // --git-wins: a row kept local by default (it differs from git) takes
      // git's version where 'git' is allowed. Never a delete: only_here has no
      // 'git' in its allowed decisions, so it stays as its default says.
      const canGit = gitWins && resolve === 'git' && r.defaultDecision === 'local'
        && (r.allowedDecisions || allowedDecisions(r)).includes('git');
      decisions[r.syncUuid] = canGit ? 'git' : r.defaultDecision;
      continue;
    }
    if (!resolve) { undecided += 1; continue; }
    // Red rows are edited_here/adopt-style rows or key clashes; delete kinds
    // always have a default, so 'git' here is never a delete. A 'git' the
    // rules forbid (key clash) degrades to 'local' and is reported.
    if (allowedDecisions(r).includes(resolve)) decisions[r.syncUuid] = resolve;
    else {
      decisions[r.syncUuid] = 'local';
      notes.push(`${r.table || ''}:${r.key || r.syncUuid} kept local (${r.blockedReason || 'not allowed'})`);
    }
  }
  return { decisions, notes, undecided };
}

// What a seed would do, counted per row once: `add` (a row git creates),
// `remove` (decided delete), `change` (git row with a default decision),
// `overwrite` (git row that needed --resolve=git: a local edit is replaced).
// Rows kept local count as nothing. `blocked` is what applySeed would refuse
// under the same --resolve: a row whose decision is not in the row's
// allowedDecisions (asset-blocked git rows, owner_missing, ...; decide()
// already degrades a forbidden 'git' on key clashes to 'local', so those are
// not refused), plus each missing_ref / invalid_value preview warning. A
// blocked row is never counted in add/change/remove/overwrite.
function summarizePreview(rows, resolve, warnings = [], { gitWins = false } = {}) {
  const all = rows || [];
  const { decisions } = decide(all, resolve, { gitWins });
  const out = { add: 0, change: 0, remove: 0, overwrite: 0, blocked: 0 };
  for (const r of all) {
    const d = decisions[r.syncUuid];
    if (d === undefined || d === 'local') continue;
    if (!(r.allowedDecisions || allowedDecisions(r)).includes(d)) { out.blocked += 1; continue; }
    if (d === 'delete') out.remove += 1;
    else if (d === 'git') {
      if (r.defaultDecision === 'local') out.overwrite += 1; // only reachable with gitWins
      else if (CREATE_KINDS.has(r.kind)) out.add += 1;
      else if (r.defaultDecision != null) out.change += 1;
      else out.overwrite += 1;
    }
  }
  out.blocked += (warnings || []).filter((w) => w.code === 'missing_ref' || w.code === 'invalid_value').length;
  return out;
}

// onProgress for one group: prints `progress <group> <phase> <done>/<total>`
// via write, at most once per intervalMs; flush() prints the last event when
// it was throttled away.
function progressPrinter(id, { write = (l) => console.error(l), now = Date.now, intervalMs = 250 } = {}) {
  let last = -Infinity;
  let pending = null;
  const print = (p) => { write(`progress ${id} ${p.phase} ${p.done}/${p.total}`); pending = null; };
  const onProgress = (p) => {
    pending = p;
    const t = now();
    if (t - last >= intervalMs) { last = t; print(p); }
  };
  onProgress.flush = () => { if (pending) print(pending); };
  return onProgress;
}

async function runGroup(pool, opts, id) {
  const onProgress = progressPrinter(id);
  try {
    return await runGroupWith(pool, opts, id, onProgress);
  } finally {
    onProgress.flush();
  }
}

async function runGroupWith(pool, opts, id, onProgress) {
  if (opts.cmd === 'status') {
    try {
      const d = await diffGroup(pool, id);
      return { line: `${id} ${d.status} ${d.localEdits} ${d.gitChanges}` };
    } catch (err) {
      if (err instanceof SyncFileError) return { line: `${id} bad_file 0 0` };
      throw err;
    }
  }
  if (opts.cmd === 'export') {
    const r = await exportGroup(pool, id, { onProgress });
    return { line: `${id} ok rows=${r.rowCount} run=${r.runId}` };
  }
  const pre = await previewSeed(pool, id);
  for (const w of pre.warnings || []) {
    const { code, ...rest } = w;
    console.error(`warn ${id} ${code} ${oneLine(JSON.stringify(rest))}`);
  }
  if (opts.cmd === 'preview') {
    return { line: `${id} preview ${JSON.stringify(summarizePreview(pre.rows || [], opts.resolve, pre.warnings, { gitWins: opts.gitWins }))}` };
  }
  const { decisions, notes, undecided } = decide(pre.rows || [], opts.resolve, { gitWins: opts.gitWins });
  if (undecided) {
    throw new SyncRefused('undecided', `${undecided} row(s) edited on this PC need --resolve=git|local`, { count: undecided });
  }
  for (const n of notes) console.error(`note ${id} ${oneLine(n)}`);
  const r = await applySeed(pool, id, decisions, { signature: pre.signature, onProgress });
  return { line: `${id} ok ${oneLine(JSON.stringify(r.summary))} run=${r.runId}` };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set; refusing to guess a database.');
    console.error('Example: DATABASE_URL=postgres://user:password@localhost:15432/game_db node scripts/seed-sync.js status');
    process.exit(1);
  }
  const ids = targets(opts);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let refused = 0;
  let failed = 0;
  try {
    for (const id of ids) {
      try {
        console.log((await runGroup(pool, opts, id)).line);
      } catch (err) {
        if (err instanceof SyncRefused) {
          refused += 1;
          console.log(`${id} refused:${err.code} ${oneLine(err.message)}`);
        } else if (err instanceof SyncFileError) {
          refused += 1;
          console.log(`${id} refused:bad_file ${oneLine(err.message)}`);
        } else {
          failed += 1;
          console.log(`${id} error ${oneLine(err && err.message)}`);
        }
      }
    }
  } finally {
    await pool.end().catch(() => {});
  }
  process.exitCode = failed ? 1 : (refused && opts.cmd !== 'status' ? 2 : 0);
}

module.exports = { summarizePreview, decide, allowedDecisions, progressPrinter };

if (require.main === module) main().catch((err) => { console.error(oneLine(err && err.message)); process.exit(1); });
