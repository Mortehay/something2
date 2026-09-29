// backend/src/api/audioRoutes.js
//
// Game audio slice 1 (spec §2-4). Two audiences on one mount:
//   /api/audio/world/:id and /api/audio/misses  -- playerGuard, the game client
//   /api/audio/admin/*                          -- adminGuard, the Audio tab
// The box token is read server-side only (loadProviderWithSecret /
// loadActiveProviderWithSecret) and never appears in a response.
const express = require('express');
const { requireAdmin, requireAuth } = require('../auth/middleware.js');
const rap = require('../services/remoteAudioProvider');
const lib = require('../services/audioLibrary');
const {
  resolveAudioProvider, contextFor, boxTrackName, generateForSlot,
} = require('../services/audioGeneration');
const {
  SUBJECT_KINDS, MAX_SUBJECT_KEY, slotKind, subjectExists, ATTACK_TYPE_CUES, itemCues, skillCues,
} = require('../services/audioSubjects');
const { checkClipBuffer } = require('../services/oggInfo');
const audioJobQueue = require('../services/audioJobQueue');
const audioDispatcher = require('../services/audioDispatcher');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Shared subject/slot validation for propose, generate and upload. Every
// field must be a single string (a repeated query param arrives as an array),
// the slot must be in the registry and the subject must exist (spec §3).
// Returns { clipKind } or { error } (always a 400).
async function checkSubject(pool, kind, key, slot) {
  if (typeof kind !== 'string' || typeof key !== 'string' || typeof slot !== 'string'
    || !key || key.length > MAX_SUBJECT_KEY) {
    return { error: 'subject_kind, subject_key (1-200 chars) and slot must each be a single string' };
  }
  const clipKind = slotKind(kind, slot);
  if (!clipKind) return { error: 'unknown subject or slot' };
  if (!(await subjectExists(pool, kind, key))) return { error: 'unknown subject' };
  return { clipKind };
}

function sendError(res, err) {
  if (err && err.status === 400) return res.status(400).json({ error: err.message });
  console.error(err);
  return res.status(500).json({ error: 'audio request failed' });
}

