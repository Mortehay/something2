'use strict';

// Which body each creature is drawn with, decided by the text LLM from its name
// and prompt. The prompts are often vague ("a lean beast creature"), so this is
// partly a guess: an admin's correction (source 'admin') is never overwritten.
const textProvider = require('./textProvider.js');

const BODY_PLANS = Object.freeze(['humanoid', 'quadruped', 'other']);
const CLASSIFY_CHUNK = 40;
// Both need hands, so the box refuses them on a four-legged body.
const QUADRUPED_EXCLUDED_ACTIONS = Object.freeze(['cast', 'use']);

const SYSTEM = [
  'You sort game creatures by body shape, for a sprite pipeline.',
  'Decide from what the creature IS. Size words such as towering, hulking, tiny or small say nothing about the shape.',
  'quadruped: the text names an animal that walks on four legs, such as a wolf, bear, boar, cat or lizard, or calls it a beast.',
  'other: the text names a body with no legs or many legs, such as a slime, serpent, insect, spider, swarm, bat, bird, floating spirit or an object.',
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
    const m = line.match(/(\d+)\s*[:=]\s*(humanoid|quadruped|other)\b/i);
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

module.exports = {
  BODY_PLANS, CLASSIFY_CHUNK, QUADRUPED_EXCLUDED_ACTIONS, classify, parseAnswer, actionsForBody,
};
