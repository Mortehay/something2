// The Sprite tab's prompt lane: which prompt a sprite subject is drawn from,
// and the Sprite tab's own edits to it (regenerate, save, revert).
//
// Stored in art_prompt_descriptions beside the art console's descriptions.
// Rows the Sprite tab writes carry origin = 'sprite'.
//
// THE RULE THAT MUST HOLD (controller ruling): a creature or hero appearance
// keeps today's sprite prompt (its template) until it is opted in from the
// Sprite tab, i.e. until it has EVER had an origin = 'sprite' version (recorded
// in sprite_prompt_optins by every Sprite-tab write). Once
// opted in it follows its ACTIVE description whichever tool wrote it. The art
// console has already described creatures for their static art; without the
// opt-in those descriptions would silently change every creature's sprite.
// Effects (vfx/aura/buff) are written only from the Sprite tab, so any active
// description counts.
//
// Revert (owner ruling) deactivates the active description WHATEVER wrote it,
// so the sprite lane is back on the template. The subject stays opted in (its
// sprite_prompt_optins row is never removed), so a later description is followed.
'use strict';

const desc = require('./artPromptDescriptions.js');
const catalogSubjects = require('./catalogSubjects.js');
const effectKinds = require('./effectKinds.js');
const effectCatalog = require('./effectCatalog.js');
const subjectDescriber = require('./subjectDescriber.js');

const PROMPT_KINDS = ['entity', 'character_appearance', 'vfx', 'aura', 'buff', 'status'];
const isEffect = (kind) => effectKinds.kindOf(kind) != null;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function assertKind(kind) {
  if (!PROMPT_KINDS.includes(kind)) throw httpError(400, `unknown prompt kind: ${kind}`);
}

// A buff is described by its skill's English name; its key stays the skill id.
const effectSubject = (kind, fx) => ({
  kind, key: fx.name, name: fx.nameEn || fx.name,
  basePrompt: effectCatalog.subjectPrompt(fx),
  row: { type: fx.kind },
});

// Every describer subject of a kind in this DB, keyed by subject key: one
// registry load (or one effect query) for a whole batch prompt phase.
// Entity / appearance: the art console's own list items (same basePrompt).
// Effect: every effect-list subject of the kind (vfx / aura rows, visual buffs), coloured
// from its row.
async function describerSubjects(db, kind) {
  assertKind(kind);
  if (isEffect(kind)) {
    const list = await effectCatalog.loadEffectCatalog(db);
    return new Map(list.filter((fx) => fx.subject_kind === kind).map((fx) => [fx.name, effectSubject(kind, fx)]));
  }
  const list = await catalogSubjects.registryFor(kind).list(db);
  return new Map(list.map((s) => [s.key, s]));
}

// One subject, or null when it is not in this DB. Same shape as
// describerSubjects gives.
async function describerSubject(db, kind, key) {
  assertKind(kind);
  if (isEffect(kind)) {
    const fx = await effectCatalog.findEffectSubject(db, kind, key);
    return fx ? effectSubject(kind, fx) : null;
  }
  return (await describerSubjects(db, kind)).get(key) || null;
}

// Subjects of a kind opted in from the Sprite tab (sprite_prompt_optins: one
// row per subject that has ever had a Sprite-tab version; it travels with seed
// sync, unlike the inactive versions that used to prove it).
async function optedIn(db, kind) {
  const { rows } = await db.query(
    'SELECT subject_key FROM sprite_prompt_optins WHERE subject_kind = $1',
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
      out.set(key, { prompt: a.text, source: 'description', descriptionId: a.id, origin: a.origin ?? null });
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
// propagate unchanged so the caller can wait and retry. A batch passes the
// `subject` it already loaded with describerSubjects.
// `timeoutMs` (the Sprite tab's per-row button) bounds the text-model call: on
// expiry it fails as busy and nothing is written, even if the model answers later.
async function regeneratePrompt(db, kind, key, { describer = subjectDescriber, subject: given = null, timeoutMs = null } = {}) {
  assertKind(kind);
  if (given && (given.kind !== kind || given.key !== key)) {
    throw httpError(400, `subject ${given.kind} "${given.key}" is not ${kind} "${key}"`);
  }
  const subject = given || await subjectOr404(db, kind, key);
  const asked = describer.describeSubject(db, subject, { length: 'medium', boxOnly: true, ...(timeoutMs ? { timeoutMs } : {}) });
  let timer = null;
  const { text, model } = await (timeoutMs
    ? Promise.race([asked, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(
        new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`), { busy: true, timedOut: true },
      )), timeoutMs);
    })]).finally(() => clearTimeout(timer))
    : asked);
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

// Back to the template: deactivates the active description whatever its
// origin (owner ruling). Older versions stay readable.
async function revertPrompt(db, kind, key) {
  assertKind(kind);
  const active = await desc.getActive(db, kind, key);
  if (!active) return { cleared: false, reason: 'none' };
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
  PROMPT_KINDS, describerSubject, describerSubjects, spritePromptsFor, regeneratePrompt, savePrompt,
  revertPrompt, promptSubjectOf,
};
