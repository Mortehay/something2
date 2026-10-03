// backend/src/services/audioPromptWriter.js
//
// Writes ONE audio slot's prompt with the text model and stores it (spec
// 2026-09-30 §5). Two contracts:
//   music/ambience -> { style, prompt }: style constrained by the JSON
//     schema's enum to the box's own styles for that clip kind, and checked
//     again here (a model that ignores the schema is the case to survive).
//   sfx -> { entity }: a short phrase for the SOURCE of the sound, the same
//     shape as the box's own cue defaults ("a steel sword", "an old wooden
//     chest"). The cue already carries the action.
//
// NEVER OVER A CHANGE (final review I1). A write takes seconds to minutes and
// the batch picks its slots from a snapshot a day old, so the caller passes
// `expectActiveId` -- the active row id it saw (null = none) -- and the store
// refuses the save with a 409 if the slot changed meanwhile; that comes back
// as { conflict: true }. undefined skips the check (a caller that wants the
// model answer to win regardless).
//
// One retry for a malformed answer, none for a provider failure: a busy box
// is the caller's to handle (batch waits or falls back), and retrying it here
// would only double the wait.
const defaultTp = require('./textProvider');
const defaultStore = require('./audioPrompts');
const { buildContext, worldMusicStyle } = require('./audioPromptContext');
const { slotKind } = require('./audioSubjects');
const aiProviders = require('./aiProviders');
const defaultRap = require('./remoteAudioProvider');

const TEMPERATURE = () => {
  const raw = parseFloat(process.env.AUDIO_PROMPT_TEMPERATURE);
  return Number.isFinite(raw) ? raw : 0.15;
};

// The box does not enforce json_schema (live 2026-10-04: every music answer
// was {"prompt": ...} with no style), so each prompt spells out the keys. Music
// and ambience are separate prompts because a shared one made "music" answers
// describe ambience ("icy wind", "dripping water").
const JSON_KEYS = 'Answer only with a JSON object with exactly two keys: '
  + '{"style": "<one name from the allowed list, copied exactly>", "prompt": "<the prompt>"}.';

const SYSTEM_MUSIC = [
  'You write prompts for a background-score generator in a medieval fantasy RPG.',
  'Pick ONE style from the allowed list, then write a prompt of at most 40 words:',
  'the instruments, melody and harmony, tempo, mood and texture of the piece.',
  'Describe only instruments and playing, never weather, water, animals or other',
  'environmental sounds. No lyrics, no vocals, no artist or song names,',
  'no sentences about the game -- only what should be heard.',
  JSON_KEYS,
].join(' ');

const SYSTEM_AMBIENCE = [
  'You write prompts for an environmental-sound generator in a medieval fantasy RPG.',
  'Pick ONE style from the allowed list, then write a prompt of at most 40 words:',
  'the sound sources of the place (wind, water, birds, insects, fire, crowd, machinery),',
  'how near or far they are, and how dense. Never instruments, melody or a tune.',
  'No voices speaking words, no sentences about the game -- only what should be heard.',
  JSON_KEYS,
].join(' ');

const SYSTEM_SFX = [
  'You write the "entity" phrase for a sound-effect generator in a medieval fantasy RPG.',
  'The sound cue (hit, death, slash, spell, waypoint...) is fixed; describe the SOURCE',
  'of the sound in at most 10 words: what it is made of, how big, what voice it has.',
  'Examples: "a heavy iron mace", "a small bat with papery wings", "an old stone shrine humming".',
  'No verbs about the action, no sentences.',
  'Answer only with a JSON object with exactly one key: {"entity": "<the phrase>"}.',
].join(' ');

function schemaFor(clipKind, styles) {
  if (clipKind === 'sfx') {
    return {
      type: 'object', properties: { entity: { type: 'string' } }, required: ['entity'], additionalProperties: false,
    };
  }
  return {
    type: 'object',
    properties: { style: { type: 'string', enum: styles }, prompt: { type: 'string' } },
    required: ['style', 'prompt'],
    additionalProperties: false,
  };
}

// -> { style, text } | null
function validate(clipKind, json, styles) {
  if (!json || typeof json !== 'object') return null;
  if (clipKind === 'sfx') {
    const text = typeof json.entity === 'string' ? json.entity.trim() : '';
    return text ? { style: null, text } : null;
  }
  const text = typeof json.prompt === 'string' ? json.prompt.trim() : '';
  if (!text || !styles.includes(json.style)) return null;
  return { style: json.style, text };
}

