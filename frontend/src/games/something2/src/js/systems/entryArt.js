// SOMET-742. Which images the loading screen waits for. The whole catalogue is
// hundreds of images fetched 6 at a time, so waiting for all of it is not an
// option; these are the ones whose absence the player sees on arrival.

function artKeysOf(def) {
  if (!def) return [];
  const atlas = def.sprite && def.sprite.atlas_key;
  return [def.image, atlas].filter(Boolean);
}

function defsOf(catalogue) {
  if (!catalogue) return [];
  return Array.isArray(catalogue) ? catalogue : Object.values(catalogue);
}

// Known before the join, so waiting for these leaves no character standing in
// the world behind the screen. Ordered by what the player notices most: when
// the limit cuts the wait short, whatever is left is the least missed.
export function essentialArtKeys({ tileTypes, entityTypes, playerKey, playerAtlas } = {}) {
  const scenery = defsOf(entityTypes).filter((d) => d && d.isCreature === false);
  return [...new Set([
    playerKey, playerAtlas,
    ...scenery.filter((d) => d.pointKind).flatMap(artKeysOf),
    ...defsOf(tileTypes).flatMap(artKeysOf),
    ...scenery.filter((d) => !d.pointKind).flatMap(artKeysOf),
  ].filter(Boolean))];
}

// Creatures are only known after the join, when the character is already in the
// world: the caller keeps this wait short.
export function nearbyCreatureArtKeys({ creatures, entityTypes, x, y, radius }) {
  const types = new Set();
  for (const c of creatures) {
    if (Math.hypot(c.x - x, c.y - y) <= radius) types.add(c.type);
  }
  return [...new Set([...types].flatMap((type) => artKeysOf(entityTypes && entityTypes[type])))];
}
