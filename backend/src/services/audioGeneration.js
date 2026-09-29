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

// The one generate → store → bind path (spec §2). The synchronous
// /admin/generate route and the batch drain both call this, so a clip made
// either way has the same label, provenance columns and binding.
async function generateForSlot(db, provider, spec, { rap = defaultRap, lib = defaultLib } = {}) {
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
  if (!gen.ok) return { ok: false, error: gen.error, retryable: Boolean(gen.retryable) };
  const clip = await lib.storeClip(db, {
    buffer: gen.buffer, kind: clipKind, label: `${subjectKey} ${slot}${style ? ` (${style})` : ''}`,
    source: 'generated', providerId: provider.id ?? null, prompt: gen.prompt, styleOrCue: style,
    seed: gen.seed, durationMs: gen.durationMs, loopStartMs: gen.loopStartMs, loopEndMs: gen.loopEndMs,
  });
  const binding = await lib.bindClip(db, {
    subjectKind, subjectKey, slot, clipId: clip.id,
  });
  return {
    ok: true, clip, binding, seed,
  };
}

module.exports = {
  resolveAudioProvider, contextFor, boxTrackName, randomSeed, generateForSlot,
};
