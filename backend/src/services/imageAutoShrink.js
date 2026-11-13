'use strict';
// Auto-shrink (spec 2026-11-13-image-shrink, "Auto-shrink"): new and
// regenerated game art gets its web copy without an admin click. Sprite
// sheets are always built from originals (the pipeline never sees a web
// copy); the finished sheet is then shrunk like any other subject.
//
// The sweep diffs the catalog against image_variants, so it needs no subject
// from the caller: a write path pokes requestAutoShrink() (debounced, DB-only
// detection) and a periodic timer catches everything else, including same-key
// rewrites (etag pass). Work goes through the Images tab's single-flight
// runner; a manual run in progress makes the sweep skip until the next tick.
//
// What is picked up: a subject with no variant (kind default params) and a
// stale variant (its previous params). Excluded: an undone variant that is not
// stale (undo wins until the admin acts), and a subject whose last operation
// was a failed auto-shrink of its current original (no retry storm; a new
// original key retries). Ops are logged with actor NULL and params.auto = true.

const runner = require('./imageShrinkRun.js');
const { bindUnbound, catalogEntries, statKeys, isFresh } = require('./imageVariants.js');
const { getSetting } = require('./gameSettings.js');

const DEBOUNCE_MS = 5000;
const DEFAULT_INTERVAL_MS = 120000;
const STAT_CONCURRENCY = 16;

const tripleKey = (t, k, c) => `${t}\u0000${k}\u0000${c}`;

// Strip the log-only marker from a variant's params before reusing them.
function previousParams(params) {
  if (!params || typeof params !== 'object') return null;
  const { auto, ...rest } = params; // eslint-disable-line no-unused-vars
  return Object.keys(rest).length ? rest : null;
}

// Map(triple -> last operation) for these subjects' tables.
async function lastOps(pool) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (subject_table, subject_key, subject_column)
            subject_table, subject_key, subject_column, original_key, status, params
       FROM image_operations
      ORDER BY subject_table, subject_key, subject_column, id DESC`);
  return new Map(rows.map((r) => [tripleKey(r.subject_table, r.subject_key, r.subject_column), r]));
}

const failedAuto = (op, cur) => !!op && op.status === 'failed' && !!op.params && op.params.auto === true
  && op.original_key === cur.original;

// `only(subject)` narrows the catalog (tests scope a sweep to their own rows).
async function findAutoShrinkWork(pool, store, { checkEtags = false, only = null } = {}) {
  await bindUnbound(pool, store);
  let entries = (await catalogEntries(pool)).map((e) => ({
    ...e, subject: { table: e.col.table, key: e.key, column: e.col.column },
  }));
  if (typeof only === 'function') entries = entries.filter((e) => only(e.subject));
  const ops = await lastOps(pool);
  const candidates = [];
  const toStat = [];
  for (const e of entries) {
    const { variant: v, cur } = e;
    if (failedAuto(ops.get(tripleKey(e.subject.table, e.subject.key, e.subject.column)), cur)) continue;
    if (!v) { candidates.push({ subject: e.subject, params: null }); continue; }
    if (v.original_key == null) continue; // seeded, not bindable yet
    const keysMoved = v.original_key !== cur.original || (v.original_manifest_key || null) !== (cur.manifest || null);
    if (keysMoved) { candidates.push({ subject: e.subject, params: previousParams(v.params) }); continue; }
    if (checkEtags) toStat.push(e);
  }
  for (let i = 0; i < toStat.length; i += STAT_CONCURRENCY) {
    const chunk = toStat.slice(i, i + STAT_CONCURRENCY);
    const stats = await Promise.all(chunk.map((e) => statKeys(store, e.cur)));
    chunk.forEach((e, j) => {
      // A missing object reads as not fresh; shrinking it would only fail, so leave it.
      if (!stats[j].st) return;
      if (!isFresh(e.variant, e.cur, stats[j])) {
        candidates.push({ subject: e.subject, params: previousParams(e.variant.params) });
      }
    });
  }
  return candidates;
}

let sweeping = false;

// -> the started run's view, or null (setting off, nothing to do, a run is
// active, or another sweep is already looking).
async function runAutoShrinkSweep(pool, store, { checkEtags = false, only = null } = {}) {
  if (sweeping) return null;
  sweeping = true;
  try {
    if ((await getSetting(pool, 'image_auto_shrink')) !== true) return null;
    const cur = runner.getRun();
    if (cur && cur.status === 'running') return null;
    const work = await findAutoShrinkWork(pool, store, { checkEtags, only });
    if (!work.length) return null;
    try {
      return await runner.startRun(pool, store, {
        op: 'shrink', auto: true, subjects: work.map((w) => ({ ...w.subject, params: w.params })),
      });
    } catch (err) {
      if (err.code === 'running') return null; // a manual run started meanwhile
      throw err;
    }
  } finally {
    sweeping = false;
  }
}

// ---- triggers -------------------------------------------------------------

let ctx = null; // { pool, store } while the timer runs
let interval = null;
let debounce = null;

function sweepQuietly(checkEtags) {
  if (!ctx) return;
  runAutoShrinkSweep(ctx.pool, ctx.store, { checkEtags })
    .catch((err) => console.error('image auto-shrink sweep failed:', err && err.message));
}

// Called by write paths after art changed. No-op until the server started the
// timer (so tests that load a route never sweep). Never throws.
function requestAutoShrink() {
  try {
    if (!ctx) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => { debounce = null; sweepQuietly(false); }, DEBOUNCE_MS);
    if (debounce.unref) debounce.unref();
  } catch (err) {
    console.error('image auto-shrink poke failed:', err && err.message);
  }
}

function startAutoShrinkTimer(pool, store, { intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  stopAutoShrinkTimer();
  ctx = { pool, store };
  interval = setInterval(() => sweepQuietly(true), intervalMs);
  if (interval.unref) interval.unref();
}

function stopAutoShrinkTimer() {
  if (interval) clearInterval(interval);
  if (debounce) clearTimeout(debounce);
  interval = null;
  debounce = null;
  ctx = null;
}

const isTimerRunning = () => interval !== null;

module.exports = {
  findAutoShrinkWork, runAutoShrinkSweep, requestAutoShrink, startAutoShrinkTimer, stopAutoShrinkTimer,
  isTimerRunning,
};
