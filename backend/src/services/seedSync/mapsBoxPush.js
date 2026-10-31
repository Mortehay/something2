// SOMET-641 (Plan 4a, Task 5). After a Maps export, push each exported spec's
// hand edits to the GPU box's world-spec generator (services/worldGenService.js).
// BEST EFFORT: nothing here may fail an export, and nothing here runs under the
// seed_sync advisory lock (the box can take 20s per call).
//
// Per spec: GET the box's own copy with its ETag (404 = the box does not know
// this spec, e.g. hand-authored vale-region: `skipped`), then PUT our whole spec
// with If-Match = that ETag (never `*`). 200 = `pushed` (the box's `problems`
// list is informational); 409 = the region changed on the box since the GET:
// `failed`, retried by the next export; 422 = rejected: `failed`; 401/403 =
// fatal for the pass (auth_failed).
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
const wg = require('../worldGenService.js');
const { readStates } = require('./mapSpecState.js');

const MAX_ERROR = 300;
const UNREACHABLE_NOTE = 'GPU box unreachable — generate regions locally in Generated Worlds; box sync resumes when it is back';
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

// The known token, plus any token-shaped value after "Bearer" (8+ chars with
// a digit, or 20+): plain prose such as "its bearer token." survives.
function scrub(text, token) {
  let out = String(text);
  if (token) out = out.split(token).join('[token]');
  return out.replace(/\bbearer\s+(?:\[token\]|(?=\S*\d)\S{8,}|\S{20,})/gi, '[token]');
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

const BOX_CHANGED = 'box_changed: the region changed on the GPU box since this export — review it there, then export again';
const authFailedText = (provider) => `auth_failed: the GPU box rejected the token of AI connector "${provider || '?'}" (it may be revoked) — update the AI provider token, then export again`;
const PUT_404 = 'not_found: PUT /spec returned 404 after the GET succeeded — the box may lack the spec endpoint';
const MAX_PROBLEMS = 10;
const MAX_PROBLEM_LEN = 200;

// The box's informational problems: scrubbed, at most 10 of 200 chars, plus
// the full count. -> { problems: string[], problemCount }
function cleanProblems(list, token) {
  const arr = Array.isArray(list) ? list : [];
  const problems = arr.slice(0, MAX_PROBLEMS).map((p) => scrub(typeof p === 'string' ? p : JSON.stringify(p), token).slice(0, MAX_PROBLEM_LEN));
  return { problems, problemCount: arr.length };
}

function rejectedText(body, token) {
  const d = body && body.detail;
  const list = Array.isArray(d) ? d : (d == null ? [] : [d]);
  const first = list.slice(0, 3).map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('; ');
  return scrub(`box_rejected: ${first || 'the box refused the spec'}`, token).replace(/\s+/g, ' ').slice(0, MAX_ERROR);
}

// deps: { fetchImpl (tests), serviceDb (tests: where the box provider is read
// from; default `db`) }. opts: { signal, onProgress, readSpec(name) }.
// -> [{ spec, status: 'pushed'|'skipped'|'failed', error, problems? }]
async function pushToBox(db, specNames, deps = {}, opts = {}) {
  const wgDeps = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {};
  const svcDb = deps.serviceDb || db;
  const { readSpec } = opts;
  const results = [];
  const total = specNames.length;
  const progress = (done) => { if (opts.onProgress) opts.onProgress({ phase: 'box', done, total }); };
  let token = null;
  let providerName = null;
  try {
    const svc = await wg.resolveWorldService(svcDb);
    token = svc.provider.auth_token;
    providerName = svc.providerName;
  } catch { /* reported per spec */ }
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
        let got = null;
        try {
          got = await wg.getWorldSpecWithEtag(svcDb, name, wgDeps);
        } catch (e) {
          if (!(e && e.code === 'not_found')) throw e;
        }
        if (!got) {
          await setState(db, name, skippedMarker(sha), null);
          res = { spec: name, status: 'skipped', error: null };
        } else {
          let put;
          try {
            put = await wg.putWorldSpec(svcDb, name, ours, got.etag, wgDeps);
          } catch (e) {
            if (!(e && e.code === 'not_found')) throw e;
            put = { status: 404 };
          }
          if (put.status === 404) {
            // A race or a box without the /spec route: never a skip.
            await setState(db, name, st.box_pushed_sha256 || null, PUT_404);
            res = { spec: name, status: 'failed', error: PUT_404 };
          } else if (put.status === 409 || put.status === 422) {
            const error = put.status === 409 ? BOX_CHANGED : rejectedText(put.body, token);
            await setState(db, name, st.box_pushed_sha256 || null, error);
            res = { spec: name, status: 'failed', error };
          } else {
            await setState(db, name, sha, null);
            res = { spec: name, status: 'pushed', error: null, ...cleanProblems(put.body && put.body.problems, token) };
          }
        }
      }
    } catch (e) {
      const error = (e && e.code === 'auth_failed') ? authFailedText(providerName).slice(0, MAX_ERROR) : errorText(e, token);
      if (e && FATAL.has(e.code)) fatal = error;
      try { await setState(db, name, st ? st.box_pushed_sha256 : null, error); } catch { /* best effort */ }
      res = { spec: name, status: 'failed', error };
    }
    results.push(res);
    progress(results.length);
  }
  return results;
}

// Informational: "GPU box notes: N problems on <spec>" per pushed spec the box
// flagged. Never an error, never blocks. [] -> null.
function problemsNote(results) {
  const lines = (results || []).filter((r) => r.problemCount > 0)
    .map((r) => `GPU box notes: ${r.problemCount} problem${r.problemCount === 1 ? '' : 's'} on ${r.spec}`);
  if (!lines.length) return null;
  const shown = lines.slice(0, MAX_NOTE_LINES);
  if (lines.length > MAX_NOTE_LINES) shown.push(`+${lines.length - MAX_NOTE_LINES} more`);
  return shown.join('\n');
}

module.exports = {
  pushToBox, boxNote, boxProblems, problemsNote, needsPush, scrub, UNREACHABLE_NOTE,
};
