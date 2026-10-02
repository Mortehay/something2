// backend/src/services/audioGeneration.js
//
// Game audio slice 2 (spec §2). resolveAudioProvider, contextFor and
// boxTrackName moved here verbatim from audioRoutes.js (slice 1) so the
// synchronous /admin/generate route and the batch drain (audioJobQueue) can
// share the same generate -> store -> bind path via generateForSlot below,
// instead of drifting into two implementations of "how a clip gets made".
const crypto = require('node:crypto');
const aiProviders = require('./aiProviders');
const defaultRap = require('./remoteAudioProvider');
const defaultLib = require('./audioLibrary');
const subjects = require('./audioSubjects');

async function resolveAudioProvider(pool, providerId) {
  if (providerId != null) {
    const p = await aiProviders.loadProviderWithSecret(pool, providerId);
    return p && p.modality === 'audio' && p.enabled ? p : null;
  }
  return aiProviders.loadActiveProviderWithSecret(pool, 'audio');
}

async function contextFor(pool, subjectKind, subjectKey, slot) {
  if (subjectKind === 'world') {
    const w = (await pool.query('SELECT name, biomes FROM worlds WHERE name = $1', [subjectKey])).rows[0];
    const biomes = w && Array.isArray(w.biomes) ? w.biomes.join(', ') : '';
    return `a medieval fantasy world called ${subjectKey}${biomes ? ` with ${biomes} regions` : ''}`;
  }
  if (subjectKind === 'biome') {
    const b = (await pool.query('SELECT name, art_style FROM biomes WHERE name = $1', [subjectKey])).rows[0];
    return `the ${subjectKey} biome${b && b.art_style ? `: ${b.art_style}` : ''}`;
  }
  // Slice 3 kinds (creature/world_point/attack_type/item/skill): reuse
  // entityPhrase rather than re-deriving the same per-kind text here -- it
  // already knows how to describe each of these without ever touching the
  // biomes table, which is what this branch used to fall through to.
  return subjects.entityPhrase(pool, subjectKind, subjectKey, slot) || subjectKey;
}

// The name the box's ledger indexes generations by (spec §2: the box caches
// by name, and generateTrack's async/ledger path polls the ledger BY NAME).
// It has to be collision-free for every (subject_kind, subject_key, slot,
// seed) the admin UI can send, which the raw
// `s2-${kind}-${key}-${slot}-${seed}`.slice(0, 120) it replaced was not:
// subject_key can run up to 200 chars, so a long key pushed the seed past
// the 120-char cutoff (every seed for that subject then collided on one box
// name), two long keys sharing a ~91-char prefix collided outright, and two
// keys that only differ in characters the slug strips ("Dark Wood" vs
// "Dark.Wood") collided whenever the seed also matched. A short sha1 of the
// RAW (unslugged) "kind/key" pair keeps those distinct regardless of what
// the slug does to them, and keeping the slugged key capped at 60 chars
// leaves the hash, slot and seed always intact -- the seed is never the part
// that gets truncated away.
function boxTrackName(subjectKind, subjectKey, slot, seed) {
  const slug = (s) => String(s).replace(/[^a-zA-Z0-9_-]+/g, '-');
  const keyHash = crypto.createHash('sha1').update(`${subjectKind}/${subjectKey}`).digest('hex').slice(0, 8);
  const name = `s2-${slug(subjectKind)}-${slug(subjectKey).slice(0, 60)}-${keyHash}-${slug(slot)}-${seed}`;
  return name.slice(0, 120);
}

function randomSeed() { return crypto.randomInt(1, 2 ** 31 - 1); }

// The `entity` text sent to generateSfx/generateSfxPack (spec §2 "SFX
// variation = entity text": the box caches SFX by (engine, cue, entity) and
// IGNORES the seed, so a different seed alone never produces a different
// file). `take` is the highest take bound to the slot + 1 (nextSfxTake) --
// the ONLY lever that makes a regenerate differ from what's already there.
function sfxEntityText(phrase, take) {
  return take >= 1 ? `${phrase} (take ${take})` : phrase;
}

