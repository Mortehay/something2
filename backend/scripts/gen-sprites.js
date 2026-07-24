#!/usr/bin/env node
const path = require('node:path');
const { loadManifest, selectEntities, loadLock, saveLock } = require('./lib/spriteManifest.js');
const { createClient } = require('./lib/spriteRunnerClient.js');
const { runGeneration } = require('./lib/spriteRunner.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const opts = { only: null, force: false, dryRun: false,
    manifest: path.join(REPO_ROOT, 'sprites.manifest.json'),
    lock: path.join(REPO_ROOT, 'sprites.manifest.lock.json') };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--force') opts.force = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--only') opts.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--manifest') opts.manifest = path.resolve(argv[++i]);
    else if (a === '--lock') opts.lock = path.resolve(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

function printReport(report) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\n${pad('ENTITY', 16)}${pad('KIND', 10)}${pad('STATUS', 12)}ATLAS / ERROR`);
  for (const r of report) {
    const tail = r.status === 'failed' ? (r.error || '') : (r.atlasKey || '');
    console.log(`${pad(r.name, 16)}${pad(r.kind, 10)}${pad(r.status, 12)}${tail}`);
  }
  const approvable = report.filter((r) => (
    (r.status === 'generated' || r.status === 'skipped')
    && r.entityTypeId != null
    && r.atlasKey != null && r.manifestKey != null && r.jobId != null
  ));
  if (approvable.length) {
    console.log('\nApprove these onto their entity types (admin token required):');
    for (const r of approvable) {
      const payload = JSON.stringify({
        atlas_key: r.atlasKey, manifest_key: r.manifestKey, job_id: r.jobId, animated: true, frames: 1,
      });
      console.log(`  curl -sS -X POST "$SOMETHING2_API_URL/api/entity-types/${r.entityTypeId}/sprite" \\`);
      console.log(`    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\`);
      console.log(`    -d '${payload}'`);
    }
  }
  const heroes = report.filter((r) => r.status === 'generated' && r.entityTypeId == null);
  if (heroes.length) {
    console.log(`\nGenerated (no entity_types row; awaiting the hero picker, Slice 3): ${heroes.map((r) => r.name).join(', ')}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const baseUrl = process.env.SOMETHING2_API_URL || 'http://localhost:3101';
  const manifest = loadManifest(opts.manifest);
  const lock = loadLock(opts.lock);
  const entities = selectEntities(manifest, { only: opts.only });
  if (entities.length === 0) throw new Error('no entities selected (check --only names)');

  const client = createClient({ baseUrl });
  let token = null;
  let nameToId = {};
  if (!opts.dryRun) {
    token = await client.login(requireEnv('SOMETHING2_ADMIN_USER'), requireEnv('SOMETHING2_ADMIN_PASSWORD'));
    const types = await client.listEntityTypes(token);
    nameToId = Object.fromEntries(types.map((t) => [t.name, t.id]));
  }

  console.log(`Running ${entities.length} entit${entities.length === 1 ? 'y' : 'ies'} against ${baseUrl}${opts.dryRun ? ' (dry-run)' : ''}...`);
  const { report, lock: nextLock } = await runGeneration({
    entities, defaults: manifest.defaults, lock, client, token, nameToId,
    force: opts.force, dryRun: opts.dryRun,
    poll: { intervalMs: 5000, timeoutMs: 30 * 60 * 1000 },
  });
  if (!opts.dryRun) saveLock(opts.lock, nextLock);
  printReport(report);
  if (report.some((r) => r.status === 'failed')) process.exitCode = 1;
}

main().catch((err) => { console.error(`gen-sprites: ${err.message}`); process.exitCode = 1; });
