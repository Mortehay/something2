#!/usr/bin/env node
// SOMET-552. Write a description for every subject that still needs one.
//
// Slice 3 of docs/superpowers/specs/2026-09-05-llm-authored-art-prompts-plan.md.
// Slice 1 proved the contract (subjectDescriber.js), slice 2 made a stored
// description reach the prompt (artPromptDescriptions.js); this is the pass
// that writes them at catalogue scale -- 530 subjects missing art, of which
// 428 are skills and passive labels.
//
// RESUMABLE WITH NO CURSOR OF ITS OWN. The database IS the progress: a subject
// with an active description is skipped. So the pass can be killed at any
// point -- and it will be, since it runs for hours on CPU -- and re-running it
// continues rather than restarting. A separate progress file would be a second
// thing to get out of sync with the only thing that matters, which is which
// rows exist.
//
// SEQUENTIAL ON PURPOSE. ollama serves one model on one runner, so two
// concurrent requests queue behind each other and only make the per-request
// timeout more likely to fire. The parallelism that matters is against the GPU
// box: this is CPU work and can run while a batch generates images.
//
// IT STOPS ITSELF IF THE MODEL IS GONE. A run over 530 subjects with the
// describer down would otherwise spend an hour writing 530 identical failures
// into the log and finish looking like it had tried. Five consecutive failures
// end the run with the last error, which is the same rule (and the same
// reason) as artDispatcher's circuit breaker.

const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const { listWithArtState } = require('../src/services/catalogSubjects.js');
const descriptions = require('../src/services/artPromptDescriptions.js');
const { describeSubject, LENGTHS, MODEL } = require('../src/services/subjectDescriber.js');

// The three kinds the describer has a contract for, and the three that have
// subjects missing art. Tiles and entities are deliberately out of scope --
// both are fully covered already, and a tile's prompt is a biome texture
// description that this contract would ruin.
const DEFAULT_KINDS = ['item', 'skill', 'passive_label'];

const CONSECUTIVE_FAILURE_LIMIT = 5;