// The one generate → store → bind path (spec §2). The synchronous
// /admin/generate route and the batch drain both call this, so a clip made
// either way has the same label, provenance columns and binding.
async function generateForSlot(db, provider, spec, { rap = defaultRap, lib = defaultLib } = {}) {
  if (spec.clipKind === 'sfx') return generateSfxForSlot(db, provider, spec, { rap, lib });
  const {
    subjectKind, subjectKey, slot, clipKind,
  } = spec;
  let { style = null, prompt = null, slots = null } = spec;
  const seed = Number.isInteger(spec.seed) ? spec.seed : randomSeed();
  if (!style && !prompt) {
    const p = await rap.propose(provider, { context: await contextFor(db, subjectKind, subjectKey, slot), kind: clipKind });
    if (p.ok) ({ style, slots, prompt } = { style: p.style, slots: p.slots, prompt: p.prompt });
  }
  const gen = await rap.generateTrack(provider, {
    kind: clipKind, name: boxTrackName(subjectKind, subjectKey, slot, seed), style, prompt, slots, seed,
  });
  // `status` and `providerFault` are carried through (both undefined when the
  // failure never got an HTTP response, e.g. a transport error or client-side
  // timeout) so the dispatcher can classify the failure using the box's own
  // signal rather than a re-derived guess: `status` tells a busy box (409/503,
  // spec §2) apart from a genuine failure, and `providerFault` marks a failure
  // remoteAudioProvider already knows is the box's fault (unusable JSON, a
  // ledger-reported generation failure, an unreadable/invalid returned file)
  // even when it isn't itself an HTTP status.
  if (!gen.ok) {
    return {
      ok: false, error: gen.error, retryable: Boolean(gen.retryable), status: gen.status, providerFault: Boolean(gen.providerFault),
    };
  }
  // Upload, then clip row + binding in ONE transaction (spec §2) -- see
  // storeAndBindClip. `bind: lib.bindClip` keeps an injected lib's bindClip
  // the one that runs inside that transaction.
  const { clip, binding } = await lib.storeAndBindClip(db, {
    buffer: gen.buffer, kind: clipKind, label: `${subjectKey} ${slot}${style ? ` (${style})` : ''}`,
    source: 'generated', providerId: provider.id ?? null, prompt: gen.prompt, styleOrCue: style,
    seed: gen.seed, durationMs: gen.durationMs, loopStartMs: gen.loopStartMs, loopEndMs: gen.loopEndMs,
  }, { subjectKind, subjectKey, slot }, { bind: lib.bindClip });
  return {
    ok: true, clip, binding, seed,
  };
}

// The `(take N)` suffix a generated sfx clip's label carries, when N >= 1
// (see sfxClipLabel below). Read back by nextSfxTake to find the highest
// take a slot has ever produced -- there is no dedicated column for this
// (review round 1, fix 2: "prefer an existing column ... over a migration"),
// so the take number rides on `label`, the one column that already exists
// purely for human-readable display and has no other consumer depending on
// its exact format (unlike `style_or_cue`, which the Audio tab groups clips
// by, or `prompt`, which is the BOX's own returned text, not ours to shape).
const TAKE_SUFFIX = /\(take (\d+)\)\s*$/;

function sfxClipLabel(subjectKey, slot, cue, take) {
  return `${subjectKey} ${slot} (${cue})${take >= 1 ? ` (take ${take})` : ''}`;
}

// Review round 1, fix 2: the count of CURRENT bindings is not a safe stand-in
// for "the next take number", because deleting a clip does not un-use its
// take on the box side -- the box's cache key is (engine, cue, entity) and
// entity encodes the take, so an old take is cached forever regardless of
// what our DB still has bound. Re-sending an already-used take after a
// deletion would silently hand back the box's stale cached file as if it
// were fresh. Instead: read every clip CURRENTLY bound to this slot, find
// the highest take any of their labels admit to (a label with no `(take N)`
// suffix -- an upload, or a take-0 generate -- counts as take 0), and use
// max+1. An empty slot (no clips at all) is the only case that starts at 0.
async function nextSfxTake(db, subjectKind, subjectKey, slot) {
  const bound = await db.query(
    `SELECT c.label FROM audio_bindings b JOIN audio_clips c ON c.id = b.clip_id
      WHERE b.subject_kind = $1 AND b.subject_key = $2 AND b.slot = $3`,
    [subjectKind, subjectKey, slot],
  );
  if (!bound.rows.length) return 0;
  let maxTake = 0;
  for (const row of bound.rows) {
    const m = TAKE_SUFFIX.exec(row.label || '');
    if (m) maxTake = Math.max(maxTake, Number(m[1]));
  }
  return maxTake + 1;
}

