// Pure stone logic: kind classification, socket compatibility, and the
// destroy-on-removal roll. No DB access -- callers own all persistence.
const STONE_DESTROY_CHANCE = 0.10;

function stoneKind(itemTypeRow) {
  return itemTypeRow.element != null ? 'spell' : 'buff';
}

function isCompatible(kind, hostCategory) {
  if (kind === 'spell') return hostCategory === 'weapon';
  return hostCategory === 'weapon' || hostCategory === 'armor';
}

function rollDestroy(rng = Math.random) {
  return rng() < STONE_DESTROY_CHANCE;
}

module.exports = { STONE_DESTROY_CHANCE, stoneKind, isCompatible, rollDestroy };