async function loadStyles(db, { rap = defaultRap } = {}) {
  const provider = await aiProviders.loadActiveProviderWithSecret(db, 'audio');
  if (!provider) return { music: [], ambience: [] };
  const r = await rap.listStyles(provider);
  if (!r.ok) return { music: [], ambience: [] };
  // slots[style] = { featured: [...], mood: [...] }: the box's own choices for
  // each style, used to give each world a lead instrument and mood.
  const values = (slot) => (slot && Array.isArray(slot.values) ? slot.values : []);
  return {
    music: r.styles.filter((s) => s.kind === 'music').map((s) => s.value),
    ambience: r.styles.filter((s) => s.kind === 'ambience').map((s) => s.value),
    slots: Object.fromEntries(r.styles.map((s) => [s.value, {
      featured: values(s.slots && s.slots.featured), mood: values(s.slots && s.slots.mood),
    }])),
  };
}

// A stable pick from `list` for `key`: the same world always gets the same
// lead instrument, and different worlds spread across the list.
function stablePick(list, key) {
  if (!list || !list.length) return null;
  let h = 0;
  for (const ch of String(key)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return list[h % list.length];
}

// World music: the style comes from worldMusicStyle, not the model (live
// 2026-10-04: the model chose "dungeon" for 18 of 20 worlds). Null when the
// rule's style is not one the box offers -- then the model chooses as before.
function fixedMusic(catalog, kind, key, clipKind, allowed, styles) {
  if (clipKind !== 'music' || kind !== 'world') return null;
  const style = worldMusicStyle(catalog.worlds.get(key), key);
  if (!style || !allowed.includes(style)) return null;
  const slots = (styles && styles.slots && styles.slots[style]) || {};
  return { style, lead: stablePick(slots.featured, key), mood: stablePick(slots.mood, `${key}|mood`) };
}

async function writeSlotPrompt(db, {
  kind, key, slot, hint = null,
}, {
  tp = defaultTp, store = defaultStore, catalog, styles, cue = null, boxOnly = false, expectActiveId,
} = {}) {
  const clipKind = slotKind(kind, slot);
  if (!clipKind) return { ok: false, error: 'unknown subject or slot' };
  const context = buildContext(catalog, kind, key, slot, { cue });
  if (!context) return { ok: false, error: 'unknown subject' };
  let allowed = clipKind === 'sfx' ? [] : (styles && styles[clipKind]) || [];
  if (clipKind !== 'sfx' && !allowed.length) {
    return { ok: false, error: `no ${clipKind} styles known -- add/refresh the audio provider first` };
  }
  const cleanHint = typeof hint === 'string' && hint.trim() ? hint.trim().slice(0, 200) : null;
  const fixed = fixedMusic(catalog, kind, key, clipKind, allowed, styles);
  if (fixed) allowed = [fixed.style];
  const request = {
    system: { sfx: SYSTEM_SFX, ambience: SYSTEM_AMBIENCE }[clipKind] || SYSTEM_MUSIC,
    prompt: [
      `Clip kind: ${clipKind}`,
      fixed ? `Style: ${fixed.style} (fixed)` : null,
      fixed && fixed.lead ? `Lead instrument: ${fixed.lead}` : null,
      fixed && fixed.mood ? `Mood: ${fixed.mood}` : null,
      clipKind === 'sfx' || fixed ? null : `Allowed styles: ${allowed.join(', ')}`,
      `Subject: ${context}`,
      cleanHint ? `Admin hint: ${cleanHint}` : null,
    ].filter(Boolean).join('\n'),
    jsonSchema: schemaFor(clipKind, allowed),
    temperature: TEMPERATURE(),
    maxTokens: clipKind === 'sfx' ? 48 : 160,
  };
  let last = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await tp.complete(db, request, { boxOnly });
    if (!r.ok) return { ok: false, error: r.error, busy: Boolean(r.busy), via: r.via };
    const good = validate(clipKind, r.json, allowed);
    if (good) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const row = await store.save(db, kind, key, slot, {
          style: good.style, text: good.text, sourceInput: context, hint: cleanHint, model: r.model, via: r.via,
        }, { expectActiveId });
        return { ok: true, row };
      } catch (err) {
        if (err && err.status === 409) {
          return {
            ok: false, conflict: true, busy: false, via: r.via, error: err.message,
          };
        }
        return {
          ok: false, busy: false, via: r.via, error: `could not store the prompt: ${err.message}`,
        };
      }
    }
    last = r;
  }
  return {
    ok: false, error: `the model did not return a usable ${clipKind === 'sfx' ? 'entity' : 'style + prompt'} (twice)`, busy: false, via: last && last.via,
  };
}

module.exports = {
  writeSlotPrompt, loadStyles, SYSTEM_MUSIC, SYSTEM_AMBIENCE, SYSTEM_SFX,
};
