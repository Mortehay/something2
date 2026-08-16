// Shared biome loader. Both the REST /chunk preview (index.js) and the
// authority's world load (authority/server.js) resolve a world's biome set
// through THIS function, for the same reason services/decorationDefs.js
// exists: the two must agree exactly, or the client renders terrain the
// server doesn't have and the player rubber-bands.
//
// Ordering is the subtle part. decorationDefs sorts by id because nothing
// authors that order; here the order IS authored -- worlds.biomes is the
// banding order, so biome i owns noise band i. Postgres returns rows in
// whatever order it likes, so the rows are re-sorted into the caller's name
// order here rather than trusted as they arrive.
async function loadBiomes(pool, names) {
  if (!Array.isArray(names) || names.length === 0) return [];
  const wanted = [];
  const seen = new Set();
  for (const n of names) {
    if (typeof n === 'string' && !seen.has(n)) { seen.add(n); wanted.push(n); }
  }
  if (wanted.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT id, name, terrain_tiles, flora_types, creature_types,
            palette, art_style, exclusions, color, creature_density
       FROM biomes
      WHERE name = ANY($1::text[])`,
    [wanted],
  );
  const byName = new Map(rows.map((r) => [r.name, r]));
  return wanted.map((n) => byName.get(n)).filter(Boolean);
}

module.exports = { loadBiomes };
