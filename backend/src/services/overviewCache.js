// backend/src/services/overviewCache.js
// The /overview minimap endpoint's response cache (GET /api/worlds/:id/overview
// in index.js), extracted into its own leaf module so authority-side chest
// mutation paths can invalidate it too.
//
// Why extracted: `worldOverviewCache`/`clearOverviewCache` used to live in
// index.js alongside the route that reads them, and every existing
// invalidation call site (village create/delete, doorway link create/delete,
// invalidateWorld) is already in index.js -- so that was fine until Task 6b
// added chest markers (including `state`) to the payload. A chest's `state`
// changes from two OTHER call sites -- authority/chestLoot.js's openChest and
// services/chests.js's respawnDueFieldChests -- neither of which can
// `require('../index.js')` to reach a index.js-local function: index.js
// requires authority/server.js (attachAuthority), which requires
// chestLoot.js, so requiring index.js back from there would be a circular
// require (and index.js's own module.exports wouldn't even be fully built
// yet at that point in the require graph). Pulling the cache + its
// invalidation function out to a dependency-free leaf module lets index.js,
// chestLoot.js, and services/chests.js all import the SAME singleton Map
// without any cycle.
//
// Unlike worldPreviewCache (one entry per world, stays in index.js -- every
// mutation path that needs to clear it is already there), a roaming player
// can mint one overview entry per 64-tile snap region, unbounded across every
// world/player on a long-running server -- so this cache needs a size cap
// (SOMET minimap HUD final review). boundedCacheSet (index.js) enforces that
// cap on insert; this module owns only the Map and the keyed clear.
const worldOverviewCache = new Map(); // "worldId:snappedCol:snappedRow" -> payload

function clearOverviewCache(worldId) {
  for (const key of worldOverviewCache.keys()) {
    if (key.startsWith(`${worldId}:`)) worldOverviewCache.delete(key);
  }
}

module.exports = { worldOverviewCache, clearOverviewCache };
