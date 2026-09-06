// Pure helpers for the Maps tab's collapsed/grouped/filtered world list
// (SOMET-554). Split out for the same reason entityFilters.js was: frontend
// vitest runs in a node environment with no DOM (see .ai/styleguides/frontend.md),
// so MapsAdmin.jsx itself cannot be rendered in a test and any logic left inside
// it is untestable.
//
// Why the list needed grouping at all: the tab used to render every bounded
// world as a fully-expanded card. On the dev database that is 100 cards, each
// carrying 293 creature checkboxes, 32 biome checkboxes and four <select>s of
// ~99 options -- roughly 72,500 form controls, plus two XHRs per card. The page
// froze on load.

// Worlds are named "Region: Place" by the map specs -- "The Rimevault: Sealed
// Core", "The Sunscar Hollows: Threshold". That prefix is the only grouping key
// the data actually carries; there is no region column. Worlds seeded before
// the region specs (and one-off overworld maps) have no colon and get no region.
export function regionOf(name) {
  if (typeof name !== 'string') return null;
  const i = name.indexOf(':');
  if (i <= 0) return null;
  const region = name.slice(0, i).trim();
  return region || null;
}

export const STANDALONE_GROUP = 'Standalone maps';

// Returns [{ region, worlds }] preserving the caller's world order within each
// group. Regions are ordered by first appearance rather than alphabetically so
// the list stays stable as worlds are added -- /api/worlds sorts by created_at
// DESC, so newest regions surface first, which is what an admin editing recent
// content wants. STANDALONE_GROUP is always last regardless of when its first
// member appeared: it is a catch-all, not a region, and floating it to the top
// because one old map happens to be newest would be noise.
export function groupWorldsByRegion(worlds) {
  const groups = new Map();
  const standalone = [];
  for (const world of worlds || []) {
    const region = regionOf(world?.name);
    if (region === null) {
      standalone.push(world);
      continue;
    }
    if (!groups.has(region)) groups.set(region, []);
    groups.get(region).push(world);
  }
  const out = [...groups.entries()].map(([region, ws]) => ({ region, worlds: ws }));
  if (standalone.length) out.push({ region: STANDALONE_GROUP, worlds: standalone });
  return out;
}

// Case-insensitive substring match on the world's own name. The region prefix is
// part of `name`, so typing "Rimevault" matches every world in that region for
// free -- there is deliberately no separate region-matching branch to keep the
// two from disagreeing.
export function filterWorlds(worlds, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return worlds || [];
  return (worlds || []).filter((w) => (w?.name || '').toLowerCase().includes(q));
}

// Which region groups start open. Collapsed-by-default is what makes the tab
// cheap, but opening none of them leaves an admin staring at 39 closed headers
// with no idea where the world they care about lives -- so the entry world's
// region opens, since that is the map players actually spawn into and the one
// most likely to be edited.
//
// While a filter is active every group with a surviving world opens instead:
// a search that returns hits you cannot see reads as a broken search.
export function defaultOpenGroups(groups, { filtered = false } = {}) {
  const open = new Set();
  for (const g of groups || []) {
    if (filtered) { open.add(g.region); continue; }
    if ((g.worlds || []).some((w) => w?.is_entry)) open.add(g.region);
  }
  return open;
}
