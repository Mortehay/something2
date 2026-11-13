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
// Every sweep first refreshes variant state, whatever the setting: binds
// seeded copies, marks variants whose column moved (DB only) and -- the
// periodic etag pass -- stats originals and marks those rewritten under the
// same key (stale_at, R15), which drops them from the serve map at once.
//
// What is picked up: a subject with no variant (kind default params), a
// stale variant (moved, marked, or seeded and not bindable to this PC's art;
// its previous params). Excluded: an undone variant, even once
// stale or regenerated (undo wins until the admin acts), and a subject whose
// last operation was a failed auto-shrink of the same original (no retry storm;
// a new original/manifest key, or new bytes seen by the etag pass, retries).
// After the admin cancels an auto run, sweeps back off for 10 minutes.
// Ops are logged with actor NULL and params.auto = true.

const runner = require('./imageShrinkRun.js');
const {
  bindUnbound, catalogEntries, statKeys, previousParams, markMovedStale, markEtagStale, invalidateServeMap,
} = require('./imageVariants.js');
const { getSetting } = require('./gameSettings.js');

const DEBOUNCE_MS = 5000;
const DEFAULT_INTERVAL_MS = 120000;
const STAT_CONCURRENCY = 16;
const CANCEL_BACKOFF_MS = 10 * 60 * 1000;

const tripleKey = (t, k, c) => `${t}\u0000${k}\u0000${c}`;

// Map(triple -> last operation) for these subjects' tables.
async function lastOps(pool) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (subject_table, subject_key, subject_column)
            subject_table, subject_key, subject_column, original_key, status, params
       FROM image_operations
      ORDER BY subject_table, subject_key, subject_column, id DESC`);
  return new Map(rows.map((r) => [tripleKey(r.subject_table, r.subject_key, r.subject_column), r]));
}

// The subject's last op is a failed auto-shrink of this same original key and
// manifest key: retried only once the art changed (see stillFailed).
const failedAuto = (op, cur) => !!op && op.status === 'failed' && !!op.params && op.params.auto === true
  && op.original_key === cur.original
  && ((op.params.auto_src && op.params.auto_src.manifest_key) || null) === (cur.manifest || null);

// Etag pass: the bytes (original or manifest) are what the failed op saw.
// An op without auto_src (older log) reads as changed and is retried once.
function stillFailed(op, stats) {
  const src = op.params.auto_src;
  if (!src) return false;
  const etag = stats.st ? stats.st.etag : null;
  const metag = stats.mst ? stats.mst.etag : null;
  return src.etag === etag && (src.manifest_etag || null) === metag;
}

async function statAll(store, list) {
  const out = [];
  for (let i = 0; i < list.length; i += STAT_CONCURRENCY) {
    out.push(...await Promise.all(list.slice(i, i + STAT_CONCURRENCY).map((e) => statKeys(store, e.cur))));
  }
  return out;
}

// Bind seeded copies and persist staleness (moved keys; with checkEtags the
// etag pass too). Runs whether or not auto-shrink is on: serving depends on it.
async function refreshVariantState(pool, store, { checkEtags = false, only = null } = {}) {
  await bindUnbound(pool, store);
  await markMovedStale(pool, { only });
  if (checkEtags) await markEtagStale(pool, store, { only });
}

// `only(subject)` narrows the catalog (tests scope a sweep to their own rows).
// `refreshed`: the caller already ran refreshVariantState.
async function findAutoShrinkWork(pool, store, { checkEtags = false, only = null, refreshed = false } = {}) {
  if (!refreshed) await refreshVariantState(pool, store, { checkEtags, only });
  let entries = (await catalogEntries(pool)).map((e) => ({
    ...e, subject: { table: e.col.table, key: e.key, column: e.col.column },
  }));
  if (typeof only === 'function') entries = entries.filter((e) => only(e.subject));
  const ops = await lastOps(pool);
  const candidates = [];
  const failed = [];
  for (const e of entries) {
    const { variant: v, cur } = e;
    // Undo wins until the admin acts -- even after the art is regenerated (R11).
    if (v && !v.active) continue;
    const params = v ? previousParams(v.params) : null;
    const op = ops.get(tripleKey(e.subject.table, e.subject.key, e.subject.column));
    if (failedAuto(op, cur)) {
      // Same keys as the failed attempt: only new bytes (etag pass) retry it.
      if (checkEtags) failed.push({ e, params, op });
      continue;
    }
    // No copy; a seeded copy not bindable to this PC's art (bind ran above),
    // which this PC's own copy replaces; a moved or marked one.
    if (!v || v.original_key == null || v.stale_at
      || v.original_key !== cur.original || (v.original_manifest_key || null) !== (cur.manifest || null)) {
      candidates.push({ subject: e.subject, params });
    }
  }
  const stats = await statAll(store, failed.map((x) => x.e));
  failed.forEach(({ e, params, op }, i) => {
    if (!stillFailed(op, stats[i])) candidates.push({ subject: e.subject, params });
  });
  return candidates;
}

let sweeping = false;

// -> the started run's view, or null (setting off, nothing to do, a run is
// active, or another sweep is already looking).
async function runAutoShrinkSweep(pool, store, { checkEtags = false, only = null } = {}) {
  if (sweeping) return null;
  sweeping = true;
  try {
    await refreshVariantState(pool, store, { checkEtags, only });
    if ((await getSetting(pool, 'image_auto_shrink')) !== true) return null;
    const cur = runner.getRun();
    if (cur && cur.status === 'running') return null;
    // The admin cancelled an auto run: leave the runner to them for a while.
    if (cur && cur.auto && cur.status === 'cancelled'
      && Date.now() - Date.parse(cur.finishedAt) < CANCEL_BACKOFF_MS) return null;
    const work = await findAutoShrinkWork(pool, store, { checkEtags, only, refreshed: true });
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
// `checkEtags`: the write rewrote art under the same key, so the debounced
// sweep runs the etag pass too (else only the periodic one would see it).
let pokeEtags = false;
function requestAutoShrink({ checkEtags = false } = {}) {
  try {
    if (checkEtags) invalidateServeMap();
    if (!ctx) return;
    pokeEtags = pokeEtags || checkEtags;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      const etags = pokeEtags;
      pokeEtags = false;
      sweepQuietly(etags);
    }, DEBOUNCE_MS);
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
  pokeEtags = false;
  ctx = null;
}

const isTimerRunning = () => interval !== null;

module.exports = {
  findAutoShrinkWork, refreshVariantState, runAutoShrinkSweep, requestAutoShrink, startAutoShrinkTimer, stopAutoShrinkTimer,
  isTimerRunning,
};
