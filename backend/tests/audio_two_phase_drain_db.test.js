// backend/tests/audio_two_phase_drain_db.test.js
//
// The phased drain (plan 2026-10-03, Task 2). The GPU box holds ONE model at
// a time, so the drain writes every pending prompt with the text model, then
// switches to each audio group's model and generates -- never interleaving
// the two. Every fake below RECORDS its call into one ordered list, and the
// cases assert on that list, so an interleaving (or a propose) shows up as a
// wrong sequence rather than slipping past a fake that answers regardless.
//
// Real queue, dispatcher, prompt writer (audioPromptWriter + audioPrompts)
// and generateForSlot against the scratch DB. Faked: the box (switch,
// generate, sfx-pack), the text model (tp.complete), the style list, the
// clip store and the sleep. Worlds are inserted per run with a tagged name,
// so the writer's real catalog lookup finds them; every row this file writes
// is removed in t.after.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { withAdvisoryLock, AUDIO_JOBS_LOCK_KEY } = require('./helpers/advisoryLock.js');
const q = require('../src/services/audioJobQueue');
const d = require('../src/services/audioDispatcher');
const gen = require('../src/services/audioGeneration');
const prompts = require('../src/services/audioPrompts');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;
const OGG = fs.readFileSync(path.join(__dirname, 'fixtures/audio/tone.ogg'));
const BRAIN = 'brain:qwen3.6-35b-a3b';
const ACE = 'audio:ace-step';
const NO_TEXT = 'no text provider — add one under AI Providers';

async function waitIdle(timeoutMs = 10000) {
  const t0 = Date.now();
  while (d.runStatus().running) {
    if (Date.now() - t0 > timeoutMs) { d.stopDrain(); throw new Error('drain did not finish'); }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 20); });
  }
  return d.runStatus();
}