// How many variants an sfx request asks for when the caller does not say
// (the box's per-request limit is 1-5, spec §1 "Clips per slot"). Queued sfx
// jobs carry no variants of their own, so a pack always uses this.
const DEFAULT_SFX_VARIANTS = 3;

// SOMET-592 (I1): the box's `cached` flag is NOT "we already have this
// file". The box cache is keyed by (engine, cue, entity) and is shared by
// every database that talks to the box (dev, a scratch DB, the Orange Pi), so
// a cached answer is often a file THIS database never stored -- e.g. a pack
// the box rendered before a reload killed our drain, or another environment's
// take 0. Only a file whose bytes (sha1) match a clip already bound to the
// same slot is a true duplicate. A duplicate is never stored; it bumps the
// take and stays retryable -- a later take is a different entity text, so
// the box renders (or serves) a different file.
const DUPLICATE_PREFIX = 'the box returned only sounds already bound to this slot';
const duplicateError = (take) => `${DUPLICATE_PREFIX} (take ${take}); the next try uses a later take`;
const DUPLICATE_TAKE = /^the box returned only sounds already bound to this slot \(take (\d+)\)/;

// How many takes past the first the single-cue path tries before giving up
// on a slot whose every answer is a duplicate.
const MAX_EXTRA_DUPLICATE_TAKES = 3;

// The take a queued job should send when its previous attempt came back a
// duplicate: one past the take that duplicated. The job row carries no take
// of its own, so it rides on last_error (which the dispatcher writes from
// duplicateError above). -1 when the last attempt was not a duplicate.
function takeAfterDuplicate(lastError) {
  const m = DUPLICATE_TAKE.exec(typeof lastError === 'string' ? lastError : '');
  return m ? Number(m[1]) + 1 : -1;
}

// The variants of one box answer that are worth storing. A fresh (not
// cached) render is new by construction and is taken whole. A cached one is
// checked byte-for-byte against the clips already bound to this slot, and
// against the other variants of this same answer.
async function freshVariants(db, lib, target, variants, cached) {
  const list = Array.isArray(variants) ? variants : [];
  if (!cached) return list;
  const boundSha1s = lib.boundClipSha1s || defaultLib.boundClipSha1s;
  const seen = await boundSha1s(db, target);
  const out = [];
  for (const v of list) {
    const hash = defaultLib.sha1Of(v.buffer);
    if (!seen.has(hash)) { seen.add(hash); out.push(v); }
  }
  return out;
}

// What one sfx (subject, slot) would send the box, or why it cannot be sent.
// Shared by the single-cue path (generateSfxForSlot) and the pack path
// (generateSfxPackForJobs) so both refuse the same slots the same way. The
// cue is never taken from the caller -- it is the registry's own answer for
// this (subjectKind, subjectKey, slot), and a slot with no cue on the box
// today (spec §4) is upload-only, refused before any box call.
async function sfxRequestFor(db, provider, {
  subjectKind, subjectKey, slot, engine,
}) {
  const cue = await subjects.cueFor(db, subjectKind, subjectKey, slot);
  if (!cue) return { ok: false, error: 'upload only: the provider has no cue for this slot', retryable: false };
  // The provider's own discovered allow-list (spec §2 "Cues": a provider's
  // Refresh writes 'cue:<name>' entries into models_cache) -- never send a
  // cue the box hasn't reported it knows about, even if the registry thinks
  // it exists (a stale registry entry vs. a provider that hasn't been
  // refreshed yet must fail the same way: upload only).
  const known = Array.isArray(provider.models_cache) && provider.models_cache.includes(`cue:${cue}`);
  if (!known) return { ok: false, error: `upload only: the provider has no cue '${cue}' registered`, retryable: false };
  return {
    ok: true,
    cue,
    // `engine` has no per-cue default available here: models_cache only
    // holds flattened 'cue:<name>' strings (see SettingsAdmin.jsx), not the
    // box's per-cue default_engine metadata, which only ever lives in the
    // Refresh response, not persisted. 'realistic' is the documented
    // fallback (spec §4 "The engine defaults to realistic, and a batch can
    // choose retro").
    engine: typeof engine === 'string' && engine ? engine : 'realistic',
    phrase: subjects.entityPhrase(db, subjectKind, subjectKey, slot),
    take: await nextSfxTake(db, subjectKind, subjectKey, slot),
  };
}

