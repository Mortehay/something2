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
  // SOMET-332: an augment's bonus packet is currently applied on the MELEE
  // damage paths only (world.js's player branch and CreatureSim.applyMeleeArc).
  // The four projectile damage sites in projectiles.js do not read it yet.
  //
  // So this refuses the socket rather than accepting it and doing nothing.
  // A stone that visibly socketets into a bow and then adds no damage is the
  // silent-inertness failure this whole epic exists to remove; an explicit
  // refusal is a rule a player can see. Lift this the moment projectiles.js
  // applies the packet -- and the test that pins it will fail loudly, which is
  // the reminder.
  if (kind === 'augment') return hostCategory === 'weapon' && hostKind === 'melee';
  if (kind === 'spell') return hostCategory === 'weapon';
  return hostCategory === 'weapon' || hostCategory === 'armor';
}

function rollDestroy(rng = Math.random) {
  return rng() < STONE_DESTROY_CHANCE;
}

module.exports = { STONE_DESTROY_CHANCE, stoneKind, isCompatible, rollDestroy };