module.exports = function audioRoutes(pool) {
  const router = express.Router();
  const admin = requireAdmin(pool);
  const player = requireAuth(pool);

  router.get('/world/:worldId', player, async (req, res) => {
    if (!UUID.test(req.params.worldId)) return res.status(400).json({ error: 'worldId must be a uuid' });
    try {
      const bundle = await lib.worldAudioBundle(pool, req.params.worldId);
      if (!bundle) return res.status(404).json({ error: 'world not found' });
      res.json(bundle);
    } catch (err) { sendError(res, err); }
  });

  router.post('/misses', player, async (req, res) => {
    try {
      res.json({ accepted: await lib.recordMisses(pool, req.body && req.body.misses) });
    } catch (err) { sendError(res, err); }
  });

  router.get('/admin/subjects', admin, async (req, res) => {
    try {
      // One query for filled-slot counts across every subject, not one
      // /admin/slots request per subject -- see filledCounts' own comment.
      // Same reasoning for itemCues: one query for every weapon rather than
      // one per name.
      const [counts, items] = await Promise.all([lib.filledCounts(pool), itemCues(pool)]);
      const out = [];
      for (const [kind, def] of Object.entries(SUBJECT_KINDS)) {
        const entry = {
          kind, label: def.label, slots: def.slots,
          // eslint-disable-next-line no-await-in-loop
          subjects: await def.list(pool),
          filled: counts[kind] || {},
        };
        // Ruling (game audio slice 3, Task 2): a fixed-cue kind (same map for
        // every subject -- world/biome carry no sfx slots at all, creature
        // and world_point are literally fixed) gets `cues`. A kind whose cue
        // depends on the subject itself gets its own per-subject map instead
        // -- `${kind}Cues` -- so the shape a client reads is consistent:
        // `cues` never varies by subject, a `*Cues` field always does.
        // attack_type's is small and static enough to ship as the shared
        // ATTACK_TYPE_CUES constant rather than a query.
        if (def.cues) entry.cues = def.cues;
        else if (kind === 'attack_type') entry.attackTypeCues = ATTACK_TYPE_CUES;
        else if (kind === 'item') entry.itemCues = items;
        else if (kind === 'skill') entry.skillCues = skillCues();
        out.push(entry);
      }
      res.json(out);
    } catch (err) { sendError(res, err); }
  });

  router.get('/admin/slots/:kind/:key', admin, async (req, res) => {
    try { res.json(await lib.subjectSlots(pool, req.params.kind, req.params.key)); }
    catch (err) { sendError(res, err); }
  });

  router.post('/admin/propose', admin, async (req, res) => {
    const { subject_kind: kind, subject_key: key, slot } = req.body || {};
    try {
      const { clipKind, error } = await checkSubject(pool, kind, key, slot);
      if (error) return res.status(400).json({ error });
      const provider = await resolveAudioProvider(pool, req.body.provider_id);
      if (!provider) return res.status(503).json({ error: 'No active audio provider. Add one under AI Providers with modality "audio".' });
      const r = await rap.propose(provider, { context: await contextFor(pool, kind, key), kind: clipKind });
      if (!r.ok) return res.status(502).json({ error: r.error });
      res.json({ style: r.style, slots: r.slots, prompt: r.prompt });
    } catch (err) { sendError(res, err); }
  });

  router.post('/admin/generate', admin, async (req, res) => {
    const b = req.body || {};
    try {
      const { clipKind, error } = await checkSubject(pool, b.subject_kind, b.subject_key, b.slot);
      if (error) return res.status(400).json({ error });
      if (clipKind === 'sfx') return res.status(400).json({ error: 'sfx generation arrives in slice 2' });
      const provider = await resolveAudioProvider(pool, b.provider_id);
      if (!provider) return res.status(503).json({ error: 'No active audio provider. Add one under AI Providers with modality "audio".' });
      // Always an explicit seed: the box caches by request, so a repeated or
      // omitted seed hands back the previous file (spec §2).
      const gen = await generateForSlot(pool, provider, {
        subjectKind: b.subject_kind,
        subjectKey: b.subject_key,
        slot: b.slot,
        clipKind,
        style: b.style || null,
        prompt: b.prompt || null,
        slots: b.slots || null,
        seed: Number.isInteger(b.seed) ? b.seed : undefined,
      });
      if (!gen.ok) return res.status(502).json({ error: gen.error, retryable: Boolean(gen.retryable) });
      res.status(201).json({ clip: gen.clip, binding: gen.binding });
    } catch (err) { sendError(res, err); }
  });

  router.post('/admin/upload', admin, express.raw({ type: 'audio/ogg', limit: '8mb' }), async (req, res) => {
    const { subject_kind: kind, subject_key: key, slot, label } = req.query;
    try {
      const { clipKind, error } = await checkSubject(pool, kind, key, slot);
      if (error) return res.status(400).json({ error });
      if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'send the file as Content-Type: audio/ogg' });
      const checked = checkClipBuffer(req.body, clipKind);
      if (!checked.ok) return res.status(400).json({ error: checked.error });
      // Upload, then clip row + binding in one transaction (spec §2), same
      // path as generate -- a concurrent delete-unbound cannot see it unbound.
      const { clip, binding } = await lib.storeAndBindClip(pool, {
        buffer: req.body, kind: clipKind, label: String(label || `${key} ${slot} (upload)`).slice(0, 200),
        source: 'uploaded', durationMs: checked.durationMs,
      }, { subjectKind: kind, subjectKey: key, slot });
      res.status(201).json({ clip, binding });
    } catch (err) { sendError(res, err); }
  });

  router.patch('/admin/bindings/:id', admin, async (req, res) => {
    const id = Number(req.params.id);
    const { volume, weight } = req.body || {};
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be an integer' });
    if (volume !== undefined && !(volume >= 0 && volume <= 1)) return res.status(400).json({ error: 'volume must be 0..1' });
    if (weight !== undefined && !(weight > 0)) return res.status(400).json({ error: 'weight must be > 0' });
    try {
      const row = await lib.updateBinding(pool, id, { volume, weight });
      return row ? res.json(row) : res.status(404).json({ error: 'binding not found' });
    } catch (err) { sendError(res, err); }
  });

  router.delete('/admin/bindings/:id', admin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be an integer' });
    try { return (await lib.unbind(pool, id)) ? res.status(204).end() : res.status(404).json({ error: 'binding not found' }); }
    catch (err) { sendError(res, err); }
  });

  // --- Clip library (SOMET-591, game audio slice 2 §1) ---------------------
  //
  // Every stored clip, independent of any subject -- lets an admin reuse a
  // clip across subjects (bind-from-library, below) or clean up ones nothing
  // points at. Sits alongside /admin/subjects (which lists SUBJECTS and their
  // filled slots) rather than replacing it.
  router.get('/admin/clips', admin, async (req, res) => {
    const { kind, unbound, limit, offset } = req.query;
    try {
      res.json(await lib.listClips(pool, {
        kind: typeof kind === 'string' ? kind : undefined,
        unbound: unbound === '1' || unbound === 'true',
        limit: limit !== undefined ? Number(limit) : undefined,
        offset: offset !== undefined ? Number(offset) : undefined,
      }));
    } catch (err) { sendError(res, err); }
  });

  // 200 with { deleted, bindings } rather than 204: unlike /admin/bindings/:id
  // (which deletes a link the caller already knows the shape of), a clip
  // delete cascades to every binding that pointed at it, and the caller (the
  // library UI) needs that count to tell the admin what else just vanished.
  router.delete('/admin/clips/:id', admin, async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'id must be a uuid' });
    try {
      const result = await lib.deleteClip(pool, req.params.id);
      return result.deleted ? res.json(result) : res.status(404).json({ error: 'clip not found' });
    } catch (err) { sendError(res, err); }
  });

  router.post('/admin/clips/delete-unbound', admin, async (req, res) => {
    const { kind } = req.body || {};
    try {
      res.json(await lib.deleteUnboundClips(pool, { kind: typeof kind === 'string' ? kind : undefined }));
    } catch (err) { sendError(res, err); }
  });

  // Bind-from-library: attach an EXISTING clip (already stored, maybe already
  // bound elsewhere) to another subject/slot, without generating or
  // uploading a new one. checkSubject does the same subject/slot validation
  // as generate/upload/propose; bindClip's own clip-kind check (spec §1)
  // rejects a clip whose kind does not match the slot's.
  router.post('/admin/bindings', admin, async (req, res) => {
    const {
      subject_kind: kind, subject_key: key, slot, clip_id: clipId,
    } = req.body || {};
    try {
      const { error } = await checkSubject(pool, kind, key, slot);
      if (error) return res.status(400).json({ error });
      if (typeof clipId !== 'string' || !UUID.test(clipId)) return res.status(400).json({ error: 'clip_id must be a uuid' });
      const binding = await lib.bindClip(pool, {
        subjectKind: kind, subjectKey: key, slot, clipId,
      });
      res.status(201).json(binding);
    } catch (err) { sendError(res, err); }
  });

  router.get('/admin/misses', admin, async (req, res) => {
    try { res.json(await lib.listMisses(pool)); } catch (err) { sendError(res, err); }
  });

  // --- Batch job routes (spec §2 Dispatcher, game audio slice 2) -----------
  //
  // The admin-facing surface over audioJobQueue.js / audioDispatcher.js,
  // mirroring /api/art-jobs* in src/index.js. A route-started drain always
  // runs through whatever audioDispatcher.__setDeps() last set (real
  // generation by default; tests swap in fakes so this file never has to
  // reach the real box to prove the routes work).
  //
  // audioDispatcher's own NO_PROVIDER precondition, exported so it is
  // stated once: "no active audio provider AND no queued job pins one that
  // resolves" is exactly what startDrain would otherwise discover
  // asynchronously and report as stopped_reason 'no_provider' -- after it
  // has already answered 202/201. Checking it here first turns that into an
  // honest 503 up front, using the real resolveAudioProvider (this route
  // never fakes generation resolution, only generateForSlot).
  const hasResolvableAudioProvider = () => audioDispatcher.hasResolvableProvider(pool, { resolveAudioProvider });

  router.post('/admin/jobs', admin, async (req, res) => {
    const b = req.body || {};
    try {
      if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 500) {
        return res.status(400).json({ error: 'items must be an array of 1-500 entries' });
      }
      const providerId = Number.isInteger(b.provider_id) ? b.provider_id : null;
      if (providerId !== null && !(await resolveAudioProvider(pool, providerId))) {
        return res.status(400).json({ error: 'provider_id does not resolve to an active audio provider' });
      }
      const rejected = [];
      const valid = [];
      for (const item of b.items) {
        const it = item && typeof item === 'object' ? item : {};
        // eslint-disable-next-line no-await-in-loop
        const { clipKind, error } = await checkSubject(pool, it.subject_kind, it.subject_key, it.slot);
        if (error) { rejected.push({ item, error }); continue; }
        if (clipKind === 'sfx') { rejected.push({ item, error: 'sfx batches arrive in slice 3' }); continue; }
        valid.push({
          subject_kind: it.subject_kind,
          subject_key: it.subject_key,
          slot: it.slot,
          clip_kind: clipKind,
          style: it.style || null,
          prompt: it.prompt || null,
        });
      }
      const enq = await audioJobQueue.enqueue(pool, valid, { providerId });
      // start/reason are only meaningful (and only present in the response,
      // JSON.stringify drops undefined) when start was actually requested --
      // a queue-only call has nothing to report about a drain.
      let started;
      let reason;
      if (b.start === true) {
        if (!(await hasResolvableAudioProvider())) {
          started = false;
          reason = 'no_provider';
        } else {
          try {
            audioDispatcher.startDrain(pool);
            started = true;
          } catch (err) {
            // A drain already running will pick these jobs up regardless --
            // that is a success from the caller's point of view, not a
            // reason to fail an enqueue that already committed.
            if (err.code === 'ALREADY_RUNNING') started = true;
            else throw err;
          }
        }
      }
      res.status(201).json({
        batch_id: enq.batch_id, queued: enq.queued, already_live: enq.already_live, rejected, started, reason,
      });
    } catch (err) { sendError(res, err); }
  });

  router.get('/admin/jobs', admin, async (req, res) => {
    try {
      res.json({
        run: audioDispatcher.runStatus(),
        stats: await audioJobQueue.stats(pool),
        recent: await audioJobQueue.recent(pool),
      });
    } catch (err) { sendError(res, err); }
  });

  router.post('/admin/jobs/dispatch', admin, async (req, res) => {
    try {
      if (!(await hasResolvableAudioProvider())) {
        return res.status(503).json({
          error: 'No active audio provider, and no queued job pins one that resolves. '
            + 'Add or activate one under AI Providers with modality "audio".',
        });
      }
      res.status(202).json(audioDispatcher.startDrain(pool));
    } catch (err) {
      if (err.code === 'ALREADY_RUNNING') {
        return res.status(409).json({ error: err.message, run: audioDispatcher.runStatus() });
      }
      sendError(res, err);
    }
  });

  router.post('/admin/jobs/stop', admin, (req, res) => {
    res.json(audioDispatcher.stopDrain());
  });

  router.post('/admin/jobs/retry-failed', admin, async (req, res) => {
    try { res.json({ requeued: await audioJobQueue.retryFailed(pool) }); }
    catch (err) { sendError(res, err); }
  });

  // Refused while a drain runs: deleting a queued row out from under a live
  // drain would race its claim (the same reason art's /api/art-jobs/clear
  // refuses), and audioJobQueue.clear's own default states include 'queued'.
  router.post('/admin/jobs/clear', admin, async (req, res) => {
    if (audioDispatcher.runStatus().running) {
      return res.status(409).json({ error: 'a batch is running -- stop it first, or wait for it to finish' });
    }
    try {
      const states = Array.isArray(req.body && req.body.states) ? req.body.states : undefined;
      res.json({ cleared: await audioJobQueue.clear(pool, states ? { states } : {}) });
    } catch (err) { sendError(res, err); }
  });

  return router;
};

module.exports.boxTrackName = boxTrackName;
