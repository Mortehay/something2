#!/usr/bin/env node
// Headless Seed/Export (SOMET-639): the admin tab's engine without a browser.
//
//   node scripts/seed-sync.js status [--group=g]
//   node scripts/seed-sync.js export --group=g | --all
//   node scripts/seed-sync.js seed   --group=g | --all [--resolve=git|local]
//
// Output: one stable line per group, `<group> <ok|refused:<code>|error> <details>`
// (status lines are `<group> <status> <localEdits> <gitChanges>`). Preview
// warnings go to stderr as `warn <group> <code> <json>`.
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
  const opts = { cmd, all: false, group: null, resolve: null };
  for (const a of rest) {
    if (a === '--all') opts.all = true;
    else if (a.startsWith('--group=')) opts.group = a.slice(8);
    else if (a.startsWith('--resolve=')) opts.resolve = a.slice(10);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!['status', 'export', 'seed'].includes(cmd)) throw new Error('usage: seed-sync.js status|export|seed [--group=g|--all] [--resolve=git|local]');
  if (opts.resolve !== null && !['git', 'local'].includes(opts.resolve)) throw new Error('--resolve must be git or local');
  if (opts.cmd !== 'status' && !opts.all && !opts.group) throw new Error(`${cmd} needs --group=<id> or --all`);
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
function decide(rows, resolve) {
  const decisions = {};
  const notes = [];
  let undecided = 0;
  for (const r of rows) {
    if (r.defaultDecision != null) { decisions[r.syncUuid] = r.defaultDecision; continue; }
    if (!resolve) { undecided += 1; continue; }
    const want = resolve === 'local' ? 'local' : (DELETE_KINDS.has(r.kind) ? 'delete' : 'git');
    if (allowedDecisions(r).includes(want)) decisions[r.syncUuid] = want;
    else {
      decisions[r.syncUuid] = 'local';
      notes.push(`${r.table || ''}:${r.key || r.syncUuid} kept local (${r.blockedReason || 'not allowed'})`);
    }
  }
  return { decisions, notes, undecided };
}

async function runGroup(pool, opts, id) {
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
    const r = await exportGroup(pool, id);
    return { line: `${id} ok rows=${r.rowCount} run=${r.runId}` };
  }
  const pre = await previewSeed(pool, id);
  for (const w of pre.warnings || []) {
    const { code, ...rest } = w;
    console.error(`warn ${id} ${code} ${oneLine(JSON.stringify(rest))}`);
  }
  const { decisions, notes, undecided } = decide(pre.rows || [], opts.resolve);
  if (undecided) {
    throw new SyncRefused('undecided', `${undecided} row(s) edited on this PC need --resolve=git|local`, { count: undecided });
  }
  for (const n of notes) console.error(`note ${id} ${oneLine(n)}`);
  const r = await applySeed(pool, id, decisions, { signature: pre.signature });
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

main().catch((err) => { console.error(oneLine(err && err.message)); process.exit(1); });
