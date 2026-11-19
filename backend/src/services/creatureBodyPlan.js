'use strict';

// Which body each creature is drawn with, decided by the text LLM from its name
// and prompt. The prompts are often vague ("a lean beast creature"), so this is
// partly a guess: an admin's correction (source 'admin') is never overwritten.
const textProvider = require('./textProvider.js');

// 'other' = a body with no poses yet (never drawn). blob and multileg are
// labels set from the concept picture; the box's catalog says whether it can draw them.
const BODY_PLANS = Object.freeze(['humanoid', 'quadruped', 'other', 'blob', 'multileg']);
// Bodies the box is told about, and whose echo it must return.
const NON_HUMANOID = Object.freeze(['quadruped', 'blob', 'multileg']);
const CLASSIFY_CHUNK = 40;
// Both need hands, so the box refuses them on a four-legged body.
const QUADRUPED_EXCLUDED_ACTIONS = Object.freeze(['cast', 'use']);

const SYSTEM = [
  'You sort game creatures by body shape, for a sprite pipeline.',
  'Decide from what the creature IS. Size words such as towering, hulking, tiny or small say nothing about the shape.',
  'quadruped: the text names an animal that walks on four legs, such as a wolf, bear, boar, cat or lizard, or calls it a beast.',
  'blob: the text names a body with no limbs that moves by squashing and stretching, such as a slime, ooze, jelly, or a mass of rock, mud or flesh.',
  'multileg: the text names a body with many legs or tentacles, such as a spider, crab, insect, centipede, scorpion or a tentacled horror.',
  'other: the text names a body that is none of these, such as a serpent, bat, bird, floating spirit or an object.',
  'humanoid: the text names an upright figure, such as a guard, warden, keeper, warrior, skeleton, giant, colossus or titan.',
  'undecided: the text names no kind of body, such as "a towering ice-touched creature". Do not guess: answer undecided.',
  'Answer one line per creature, exactly: <id>=<shape>. No other text.',
].join('\n');

function buildPrompt(creatures) {
  return creatures.map((c) => `${c.id}: ${c.name} - ${String(c.prompt || '').slice(0, 200)}`).join('\n');
}

// Line by line, because the box ignores json_schema. An "undecided", missing or
// unknown answer is left out, so that creature stays unset and draws as today.
function parseAnswer(text, creatures) {
  const ids = new Set(creatures.map((c) => c.id));
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/(\d+)\s*[:=]\s*(humanoid|quadruped|other|blob|multileg)\b/i);
    if (m && ids.has(Number(m[1]))) out.set(Number(m[1]), m[2].toLowerCase());
  }
  return out;
}

async function classify(db, creatures, { complete = textProvider.complete } = {}) {
  const r = await complete(db, {
    system: SYSTEM,
    prompt: buildPrompt(creatures),
    maxTokens: 16 * creatures.length + 32,
    temperature: 0,
  });
  if (!r.ok) {
    const err = new Error(r.error || 'text provider failed');
    err.busy = Boolean(r.busy);
    throw err;
  }
  return parseAnswer(r.text, creatures);
}

// The chosen actions for a body; a four-legged row drops the ones it cannot do.
function actionsForBody(actions, bodyPlan) {
  if (bodyPlan !== 'quadruped') return actions;
  const kept = actions.filter((a) => !QUADRUPED_EXCLUDED_ACTIONS.includes(a));
  return kept.length ? kept : ['idle'];
}

// The chosen actions the connector's live catalog has poses for on this body.
// A NULL body is drawn as humanoid; a catalog entry without body_plans is
// humanoid-only (an older box, or the HQ lane).
function catalogActionsForBody(actions, bodyPlan, catalogActions) {
  const body = bodyPlan || 'humanoid';
  const plansOf = new Map((catalogActions || []).map((a) => [a.id, Array.isArray(a.body_plans) ? a.body_plans : ['humanoid']]));
  return actions.filter((a) => (plansOf.get(a) || []).includes(body));
}

// A sheet with no body echo was drawn as humanoid, so no echo, NULL and
// 'humanoid' are one body.
const asBody = (b) => b || 'humanoid';
function sameBody(a, b) {
  return asBody(a) === asBody(b);
}

module.exports = {
  NON_HUMANOID, catalogActionsForBody, sameBody,
  BODY_PLANS, CLASSIFY_CHUNK, QUADRUPED_EXCLUDED_ACTIONS, classify, parseAnswer, actionsForBody,
};