// Which subjects this run should write a description for, and why each one was
// skipped. Pure, so the selection rules can be tested without a model, a
// database or an hour.
//
// The ORDER of these checks is the behaviour. `redo` beats everything (an
// explicit "write them all again"); a subject that already has ART is left
// alone unless asked for, because regenerating art that exists is out of scope
// for this feature and re-describing it would silently change what a later
// regeneration produces; then a fresh description means done, and a STALE one
// is a candidate only when asked for by --stale.
function selectSubjects(subjects, active, {
  redo = false, includeStale = false, withArt = false, limit = 0,
} = {}) {
  const todo = [];
  const skipped = {
    hasArt: 0, described: 0, stale: 0, noPrompt: 0,
  };
  for (const s of subjects) {
    if (!s.basePrompt) { skipped.noPrompt += 1; continue; }
    const current = active.get(s.key) || null;
    const stale = descriptions.isStale(current, s.basePrompt);
    if (!redo) {
      if (s.hasArt && !withArt) { skipped.hasArt += 1; continue; }
      if (current && !stale) { skipped.described += 1; continue; }
      if (current && stale && !includeStale) { skipped.stale += 1; continue; }
    }
    todo.push({ ...s, stale, replacing: current });
    if (limit && todo.length >= limit) break;
  }
  return { todo, skipped };
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// `describe` is injectable for one reason: the loop around it -- what gets
// skipped, what counts as written, when the run gives up -- is the part that
// can be wrong for hours without anyone noticing, and testing it through a
// real 7B model on CPU would make the test take longer than the feature.
async function describeAll(pool, {
  kinds = DEFAULT_KINDS, length = 'medium', dryRun = false, log = console.log,
  describe = describeSubject, ...select
} = {}) {
  const stats = {
    written: 0, failed: 0, skipped: { hasArt: 0, described: 0, stale: 0, noPrompt: 0 }, elapsedMs: 0,
  };
  const started = Date.now();
  let consecutiveFailures = 0;
  let lastError = null;
  let remainingLimit = select.limit || 0;

  for (const kind of kinds) {
    // eslint-disable-next-line no-await-in-loop
    const [subjects, active] = await Promise.all([
      listWithArtState(pool, kind), descriptions.listActive(pool, kind),
    ]);
    const { todo, skipped } = selectSubjects(subjects, active, {
      ...select, limit: select.limit ? remainingLimit : 0,
    });
    for (const k of Object.keys(skipped)) stats.skipped[k] += skipped[k];
    log(`${kind}: ${subjects.length} subjects, ${todo.length} to describe`
      + ` (${skipped.hasArt} have art, ${skipped.described} described,`
      + ` ${skipped.stale} stale but not asked for)`);

    for (const subject of todo) {
      const at = Date.now();
      let written = null;
      try {
        // eslint-disable-next-line no-await-in-loop
        const out = await describe(subject, { length });
        if (!dryRun) {
          // eslint-disable-next-line no-await-in-loop
          written = await descriptions.replace(pool, kind, subject.key, {
            text: out.text,
            length: out.length,
            model: out.model,
            // The whole point of slice 3's extra column: what the catalogue
            // said at the moment this description was written.
            sourcePrompt: subject.basePrompt,
          });
        }
        // A description the store refused (empty after trimming) must not be
        // counted as written -- that is how a run reports 530 successes and
        // leaves 530 subjects still on the template.
        if (!dryRun && !written) {
          stats.failed += 1;
          consecutiveFailures += 1;
          log(`  REFUSED ${subject.key}: nothing storable came back`);
        } else {
          stats.written += 1;
          consecutiveFailures = 0;
          log(`  ${dryRun ? '[dry] ' : ''}${subject.key}`
            + `${subject.stale ? ' [was stale]' : ''}\n`
            + `      template: ${subject.basePrompt}\n`
            + `      written:  ${out.text}`
            + `   (${fmtDuration(Date.now() - at)})`);
        }
      } catch (err) {
        stats.failed += 1;
        consecutiveFailures += 1;
        lastError = err;
        log(`  FAILED ${subject.key}: ${err.message}`);
        if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
          stats.elapsedMs = Date.now() - started;
          stats.abortedAfter = consecutiveFailures;
          stats.lastError = err.message;
          return stats;
        }
      }
      if (select.limit) {
        remainingLimit -= 1;
        if (remainingLimit <= 0) { stats.elapsedMs = Date.now() - started; return stats; }
      }
    }
  }
  stats.elapsedMs = Date.now() - started;
  if (lastError) stats.lastError = lastError.message;
  return stats;
}

module.exports = { describeAll, selectSubjects, DEFAULT_KINDS, CONSECUTIVE_FAILURE_LIMIT };

function flagValue(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

if (require.main === module) {
  const env = dotenv.config({ path: path.resolve(__dirname, '../../.env') }).parsed || {};
  const url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }

  const length = flagValue('length', 'medium');
  if (!LENGTHS[length]) {
    console.error(`unknown length "${length}" -- one of ${Object.keys(LENGTHS).join(', ')}`);
    process.exit(1);
  }
  const kinds = flagValue('kind', DEFAULT_KINDS.join(',')).split(',').map((k) => k.trim());
  const opts = {
    kinds,
    length,
    dryRun: process.argv.includes('--dry-run'),
    redo: process.argv.includes('--redo'),
    includeStale: process.argv.includes('--stale'),
    withArt: process.argv.includes('--with-art'),
    limit: parseInt(flagValue('limit', '0'), 10) || 0,
  };

  const pool = new Pool({ connectionString: url });
  console.log(`describing with ${MODEL()} at ${length} length`
    + `${opts.dryRun ? ' [DRY RUN -- nothing is stored]' : ''}`);
  describeAll(pool, opts)
    .then((s) => {
      const each = s.written ? ` (${fmtDuration(s.elapsedMs / s.written)} each)` : '';
      console.log(`\nwrote ${s.written}, failed ${s.failed}, in ${fmtDuration(s.elapsedMs)}${each}`);
      console.log(`skipped: ${s.skipped.hasArt} have art, ${s.skipped.described} already `
        + `described, ${s.skipped.stale} stale, ${s.skipped.noPrompt} have no subject at all`);
      if (s.abortedAfter) {
        console.error(`\nABORTED after ${s.abortedAfter} consecutive failures: ${s.lastError}`);
        console.error('Nothing written is lost -- re-run to continue from where this stopped.');
      }
      if (s.failed) process.exitCode = 1;
    })
    .catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
