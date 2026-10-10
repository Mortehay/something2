// backend/tests/audio_sfx_dedupe_drain_db.test.js
//
// SOMET-592 (I1), through the real drain: the box's `cached` flag is about
// the box's own cache -- shared by every database on the box -- not about
// this database. Two cases the old "cached = refuse, not retryable" rule
// turned into permanent failures:
//   1. a drain killed mid-pack (nodemon reload, timeout): requeueOrphans
//      re-sends the same entity text, the box answers `cached` with a file we
//      never stored -- it must be stored and bound;
//   2. a true duplicate (bytes equal to a clip already bound to the slot) --
//      the job stays retryable, is not a breaker fault, and its retry sends a
//      later take.
// Real queue, dispatcher, generation and library against the scratch DB;
// only the box (rap.generateSfxPack) and the object store are faked. Every
// row this file writes is its own and removed in t.after.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { withAdvisoryLock, AUDIO_JOBS_LOCK_KEY, AUDIO_CLIPS_LOCK_KEY } = require('./helpers/advisoryLock.js');
const assetStore = require('../src/services/assetStore');
const lib = require('../src/services/audioLibrary');
const gen = require('../src/services/audioGeneration');
const q = require('../src/services/audioJobQueue');
const d = require('../src/services/audioDispatcher');
const prompts = require('../src/services/audioPrompts');

const { promptPhaseStub } = require('./helpers/audioPromptPhaseStub.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;
const OGG = fs.readFileSync(path.join(__dirname, 'fixtures/audio/tone.ogg'));
const variant = (n) => Buffer.concat([OGG, Buffer.from([n])]);
// Real, read-only skill ids (seeds/data/skills.js), used by no other audio
// test file: melee skills, so use -> 'slash' and hit -> 'hit'.
const SKILL = 'war_skull_splitter';

// The entity text a slot sends: its stored prompt when it has one (spec
// 2026-09-30 §6), else the registry phrase. Read at test time, because a
// batch run (make audio-describe) may have written prompts for these fixed
// subjects on the scratch DB -- hard-coding the registry phrase made this
// file green on a fresh DB and red on a used one.
async function phraseOf(pool, kind, key, slot, registry) {
  const p = await prompts.getActive(pool, kind, key, slot);
  return p && p.text ? p.text : registry;
}

async function waitIdle(timeoutMs = 10000) {
  const t0 = Date.now();
  while (d.runStatus().running) {
    if (Date.now() - t0 > timeoutMs) { d.stopDrain(); throw new Error('drain did not finish'); }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 20); });
  }
  return d.runStatus();
}

