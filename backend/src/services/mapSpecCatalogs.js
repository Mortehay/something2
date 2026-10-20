// The two catalog reads validateMapSpec needs, identical to the ones
// scripts/seed-map.js's applyMapSpec performs. Kept here rather than imported
// from the seeding script so the world-gen routes (box download/seed and the
// SOMET-644 local fallback) do not depend on it for a read-only check.
async function mapSpecCatalogs(db) {
  const biomeRows = (await db.query('SELECT name, creature_types FROM biomes')).rows;
  return {
    biomeNames: new Set(biomeRows.map((r) => r.name)),
    biomeCreatureTypes: new Map(
      biomeRows.map((r) => [r.name, Array.isArray(r.creature_types) ? r.creature_types : []])),
    creatureTypeNames: new Set(
      (await db.query('SELECT name FROM entity_types WHERE is_creature = true')).rows.map((r) => r.name)),
  };
}

module.exports = { mapSpecCatalogs };
