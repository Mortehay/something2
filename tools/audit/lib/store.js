'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fingerprint, validate } = require('./finding.js');
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

function merge(doc, incoming) {
  const next = { version: doc.version || 1, findings: doc.findings.map((f) => Object.assign({}, f)) };
  const byFingerprint = new Map(next.findings.map((f) => [f.fingerprint, f]));
  const added = [];
  const updated = [];

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
    next.findings.push(created);
    byFingerprint.set(fp, created);
    added.push(created.id);
  }

  return { doc: next, added, updated };
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

module.exports = { emptyDoc, load, save, nextId, merge, setStatus, MUTABLE };
