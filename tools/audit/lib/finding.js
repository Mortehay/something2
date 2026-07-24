'use strict';

const crypto = require('node:crypto');
const { SEVERITIES, LENSES, SURFACES, STATUSES, SOURCES } = require('./config.js');

// A failure scenario earns a severity above P3 only if it describes a trigger
// AND an outcome. This is the machine-checkable half of the verification bar;
// the reviewing agent enforces the rest.
const MIN_SCENARIO_WORDS = 8;

function normalizeClaim(claim) {
  return String(claim || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripLine(file) {
  return String(file || '').replace(/:\d+(-\d+)?$/, '');
}

function fingerprint(f) {
  const parts = [f.surface, stripLine(f.file), f.lens, normalizeClaim(f.claim)];
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validate(f) {
  const errors = [];

  if (!f || typeof f !== 'object') return ['finding must be an object'];

  if (!/^F-\d{3,}$/.test(f.id || '')) errors.push('id must look like F-001');
  if (!SURFACES.includes(f.surface)) errors.push(`surface must be one of ${SURFACES.join(', ')}`);
  if (!LENSES.includes(f.lens)) errors.push(`lens must be one of ${LENSES.join(', ')}`);
  if (!SEVERITIES.includes(f.severity)) errors.push(`severity must be one of ${SEVERITIES.join(', ')}`);
  if (!SOURCES.includes(f.source)) errors.push(`source must be one of ${SOURCES.join(', ')}`);
  if (!STATUSES.includes(f.status)) errors.push(`status must be one of ${STATUSES.join(', ')}`);

  if (!/:\d+(-\d+)?$/.test(f.file || '')) {
    errors.push('file must end in a line number, e.g. path/to/file.js:42');
  }

  for (const field of ['claim', 'failure_scenario', 'proposed_fix', 'verification']) {
    if (!nonEmpty(f[field])) errors.push(`${field} must be a non-empty string`);
  }

  if (f.plane_id !== null && typeof f.plane_id !== 'string') {
    errors.push('plane_id must be null or a string');
  }

  const scenarioWords = String(f.failure_scenario || '').trim().split(/\s+/).filter(Boolean).length;
  if (f.severity !== 'P3' && SEVERITIES.includes(f.severity) && scenarioWords < MIN_SCENARIO_WORDS) {
    errors.push(
      `failure_scenario is too thin to justify ${f.severity}; ` +
      'describe a trigger and an outcome, or record this at P3'
    );
  }

  return errors;
}

module.exports = { normalizeClaim, stripLine, fingerprint, validate };
