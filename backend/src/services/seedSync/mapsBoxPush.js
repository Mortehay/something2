// SOMET-641 (Plan 4a, Task 5). After a Maps export, push each exported spec's
// hand edits to the GPU box's world-spec generator (services/worldGenService.js).
// BEST EFFORT: nothing here may fail an export, and nothing here runs under the
// seed_sync advisory lock (the box can take 20s per call).
//
// Per spec: GET the box's own copy (404 = the box does not know this spec, e.g.
// hand-authored vale-region: `skipped`), diff it against ours at whole top-level
// key granularity (a `worlds` array is ONE key; no finer patch format is
// invented), and PATCH only the differing keys. No difference = `pushed`
// without a request. A box copy whose shape differs from ours (shapeMismatch)
// is never PATCHed: `failed` with box_error 'shape_mismatch: ...'.
//
// State (map_spec_state):
//   pushed   box_pushed_sha256 = exported_sha256, box_error = NULL
//   failed   box_error = '<code>: <message>' (<= 300 chars, token scrubbed)
//   skipped  box_pushed_sha256 = 'skipped:<exported_sha256>', box_error = NULL.
//            The marker keeps the exported hash in it: while it matches
//            exported_sha256 the spec is settled and never produces a note; once
//            the spec is re-exported with new content the marker is stale, the
//            spec counts as unpushed again (the box may know it by now) and
//            the next export tries it.
// The group note (mapsGroup.computeStatus) reads this state; see boxNote.
const nodeUtil = require('node:util');
const wg = require('../worldGenService.js');
const { readStates } = require('./mapSpecState.js');

const MAX_ERROR = 300;
const UNREACHABLE_NOTE = 'GPU box unreachable — new regions need the box (local generator: SOMET-644)';
const MAX_NOTE_LINES = 3;
// A failure that will hit every remaining spec too: stop calling the box.
const FATAL = new Set(['unreachable', 'auth_failed', 'not_configured']);

const skippedMarker = (sha) => `skipped:${sha}`;
const isSkipped = (v) => typeof v === 'string' && v.startsWith('skipped:');

// A state row whose current export the box has not settled: a recorded error,
// or a pushed hash / skip marker that is not for the current exported hash.
function needsPush(st) {
  if (!st || !st.exported_sha256) return false;
  if (st.box_error) return true;
  const v = st.box_pushed_sha256;
  return (isSkipped(v) ? v !== skippedMarker(st.exported_sha256) : v !== st.exported_sha256);
}

function scrub(text, token) {
  let out = String(text);
  if (token) out = out.split(token).join('[token]');
  return out.replace(/bearer\s+\S+/gi, '[token]');
}
function errorText(err, token) {
  const code = (err && err.code && typeof err.code === 'string') ? err.code : 'error';
  const msg = scrub((err && err.message) || String(err), token).replace(/\s+/g, ' ');
  return `${code}: ${msg}`.slice(0, MAX_ERROR);
}

// The group note for specs with a box problem: [{ spec, error }] -> string|null.
function boxNote(problems) {
  if (!problems.length) return null;
  if (problems.every((p) => /^unreachable:/.test(p.error))) return UNREACHABLE_NOTE;
  const lines = problems.slice(0, MAX_NOTE_LINES).map((p) => `GPU box not updated: ${p.spec}: ${p.error}`);
  if (problems.length > MAX_NOTE_LINES) lines.push(`+${problems.length - MAX_NOTE_LINES} more`);
  return lines.join('\n');
}

// Specs from state rows (specs the box knows) that have a box problem.
function boxProblems(states, specNames) {
  const out = [];
  for (const name of specNames) {
    const st = states.get(name);
    if (!needsPush(st)) continue;
    out.push({ spec: name, error: st.box_error || 'not pushed yet' });
  }
  return out;
}

async function setState(db, name, pushed, error) {
  await db.query(
    'UPDATE map_spec_state SET box_pushed_sha256 = $2, box_error = $3, updated_at = now() WHERE spec_name = $1',
    [name, pushed, error]);
}

// Top-level keys of `ours` whose value differs from the box's copy. `name` is
// the identity, never patched.
function changedKeys(ours, theirs) {
  const body = {};
  for (const k of Object.keys(ours)) {
    if (k === 'name') continue;
    if (!theirs || !nodeUtil.isDeepStrictEqual(ours[k], theirs[k])) body[k] = ours[k];
  }
  return body;
}

