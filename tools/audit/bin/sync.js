#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const store = require('../lib/store.js');
const { PlaneClient } = require('../lib/plane.js');
const { reconcile } = require('../lib/sync.js');

const EPIC_LABEL = 'K · Audit & hardening';
const KNOWN_FLAGS = new Set(['--dry-run', '--findings', '--epic', '--delay-ms']);

function readApiKey() {
  if (process.env.PLANE_API_KEY) return process.env.PLANE_API_KEY;
  const mcpPath = path.resolve(__dirname, '../../../.mcp.json');
  let raw;
  try {
    raw = fs.readFileSync(mcpPath, 'utf8');
  } catch (error) {
    throw new Error(
      `could not read ${mcpPath} (${error.message}); set PLANE_API_KEY or provide .mcp.json at the repo root`
    );
  }
  const match = raw.match(/plane_api_[A-Za-z0-9]+/);
  if (!match) throw new Error('no Plane API key in PLANE_API_KEY or .mcp.json');
  return match[0];
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    findings: null,
    epicId: process.env.AUDIT_EPIC_ID || null,
    delayMs: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!KNOWN_FLAGS.has(flag)) {
      throw new Error(`unknown flag: ${flag}`);
    }
    if (flag === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`${flag} requires a value`);
    }
    i += 1;
    if (flag === '--findings') args.findings = value;
    else if (flag === '--epic') args.epicId = value;
    else if (flag === '--delay-ms') {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`--delay-ms must be a non-negative number, got: ${value}`);
      }
      args.delayMs = parsed;
    }
  }
  if (!args.findings) {
    throw new Error('usage: sync.js --findings <path> [--epic <uuid>] [--dry-run] [--delay-ms <n>]');
  }
  if (!args.epicId) throw new Error('no epic id: pass --epic <uuid> or set AUDIT_EPIC_ID');
  return args;
}

// Loads the findings doc, runs reconcile, and always persists whatever
// progress reconcile made — even when it throws partway through. Without
// this, a mid-sync failure leaves newly created plane_ids only in memory:
// the on-disk file stays stale and the next run duplicates every issue
// reconcile already created before the failure.
async function syncDocument({ findingsPath, client, epicId, labelIds, dryRun = false, delayMs, sleepImpl }) {
  const doc = store.load(findingsPath);

  // Computed up front, before any write: a near-duplicate pair (same
  // surface+location+lens, different fingerprint — see store.js's
  // duplicateKey) is a sign that a re-audit re-described an existing defect
  // in different words and is about to file it as a second Plane issue.
  // Warn-only, never blocks the sync — see .claude/skills/plane-sync/SKILL.md.
  const suspected = store.findSuspectedDuplicates(doc.findings);

  const reconcileArgs = { doc, client, epicId, labelIds, dryRun };
  if (delayMs !== undefined && delayMs !== null) reconcileArgs.delayMs = delayMs;
  if (sleepImpl !== undefined) reconcileArgs.sleepImpl = sleepImpl;
  let result;
  try {
    result = await reconcile(reconcileArgs);
  } finally {
    if (!dryRun) store.save(findingsPath, doc);
  }

  return {
    dryRun,
    created: result.created.length,
    updated: result.updated.length,
    closed: result.closed.length,
    skipped: result.skipped.length,
    total: doc.findings.length,
    suspected,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = new PlaneClient({ apiKey: readApiKey() });

  const labels = await client.listLabels();
  const label = labels.find((l) => l.name === EPIC_LABEL);
  if (!label) {
    throw new Error(
      `label "${EPIC_LABEL}" does not exist; the Plane bootstrap is a manual procedure — ` +
      'see docs/audits/2026-07-24/plane-bootstrap.md for how it was run and confirm the label was created'
    );
  }

  const summary = await syncDocument({
    findingsPath: args.findings,
    client,
    epicId: args.epicId,
    labelIds: [label.id],
    dryRun: args.dryRun,
    delayMs: args.delayMs,
  });

  if (summary.suspected.length) {
    console.warn(
      `\n⚠ ${summary.suspected.length} suspected near-duplicate finding pair(s) — ` +
      'same surface+file+lens, different fingerprint. Not blocked, but check by hand ' +
      'before trusting the tracker: a re-audit may have re-described an existing ' +
      'finding in different words instead of matching it.'
    );
    for (const { newId, existingId } of summary.suspected) {
      console.warn(`  ${newId} looks like it may duplicate ${existingId}`);
    }
    console.warn('');
  }

  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { parseArgs, syncDocument, main, readApiKey };