test('sfx drain: cached is not a duplicate; a duplicate is retryable', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const jobIds = [];
  const clipIds = [];
  const bindingIds = [];
  t.after(async () => {
    try {
      if (jobIds.length) await pool.query('DELETE FROM audio_jobs WHERE id = ANY($1)', [jobIds]);
      if (bindingIds.length) await pool.query('DELETE FROM audio_bindings WHERE id = ANY($1)', [bindingIds]);
      if (clipIds.length) await pool.query('DELETE FROM audio_clips WHERE id = ANY($1)', [clipIds]);
    } finally { d.__resetRun(); await pool.end(); }
  });

  await withAdvisoryLock(pool, AUDIO_JOBS_LOCK_KEY, () => withAdvisoryLock(pool, AUDIO_CLIPS_LOCK_KEY, async () => {
    // A drain claims ANY queued job: park foreign ones for the duration,
    // restoring their exact not_before afterwards (same as
    // audio_dispatcher_db.test.js).
    const foreign = (await pool.query(
      `SELECT id, not_before FROM audio_jobs
        WHERE state = 'queued' AND (not_before IS NULL OR not_before <= now())`)).rows;
    if (foreign.length) {
      await pool.query(`UPDATE audio_jobs SET not_before = now() + interval '1 hour' WHERE id = ANY($1)`,
        [foreign.map((r) => r.id)]);
    }
    assetStore.__setAssetClient({ bucketExists: async () => true, putObject: async () => {} });
    const prevBase = process.env.AUDIO_JOB_RETRY_BASE_MS;
    process.env.AUDIO_JOB_RETRY_BASE_MS = '1';
    try {
      const provider = {
        id: null, base_url: 'http://x', modality: 'audio', models_cache: ['cue:slash', 'cue:hit'],
      };
      const packCalls = [];
      const depsFor = (answer) => ({
        resolveAudioProvider: async () => provider,
        sleep: async () => {},
        // No prompt is written and no model switch reaches a box (the phases
        // are tested in audio_two_phase_drain_db.test.js): the entity text
        // stays the slot's stored prompt or registry phrase, as phraseOf reads.
        ...promptPhaseStub,
        generateSfxPackForJobs: (db, p, jobs, opts) => gen.generateSfxPackForJobs(db, p, jobs, {
          ...opts,
          lib,
          rap: {
            generateSfxPack: async (prov, body) => {
              packCalls.push(body.items.map((it) => it.entity));
              return {
                ok: true,
                items: body.items.map((it) => ({
                  ok: true, cue: it.cue, entity: it.entity, clips: [{ buffer: answer(packCalls.length, it), durationMs: 500 }], prompt: 'p', seed: 1, cached: true,
                })),
              };
            },
          },
        }),
      });
      const boundTo = async (slot) => (await pool.query(
        `SELECT b.id AS binding_id, c.id AS clip_id, c.sha1, c.label FROM audio_bindings b JOIN audio_clips c ON c.id = b.clip_id
          WHERE b.subject_kind = 'skill' AND b.subject_key = $1 AND b.slot = $2`, [SKILL, slot])).rows;

      await t.test('a re-sent pack after an interrupted drain stores the box\'s cached file and completes', async () => {
        d.__resetRun();
        const { queued: [job] } = await q.enqueue(pool, [{
          subject_kind: 'skill', subject_key: SKILL, slot: 'hit', clip_kind: 'sfx', engine: 'realistic',
        }], {});
        jobIds.push(job.id);
        // The drain that died: it claimed the job (and the box rendered the
        // pack), but nothing was stored.
        const claimed = await q.claimBatch(pool, 12);
        assert.deepEqual(claimed.map((r) => String(r.id)), [String(job.id)]);

        packCalls.length = 0;
        d.startDrain(pool, { deps: depsFor(() => variant(40)) });
        const st = await waitIdle();
        assert.equal(st.requeued_orphans, 1);
        assert.equal(st.done, 1, st.error);
        assert.equal(st.failed, 0);
        assert.deepEqual(packCalls, [[await phraseOf(pool, 'skill', SKILL, 'hit', 'Skull Splitter')]]);
        const row = (await pool.query('SELECT state, clip_id FROM audio_jobs WHERE id = $1', [job.id])).rows[0];
        assert.equal(row.state, 'done');
        const bound = await boundTo('hit');
        for (const b of bound) { bindingIds.push(b.binding_id); clipIds.push(b.clip_id); }
        assert.equal(bound.length, 1);
        assert.equal(bound[0].sha1, lib.sha1Of(variant(40)));
        assert.equal(bound[0].clip_id, row.clip_id);
      });

      // SOMET-605: the pack path checks each job's subject WITH its slot.
      await t.test('the pack path asks subjectExists with each job\'s slot', async () => {
        d.__resetRun();
        const { queued: [job] } = await q.enqueue(pool, [{
          subject_kind: 'skill', subject_key: SKILL, slot: 'hit', clip_kind: 'sfx', engine: 'realistic',
        }], {});
        jobIds.push(job.id);
        const asked = [];
        d.startDrain(pool, {
          deps: {
            ...depsFor(() => variant(60)),
            subjectExists: async (db, kind, key, slot) => { asked.push([kind, key, slot]); return true; },
          },
        });
        let st;
        try {
          st = await waitIdle();
        } finally {
          // Register cleanup before asserting (and even if waitIdle throws).
          for (const b of await boundTo('hit')) { bindingIds.push(b.binding_id); clipIds.push(b.clip_id); }
        }
        assert.equal(st.done, 1, st.error);
        assert.deepEqual(asked, [['skill', SKILL, 'hit']]);
      });

      await t.test('a true duplicate is retried with a later take and never trips the breaker', async () => {
        d.__resetRun();
        const own = await lib.storeClip(pool, {
          buffer: variant(50), kind: 'sfx', label: 'already here', source: 'uploaded', durationMs: 500,
        });
        clipIds.push(own.id);
        const b = await lib.bindClip(pool, {
          subjectKind: 'skill', subjectKey: SKILL, slot: 'use', clipId: own.id,
        });
        bindingIds.push(b.id);
        const { queued: [job] } = await q.enqueue(pool, [{
          subject_kind: 'skill', subject_key: SKILL, slot: 'use', clip_kind: 'sfx', engine: 'realistic',
        }], {});
        jobIds.push(job.id);

        packCalls.length = 0;
        // The first answer is byte-identical to the bound clip; the next is new.
        d.startDrain(pool, { deps: depsFor((n) => (n === 1 ? variant(50) : variant(51))) });
        const st = await waitIdle();
        assert.equal(st.stopped_reason, 'empty', 'not the breaker');
        assert.equal(st.done, 1, st.error);
        assert.equal(st.retried, 1);
        assert.equal(st.failed, 0);
        const useText = await phraseOf(pool, 'skill', SKILL, 'use', 'Skull Splitter');
        assert.deepEqual(packCalls, [[`${useText} (take 1)`], [`${useText} (take 2)`]],
          'the retry moves past the duplicated take');
        const row = (await pool.query('SELECT state, attempts FROM audio_jobs WHERE id = $1', [job.id])).rows[0];
        assert.deepEqual([row.state, row.attempts], ['done', 2]);
        const bound = await boundTo('use');
        for (const x of bound) if (x.clip_id !== own.id) { bindingIds.push(x.binding_id); clipIds.push(x.clip_id); }
        assert.deepEqual(bound.map((x) => x.sha1).sort(), [lib.sha1Of(variant(50)), lib.sha1Of(variant(51))].sort(),
          'the duplicate was not stored twice');
      });
    } finally {
      if (prevBase === undefined) delete process.env.AUDIO_JOB_RETRY_BASE_MS; else process.env.AUDIO_JOB_RETRY_BASE_MS = prevBase;
      if (foreign.length) {
        for (const r of foreign) {
          // eslint-disable-next-line no-await-in-loop
          await pool.query('UPDATE audio_jobs SET not_before = $2 WHERE id = $1', [r.id, r.not_before]);
        }
      }
    }
  }));
});