// Store and bind every variant the box returned for ONE (subject, slot).
// Shared by the single-cue and pack paths, so a clip made either way has the
// same label (take suffix), provenance columns and binding.
//
// Review round 1, fix 1: storeAndBindClip can throw on any ONE variant
// (e.g. a transient DB error) without the box call having wasted the other
// variants' GPU time. Catch per variant so a mid-loop failure neither loses
// the variants that DID commit nor throws out as an uncaught exception
// (which the route would turn into a bare 500, telling the caller "generate
// again" and piling up more clips on top of the ones that already landed).
async function storeSfxVariants(db, provider, {
  subjectKind, subjectKey, slot, cue, engine, take, clips: variants, prompt, seed,
}, { lib }) {
  const clips = [];
  const bindings = [];
  let firstStoreError = null;
  for (const c of variants) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const { clip, binding } = await lib.storeAndBindClip(db, {
        buffer: c.buffer, kind: 'sfx', label: sfxClipLabel(subjectKey, slot, cue, take),
        source: 'generated', providerId: provider.id ?? null, prompt, styleOrCue: cue,
        engine, seed, durationMs: c.durationMs,
      }, { subjectKind, subjectKey, slot }, { bind: lib.bindClip });
      clips.push(clip);
      bindings.push(binding);
    } catch (err) {
      if (!firstStoreError) firstStoreError = err;
    }
  }
  if (!clips.length) {
    return {
      ok: false, error: firstStoreError ? firstStoreError.message : 'no sfx variant could be stored', retryable: false,
    };
  }
  // `clip`/`binding` (the first stored variant) are exposed alongside
  // `clips`/`bindings` so the dispatcher's result.clip.id-based complete()
  // path works the same for sfx as for music/ambience.
  const result = {
    ok: true, clips, bindings, clip: clips[0], binding: bindings[0], seed,
  };
  if (firstStoreError) {
    // Some, but not all, variants stored -- the caller (route) must see this
    // rather than a bare 201 that looks identical to a full success, or an
    // admin re-generating "the missing ones" would pile up more clips on
    // top of the ones that already landed.
    result.partial = true;
    result.error = firstStoreError.message;
  }
  return result;
}

// SFX branch of generateForSlot (game audio slice 3, Task 3).
async function generateSfxForSlot(db, provider, spec, { rap, lib }) {
  const { subjectKind, subjectKey, slot } = spec;
  const seed = Number.isInteger(spec.seed) ? spec.seed : randomSeed();
  const variants = Number.isInteger(spec.variants) && spec.variants >= 1 && spec.variants <= 5
    ? spec.variants : DEFAULT_SFX_VARIANTS;

  const req = await sfxRequestFor(db, provider, {
    subjectKind, subjectKey, slot, engine: spec.engine,
  });
  if (!req.ok) return req;
  const { cue, engine, phrase } = req;
  const target = { subjectKind, subjectKey, slot };

  // A cached answer is stored unless it is a true duplicate (see
  // DUPLICATE_PREFIX); a duplicate steps to the next take, a bounded number
  // of times.
  const firstTake = req.take;
  for (let take = firstTake; take <= firstTake + MAX_EXTRA_DUPLICATE_TAKES; take += 1) {
    // eslint-disable-next-line no-await-in-loop
    const gen = await rap.generateSfx(provider, {
      cue, entity: sfxEntityText(phrase, take), engine, variants, seed,
    });
    if (!gen.ok) {
      return {
        ok: false, error: gen.error, retryable: Boolean(gen.retryable), status: gen.status, providerFault: Boolean(gen.providerFault),
      };
    }
    // eslint-disable-next-line no-await-in-loop
    const fresh = await freshVariants(db, lib, target, gen.clips, gen.cached);
    if (fresh.length) {
      return storeSfxVariants(db, provider, {
        ...target, cue, engine, take, clips: fresh, prompt: gen.prompt, seed: gen.seed,
      }, { lib });
    }
  }
  return {
    ok: false,
    duplicate: true,
    retryable: true,
    error: `${DUPLICATE_PREFIX} (takes ${firstTake}-${firstTake + MAX_EXTRA_DUPLICATE_TAKES}); upload a sound or bind one from the library instead`,
  };
}

// A pack result row is matched back to its job by what the box echoes --
// (cue, entity) -- never by its position in the response (Task 3 review: the
// box's rows carry the echoed cue/entity, not the request index).
const packKey = (cue, entity) => `${cue}\u0000${entity}`;

