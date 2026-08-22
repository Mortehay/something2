// Pure stone logic: kind classification, socket compatibility, and the
// destroy-on-removal roll. No DB access -- callers own all persistence.
const STONE_DESTROY_CHANCE = 0.10;

// SOMET-332 added a third kind. Checked BEFORE the element test, because an
// augment stone also carries an element and would otherwise classify as a
// spell stone -- which is exactly how it would end up in the replace path.
function stoneKind(itemTypeRow) {
  if (itemTypeRow.stone_mode === 'augment') return 'augment';
  return itemTypeRow.element != null ? 'spell' : 'buff';
}

// `hostKind` is the host weapon's item_types.kind ('melee' | 'projectile'),
// needed only by the augment rule below. Optional so existing callers that
// pass two arguments keep their exact behaviour.
function isCompatible(kind, hostCategory, hostKind = null) {
  // SOMET-343 LIFTED the melee-only restriction SOMET-332 imposed here.
  //
  // That restriction existed because the four projectile damage sites in
  // projectiles.js did not read the augment packet, so a stone socketed into a
  // bow would have added nothing -- and an explicit refusal beats silent
  // inertness. All four now apply it (see applyCreatureAugment /
  // applyPlayerAugment there), so an augment is compatible with any weapon.
  //
  // `hostKind` is retained in the signature: it is what a future kind-specific
  // rule would key on, and removing it would silently change every caller's
  // arity back.
  if (kind === 'augment') return hostCategory === 'weapon';
  if (kind === 'spell') return hostCategory === 'weapon';
  return hostCategory === 'weapon' || hostCategory === 'armor';
}

function rollDestroy(rng = Math.random) {
  return rng() < STONE_DESTROY_CHANCE;
}

module.exports = { STONE_DESTROY_CHANCE, stoneKind, isCompatible, rollDestroy };
