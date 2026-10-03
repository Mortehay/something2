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
  SUBJECT_KINDS, MAX_SUBJECT_KEY, slotKind, subjectExists, cueFor,
} = require('../services/audioSubjects');
const { checkClipBuffer } = require('../services/oggInfo');
const audioJobQueue = require('../services/audioJobQueue');
const audioDispatcher = require('../services/audioDispatcher');
const audioPrompts = require('../services/audioPrompts');
const { loadPromptCatalog, buildContext, isStale } = require('../services/audioPromptContext');
const { writeSlotPrompt, loadStyles } = require('../services/audioPromptWriter');
const aiProviders = require('../services/aiProviders');

// A job id as the retry route accepts it: a positive integer, or a digit
// string (pg hands bigint ids to the client as strings), no larger than
// Postgres' bigint maximum -- above it the ::bigint[] cast would throw and
// turn a bad request into a 500.
const BIGINT_MAX = 9223372036854775807n;
function isJobId(id) {
  if (Number.isSafeInteger(id)) return id > 0;
  return typeof id === 'string' && /^[1-9][0-9]{0,18}$/.test(id) && BigInt(id) <= BIGINT_MAX;
}

// POST /admin/jobs' per-request item cap. checkSubject + cueFor run once per
// item, sequentially, so a request stays bounded. The slot table sends a
// bigger selection in chunks of this size (audioSelection.MAX_JOB_ITEMS,
// which a frontend test pins to this line).
const MAX_JOB_ITEMS = 500;

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

// The rest of a POST /admin/jobs item: what the slot card's synchronous
// Generate / Write with model sent, so the same click can go through the
// queue instead. Returns { variants, slots, hint, seed } (each undefined/null
// when absent) or { error }.
//   variants  sfx only, an integer 1-5 -- the same rule as /admin/generate.
//   slots     music/ambience only, a plain object: /admin/generate passes
//             b.slots to the box as given, so only the shape is checked.
//   hint      a string, trimmed and capped at 200 as writeSlotPrompt caps it;
//             '' is no hint.
//   seed      an integer.
const MAX_HINT = 200;
function checkJobExtras(it, clipKind) {
  const out = {};
  if (it.variants !== undefined) {
    if (clipKind !== 'sfx') return { error: 'variants are for sfx only' };
    if (!(Number.isInteger(it.variants) && it.variants >= 1 && it.variants <= 5)) {
      return { error: 'variants must be an integer 1-5' };
    }
    out.variants = it.variants;
  }
  if (it.slots !== undefined && it.slots !== null) {
    if (clipKind === 'sfx') return { error: 'slots are for music and ambience only' };
    if (typeof it.slots !== 'object' || Array.isArray(it.slots)) return { error: 'slots must be an object' };
    out.slots = Object.keys(it.slots).length ? it.slots : null;
  }
  if (it.hint !== undefined && it.hint !== null) {
    if (typeof it.hint !== 'string') return { error: 'hint must be a string' };
    out.hint = it.hint.trim().slice(0, MAX_HINT) || null;
  }
  if (it.seed !== undefined && it.seed !== null) {
    if (!Number.isSafeInteger(it.seed)) return { error: 'seed must be an integer' };
    out.seed = it.seed;
  }
  return out;
}

function sendError(res, err) {
  if (err && err.status === 400) return res.status(400).json({ error: err.message });
  console.error(err);
  return res.status(500).json({ error: 'audio request failed' });
}

