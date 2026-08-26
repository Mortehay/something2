#!/usr/bin/env node
//
// Bulk re-generation of the STATIC catalog art -- every tile texture and every
// entity object image -- through the registered AI providers.
//
// WHY A SCRIPT AND NOT THE ADMIN UI: the panels generate one subject at a
// time and each image takes ~1-2 minutes on the remote box. 244 of them by
// hand is not a task a person should be given.
//
// SPRITES ARE OUT OF SCOPE, DELIBERATELY AND STRICTLY:
//   * every job is frames = 1, so the remote is never asked for a sheet;
//   * the `sprite` column is never read and never written -- not even set to
//     NULL, which is what the approve ROUTES do (see index.js
//     tile-types/:id/image). Clearing it there is right for an interactive
//     approve; here it would be this script silently deleting animation work;
//   * sprite_sets rows are not written either. That table is generation
//     history for the admin panels, and a bulk run has its own log (--log).
//
// It reuses the real services (providerDiscovery auth, remoteImageProvider
// generation, generationTarget resolution) rather than re-implementing them,
// so a row generated here is byte-identical in treatment to one generated
// from the admin panel.
//
// Usage:
//   node scripts/regenerate-catalog-images.js --kind=tiles --dry-run
//   node scripts/regenerate-catalog-images.js --kind=both
//   node scripts/regenerate-catalog-images.js --kind=entities --only=Wolf,Goblin
//   node scripts/regenerate-catalog-images.js --kind=entities --include-rect
//
// Flags:
//   --kind=tiles|entities|both   what to regenerate            (default both)
//   --only=a,b,c                 restrict to these names
//   --limit=N                    stop after N subjects
//   --dry-run                    resolve and print the plan, generate nothing
//   --include-rect               ALSO generate for entity types currently
//                                rendered as plain colour boxes, promoting
//                                them to render_mode 'static'. Off by default:
//                                that is new art for something that never had
//                                any, not a re-generation, and it changes how
//                                114 types look in game.
//   --provider-for-default=N     provider to use for types pinned to 'default'
//                                when no provider is ACTIVE. Without it those
//                                types resolve to local sprite-gen and are
//                                skipped. This is a per-run choice on purpose:
//                                activating a provider globally would change
//                                what every future generation does, which is a
//                                bigger decision than one batch.
//   --seed=N                     BASE seed (default 0). Each subject gets its
//                                own seed derived from this plus its name, so a
//                                batch does not come back as 50 variations of
//                                one composition. Change it for a fresh set.
//   --same-seed                  send --seed verbatim to EVERY subject. Only for
//                                A/B work where the seed must be held constant;
//                                it makes a whole catalog look alike.
//   --retries=N                  attempts per subject            (default 2)
//   --give-up-after=N            abort after N consecutive failures (default 5)
//   --log=PATH                   JSONL progress log         (default ./regen-log.jsonl)
//   --resume                     skip subjects already marked done in --log

const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');

const aiProviders = require('../src/services/aiProviders');
// The rules -- what is in scope, how a provider is resolved, what SQL a
// finished image writes -- live in the service the admin buttons also call.
// This file is the CLI around them: flags, a resumable log, and an ETA.
const bulk = require('../src/services/bulkImageRegeneration');

function parseArgs(argv) {
  const args = {
    kind: 'both', only: null, limit: Infinity, dryRun: false, includeRect: false,
    seed: 0, sameSeed: false, retries: 2, giveUpAfter: 5, log: 'regen-log.jsonl', resume: false,
    providerForDefault: null,
  };
  for (const raw of argv.slice(2)) {
    const [key, value] = raw.replace(/^--/, '').split('=');
    switch (key) {
      case 'kind': args.kind = value; break;
      case 'only': args.only = new Set(value.split(',').map(s => s.trim()).filter(Boolean)); break;
      case 'limit': args.limit = Number(value); break;
      case 'dry-run': args.dryRun = true; break;
      case 'include-rect': args.includeRect = true; break;
      case 'seed': args.seed = Number(value) || 0; break;
      case 'retries': args.retries = Number(value); break;
      case 'give-up-after': args.giveUpAfter = Number(value); break;
      case 'log': args.log = value; break;
      case 'resume': args.resume = true; break;
      case 'same-seed': args.sameSeed = true; break;
      case 'provider-for-default': args.providerForDefault = Number(value); break;
      default: throw new Error(`unknown flag --${key}`);
    }
  }
  if (!['tiles', 'entities', 'both'].includes(args.kind)) {
    throw new Error('--kind must be tiles, entities or both');
  }
  return args;
}

