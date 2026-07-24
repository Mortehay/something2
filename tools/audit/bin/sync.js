#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const store = require('../lib/store.js');
const { PlaneClient } = require('../lib/plane.js');
const { reconcile } = require('../lib/sync.js');

const EPIC_LABEL = 'K · Audit & hardening';

function readApiKey() {
  if (process.env.PLANE_API_KEY) return process.env.PLANE_API_KEY;
  const mcpPath = path.resolve(__dirname, '../../../.mcp.json');
  const match = fs.readFileSync(mcpPath, 'utf8').match(/plane_api_[A-Za-z0-9]+/);
  if (!match) throw new Error('no Plane API key in PLANE_API_KEY or .mcp.json');
  return match[0];
}

function parseArgs(argv) {
  const args = { dryRun: false, findings: null, epicId: process.env.AUDIT_EPIC_ID || null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--findings') args.findings = argv[++i];
    else if (argv[i] === '--epic') args.epicId = argv[++i];
  }
  if (!args.findings) throw new Error('usage: sync.js --findings <path> [--epic <uuid>] [--dry-run]');
  if (!args.epicId) throw new Error('no epic id: pass --epic <uuid> or set AUDIT_EPIC_ID');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = new PlaneClient({ apiKey: readApiKey() });

  const labels = await client.listLabels();
  const label = labels.find((l) => l.name === EPIC_LABEL);
  if (!label) throw new Error(`label "${EPIC_LABEL}" does not exist; run the bootstrap step first`);

  const doc = store.load(args.findings);
  const result = await reconcile({
    doc,
    client,
    epicId: args.epicId,
    labelIds: [label.id],
    dryRun: args.dryRun,
  });

  if (!args.dryRun) store.save(args.findings, doc);

  console.log(JSON.stringify({
    dryRun: args.dryRun,
    created: result.created.length,
    updated: result.updated.length,
    closed: result.closed.length,
    skipped: result.skipped.length,
    total: doc.findings.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
