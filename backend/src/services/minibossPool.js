'use strict';
// Minibosses in the wild population.
//
// The catalog has 41 minibosses ("Undead Miniboss", "Fallen Elite Miniboss" ...), one or two per creature
// family, built to be rare tougher spawns with better drops. They were never spawned: a world's
// allowed_creature_types lists only the plain rungs of its families ("Undead Line"), and population only
// places what is listed. Rather than hand-edit every map spec, a world that lists a family's Line also
// draws that family's minibosses, at a low weight so they stay rare.

// Weight of one candidate type in the placement draw, against 1 for an ordinary creature: with a Line, a
// Swarm and a Skirmisher on the list a miniboss is about one spawn in a hundred, an Elite one in three hundred.
const MINIBOSS_WEIGHT = 0.03;
const ELITE_MINIBOSS_WEIGHT = 0.01;

function isMiniboss(t) {
  return !!t && t.boss_tier === 'miniboss';
}

// The weight of one entity row (needs `name` and `boss_tier`) in a placement draw.
function typeWeight(t) {
  if (!isMiniboss(t)) return 1;
  return /Elite/.test(String(t.name)) ? ELITE_MINIBOSS_WEIGHT : MINIBOSS_WEIGHT;
}

// The miniboss names a world may draw, given its allowed_creature_types: "<Family> Miniboss" and
// "<Family> Elite Miniboss" for every "<Family> Line" on the list. A name the catalog does not have is
// harmless: the query that resolves these names simply does not return it.
function minibossNamesFor(allowedNames) {
  const out = new Set();
  for (const n of allowedNames || []) {
    const m = /^(.+) Line$/.exec(String(n));
    if (m) { out.add(`${m[1]} Miniboss`); out.add(`${m[1]} Elite Miniboss`); }
  }
  return [...out];
}

// allowed_creature_types plus the minibosses those families bring.
function withMinibosses(allowedNames) {
  return [...new Set([...(allowedNames || []), ...minibossNamesFor(allowedNames)])];
}

// One weighted pick. `r` in [0,1) is the SAME single draw the uniform pick used, so a world with no
// miniboss in its candidates (every weight 1) picks exactly the index it always did and an existing
// seed lays out unchanged.
function weightedPick(candidates, r) {
  let total = 0;
  for (const t of candidates) total += typeWeight(t);
  if (candidates.length === 1 || total === candidates.length) {
    return candidates[Math.min(candidates.length - 1, Math.floor(r * candidates.length))];
  }
  let acc = r * total;
  for (const t of candidates) {
    acc -= typeWeight(t);
    if (acc < 0) return t;
  }
  return candidates[candidates.length - 1];
}

module.exports = { MINIBOSS_WEIGHT, ELITE_MINIBOSS_WEIGHT, typeWeight, minibossNamesFor, withMinibosses, weightedPick, isMiniboss };