// The box's spec format is not verified, and a PATCH replaces whole top-level
// keys: a key the box has and we do not would be dropped with them. Compared
// before any PATCH: the top-level key sets, and the key sets of the `worlds`
// and `links` elements (union over elements). A mismatch when the box has a
// key we do not (any level), or lacks a top-level key we would PATCH. An
// element key only we have (e.g. a hand-placed `graph`) is an edit, not a
// shape change. -> null, or the first differing keys ('box has worlds[].x').
const ELEMENT_ARRAYS = ['worlds', 'links'];
const MAX_SHAPE_KEYS = 3;
function shapeMismatch(ours, theirs, body) {
  if (!theirs || typeof theirs !== 'object' || Array.isArray(theirs)) return 'box copy is not an object';
  const extra = Object.keys(theirs).filter((k) => !(k in ours)).sort();
  const lacks = Object.keys(body).filter((k) => !(k in theirs)).sort();
  for (const k of ELEMENT_ARRAYS) {
    if (!(k in theirs) || !(k in ours)) continue;
    if (!Array.isArray(theirs[k])) return `box ${k} is not an array`;
    const keysOf = (arr) => new Set((Array.isArray(arr) ? arr : [])
      .flatMap((e) => (e && typeof e === 'object' && !Array.isArray(e) ? Object.keys(e) : [])));
    const mine = keysOf(ours[k]);
    for (const x of [...keysOf(theirs[k])].sort()) if (!mine.has(x)) extra.push(`${k}[].${x}`);
  }
  const parts = [];
  if (extra.length) parts.push(`box has ${extra.slice(0, MAX_SHAPE_KEYS).join(', ')}${extra.length > MAX_SHAPE_KEYS ? ', …' : ''}`);
  if (lacks.length) parts.push(`box lacks ${lacks.slice(0, MAX_SHAPE_KEYS).join(', ')}${lacks.length > MAX_SHAPE_KEYS ? ', …' : ''}`);
  return parts.length ? parts.join('; ') : null;
}

// deps: { fetchImpl (tests), serviceDb (tests: where the box provider is read
// from; default `db`) }. opts: { signal, onProgress, readSpec(name) }.
// -> [{ spec, status: 'pushed'|'skipped'|'failed', error }]
async function pushToBox(db, specNames, deps = {}, opts = {}) {
  const wgDeps = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {};
  const svcDb = deps.serviceDb || db;
  const { readSpec } = opts;
  const results = [];
  const total = specNames.length;
  const progress = (done) => { if (opts.onProgress) opts.onProgress({ phase: 'box', done, total }); };
  let token = null;
  try { token = (await wg.resolveWorldService(svcDb)).provider.auth_token; } catch { /* reported per spec */ }
  const states = await readStates(db);
  let fatal = null;
  progress(0);
  for (const name of specNames) {
    if (opts.signal && opts.signal.aborted) break;
    const st = states.get(name);
    const sha = st && st.exported_sha256;
    let res;
    try {
      if (!sha) {
        res = { spec: name, status: 'skipped', error: null };
      } else if (!wg.NAME_RE.test(name)) {
        await setState(db, name, skippedMarker(sha), null);
        res = { spec: name, status: 'skipped', error: null };
      } else if (fatal) {
        await setState(db, name, st.box_pushed_sha256 || null, fatal);
        res = { spec: name, status: 'failed', error: fatal };
      } else {
        const ours = readSpec(name);
        let theirs = null;
        let known = true;
        try {
          theirs = await wg.getWorldSpec(svcDb, name, wgDeps);
        } catch (e) {
          if (e && e.code === 'not_found') known = false; else throw e;
        }
        if (!known) {
          await setState(db, name, skippedMarker(sha), null);
          res = { spec: name, status: 'skipped', error: null };
        } else {
          const body = changedKeys(ours, theirs);
          const mismatch = Object.keys(body).length ? shapeMismatch(ours, theirs, body) : null;
          if (mismatch) {
            // Not PATCHed: recorded, and the group note shows it.
            const error = `shape_mismatch: ${mismatch}`.slice(0, MAX_ERROR);
            await setState(db, name, st.box_pushed_sha256 || null, error);
            res = { spec: name, status: 'failed', error };
          } else {
            if (Object.keys(body).length) await wg.patchWorld(svcDb, name, body, wgDeps);
            await setState(db, name, sha, null);
            res = { spec: name, status: 'pushed', error: null };
          }
        }
      }
    } catch (e) {
      const error = errorText(e, token);
      if (e && FATAL.has(e.code)) fatal = error;
      try { await setState(db, name, st ? st.box_pushed_sha256 : null, error); } catch { /* best effort */ }
      res = { spec: name, status: 'failed', error };
    }
    results.push(res);
    progress(results.length);
  }
  return results;
}

module.exports = {
  pushToBox, boxNote, boxProblems, needsPush, UNREACHABLE_NOTE, _changedKeys: changedKeys, _shapeMismatch: shapeMismatch,
};
