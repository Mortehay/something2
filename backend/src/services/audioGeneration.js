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

async function contextFor(pool, subjectKind, subjectKey) {
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
  return subjects.entityPhrase(pool, subjectKind, subjectKey) || subjectKey;
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
// file). `take` is the count of clips already bound to the slot -- the ONLY
// lever that makes a regenerate differ from what's already there.
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
    const p = await rap.propose(provider, { context: await contextFor(db, subjectKind, subjectKey), kind: clipKind });
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

// SFX branch of generateForSlot (game audio slice 3, Task 3). Unlike
// music/ambience, the cue is never taken from the caller -- it is the
// registry's own answer for this (subjectKind, subjectKey, slot), and a slot
// with no cue on the box today (spec §4) is upload-only, refused before any
// box call. `take` is read fresh from the DB (a plain COUNT, not
// lib.subjectSlots' full binding+clip join, which this doesn't need) so a
// regenerate on an already-filled slot varies the entity text rather than
// silently returning the box's cached file for the old text.
async function generateSfxForSlot(db, provider, spec, { rap, lib }) {
  const { subjectKind, subjectKey, slot } = spec;
  const seed = Number.isInteger(spec.seed) ? spec.seed : randomSeed();
  const variants = Number.isInteger(spec.variants) && spec.variants >= 1 && spec.variants <= 5 ? spec.variants : 3;

  const cue = await subjects.cueFor(db, subjectKind, subjectKey, slot);
  if (!cue) return { ok: false, error: 'upload only: the provider has no cue for this slot', retryable: false };
  // The provider's own discovered allow-list (spec §2 "Cues": a provider's
  // Refresh writes 'cue:<name>' entries into models_cache) -- never send a
  // cue the box hasn't reported it knows about, even if the registry thinks
  // it exists (a stale registry entry vs. a provider that hasn't been
  // refreshed yet must fail the same way: upload only).
  const known = Array.isArray(provider.models_cache) && provider.models_cache.includes(`cue:${cue}`);
  if (!known) return { ok: false, error: `upload only: the provider has no cue '${cue}' registered`, retryable: false };

  const phrase = subjects.entityPhrase(db, subjectKind, subjectKey);
  // `engine` has no per-cue default available here: models_cache only holds
  // flattened 'cue:<name>' strings (see SettingsAdmin.jsx), not the box's
  // per-cue default_engine metadata, which only ever lives in the Refresh
  // response, not persisted. 'realistic' is the documented fallback (spec
  // §4 "The engine defaults to realistic, and a batch can choose retro").
  const engine = typeof spec.engine === 'string' && spec.engine ? spec.engine : 'realistic';

  const bound = await db.query(
    'SELECT COUNT(*)::int AS n FROM audio_bindings WHERE subject_kind = $1 AND subject_key = $2 AND slot = $3',
    [subjectKind, subjectKey, slot],
  );
  let take = bound.rows[0].n;

  let gen = await rap.generateSfx(provider, {
    cue, entity: sfxEntityText(phrase, take), engine, variants, seed,
  });
  // The box's cache hit (spec §2): the exact same file would come back again.
  // One retry with take+1 gives it a different entity string; whatever that
  // second call returns is accepted even if it is ALSO cached (e.g. someone
  // else generated that exact take already) -- this is a best-effort nudge,
  // not a loop hunting for a guaranteed-fresh file.
  if (gen.ok && gen.cached) {
    take += 1;
    gen = await rap.generateSfx(provider, {
      cue, entity: sfxEntityText(phrase, take), engine, variants, seed,
    });
  }
  if (!gen.ok) {
    return {
      ok: false, error: gen.error, retryable: Boolean(gen.retryable), status: gen.status, providerFault: Boolean(gen.providerFault),
    };
  }

  const clips = [];
  const bindings = [];
  for (const c of gen.clips) {
    // Store and bind ONE variant per transaction (spec/task: "storeAndBindClip
    // ... in ONE transaction per variant"), same reasoning as the music/
    // ambience path -- a partial failure here leaves whichever variants
    // already committed bound, rather than losing all of them.
    // eslint-disable-next-line no-await-in-loop
    const { clip, binding } = await lib.storeAndBindClip(db, {
      buffer: c.buffer, kind: 'sfx', label: `${subjectKey} ${slot} (${cue})`,
      source: 'generated', providerId: provider.id ?? null, prompt: gen.prompt, styleOrCue: cue,
      engine, seed: gen.seed, durationMs: c.durationMs,
    }, { subjectKind, subjectKey, slot }, { bind: lib.bindClip });
    clips.push(clip);
    bindings.push(binding);
  }
  // `clip`/`binding` (the first variant) are exposed alongside `clips`/
  // `bindings` so the dispatcher's existing result.clip.id-based complete()
  // path keeps working until it is rewritten for multi-clip sfx results.
  return {
    ok: true, clips, bindings, clip: clips[0], binding: bindings[0], seed: gen.seed,
  };
}

module.exports = {
  resolveAudioProvider, contextFor, boxTrackName, randomSeed, generateForSlot, sfxEntityText,
};