// One line per subject, appended as it finishes. Written synchronously: a run
// this long WILL be interrupted at some point, and a buffered log that loses
// the last hour of results would make --resume worse than useless.
function makeLogger(file) {
  const abs = path.resolve(file);
  return {
    path: abs,
    append(record) {
      fs.appendFileSync(abs, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
    },
    // Only 'done' counts as already-handled. A subject logged as failed is
    // retried by the next run, which is the point of resuming at all.
    doneKeys() {
      if (!fs.existsSync(abs)) return new Set();
      const keys = new Set();
      for (const line of fs.readFileSync(abs, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (rec.status === 'done') keys.add(`${rec.table}:${rec.id}`);
        } catch (_) { /* a torn last line from a kill -9 is not fatal */ }
      }
      return keys;
    },
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const log = makeLogger(args.log);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const alreadyDone = args.resume ? log.doneKeys() : new Set();

  // Providers are loaded once, not per subject: each load carries a secret and
  // there are only ever a handful of them.
  const providerCache = new Map();
  const loadProvider = async (id) => {
    if (!providerCache.has(id)) {
      providerCache.set(id, await aiProviders.loadProviderWithSecret(pool, id));
    }
    return providerCache.get(id);
  };

  const planned = await bulk.planRun(pool, {
    kind: args.kind,
    includeRect: args.includeRect,
    only: args.only,
    providerForDefault: args.providerForDefault,
  });
  const fresh = s => !alreadyDone.has(`${s.table}:${s.id}`);
  const skipped = planned.skipped.filter(fresh);
  const work = planned.work.filter(fresh).slice(0, args.limit);
  const total = planned.work.length + planned.skipped.length;

  console.log(`subjects: ${total} | already done (resumed): ${total - work.length - skipped.length} | `
    + `to generate: ${work.length} | no AI provider (skipped): ${skipped.length}`);
  for (const [id, group] of groupBy(work, s => s.providerId)) {
    const provider = await loadProvider(id);
    console.log(`  provider ${id} "${provider.name}" model=${provider.model} -> ${group.length} subjects`);
  }
  if (skipped.length) {
    console.log(`  skipped (resolve to local sprite-gen): ${skipped.map(s => s.name).join(', ')}`);
  }
  if (args.dryRun) {
    console.log('\n--dry-run: nothing generated.');
    await pool.end();
    return;
  }

  let done = 0; let failed = 0; let consecutiveFailures = 0;
  const startedAt = Date.now();

  for (const [index, subject] of work.entries()) {
    const provider = await loadProvider(subject.providerId);
    let result = null;
    for (let attempt = 1; attempt <= args.retries; attempt += 1) {
      const t0 = Date.now();
      result = await bulk.regenerateSubject(pool, subject, provider,
        { seed: args.seed, sameSeed: args.sameSeed });
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (result.ok) {
        done += 1;
        consecutiveFailures = 0;
        const elapsed = (Date.now() - startedAt) / 1000;
        const eta = ((elapsed / (index + 1)) * (work.length - index - 1) / 60).toFixed(0);
        console.log(`[${index + 1}/${work.length}] ${subject.table} ${subject.name} `
          + `ok in ${secs}s -> ${result.imageKey}  (eta ~${eta}m)`);
        log.append({
          status: 'done', table: subject.table, id: subject.id, name: subject.name,
          provider_id: subject.providerId, model: provider.model,
          image_key: result.imageKey, seed: result.seed, seconds: Number(secs),
        });
        break;
      }
      console.log(`[${index + 1}/${work.length}] ${subject.table} ${subject.name} `
        + `attempt ${attempt}/${args.retries} FAILED after ${secs}s: ${result.error}`);
    }
    if (!result.ok) {
      failed += 1;
      consecutiveFailures += 1;
      log.append({
        status: 'failed', table: subject.table, id: subject.id, name: subject.name,
        provider_id: subject.providerId, error: result.error,
      });
      // A remote box that has gone away fails every remaining subject the same
      // way. Stopping keeps the log readable and the run resumable instead of
      // burning through 200 identical timeouts.
      if (consecutiveFailures >= args.giveUpAfter) {
        console.error(`\nABORTING: ${consecutiveFailures} consecutive failures. `
          + `Fix the provider and re-run with --resume.`);
        break;
      }
    }
  }

  const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
  console.log(`\ndone: ${done}  failed: ${failed}  in ${mins}m  (log: ${log.path})`);
  await pool.end();
  process.exitCode = failed > 0 ? 1 : 0;
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
