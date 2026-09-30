#!/usr/bin/env node
// Audio prompt writer batch (spec 2026-09-30 §8): write a stored prompt for
// every audio slot that has none.
//
// RESUMABLE WITH NO CURSOR: a slot with an active prompt is skipped, so the
// database is the progress and killing the run is safe (same rule as
// describe-subjects.js). SEQUENTIAL: one text model serves one request at a
// time, and the box's gateway swaps models -- parallel calls only queue.
//
// A BUSY BOX NEVER STOPS THE RUN. Without --box-only a busy box means the
// CPU fallback answers; with it, the run waits and retries the same slot.
// Five consecutive NON-busy failures stop it (the describer is down; writing
// 2,300 identical failures into the log helps nobody).
//
// DUPLICATES ARE REPORTED, NOT FIXED. The art epic measured 12 of 20 skills
// collapsing to one generic weapon; the per-kind duplicate count is how that
// shows up here before a full run is spent on it.
//
// CUE LOOKUP: one cueFor(db, ...) call per sfx slot (~2,300 slots total, of
// which only the `item` kind's cueFor issues a DB query -- 144 weapons x 2
// slots). Measured on the scratch DB: allSlots + loadPromptCatalog ~200ms,
// the whole per-slot cueFor loop (2,074 sfx calls) ~460ms. Nowhere near the
// ~30s a naive per-slot approach would risk if every kind queried, so this
// stays the simple per-slot form rather than precomputing via each kind's
// subjectCues(db) map.
const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const { SUBJECT_KINDS, slotKind, cueFor } = require('../src/services/audioSubjects');
const audioPrompts = require('../src/services/audioPrompts');
const { loadPromptCatalog, buildContext, isStale } = require('../src/services/audioPromptContext');
const writer = require('../src/services/audioPromptWriter');

const CONSECUTIVE_FAILURE_LIMIT = 5;
const BUSY_WAIT_MS = () => Number(process.env.AUDIO_DESCRIBE_BUSY_WAIT_MS) || 30000;

function selectSlots(slots, activeByKey, currentByKey, {
  kinds = null, slot = null, stale = false, limit = 0,
} = {}) {
  const todo = [];
  const skipped = { written: 0, stale: 0 };
  for (const s of slots) {
    if (kinds && !kinds.includes(s.kind)) continue;
    if (slot && s.slot !== slot) continue;
    const active = activeByKey.get(s.id);
    const isStaleRow = Boolean(active) && isStale(active, currentByKey.get(s.id));
    if (stale) {
      if (isStaleRow) todo.push(s);
      else if (active) skipped.written += 1;
    } else if (!active) {
      todo.push(s);
    } else if (isStaleRow) skipped.stale += 1; else skipped.written += 1;
    if (limit && todo.length >= limit) break;
  }
  return { todo, skipped };
}

function summarize(results) {
  const out = {};
  const seen = {};
  for (const r of results) {
    const k = (out[r.kind] ||= { written: 0, failed: 0, box: 0, fallback: 0, duplicates: 0 });
    if (!r.ok) { k.failed += 1; continue; }
    k.written += 1;
    if (r.via === 'box') k.box += 1; else if (r.via === 'fallback') k.fallback += 1;
    const norm = String(r.text || '').trim().toLowerCase();
    const bucket = (seen[r.kind] ||= new Map());
    if (bucket.has(norm)) k.duplicates += 1; else bucket.set(norm, r.key);
  }
  return out;
}

async function allSlots(db) {
  const out = [];
  for (const [kind, def] of Object.entries(SUBJECT_KINDS)) {
    // eslint-disable-next-line no-await-in-loop
    const keys = await def.list(db);
    for (const key of keys) {
      for (const slot of Object.keys(def.slots)) out.push({ kind, key, slot, id: `${kind}/${key}/${slot}` });
    }
  }
  return out;
}

async function run(db, opts, { log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), write = writer.writeSlotPrompt, loadStyles = writer.loadStyles } = {}) {
  const [slots, active, catalog] = await Promise.all([allSlots(db), audioPrompts.listAllActive(db), loadPromptCatalog(db)]);
  const activeByKey = new Map(active.map((p) => [`${p.subject_kind}/${p.subject_key}/${p.slot}`, p]));
  const cues = new Map();
  const currentByKey = new Map();
  for (const s of slots) {
    const cue = slotKind(s.kind, s.slot) === 'sfx' ? await cueFor(db, s.kind, s.key, s.slot) : null; // eslint-disable-line no-await-in-loop
    cues.set(s.id, cue);
    currentByKey.set(s.id, buildContext(catalog, s.kind, s.key, s.slot, { cue }));
  }
  const { todo, skipped } = selectSlots(slots, activeByKey, currentByKey, opts);
  log(`${todo.length} slot(s) to write; skipped ${skipped.written} written, ${skipped.stale} stale`);
  if (opts.dryRun) {
    for (const s of todo) log(`  ${s.id}: ${currentByKey.get(s.id)}`);
    return { dryRun: true, todo: todo.length };
  }
  const styles = await loadStyles(db);
  const results = [];
  let consecutive = 0;
  for (let i = 0; i < todo.length; i += 1) {
    const s = todo[i];
    // eslint-disable-next-line no-await-in-loop
    const r = await write(db, { kind: s.kind, key: s.key, slot: s.slot }, {
      catalog, styles, cue: cues.get(s.id), boxOnly: Boolean(opts.boxOnly),
    });
    if (!r.ok && r.busy && opts.boxOnly) {
      log(`  busy, waiting: ${r.error}`);
      await sleep(BUSY_WAIT_MS()); // eslint-disable-line no-await-in-loop
      i -= 1;
      continue;
    }
    results.push({ kind: s.kind, key: s.key, ok: r.ok, via: r.ok ? r.row.via : r.via, text: r.ok ? r.row.text : null });
    log(`  [${i + 1}/${todo.length}] ${s.id}: ${r.ok ? `${r.row.via} ${r.row.style ? `(${r.row.style}) ` : ''}${r.row.text}` : `FAILED ${r.error}`}`);
    consecutive = r.ok ? 0 : consecutive + 1;
    if (consecutive >= CONSECUTIVE_FAILURE_LIMIT) {
      log(`stopping: ${CONSECUTIVE_FAILURE_LIMIT} failures in a row (last: ${r.error})`);
      break;
    }
  }
  const summary = summarize(results);
  log(JSON.stringify(summary, null, 2));
  return summary;
}

function parseArgs(argv) {
  const get = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  return {
    kinds: get('--kind') ? get('--kind').split(',').map((s) => s.trim()) : null,
    slot: get('--slot') || null,
    limit: get('--limit') ? Number(get('--limit')) : 0,
    dryRun: argv.includes('--dry-run'),
    stale: argv.includes('--stale'),
    boxOnly: argv.includes('--box-only'),
  };
}

if (require.main === module) {
  const env = dotenv.config({ path: path.resolve(__dirname, '../../.env') }).parsed || {};
  const url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }
  const pool = new Pool({ connectionString: url });
  run(pool, parseArgs(process.argv.slice(2)))
    .then(() => pool.end())
    .catch(async (err) => { console.error(err); await pool.end(); process.exit(1); });
}

module.exports = {
  selectSlots, summarize, run, parseArgs,
};