test('audio drain in phases', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const tag = `phase-${process.pid}-${Date.now()}`;
  const worldIds = [];
  t.after(async () => {
    try {
      await pool.query('DELETE FROM audio_jobs WHERE subject_key LIKE $1', [`${tag}%`]);
      await pool.query('DELETE FROM audio_prompts WHERE subject_key LIKE $1', [`${tag}%`]);
      if (worldIds.length) await pool.query('DELETE FROM worlds WHERE id = ANY($1)', [worldIds]);
    } finally { d.__resetRun(); await pool.end(); }
  });

  const world = async (suffix) => {
    const name = `${tag}-${suffix}`;
    worldIds.push((await pool.query('INSERT INTO worlds (name, seed) VALUES ($1, 1) RETURNING id', [name])).rows[0].id);
    return name;
  };
  const music = (key, extra = {}) => ({
    subject_kind: 'world', subject_key: key, slot: 'music', clip_kind: 'music', ...extra,
  });
  const jobOf = async (key, slot = 'music') => (await pool.query(
    `SELECT state, attempts, needs_prompt, force_prompt, prompt_only, last_error FROM audio_jobs
      WHERE subject_key = $1 AND slot = $2 ORDER BY id DESC LIMIT 1`, [key, slot])).rows[0];

  await withAdvisoryLock(pool, AUDIO_JOBS_LOCK_KEY, async () => {
    // A drain claims ANY queued job: park foreign ones for the duration and
    // put their exact not_before back afterwards (same as the dispatcher test).
    const foreign = (await pool.query(
      `SELECT id, not_before FROM audio_jobs
        WHERE state = 'queued' AND (not_before IS NULL OR not_before <= now())
          AND subject_key NOT LIKE $1`, [`${tag}%`])).rows;
    if (foreign.length) {
      await pool.query(`UPDATE audio_jobs SET not_before = now() + interval '1 hour' WHERE id = ANY($1)`,
        [foreign.map((r) => r.id)]);
    }

    // One recorder for the whole box + text model, reset per case.
    const calls = [];
    let written = 0;
    const provider = {
      id: null, base_url: 'http://box.invalid', modality: 'audio', models_cache: ['cue:hit', 'cue:death'],
    };
    const textProvider = { id: null, modality: 'text', model: 'qwen3.6-35b-a3b', base_url: 'http://box.invalid' };
    const fakeLib = {
      bindClip: async () => ({}),
      storeAndBindClip: async () => ({ clip: { id: null }, binding: { id: null } }),
    };
    const rap = {
      propose: async () => { calls.push('propose'); throw new Error('propose must not be called'); },
      generateTrack: async (p, body) => {
        calls.push(`generate:${body.prompt}`);
        return {
          ok: true, buffer: OGG, durationMs: 2000, loopStartMs: 0, loopEndMs: 2000, prompt: body.prompt, seed: body.seed,
        };
      },
    };
    const tp = {
      complete: async (db, req, opts) => {
        calls.push(opts && opts.boxOnly === true ? 'text' : 'text-NOT-boxOnly');
        written += 1;
        return {
          ok: true, json: { style: 'medieval_fantasy', prompt: `written ${tag} ${written}` }, model: 'qwen3.6-35b-a3b', via: 'box',
        };
      },
    };
    const okSwitch = async (p, model) => { calls.push(`switch:${model}`); return { ok: true, json: {} }; };
    const depsWith = (over = {}) => ({
      resolveAudioProvider: async () => provider,
      subjectExists: async () => true,
      sleep: async () => {},
      switchModel: okSwitch,
      loadTextProvider: async () => textProvider,
      tp,
      loadStyles: async () => ({ music: ['medieval_fantasy'], ambience: ['forest'] }),
      generateForSlot: (db, p, spec) => gen.generateForSlot(db, p, spec, { rap, lib: fakeLib }),
      ...over,
    });
    const reset = () => { d.__resetRun(); calls.length = 0; };

    try {
      await t.test('enqueue decides needs_prompt from the item and the stored prompt', async () => {
        const [none, stored, cleared, own, forced, only] = await Promise.all(
          ['nq-none', 'nq-stored', 'nq-cleared', 'nq-own', 'nq-forced', 'nq-only'].map(world),
        );
        await prompts.save(pool, 'world', stored, 'music', { style: 'village', text: 'kept' });
        await prompts.save(pool, 'world', cleared, 'music', { style: null, text: '' });
        await prompts.save(pool, 'world', forced, 'music', { style: 'village', text: 'hand written' });
        await prompts.save(pool, 'world', only, 'music', { style: 'village', text: 'already there' });
        const r = await q.enqueue(pool, [
          music(none), music(stored), music(cleared), music(own, { prompt: 'typed' }),
          music(forced, { force_prompt: true }), music(only, { prompt_only: true }),
        ]);
        const by = Object.fromEntries(r.queued.map((j) => [j.subject_key, [j.needs_prompt, j.force_prompt, j.prompt_only, j.state]]));
        assert.deepEqual(by, {
          [none]: [true, false, false, 'queued'],
          [stored]: [false, false, false, 'queued'],
          [cleared]: [true, false, false, 'queued'],
          [own]: [false, false, false, 'queued'],
          [forced]: [true, true, false, 'queued'],
          [only]: [false, false, true, 'done'],
        });
        // The prompt JOIN must not reorder the inserts: the drain claims and
        // packs by id, so ids follow the items' order.
        const byId = [...r.queued].sort((a, b) => Number(a.id) - Number(b.id)).map((j) => j.subject_key);
        assert.deepEqual(byId, [none, stored, cleared, own, forced, only]);
        await pool.query('DELETE FROM audio_jobs WHERE subject_key LIKE $1', [`${tag}-nq-%`]);
      });

      await t.test('(a) prompts first under the text model, then one switch and every generate -- never interleaved, no propose', async () => {
        reset();
        const keys = await Promise.all(['a1', 'a2', 'a3', 'a4', 'a5'].map(world));
        await prompts.save(pool, 'world', keys[3], 'music', { style: 'village', text: 'stored four' });
        await prompts.save(pool, 'world', keys[4], 'music', { style: 'village', text: 'stored five' });
        await q.enqueue(pool, keys.map((k) => music(k)));
        d.startDrain(pool, { deps: depsWith() });
        const s = await waitIdle();
        assert.equal(s.stopped_reason, 'empty', s.error);
        assert.equal(s.failed, 0, s.error);
        assert.equal(s.done, 5);
        assert.deepEqual(calls.map((c) => c.replace(/^generate:.*/, 'generate')), [
          `switch:${BRAIN}`, 'text', 'text', 'text',
          `switch:${ACE}`, 'generate', 'generate', 'generate', 'generate', 'generate',
        ]);
        const sent = calls.filter((c) => c.startsWith('generate:')).map((c) => c.slice('generate:'.length)).sort();
        assert.deepEqual(sent, [`written ${tag} 1`, `written ${tag} 2`, `written ${tag} 3`, 'stored five', 'stored four'].sort(),
          'each generate sent the stored or the freshly written prompt');
        for (const k of keys) {
          // eslint-disable-next-line no-await-in-loop
          const j = await jobOf(k);
          assert.deepEqual([j.state, j.needs_prompt, j.attempts], ['done', false, 1], `${k}: the prompt claim's attempt was refunded`);
        }
        assert.equal(s.phase, null, 'no phase once the drain has ended');
        assert.equal(s.waiting, null);
      });

      await t.test('(b) a switch refused 409 twice then accepted ends with 0 failed; waiting is shown while it waits', async () => {
        reset();
        const k = await world('b1');
        await prompts.save(pool, 'world', k, 'music', { style: 'village', text: 'stored b' });
        await q.enqueue(pool, [music(k)]);
        let refusals = 0;
        const seenWaiting = [];
        d.startDrain(pool, {
          deps: depsWith({
            switchModel: async (p, model) => {
              calls.push(`switch:${model}`);
              if (refusals < 2) {
                refusals += 1;
                return { ok: false, status: 409, retryable: true, error: 'audio service answered 409: a job is queued' };
              }
              return { ok: true, json: {} };
            },
            sleep: async () => { seenWaiting.push(d.runStatus().waiting); },
          }),
        });
        const s = await waitIdle();
        assert.equal(s.stopped_reason, 'empty', s.error);
        assert.equal(s.failed, 0);
        assert.equal(s.done, 1);
        assert.deepEqual(calls.map((c) => c.replace(/^generate:.*/, 'generate')), [`switch:${ACE}`, `switch:${ACE}`, `switch:${ACE}`, 'generate']);
        const w = seenWaiting.find(Boolean);
        assert.ok(w, 'run.waiting was set during the wait');
        assert.equal(w.model, ACE);
        assert.match(w.reason, /a job is queued/);
        assert.ok(!Number.isNaN(Date.parse(w.since)), 'since is a timestamp');
        assert.equal(s.waiting, null, 'waiting is cleared once the switch went through');
        assert.equal((await jobOf(k)).state, 'done');
      });

      await t.test('(c) force_prompt replaces a hand-written prompt; the old row stays as history', async () => {
        reset();
        const k = await world('c1');
        const hand = await prompts.save(pool, 'world', k, 'music', { style: 'village', text: 'hand written c' });
        await q.enqueue(pool, [music(k, { force_prompt: true })]);
        d.startDrain(pool, { deps: depsWith() });
        const s = await waitIdle();
        assert.equal(s.failed, 0, s.error);
        const rows = (await pool.query(
          `SELECT id, text, active, via FROM audio_prompts WHERE subject_kind = 'world' AND subject_key = $1 AND slot = 'music'
            ORDER BY id`, [k])).rows;
        assert.equal(rows.length, 2);
        assert.deepEqual([String(rows[0].id), rows[0].active, rows[0].text], [String(hand.id), false, 'hand written c']);
        assert.equal(rows[1].active, true);
        assert.equal(rows[1].via, 'box');
        assert.match(rows[1].text, /^written /);
        assert.deepEqual(calls.filter((c) => c.startsWith('generate:')), [`generate:${rows[1].text}`], 'the new prompt is the one generated');
      });

      await t.test('(d) a prompt_only job ends done with its prompt written and no generate', async () => {
        reset();
        const k = await world('d1');
        await q.enqueue(pool, [music(k, { prompt_only: true })]);
        d.startDrain(pool, { deps: depsWith() });
        const s = await waitIdle();
        assert.equal(s.failed, 0, s.error);
        assert.deepEqual(calls, [`switch:${BRAIN}`, 'text'], 'no audio switch and no generate');
        const j = await jobOf(k);
        assert.deepEqual([j.state, j.needs_prompt], ['done', false]);
        const active = await prompts.getActive(pool, 'world', k, 'music');
        assert.match(active.text, /^written /);
      });

      await t.test('(e) a job enqueued during the audio phase gets its prompt in the next cycle, not mid-phase', async () => {
        reset();
        const [p1, p2, late] = await Promise.all(['e1', 'e2', 'e3'].map(world));
        await prompts.save(pool, 'world', p1, 'music', { style: 'village', text: 'stored e1' });
        await prompts.save(pool, 'world', p2, 'music', { style: 'village', text: 'stored e2' });
        await q.enqueue(pool, [music(p1), music(p2)]);
        let enqueued = false;
        const lateRap = {
          ...rap,
          generateTrack: async (p, body) => {
            const r = await rap.generateTrack(p, body);
            if (!enqueued) { enqueued = true; await q.enqueue(pool, [music(late)]); }
            return r;
          },
        };
        d.startDrain(pool, {
          deps: depsWith({ generateForSlot: (db, p, spec) => gen.generateForSlot(db, p, spec, { rap: lateRap, lib: fakeLib }) }),
        });
        const s = await waitIdle();
        assert.equal(s.failed, 0, s.error);
        assert.equal(s.done, 3);
        assert.deepEqual(calls.map((c) => c.replace(/^generate:written.*/, 'generate:written')), [
          `switch:${ACE}`, 'generate:stored e1', 'generate:stored e2',
          `switch:${BRAIN}`, 'text',
          `switch:${ACE}`, 'generate:written',
        ]);
      });

      await t.test('(f) with no text provider the prompt job fails with that message; nothing is switched or generated', async () => {
        reset();
        const k = await world('f1');
        await q.enqueue(pool, [music(k)]);
        d.startDrain(pool, { deps: depsWith({ loadTextProvider: async () => null }) });
        const s = await waitIdle();
        assert.equal(s.stopped_reason, 'empty', s.error);
        assert.equal(s.failed, 1);
        assert.deepEqual(calls, []);
        const j = await jobOf(k);
        assert.deepEqual([j.state, j.last_error], ['failed', NO_TEXT]);
      });

      await t.test('(g) Stop during a 409 wait ends the drain as stopped; the job is not failed', async () => {
        reset();
        const k = await world('g1');
        await prompts.save(pool, 'world', k, 'music', { style: 'village', text: 'stored g' });
        await q.enqueue(pool, [music(k)]);
        let sleeps = 0;
        d.startDrain(pool, {
          deps: depsWith({
            switchModel: async (p, model) => {
              calls.push(`switch:${model}`);
              return { ok: false, status: 409, retryable: true, error: 'audio service answered 409: pinned' };
            },
            sleep: async () => { sleeps += 1; if (sleeps === 3) d.stopDrain(); },
          }),
        });
        const s = await waitIdle();
        assert.equal(s.stopped_reason, 'stopped');
        assert.equal(s.failed, 0);
        assert.ok(calls.every((c) => c === `switch:${ACE}`), JSON.stringify(calls));
        const j = await jobOf(k);
        assert.deepEqual([j.state, j.attempts], ['queued', 0], 'never claimed, never failed');
        await pool.query('DELETE FROM audio_jobs WHERE subject_key = $1', [k]);
      });

      await t.test('a refusal naming another model switches to it and retries, for a group with no map entry', async () => {
        reset();
        const sfx = (key) => ({
          subject_kind: 'creature', subject_key: `${tag}-${key}`, slot: 'hurt', clip_kind: 'sfx', engine: 'realistic', prompt: 'a beast',
        });
        await q.enqueue(pool, [sfx('r1'), sfx('r2')]);
        let packs = 0;
        const generateSfxPack = async (p, body) => {
          packs += 1;
          calls.push(`pack:${body.items.length}`);
          if (packs === 1) {
            return {
              ok: false, status: 409, retryable: true,
              error: `audio service answered 409 for POST /api/audio/sfx-pack: requested audio:foley-x, but ${BRAIN} holds the card`,
            };
          }
          return {
            ok: true,
            items: body.items.map((it) => ({
              ok: true, cue: it.cue, entity: it.entity, clips: [{ buffer: OGG, durationMs: 500 }], prompt: 'p', seed: 1, cached: false,
            })),
          };
        };
        d.startDrain(pool, {
          deps: depsWith({
            generateSfxPackForJobs: (db, p, jobs, opts) => gen.generateSfxPackForJobs(db, p, jobs, {
              ...opts, rap: { generateSfxPack }, lib: fakeLib,
            }),
          }),
        });
        const s = await waitIdle();
        assert.equal(s.stopped_reason, 'empty', s.error);
        assert.equal(s.failed, 0, s.error);
        assert.equal(s.done, 2);
        assert.deepEqual(calls, ['pack:2', 'switch:audio:foley-x', 'pack:2'], 'no up-front switch for sfx; the refusal named the model');
        const rows = (await pool.query(
          'SELECT state, attempts FROM audio_jobs WHERE subject_key LIKE $1 ORDER BY id', [`${tag}-r%`])).rows;
        assert.deepEqual(rows, [{ state: 'done', attempts: 1 }, { state: 'done', attempts: 1 }], 'the refused try was refunded');
      });
      // The slot card's own inputs, carried by the queue.
      await t.test('an sfx job with variants 5 runs alone and asks for 5; variants-null jobs still pack', async () => {
        reset();
        const sfx = (key, extra = {}) => ({
          subject_kind: 'creature', subject_key: `${tag}-${key}`, slot: 'hurt', clip_kind: 'sfx', engine: 'realistic', prompt: 'a beast', ...extra,
        });
        await q.enqueue(pool, [sfx('v-solo', { variants: 5 }), sfx('v-a'), sfx('v-b')]);
        const clipsFor = (n) => Array.from({ length: n }, (_, i) => ({ buffer: Buffer.concat([OGG, Buffer.from([i])]), durationMs: 500 }));
        const sfxRap = {
          generateSfx: async (p, body) => {
            calls.push(`sfx:${body.entity}:${body.variants}`);
            return { ok: true, clips: clipsFor(body.variants), cached: false, prompt: body.entity, seed: body.seed };
          },
          generateSfxPack: async (p, body) => {
            calls.push(`pack:${body.items.length}:${body.variants}`);
            return {
              ok: true,
              items: body.items.map((it) => ({
                ok: true, cue: it.cue, entity: it.entity, clips: clipsFor(body.variants), prompt: 'p', seed: 1, cached: false,
              })),
            };
          },
        };
        d.startDrain(pool, {
          deps: depsWith({
            generateForSlot: (db, p, spec) => gen.generateForSlot(db, p, spec, { rap: sfxRap, lib: fakeLib }),
            generateSfxPackForJobs: (db, p, jobs, opts) => gen.generateSfxPackForJobs(db, p, jobs, { ...opts, rap: sfxRap, lib: fakeLib }),
          }),
        });
        const s = await waitIdle();
        assert.equal(s.stopped_reason, 'empty', s.error);
        assert.equal(s.failed, 0, s.error);
        assert.equal(s.done, 3);
        // A tagged creature's entity text is its lower-cased key (entityPhrase).
        assert.deepEqual(calls, [`sfx:${`${tag}-v-solo`.toLowerCase()}:5`, `pack:2:${gen.DEFAULT_SFX_VARIANTS}`],
          'the variants-5 job went alone with its own count; the others packed with the default');
      });

      await t.test("a job's hint reaches the text model's request", async () => {
        reset();
        const k = await world('h1');
        await q.enqueue(pool, [music(k, { hint: 'stormy sea shanty', prompt_only: true })]);
        const requests = [];
        d.startDrain(pool, {
          deps: depsWith({
            tp: { complete: async (db, req, opts) => { requests.push(req.prompt); return tp.complete(db, req, opts); } },
          }),
        });
        const s = await waitIdle();
        assert.equal(s.failed, 0, s.error);
        assert.equal(requests.length, 1);
        assert.match(requests[0], /^Admin hint: stormy sea shanty$/m);
        const active = await prompts.getActive(pool, 'world', k, 'music');
        assert.equal(active.hint, 'stormy sea shanty', 'the stored prompt records the hint');
      });

      await t.test("a job's slots reach generateTrack", async () => {
        reset();
        const k = await world('s1');
        await prompts.save(pool, 'world', k, 'music', { style: 'village', text: 'stored s' });
        await q.enqueue(pool, [music(k, { slots: { mood: 'calm and sunny' } })]);
        const bodies = [];
        const slotRap = { ...rap, generateTrack: async (p, body) => { bodies.push(body); return rap.generateTrack(p, body); } };
        d.startDrain(pool, {
          deps: depsWith({ generateForSlot: (db, p, spec) => gen.generateForSlot(db, p, spec, { rap: slotRap, lib: fakeLib }) }),
        });
        const s = await waitIdle();
        assert.equal(s.failed, 0, s.error);
        assert.equal(bodies.length, 1);
        assert.deepEqual(bodies[0].slots, { mood: 'calm and sunny' });
      });
    } finally {
      for (const r of foreign) {
        // eslint-disable-next-line no-await-in-loop
        await pool.query('UPDATE audio_jobs SET not_before = $2 WHERE id = $1', [r.id, r.not_before]);
      }
    }
  });
});
