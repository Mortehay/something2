'use strict';
// The last finished actions, kept in backend/run/pi-actions.jsonl so they survive a restart and are
// written whether or not a tab is open (it hangs off the job's onDone). One JSON object per line,
// 50 kept; the file is rewritten whole through a temporary file, so a crash never leaves half of it.
const fs = require('node:fs');
const path = require('node:path');
const { LOG_CAP } = require('./jobs');

const MAX_ENTRIES = 50;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const asText = (v) => (typeof v === 'string' ? v : null);

function toEntry(job) {
  return {
    id: String(job.id),
    kind: String(job.kind),
    state: String(job.state),
    startedAt: asText(job.startedAt),
    finishedAt: asText(job.finishedAt),
    steps: Array.isArray(job.steps) ? job.steps.map((s) => ({ name: String(s.name), state: String(s.state), detail: asText(s.detail) })) : [],
    error: asText(job.error),
    targetSha: asText(job.targetSha),
    ciUrl: asText(job.ciUrl),
    log: String(job.log || '').slice(-LOG_CAP),
  };
}

// The list shape: everything but the log, and a step is a name and a state.
function toSummary(entry) {
  const { log, ...rest } = entry; // eslint-disable-line no-unused-vars
  return { ...rest, steps: entry.steps.map((s) => ({ name: s.name, state: s.state })) };
}

function createActionHistory({ file = null, max = MAX_ENTRIES, log = (m) => console.error(m) } = {}) {
  let entries = []; // oldest first
  let warned = false;
  const warn = (e) => {
    if (warned) return;
    warned = true;
    log(`pi-helper: could not save the action history (${file}): ${e && e.message ? e.message : e}. Actions still run.`);
  };

  if (file) {
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const e = JSON.parse(line);
          if (e && typeof e === 'object' && ID_RE.test(String(e.id)) && typeof e.kind === 'string' && typeof e.state === 'string') entries.push(toEntry(e));
        } catch { /* a corrupt or truncated line */ }
      }
      entries = entries.slice(-max);
    } catch { /* no file yet */ }
  }

  function save() {
    if (!file) return;
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, entries.map((e) => `${JSON.stringify(e)}\n`).join(''), { mode: 0o600 });
      fs.renameSync(tmp, file);
      warned = false;
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
      warn(e);
    }
  }

  // Never throws: a failed save must not turn an action's result into an error.
  function add(job) {
    try {
      const e = toEntry(job);
      entries = entries.filter((x) => x.id !== e.id);
      entries.push(e);
      if (entries.length > max) entries = entries.slice(-max);
    } catch (e) { warn(e); return; }
    save();
  }

  return {
    add,
    list: () => entries.slice().reverse().map(toSummary),
    // The id is compared to stored ids and never reaches the filesystem.
    get: (id) => (typeof id === 'string' && ID_RE.test(id) ? entries.find((e) => e.id === id) || null : null),
  };
}

module.exports = { createActionHistory, MAX_ENTRIES, ID_RE };