// The pack path of the batch drain (spec §2 "Packing"): ONE sfx-pack request
// for several queued sfx jobs of one drain group. Returns, without touching
// any job row (bookkeeping is the dispatcher's):
//   refused     [{job, result}]  -- upload-only / cue not offered; never sent
//   sent        [{job, cue, entity, engine, take}] -- what went in the request
//   packFailure the adapter's whole-request failure, when the box refused the
//               pack as a whole (busy, a fault, an unknown cue); `results`
//               is then empty and every `sent` job is still undecided
//   results     [{job, result}]  -- one per `sent` job, generateForSlot's
//               result shape: stored clips, or {ok:false, error, retryable,
//               providerFault}
//
// Two jobs whose (cue, entity) would coincide within one pack (two subjects
// whose phrases match, e.g. creature names differing only in case) could
// not be told apart in the response. The later one's take is bumped until
// its entity text is unique within the pack: a higher take is still a fresh
// entity for the box, and its label records that take.
async function generateSfxPackForJobs(db, provider, jobs, {
  rap = defaultRap, lib = defaultLib, seed: packSeed, variants = DEFAULT_SFX_VARIANTS,
} = {}) {
  const refused = [];
  const sent = [];
  const used = new Set();
  for (const job of jobs) {
    // eslint-disable-next-line no-await-in-loop
    const req = await sfxRequestFor(db, provider, {
      subjectKind: job.subject_kind, subjectKey: job.subject_key, slot: job.slot, engine: job.engine,
    });
    if (!req.ok) { refused.push({ job, result: req }); continue; }
    // A job whose last attempt came back a duplicate moves past that take.
    let take = Math.max(req.take, takeAfterDuplicate(job.last_error));
    while (used.has(packKey(req.cue, sfxEntityText(req.phrase, take)))) take += 1;
    const entity = sfxEntityText(req.phrase, take);
    used.add(packKey(req.cue, entity));
    sent.push({
      job, cue: req.cue, entity, engine: req.engine, take,
    });
  }
  if (!sent.length) return { refused, sent, results: [] };

  const seed = Number.isInteger(packSeed) ? packSeed : randomSeed();
  let pack;
  try {
    pack = await rap.generateSfxPack(provider, {
      items: sent.map(({ cue, entity, engine }) => ({ cue, entity, engine })), variants, seed,
    });
  } catch (err) {
    pack = { ok: false, error: err && err.message ? err.message : String(err), retryable: false };
  }
  if (!pack.ok) return { refused, sent, packFailure: pack, results: [] };

  // First row per (cue, entity) wins; a row with no cue (an error row the box
  // could not attribute) matches nothing and is ignored rather than crashing.
  const rows = new Map();
  for (const row of Array.isArray(pack.items) ? pack.items : []) {
    if (!row || typeof row.cue !== 'string') continue;
    const k = packKey(row.cue, row.entity);
    if (!rows.has(k)) rows.set(k, row);
  }

  const results = [];
  for (const s of sent) {
    const row = rows.get(packKey(s.cue, s.entity));
    let result;
    if (!row) {
      result = {
        ok: false, error: 'the box returned no result for this sfx pack item', retryable: true, providerFault: true,
      };
    } else if (!row.ok) {
      result = {
        ok: false, error: row.error, retryable: Boolean(row.providerFault), providerFault: Boolean(row.providerFault),
      };
    } else {
      const target = { subjectKind: s.job.subject_kind, subjectKey: s.job.subject_key, slot: s.job.slot };
      // A cached row is a file the box already had, which is NOT the same as
      // one this slot already has (see DUPLICATE_PREFIX).
      // eslint-disable-next-line no-await-in-loop
      const fresh = await freshVariants(db, lib, target, row.clips, row.cached);
      if (!fresh.length) {
        result = {
          ok: false, duplicate: true, retryable: true, error: duplicateError(s.take),
        };
      } else {
        // eslint-disable-next-line no-await-in-loop
        result = await storeSfxVariants(db, provider, {
          ...target,
          cue: s.cue,
          engine: s.engine,
          take: s.take,
          clips: fresh,
          prompt: row.prompt,
          seed: row.seed,
        }, { lib });
      }
    }
    results.push({ job: s.job, result });
  }
  return { refused, sent, results };
}

module.exports = {
  resolveAudioProvider,
  contextFor,
  boxTrackName,
  randomSeed,
  generateForSlot,
  generateSfxPackForJobs,
  sfxEntityText,
  takeAfterDuplicate,
  DEFAULT_SFX_VARIANTS,
  MAX_EXTRA_DUPLICATE_TAKES,
};
