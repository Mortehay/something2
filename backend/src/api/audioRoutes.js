// backend/src/api/audioRoutes.js
//
// Game audio slice 1 (spec §2-4). Two audiences on one mount:
//   /api/audio/world/:id and /api/audio/misses  -- playerGuard, the game client
//   /api/audio/admin/*                          -- adminGuard, the Audio tab
// The box token is read server-side only (loadProviderWithSecret /
// loadActiveProviderWithSecret) and never appears in a response.
const express = require('express');
const crypto = require('node:crypto');
const { requireAdmin, requireAuth } = require('../auth/middleware.js');
const aiProviders = require('../services/aiProviders');
const rap = require('../services/remoteAudioProvider');
const lib = require('../services/audioLibrary');
const { SUBJECT_KINDS, slotKind } = require('../services/audioSubjects');
const { checkClipBuffer } = require('../services/oggInfo');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveAudioProvider(pool, providerId) {
  if (providerId != null) {
    const p = await aiProviders.loadProviderWithSecret(pool, providerId);
    return p && p.modality === 'audio' && p.enabled ? p : null;
  }
  return aiProviders.loadActiveProviderWithSecret(pool, 'audio');
}

async function contextFor(pool, subjectKind, subjectKey) {
  if (subjectKind === 'world') {
    const w = (await pool.query('SELECT name, biomes FROM worlds WHERE name = $1', [subjectKey])).rows[0];
    const biomes = w && Array.isArray(w.biomes) ? w.biomes.join(', ') : '';
    return `a medieval fantasy world called ${subjectKey}${biomes ? ` with ${biomes} regions` : ''}`;
  }
  const b = (await pool.query('SELECT name, art_style FROM biomes WHERE name = $1', [subjectKey])).rows[0];
  return `the ${subjectKey} biome${b && b.art_style ? `: ${b.art_style}` : ''}`;
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
      const out = [];
      for (const [kind, def] of Object.entries(SUBJECT_KINDS)) {
        // eslint-disable-next-line no-await-in-loop
        out.push({ kind, label: def.label, slots: def.slots, subjects: await def.list(pool) });
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
    const clipKind = slotKind(kind, slot);
    if (!clipKind || typeof key !== 'string') return res.status(400).json({ error: 'unknown subject or slot' });
    try {
      const provider = await resolveAudioProvider(pool, req.body.provider_id);
      if (!provider) return res.status(503).json({ error: 'No active audio provider. Add one under AI Providers with modality "audio".' });
      const r = await rap.propose(provider, { context: await contextFor(pool, kind, key), kind: clipKind });
      if (!r.ok) return res.status(502).json({ error: r.error });
      res.json({ style: r.style, slots: r.slots, prompt: r.prompt });
    } catch (err) { sendError(res, err); }
  });

  router.post('/admin/generate', admin, async (req, res) => {
    const b = req.body || {};
    const clipKind = slotKind(b.subject_kind, b.slot);
    if (!clipKind || typeof b.subject_key !== 'string' || !b.subject_key) {
      return res.status(400).json({ error: 'unknown subject or slot' });
    }
    if (clipKind === 'sfx') return res.status(400).json({ error: 'sfx generation arrives in slice 2' });
    try {
      const provider = await resolveAudioProvider(pool, b.provider_id);
      if (!provider) return res.status(503).json({ error: 'No active audio provider. Add one under AI Providers with modality "audio".' });
      // Always an explicit seed: the box caches by request, so a repeated or
      // omitted seed hands back the previous file (spec §2).
      const seed = Number.isInteger(b.seed) ? b.seed : crypto.randomInt(1, 2 ** 31 - 1);
      const name = `s2-${b.subject_kind}-${b.subject_key}-${b.slot}-${seed}`.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 120);
      const gen = await rap.generateTrack(provider, {
        kind: clipKind, name, style: b.style || null, prompt: b.prompt || null, slots: b.slots || null, seed,
      });
      if (!gen.ok) return res.status(502).json({ error: gen.error, retryable: Boolean(gen.retryable) });
      const clip = await lib.storeClip(pool, {
        buffer: gen.buffer, kind: clipKind, label: `${b.subject_key} ${b.slot}${b.style ? ` (${b.style})` : ''}`,
        source: 'generated', providerId: provider.id, prompt: gen.prompt, styleOrCue: b.style || null,
        seed: gen.seed, durationMs: gen.durationMs, loopStartMs: gen.loopStartMs, loopEndMs: gen.loopEndMs,
      });
      const binding = await lib.bindClip(pool, { subjectKind: b.subject_kind, subjectKey: b.subject_key, slot: b.slot, clipId: clip.id });
      res.status(201).json({ clip, binding });
    } catch (err) { sendError(res, err); }
  });

  router.post('/admin/upload', admin, express.raw({ type: 'audio/ogg', limit: '8mb' }), async (req, res) => {
    const { subject_kind: kind, subject_key: key, slot, label } = req.query;
    const clipKind = slotKind(kind, slot);
    if (!clipKind || !key) return res.status(400).json({ error: 'unknown subject or slot' });
    if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'send the file as Content-Type: audio/ogg' });
    const checked = checkClipBuffer(req.body, clipKind);
    if (!checked.ok) return res.status(400).json({ error: checked.error });
    try {
      const clip = await lib.storeClip(pool, {
        buffer: req.body, kind: clipKind, label: String(label || `${key} ${slot} (upload)`).slice(0, 200),
        source: 'uploaded', durationMs: checked.durationMs,
      });
      const binding = await lib.bindClip(pool, { subjectKind: kind, subjectKey: key, slot, clipId: clip.id });
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

  router.delete('/admin/clips/:id', admin, async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'id must be a uuid' });
    try { return (await lib.deleteClip(pool, req.params.id)) ? res.status(204).end() : res.status(404).json({ error: 'clip not found' }); }
    catch (err) { sendError(res, err); }
  });

  router.get('/admin/misses', admin, async (req, res) => {
    try { res.json(await lib.listMisses(pool)); } catch (err) { sendError(res, err); }
  });

  return router;
};