// The style a hand edit may save: one the active audio provider reported
// (models_cache holds style values plus "cue:"-prefixed cues). With no
// provider or an empty cache there is nothing to check against, so any
// style is accepted -- refusing would lock editing on a box-less install.
async function unknownStyle(pool, style) {
  if (!style) return false;
  const p = await aiProviders.loadActiveProviderWithSecret(pool, 'audio');
  const known = p && Array.isArray(p.models_cache) ? p.models_cache.filter((m) => !m.startsWith('cue:')) : [];
  return known.length > 0 && !known.includes(style);
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

  // Ruling (game audio slice 3, Task 2, revised in review): every group's
  // cue map is read the SAME way -- `def.subjectCues(pool)`, if the kind
  // defines one (see the SUBJECT_KINDS header comment in audioSubjects.js).
  // No per-kind switch here: a kind with no `subjectCues` (world, biome --
  // music/ambience have no cue concept) simply gets no `cues` field, and
  // adding a cue-bearing kind later needs no route change, only a registry
  // entry. Every group's `cues`, when present, is shaped the same way too:
  // `{ [subjectKey]: { [slot]: cue|null } }`, whether the underlying rule is
  // fixed (creature, world_point) or per-subject (attack_type, item, skill).
  router.get('/admin/subjects', admin, async (req, res) => {
    try {
      // One query for per-slot clip counts across every subject, not one
      // /admin/slots request per subject -- see slotClipCounts' own comment.
      // `filled` (distinct filled slots, the badge the existing callers
      // read) is derived from the same rows; `filledSlots` (SOMET-596) is
      // the per-slot clip count the slot table shows.
      const slotCounts = await lib.slotClipCounts(pool);
      const counts = lib.filledFromSlotCounts(slotCounts);
      // Prompt coverage (spec 2026-09-30 §7): one read of every active prompt
      // and one catalog snapshot, never a query per slot. Stale needs the cue
      // for sfx slots; those come from the kind's subjectCues, loaded below.
      const [activePrompts, promptCatalog] = await Promise.all([audioPrompts.listAllActive(pool), loadPromptCatalog(pool)]);
      const out = [];
      for (const [kind, def] of Object.entries(SUBJECT_KINDS)) {
        const entry = {
          kind, label: def.label, slots: def.slots,
          // eslint-disable-next-line no-await-in-loop
          subjects: await def.list(pool),
          filled: counts[kind] || {},
          filledSlots: slotCounts[kind] || {},
        };
        // eslint-disable-next-line no-await-in-loop
        if (def.subjectCues) entry.cues = await def.subjectCues(pool);
        const states = {};
        for (const p of activePrompts) {
          if (p.subject_kind !== kind) continue;
          const cue = entry.cues && entry.cues[p.subject_key] ? entry.cues[p.subject_key][p.slot] || null : null;
          let state = 'written';
          if (!p.text) state = 'cleared';
          else if (isStale(p, buildContext(promptCatalog, kind, p.subject_key, p.slot, { cue }))) state = 'stale';
          (states[p.subject_key] ||= {})[p.slot] = state;
        }
        entry.promptStates = states;
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
      const r = await rap.propose(provider, { context: await contextFor(pool, kind, key, slot), kind: clipKind });
      if (!r.ok) return res.status(502).json({ error: r.error });
      res.json({ style: r.style, slots: r.slots, prompt: r.prompt });
    } catch (err) { sendError(res, err); }
  });

  // Spec 2026-09-30 §7. Every slot of one subject: active prompt, history,
  // and whether the context the prompt was written from has moved.
  router.get('/admin/prompts/:kind/:key', admin, async (req, res) => {
    const { kind, key } = req.params;
    try {
      const def = SUBJECT_KINDS[kind];
      if (!def || !Object.hasOwn(SUBJECT_KINDS, kind)) return res.status(400).json({ error: 'unknown subject kind' });
      const [bySlot, catalog] = await Promise.all([audioPrompts.listForSubject(pool, kind, key), loadPromptCatalog(pool)]);
      const out = {};
      for (const slot of Object.keys(def.slots)) {
        // eslint-disable-next-line no-await-in-loop
        const cue = slotKind(kind, slot) === 'sfx' ? await cueFor(pool, kind, key, slot) : null;
        const currentInput = buildContext(catalog, kind, key, slot, { cue });
        const entry = bySlot[slot] || { active: null, history: [] };
        out[slot] = { ...entry, currentInput, stale: isStale(entry.active, currentInput) };
      }
      res.json(out);
    } catch (err) { sendError(res, err); }
  });

  router.put('/admin/prompts/:kind/:key/:slot', admin, async (req, res) => {
    const { kind, key, slot } = req.params;
    const b = req.body || {};
    try {
      const { clipKind, error } = await checkSubject(pool, kind, key, slot);
      if (error) return res.status(400).json({ error });
      if (typeof b.text !== 'string') return res.status(400).json({ error: 'text must be a string' });
      const style = clipKind === 'sfx' ? null : (typeof b.style === 'string' && b.style.trim() ? b.style.trim() : null);
      if (await unknownStyle(pool, style)) return res.status(400).json({ error: `style '${style}' is not one the audio provider offers` });
      const row = await audioPrompts.save(pool, kind, key, slot, { style, text: b.text }, {
        expectActiveId: b.expect_active_id === undefined ? undefined : b.expect_active_id,
      });
      res.json(row);
    } catch (err) {
      if (err && err.status === 409) return res.status(409).json({ error: err.message });
      sendError(res, err);
    }
  });

  router.post('/admin/prompts/:kind/:key/:slot/write', admin, async (req, res) => {
    const { kind, key, slot } = req.params;
    try {
      const { clipKind, error } = await checkSubject(pool, kind, key, slot);
      if (error) return res.status(400).json({ error });
      const [catalog, styles] = await Promise.all([
        loadPromptCatalog(pool), clipKind === 'sfx' ? { music: [], ambience: [] } : loadStyles(pool),
      ]);
      const cue = clipKind === 'sfx' ? await cueFor(pool, kind, key, slot) : null;
      // Read BEFORE the model call: the call can take minutes, and a hand
      // edit saved meanwhile must win over the model answer (final review I1).
      const before = await audioPrompts.getActive(pool, kind, key, slot);
      const r = await writeSlotPrompt(pool, { kind, key, slot, hint: (req.body || {}).hint }, {
        catalog, styles, cue, expectActiveId: before ? before.id : null,
      });
      if (!r.ok) {
        if (r.conflict) return res.status(409).json({ error: 'the prompt changed while the model was writing; reload it to see the current text' });
        return res.status(502).json({ error: r.error, via: r.via ?? null });
      }
      res.status(201).json(r.row);
    } catch (err) {
      if (err && err.status === 409) return res.status(409).json({ error: err.message });
      sendError(res, err);
    }
  });

  router.post('/admin/generate', admin, async (req, res) => {
    const b = req.body || {};
    try {
      const { clipKind, error } = await checkSubject(pool, b.subject_kind, b.subject_key, b.slot);
      if (error) return res.status(400).json({ error });
      // sfx-only body fields (game audio slice 3, Task 3): `variants` is
      // validated here, before any box call, the same way volume/weight are
      // validated in PATCH /admin/bindings/:id above.
      if (clipKind === 'sfx' && b.variants !== undefined
        && !(Number.isInteger(b.variants) && b.variants >= 1 && b.variants <= 5)) {
        return res.status(400).json({ error: 'variants must be an integer 1-5' });
      }
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
        engine: typeof b.engine === 'string' ? b.engine : undefined,
        variants: clipKind === 'sfx' && Number.isInteger(b.variants) ? b.variants : undefined,
        seed: Number.isInteger(b.seed) ? b.seed : undefined,
      });
      // No request prompt and none stored (plan 2026-10-03): generate never
      // proposes any more, so this is the caller's to fix -- write a prompt
      // (or queue the slot, whose prompt phase writes one) -- not a box fault.
      if (!gen.ok && gen.error === 'no prompt') return res.status(409).json({ error: 'no prompt' });
      if (!gen.ok) return res.status(502).json({ error: gen.error, retryable: Boolean(gen.retryable) });
      // sfx generates N variants at once (`{clips, bindings}`); music/ambience
      // stay a single clip (`{clip, binding}`) -- callers of the existing
      // shape (e.g. the Audio tab's music/ambience generate button) see no
      // change.
      if (clipKind === 'sfx') {
        const body = { clips: gen.clips, bindings: gen.bindings };
        // Review round 1, fix 1: a partial store (some variants bound, one or
        // more failed mid-loop) is still a 201 -- the successful variants are
        // real and already bound -- but `partial`/`error` must be visible so
        // the caller does not treat it as identical to a full success.
        if (gen.partial) { body.partial = true; body.error = gen.error; }
        return res.status(201).json(body);
      }
      res.status(201).json({ clip: gen.clip, binding: gen.binding });
    } catch (err) { sendError(res, err); }
  });

  router.post('/admin/upload', admin, express.raw({ type: 'audio/ogg', limit: '8mb' }), async (req, res) => {
    const {
      subject_kind: kind, subject_key: key, slot, label, loopable: loopParam,
    } = req.query;
    try {
      const { clipKind, error } = await checkSubject(pool, kind, key, slot);
      if (error) return res.status(400).json({ error });
      // `loopable` (SOMET-592, I2): the "Loop" checkbox on a world point's
      // nearby slot. Absent = the default (sfx never loops); any other slot
      // refuses it rather than silently storing a flag nothing reads.
      let loopable;
      if (loopParam !== undefined) {
        if (loopParam !== 'true' && loopParam !== 'false') return res.status(400).json({ error: "loopable must be 'true' or 'false'" });
        if (clipKind === 'sfx' && !lib.canSetLoopable(kind, slot)) {
          return res.status(400).json({ error: 'only a world point\'s nearby slot takes a loopable upload' });
        }
        if (clipKind === 'sfx') loopable = loopParam === 'true';
      }
      if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'send the file as Content-Type: audio/ogg' });
      const checked = checkClipBuffer(req.body, clipKind);
      if (!checked.ok) return res.status(400).json({ error: checked.error });
      // Upload, then clip row + binding in one transaction (spec §2), same
      // path as generate -- a concurrent delete-unbound cannot see it unbound.
      const { clip, binding } = await lib.storeAndBindClip(pool, {
        buffer: req.body, kind: clipKind, label: String(label || `${key} ${slot} (upload)`).slice(0, 200),
        source: 'uploaded', durationMs: checked.durationMs, loopable,
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

  // SOMET-592 (I2): the Loop toggle on a world point's nearby clip rows. See
  // lib.setClipLoopable for the rule (world_point nearby, or a non-sfx clip).
  router.patch('/admin/clips/:id', admin, async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'id must be a uuid' });
    const { loopable } = req.body || {};
    if (typeof loopable !== 'boolean') return res.status(400).json({ error: 'loopable must be a boolean' });
    try {
      const row = await lib.setClipLoopable(pool, req.params.id, loopable);
      return row ? res.json(row) : res.status(404).json({ error: 'clip not found' });
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
      if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > MAX_JOB_ITEMS) {
        return res.status(400).json({ error: `items must be an array of 1-${MAX_JOB_ITEMS} entries` });
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
        // Plan 2026-10-03: "Force regenerate prompt" (force_prompt) and
        // "Write with model" (prompt_only). Strict booleans: a truthy string
        // must not force a rewrite over someone's hand-written prompt.
        const badFlag = ['force_prompt', 'prompt_only'].find((f) => it[f] !== undefined && typeof it[f] !== 'boolean');
        if (badFlag) { rejected.push({ item, error: `${badFlag} must be a boolean` }); continue; }
        // sfx (slice 3): an upload-only slot has no cue on the box, so a
        // job for it could never generate anything (spec §4) -- refused here
        // rather than queued to fail later. The per-item engine is optional
        // (realistic when absent) and picks the drain group.
        if (clipKind === 'sfx') {
          // eslint-disable-next-line no-await-in-loop
          if (!(await cueFor(pool, it.subject_kind, it.subject_key, it.slot))) {
            rejected.push({ item, error: 'upload only: no cue on the provider' });
            continue;
          }
          if (it.engine !== undefined && !audioJobQueue.SFX_ENGINES.includes(it.engine)) {
            rejected.push({ item, error: "engine must be 'realistic' or 'retro'" });
            continue;
          }
        }
        const extra = checkJobExtras(it, clipKind);
        if (extra.error) { rejected.push({ item, error: extra.error }); continue; }
        valid.push({
          subject_kind: it.subject_kind,
          subject_key: it.subject_key,
          slot: it.slot,
          clip_kind: clipKind,
          style: it.style || null,
          prompt: it.prompt || null,
          engine: clipKind === 'sfx' ? it.engine : undefined,
          force_prompt: it.force_prompt === true,
          prompt_only: it.prompt_only === true,
          variants: extra.variants,
          slots: extra.slots,
          hint: extra.hint,
          seed: extra.seed,
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

  // SOMET-596: the slot table's Job column and its failed-by-cause panel.
  // One row per (kind, key, slot) -- see audioJobQueue.slotJobs for which row
  // wins when a slot has several.
  router.get('/admin/jobs/slots', admin, async (req, res) => {
    try { res.json(await audioJobQueue.slotJobs(pool)); }
    catch (err) { sendError(res, err); }
  });

  // No body (or no `ids`): every failed job, as before. `ids` (SOMET-596, the
  // by-cause panel's "Retry these N") scopes it to those jobs' slots; an id
  // that is not a failed job is ignored, and `requeued` says how many went
  // back. Ids are bigints, so digit strings are accepted as well as integers
  // (pg hands bigint ids to the client as strings).
  router.post('/admin/jobs/retry-failed', admin, async (req, res) => {
    const { ids } = req.body || {};
    let scoped;
    if (ids !== undefined) {
      const ok = Array.isArray(ids) && ids.length <= 10000 && ids.every(isJobId);
      if (!ok) return res.status(400).json({ error: 'ids must be an array of job ids (positive integers)' });
      scoped = ids.map(String);
    }
    try { res.json({ requeued: await audioJobQueue.retryFailed(pool, scoped ? { ids: scoped } : {}) }); }
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
module.exports.MAX_JOB_ITEMS = MAX_JOB_ITEMS;
