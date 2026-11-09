// The Sprite tab's prompt lane: which prompt a sprite subject is drawn from,
// and the Sprite tab's own edits to it (regenerate, save, revert).
//
// Stored in art_prompt_descriptions beside the art console's descriptions.
// Rows the Sprite tab writes carry origin = 'sprite'.
//
// THE RULE THAT MUST HOLD (controller ruling): a creature or hero appearance
// keeps today's sprite prompt (its template) until it is opted in from the
// Sprite tab, i.e. until it has EVER had an origin = 'sprite' version. Once
// opted in it follows its ACTIVE description whichever tool wrote it. The art
// console has already described creatures for their static art; without the
// opt-in those descriptions would silently change every creature's sprite.
// Effects (vfx/aura) are written only from the Sprite tab, so any active
// description counts.
'use strict';

const desc = require('./artPromptDescriptions.js');
const catalogSubjects = require('./catalogSubjects.js');
const effectSprites = require('./effectSprites.js');
const subjectDescriber = require('./subjectDescriber.js');

const PROMPT_KINDS = ['entity', 'character_appearance', 'vfx', 'aura'];
const EFFECT_KINDS = new Set(['vfx', 'aura']);
const isEffect = (kind) => EFFECT_KINDS.has(kind);

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function assertKind(kind) {
  if (!PROMPT_KINDS.includes(kind)) throw httpError(400, `unknown prompt kind: ${kind}`);
}

// The subject the describer is given, or null when it is not in this DB.
// Entity / appearance: the art console's own list item (same basePrompt).
// Effect: the batch-1 shape, coloured from its vfx_effects / aura_effects row.
async function describerSubject(db, kind, key) {
  assertKind(kind);
  if (isEffect(kind)) {
    const fx = effectSprites.subjectOf(kind, key);
    if (!fx) return null;
    const table = kind === 'aura' ? 'aura_effects' : 'vfx_effects';
    const { rows } = await db.query(`SELECT color FROM ${table} WHERE name = $1`, [key]);
    if (!rows[0]) return null;
    return {
      kind, key, name: key,
      basePrompt: effectSprites.defaultPrompt(key, rows[0].color),
      row: { type: fx.kind },
    };
  }
  const list = await catalogSubjects.registryFor(kind).list(db);
  return list.find((s) => s.key === key) || null;
}

// Subjects of a kind that have ever had a Sprite-tab version.
async function optedIn(db, kind) {
  const { rows } = await db.query(
    `SELECT DISTINCT subject_key FROM art_prompt_descriptions
      WHERE subject_kind = $1 AND origin = 'sprite'`,
    [kind],
  );
  return new Set(rows.map((r) => r.subject_key));
}

// The sprite prompt for every key in `templates` (key -> template prompt).
async function spritePromptsFor(db, kind, templates) {
  assertKind(kind);
  const [active, opted] = await Promise.all([
    desc.listActive(db, kind),
    isEffect(kind) ? null : optedIn(db, kind),
  ]);
  const out = new Map();
  for (const [key, template] of templates) {
    const a = active.get(key);
    if (a && (!opted || opted.has(key))) {
      out.set(key, { prompt: a.text, source: 'sprite', descriptionId: a.id, origin: a.origin ?? null });
    } else {
      out.set(key, { prompt: template, source: 'template', descriptionId: null, origin: null });
    }
  }
  return out;
}

async function subjectOr404(db, kind, key) {
  assertKind(kind);
  const subject = await describerSubject(db, kind, key);
  if (!subject) throw httpError(404, `${kind} "${key}" not found`);
  return subject;
}

// Ask the box's text model for a new prompt. Describer errors (busy included)
// propagate unchanged so the caller can wait and retry.
async function regeneratePrompt(db, kind, key, { describer = subjectDescriber } = {}) {
  const subject = await subjectOr404(db, kind, key);
  const { text, model } = await describer.describeSubject(db, subject, { length: 'medium', boxOnly: true });
  await desc.replace(db, kind, key, {
    text, length: 'medium', model, sourcePrompt: subject.basePrompt, origin: 'sprite',
  });
  return { text, model };
}

// A hand-edited prompt. Refused rather than truncated when too long.
async function savePrompt(db, kind, key, text) {
  assertKind(kind);
  const body = String(text == null ? '' : text).trim();
  if (body.length < 1 || body.length > desc.MAX_TEXT) {
    throw httpError(400, `prompt must be 1-${desc.MAX_TEXT} characters`);
  }
  const subject = await subjectOr404(db, kind, key);
  return desc.replace(db, kind, key, {
    text: body, model: null, sourcePrompt: subject.basePrompt, origin: 'sprite',
  });
}

// Back to the template. Never clears an art-console description of a creature
// or appearance: the Sprite tab does not own it.
async function revertPrompt(db, kind, key) {
  assertKind(kind);
  const active = await desc.getActive(db, kind, key);
  if (!active) return { cleared: false, reason: 'none' };
  if (!isEffect(kind) && active.origin !== 'sprite') return { cleared: false, reason: 'not-sprite' };
  return { cleared: await desc.clear(db, kind, key) };
}

// A sprite_sheets row's prompt subject. optionsForAppearance already sets
// `creature` to `Class:variant` for appearance rows.
function promptSubjectOf(spriteRow) {
  return {
    kind: spriteRow.appearance_variant == null ? 'entity' : 'character_appearance',
    key: spriteRow.creature,
  };
}

module.exports = {
  PROMPT_KINDS, describerSubject, spritePromptsFor, regeneratePrompt, savePrompt,
  revertPrompt, promptSubjectOf,
};
