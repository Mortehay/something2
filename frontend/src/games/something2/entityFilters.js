// Pure helpers for the Entity Types Registry's search/biome-tab/pagination
// UI. Split out because frontend vitest runs in a node environment with no
// DOM (see .ai/styleguides/frontend.md) -- EntityTypesAdmin.jsx itself can't
// be rendered in a test, so the filtering logic lives here where it can be.

// A biome's `flora_types`/`creature_types` arrays reference entity_types.name
// by string (see backend/seeds/data/biomes.js's header comment) -- there is
// no FK, so an entity "lives in" a biome purely by name membership in either
// list. Decorations (Tree, Stone, ...) show up via flora_types; creatures via
// creature_types; nothing stops an entity from being missing from both.
export function buildBiomeIndex(biomes) {
  const index = new Map(); // entity name -> Set<biome name>
  for (const biome of biomes || []) {
    const names = [...(biome.flora_types || []), ...(biome.creature_types || [])];
    for (const name of names) {
      if (!index.has(name)) index.set(name, new Set());
      index.get(name).add(biome.name);
    }
  }
  return index;
}

// Only biomes that actually reference at least one entity get a tab --
// P4 (SOMET-250) seeded 288 creature types with no biome placement yet, so
// most of the 33 biomes would otherwise render an always-empty tab.
export function biomesWithEntities(biomes, biomeIndex) {
  const referenced = new Set();
  for (const names of biomeIndex.values()) {
    for (const name of names) referenced.add(name);
  }
  return (biomes || [])
    .filter((b) => referenced.has(b.name))
    .map((b) => b.name)
    .sort((a, b) => a.localeCompare(b));
}

export const ALL_TAB = 'all';
export const UNASSIGNED_TAB = 'unassigned';

// activeTab is ALL_TAB, UNASSIGNED_TAB, or a biome name.
export function filterByBiomeTab(entityTypes, activeTab, biomeIndex) {
  if (activeTab === ALL_TAB) return entityTypes;
  if (activeTab === UNASSIGNED_TAB) {
    return entityTypes.filter((e) => !biomeIndex.has(e.name));
  }
  return entityTypes.filter((e) => biomeIndex.get(e.name)?.has(activeTab));
}

// Case-insensitive substring match on name. Blank/whitespace-only search
// returns every entity unfiltered rather than matching nothing.
export function filterBySearch(entityTypes, search) {
  const q = (search || '').trim().toLowerCase();
  if (!q) return entityTypes;
  return entityTypes.filter((e) => e.name.toLowerCase().includes(q));
}

// Clamps page into [1, totalPages] (never 0 or negative, never past the last
// page a shorter filtered list now has) rather than returning an empty slice
// when a filter shrinks the result set out from under the current page.
export function paginate(items, page, pageSize) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const clamped = Math.min(Math.max(1, page), totalPages);
  const start = (clamped - 1) * pageSize;
  return { pageItems: items.slice(start, start + pageSize), page: clamped, totalPages };
}
