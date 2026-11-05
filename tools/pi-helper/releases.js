'use strict';
// Releases: a successful Update is a release. The board keeps the main copy in
// $ORANGEPI_DATA_DIR/locks/releases.jsonl (the last 200), this PC keeps another in
// backend/run/pi-releases.jsonl. Commit subjects are untrusted text: they travel to the board only as JSON
// on ssh's stdin, never in a command line. A failed board write never fails an Update; the entry stays on
// this PC and is written to the board at the next status refresh.
const fs = require('node:fs');
const path = require('node:path');

const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_RELEASES = 200;
const MAX_COMMITS = 100;
const SYNC_TAIL = 5; // a status refresh reads only this many of the newest entries
const SUBJECT_CAP = 300;
const SSH_MS = 20_000;
const LIST_MEMO_MS = 20_000;

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const keyOf = (e) => `${e.version}|${e.at}`;
const time = (e) => { const t = Date.parse(e.at); return Number.isFinite(t) ? t : 0; };
const short = (sha) => String(sha).slice(0, 8);

function parseLines(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === 'object' && SHA_RE.test(e.version) && typeof e.at === 'string' && Array.isArray(e.commits)) out.push(e);
    } catch { /* a corrupt or truncated line */ }
  }
  return out;
}

function createReleases({
  runner, git, file = null, max = MAX_RELEASES, maxCommits = MAX_COMMITS, now = () => new Date(),
  log = (m) => console.error(m), isBusy = () => false,
} = {}) {
  let busy = isBusy;
  let lastDeployed = null;
  let syncing = false;
  let memo = null; // { at, value } for list()

  // --- this PC's copy ---
  const readLaptop = () => { try { return parseLines(fs.readFileSync(file, 'utf8')); } catch { return []; } };
  function writeLaptop(entries) {
    if (!file) return;
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, entries.slice(-max).map((e) => `${JSON.stringify(e)}\n`).join(''), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
      log(`pi-helper: could not save the release on this PC (${file}): ${e.message}`);
    }
  }
  let mem = file ? null : []; // no file: keep them in memory only
  const laptop = () => (mem || readLaptop());
  const saveLaptop = (entries) => { if (mem) mem = entries.slice(-max); else writeLaptop(entries); };

  // --- the board's copy ---
  const dataDir = () => {
    const d = runner.env().ORANGEPI_DATA_DIR;
    return d ? String(d).replace(/\/+$/, '') : null;
  };
  const boardFile = () => (dataDir() ? `${dataDir()}/locks/releases.jsonl` : null);
  const markerFile = () => (dataDir() ? `${dataDir()}/locks/deployed-sha` : null);

  // Atomic: copy the old file and the new line (stdin) to a temp file in the same directory, keep the last
  // `max` lines, move it into place. Everything interpolated here is configuration, never commit text.
  // entries: one or more, all sent in a single ssh call as lines on stdin.
  async function appendBoard(entries) {
    const f = boardFile();
    if (!f) return { ok: false, why: 'ORANGEPI_DATA_DIR is not set' };
    const cmd = `F=${shq(f)}; D=$(dirname "$F"); mkdir -p "$D" && T=$(mktemp "$D/.releases.XXXXXX") && `
      + `{ { [ -f "$F" ] && cat "$F"; cat; } | tail -n ${max} > "$T" && chmod 644 "$T" && mv -f "$T" "$F"; } || { rm -f "$T"; exit 1; }`;
    const r = await runner.ssh(cmd, { timeoutMs: SSH_MS, reuse: true, input: entries.map((e) => `${JSON.stringify(e)}\n`).join('') });
    if (r.code === 0 && !r.timedOut) return { ok: true };
    return { ok: false, why: String(r.stderr || r.output || `exit ${r.code}`).trim().split('\n').pop() || `exit ${r.code}` };
  }

  // -> { deployed, releases } | null when the board did not answer. tail: read only that many of the
  // newest entries (a status refresh); without it the whole file (a request for the list, at most 200).
  async function readBoard({ tail = null } = {}) {
    const f = boardFile();
    if (!f) return null;
    const cmd = `printf 'deployed=%s\\n' "$(head -c 64 ${shq(markerFile())} 2>/dev/null | tr -d '[:space:]')"; echo '=== releases'; `
      + `if [ -f ${shq(f)} ]; then ${tail ? `tail -n ${Number(tail)}` : 'cat'} ${shq(f)}; fi`;
    const r = await runner.ssh(cmd, { timeoutMs: SSH_MS, reuse: true });
    if (r.code !== 0 || r.timedOut) return null;
    const i = r.stdout.indexOf('=== releases\n');
    const head = i >= 0 ? r.stdout.slice(0, i) : '';
    const m = /^deployed=(.*)$/m.exec(head);
    return { deployed: m && SHA_RE.test(m[1].trim()) ? m[1].trim() : null, releases: parseLines(i >= 0 ? r.stdout.slice(i + '=== releases\n'.length) : '') };
  }

  // --- the commit list ---
  async function commitsBetween(previous, version) {
    if (previous === undefined) return { commits: [], truncated: 0, note: 'The version before this update could not be read, so its commits are not listed.' };
    if (previous === null) return { commits: [], truncated: 0, note: 'No earlier release is recorded, so this is the first entry and its commits are not listed.' };
    if (!SHA_RE.test(previous) || !SHA_RE.test(version)) return { commits: [], truncated: 0, note: 'A version is not a commit id, so its commits are not listed.' };
    const has = async (sha) => (await git(['cat-file', '-e', `${sha}^{commit}`])).code === 0;
    if (!(await has(previous))) return { commits: [], truncated: 0, note: `The previous version ${short(previous)} is not in this checkout, so its commits are not listed.` };
    if (!(await has(version))) return { commits: [], truncated: 0, note: `The version ${short(version)} is not in this checkout, so its commits are not listed.` };
    const range = `${previous}..${version}`;
    const log1 = await git(['log', `--max-count=${maxCommits}`, '--format=%H%x1f%an%x1f%s%x1e', range]);
    if (log1.code !== 0) return { commits: [], truncated: 0, note: `The commits could not be listed (git exit ${log1.code}).` };
    const commits = [];
    for (const rec of log1.stdout.split('\x1e')) {
      const [sha, author, ...rest] = rec.trim().split('\x1f');
      if (sha && SHA_RE.test(sha)) commits.push({ sha, subject: rest.join('\x1f').slice(0, SUBJECT_CAP), author: author || '' });
    }
    const count = Number((await git(['rev-list', '--count', range])).stdout.trim());
    return { commits, truncated: Number.isInteger(count) && count > commits.length ? count - commits.length : 0 };
  }

  async function buildEntry({ version, previous, sourceBranch, buildBranch, ciUrl, viaHook, baseline }) {
    const c = baseline
      ? { commits: [], truncated: 0, note: 'The version the board was running when the release history began.' }
      : await commitsBetween(previous, version);
    const entry = {
      version, previousVersion: previous === undefined ? null : previous, at: now().toISOString(),
      sourceBranch: sourceBranch || null, buildBranch: buildBranch || null, ciUrl: ciUrl || null,
      commits: c.commits, truncated: c.truncated,
    };
    if (c.note) entry.note = c.note;
    // `at` is when this PC noticed the version, not when it was deployed.
    if (baseline || viaHook) entry.observed = true;
    if (baseline) entry.baseline = true;
    if (viaHook) entry.viaHook = true;
    return entry;
  }

  const newest = (entries) => entries.slice().sort((a, b) => time(a) - time(b)).pop() || null;

  // After a successful Update (verify passed). Never throws; null when nothing was recorded.
  async function afterUpdate({ version, previous, sourceBranch, buildBranch, ciUrl, log: jobLog = () => {} } = {}) {
    try {
      if (!SHA_RE.test(version) || previous === version) return null;
      const entry = await buildEntry({ version, previous, sourceBranch, buildBranch, ciUrl });
      saveLaptop([...laptop(), entry]);
      memo = null;
      const w = await appendBoard([entry]);
      if (w.ok) jobLog(`Release ${short(version)} recorded.`);
      else jobLog(`Release ${short(version)} could not be written to the board (${w.why}). It is kept on this PC and written to the board at the next status refresh.`);
      return entry;
    } catch (e) {
      try { jobLog(`Release ${short(version)} could not be recorded: ${e.message}`); } catch { /* the log is best effort */ }
      return null;
    }
  }

  // Called after each status refresh: write what the board lacks, and record a version nobody here
  // installed. One ssh call writes everything.
  async function sync() {
    if (syncing || busy()) return;
    syncing = true;
    try {
      const b = await readBoard({ tail: SYNC_TAIL });
      if (!b) return;
      if (busy()) return; // an action started while we asked: it will record its own release
      lastDeployed = b.deployed;
      const have = new Set(b.releases.map(keyOf));
      // A full tail means older entries are not visible; only newer-than-its-oldest ones can be missing.
      const oldest = b.releases.length >= SYNC_TAIL ? Math.min(...b.releases.map(time)) : -Infinity;
      const mine = laptop();
      const missing = mine.filter((x) => !have.has(keyOf(x)) && time(x) >= oldest).sort((x, y) => time(x) - time(y));
      const last = newest([...b.releases, ...mine]);
      let observed = null;
      if (b.deployed && (!last || last.version !== b.deployed)) {
        // With a release before it, the deploy happened outside a completed Update. With none, it is a baseline.
        observed = await buildEntry({ version: b.deployed, previous: last ? last.version : null, viaHook: Boolean(last), baseline: !last });
      }
      const batch = observed ? [...missing, observed] : missing;
      if (batch.length === 0) return;
      if (busy()) return;
      if (observed) saveLaptop([...laptop(), observed]);
      memo = null;
      const w = await appendBoard(batch);
      if (!w.ok) log(`pi-helper: ${batch.length} release(s) not written to the board yet: ${w.why}`);
    } catch (e) { log(`pi-helper: release sync failed: ${e.message}`); } finally { syncing = false; }
  }

  // -> { source: 'board' | 'laptop', releases } newest first.
  async function list({ fresh = false } = {}) {
    if (!fresh && memo && Date.now() - memo.at < LIST_MEMO_MS) return memo.value;
    const b = await readBoard().catch(() => null);
    const sorted = (a) => a.slice().sort((x, y) => time(y) - time(x));
    const value = b ? { source: 'board', releases: sorted(b.releases) } : { source: 'laptop', releases: sorted(laptop()) };
    memo = { at: Date.now(), value };
    return value;
  }

  // The version the board runs: the marker last read, else the newest release known.
  const currentVersion = () => lastDeployed || (newest(laptop()) || {}).version || null;

  return { afterUpdate, sync, list, currentVersion, setBusy: (fn) => { busy = fn; } };
}

module.exports = { createReleases, parseLines, MAX_RELEASES, MAX_COMMITS };
