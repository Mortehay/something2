'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fingerprint, validate, stripLine } = require('./finding.js');
const { STATUSES } = require('./config.js');

// Fields a re-audit is allowed to overwrite. Everything else — id, plane_id,
// status — belongs to the lifecycle, not to the observation, and survives.
const MUTABLE = [
  'file',
  'severity',
  'source',
  'claim',
  'failure_scenario',
  'proposed_fix',
  'verification',
];

function emptyDoc() {
  return { version: 1, findings: [] };
}

function load(file) {
  if (!fs.existsSync(file)) return emptyDoc();
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function save(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function nextId(doc) {
  const highest = doc.findings.reduce((max, f) => {
    const n = Number.parseInt(String(f.id).slice(2), 10);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  return `F-${String(highest + 1).padStart(3, '0')}`;
}

// Fingerprint dedupe matches on the *exact* normalized claim (see
// finding.js's normalizeClaim), so it is stable across line-number churn and
// cosmetic rewording but not across a genuine re-description of the same
// defect — an LLM-driven re-audit describing the same bug in different words
// gets a different fingerprint and slips past dedupe as a "new" finding.
// That is not solvable by loosening the fingerprint without risking false
// merges of genuinely distinct findings (semantic matching is out of scope
// here), so instead we warn: a new finding that lands on the same
// surface+location+lens as one already on file is *suspicious*, even though
// it is not provably the same finding. This never blocks the merge — it is
// a hint for the operator to eyeball before syncing to Plane, not a gate.
function duplicateKey(f) {
  return `${f.surface}|${stripLine(f.file)}|${f.lens}`;
}

function merge(doc, incoming) {
  const next = { version: doc.version || 1, findings: doc.findings.map((f) => Object.assign({}, f)) };
  const byFingerprint = new Map(next.findings.map((f) => [f.fingerprint, f]));
  const added = [];
  const updated = [];
  const suspected = [];

  for (const raw of incoming) {
    const fp = fingerprint(raw);
    const existing = byFingerprint.get(fp);

    if (existing) {
      for (const field of MUTABLE) {
        if (raw[field] !== undefined) existing[field] = raw[field];
      }
      const errors = validate(existing);
      if (errors.length) throw new Error(`${existing.id}: ${errors.join('; ')}`);
      updated.push(existing.id);
      continue;
    }

    const created = Object.assign({}, raw, {
      id: nextId(next),
      fingerprint: fp,
      status: 'open',
      plane_id: null,
    });
    const errors = validate(created);
    if (errors.length) throw new Error(`${created.id}: ${errors.join('; ')}`);

    const key = duplicateKey(created);
    for (const other of next.findings) {
      if (duplicateKey(other) === key) {
        suspected.push({ newId: created.id, existingId: other.id });
      }
    }

    next.findings.push(created);
    byFingerprint.set(fp, created);
    added.push(created.id);
  }

  return { doc: next, added, updated, suspected };
}

// Whole-doc version of the same check `merge` runs incrementally: every pair
// of findings sharing a surface+location+lens, regardless of when either was
// added. `bin/sync.js` runs this against the loaded doc immediately before
// syncing, so a near-duplicate pair is visible to the operator right before
// the write that would file it as a second Plane issue — whether it arrived
// via `merge` moments ago or was already sitting in findings.json from
// before this check existed.
function findSuspectedDuplicates(findings) {
  const byKey = new Map();
  for (const f of findings) {
    const key = duplicateKey(f);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(f);
  }
  const suspected = [];
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    for (let i = 1; i < group.length; i += 1) {
      suspected.push({ newId: group[i].id, existingId: group[0].id });
    }
  }
  return suspected;
}

// The narrow, explicit path for lifecycle status changes. `merge` deliberately
// excludes `status` from MUTABLE so a re-audit cannot silently reset a `fixed`
// finding back to `open`; this is the only sanctioned way to change it.
function setStatus(doc, id, status) {
  if (!STATUSES.includes(status)) {
    throw new Error(`setStatus: unknown status '${status}' (expected one of ${STATUSES.join(', ')})`);
  }
  const finding = doc.findings.find((f) => f.id === id);
  if (!finding) {
    throw new Error(`setStatus: no finding with id '${id}'`);
  }
  finding.status = status;
  return doc;
}

module.exports = { emptyDoc, load, save, nextId, merge, setStatus, findSuspectedDuplicates, MUTABLE };
