// F-027/SOMET-207: tile_types.name is referenced by entity_types.spawn_tiles
// with no integrity check anywhere -- DELETE /api/tile-types/:id has no
// FK/consistency guard, and entity_types.spawn_tiles is untouched jsonb, so
// deleting a tile type silently orphans any entity type whose spawn_tiles
// still names it. The honest fix is server-side (block the delete with a 409
// listing referencing rows, or cascade-strip the name -- same defect class
// as F-005/F-048, a different trigger: tile delete vs entity rename). That is
// out of scope here; these are the bounded client-side helpers: warn the
// admin by name before the delete, and surface a reference that already went
// dangling instead of an admin UI that just silently omits it.

// Entity types whose spawn_tiles still names `tileName` -- used to warn
// before deleting that tile type.
export function entityTypesReferencingTile(tileName, entityTypes) {
  return (entityTypes || [])
    .filter(e => (e.spawn_tiles || []).includes(tileName))
    .map(e => e.name);
}

// Entries in `spawnTiles` that no longer name a live tile type. Before this,
// EntityTypesAdmin's Spawn Tiles checklist only iterated the live tileTypes
// list, so a dangling reference was invisible and un-removable -- any Save
// Changes just re-sent the untouched array forever.
export function orphanedSpawnTiles(spawnTiles, tileTypes) {
  const live = new Set((tileTypes || []).map(t => t.name));
  return (spawnTiles || []).filter(name => !live.has(name));
}
