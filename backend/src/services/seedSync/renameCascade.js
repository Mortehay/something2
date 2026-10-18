// Name-based references (no FK) that follow a rename. Shared by the admin PUT
// routes (entity types, auras) and seed-sync apply, so a rename made by either
// leaves every referencing name exactly the same way. Every function runs on
// the caller's transactional `client`, in the SAME transaction as the renamed
// row's own UPDATE, and its queries run sequentially: a single pg Client can
// only run one query at a time (concurrent client.query() queuing is
// deprecated as of pg 8.x and removed in pg 9).

// SOMET-228: worlds.allowed_creature_types, world_creatures.type and
// biomes.flora_types/creature_types reference entity_types by NAME (no
// FK). SOMET-185 used to 409 a rename that would orphan any of these --
// safe, but it meant a typo'd name could never actually be fixed once
// referenced anywhere, short of hand-editing the DB. Instead: when a
// rename would orphan a reference, cascade-rewrite every referencing name
// in the SAME transaction as the entity_types row update, so the rename
// always succeeds and nothing is left inconsistent.
//
// Returns null when nothing referenced oldName, else
// { worlds, biomes, hadPlacedCreatures, dungeonBosses } (the admin PUT's
// renamedReferences). Caller guarantees oldName !== newName.
async function cascadeEntityRename(client, oldName, name) {
  const worldsRef = await client.query('SELECT id, name FROM worlds WHERE allowed_creature_types @> $1::jsonb', [JSON.stringify([oldName])]);
  const creaturesRef = await client.query('SELECT 1 FROM world_creatures WHERE type = $1 LIMIT 1', [oldName]);
  // biomes.flora_types / creature_types reference entity_types by name
  // with no FK, exactly like allowed_creature_types above.
  const biomesRef = await client.query(
    'SELECT id, name FROM biomes WHERE flora_types @> $1::jsonb OR creature_types @> $1::jsonb',
    [JSON.stringify([oldName])],
  );
  // SOMET-609: worlds.dungeon_boss names its boss entity by name, no FK.
  const bossRef = await client.query(
    "SELECT id, name FROM worlds WHERE dungeon_boss->>'entity' = $1",
    [oldName],
  );
  if (!(worldsRef.rows.length > 0 || creaturesRef.rows.length > 0 || biomesRef.rows.length > 0
    || bossRef.rows.length > 0)) {
    return null;
  }
  // Rewrite the ONE matching element inside each jsonb array, not the
  // whole array -- WITH ORDINALITY + `ORDER BY` keeps element order
  // stable, and jsonb_agg's per-element CASE leaves every other
  // element (including duplicates of a name that isn't oldName)
  // untouched. WHERE ... @> guarantees the source array actually
  // contains oldName, so jsonb_agg is never aggregating over zero
  // rows here (which would collapse to NULL and wipe the column).
  // Each cascade UPDATE only runs when its own reference check found
  // a match -- the three reference sites are independent, and a
  // rename referenced in only one of them shouldn't touch the other
  // two tables at all.
  let worldsCount = 0;
  let biomesCount = 0;
  if (worldsRef.rows.length > 0) {
    const worldsResult = await client.query(
      `UPDATE worlds
               SET allowed_creature_types = (
                 SELECT jsonb_agg(CASE WHEN elem.value = $1 THEN $2 ELSE elem.value END ORDER BY elem.ordinality)
                 FROM jsonb_array_elements_text(allowed_creature_types) WITH ORDINALITY AS elem(value, ordinality)
               )
               WHERE allowed_creature_types @> $3::jsonb`,
      [oldName, name, JSON.stringify([oldName])],
    );
    worldsCount = worldsResult.rowCount || 0;
  }
  if (creaturesRef.rows.length > 0) {
    await client.query(
      'UPDATE world_creatures SET type = $2 WHERE type = $1',
      [oldName, name],
    );
  }
  if (biomesRef.rows.length > 0) {
    // biomes has TWO reference arrays on the same row. Guard each
    // column's rewrite with its own containment check so a biome
    // that matches via flora_types but has an empty/absent
    // creature_types (or vice versa) doesn't have the untouched
    // column dragged through jsonb_agg over zero rows and collapsed
    // to NULL.
    const biomesResult = await client.query(
      `UPDATE biomes
               SET
                 flora_types = CASE WHEN flora_types @> $3::jsonb THEN (
                   SELECT jsonb_agg(CASE WHEN elem.value = $1 THEN $2 ELSE elem.value END ORDER BY elem.ordinality)
                   FROM jsonb_array_elements_text(flora_types) WITH ORDINALITY AS elem(value, ordinality)
                 ) ELSE flora_types END,
                 creature_types = CASE WHEN creature_types @> $3::jsonb THEN (
                   SELECT jsonb_agg(CASE WHEN elem.value = $1 THEN $2 ELSE elem.value END ORDER BY elem.ordinality)
                   FROM jsonb_array_elements_text(creature_types) WITH ORDINALITY AS elem(value, ordinality)
                 ) ELSE creature_types END
               WHERE flora_types @> $3::jsonb OR creature_types @> $3::jsonb`,
      [oldName, name, JSON.stringify([oldName])],
    );
    biomesCount = biomesResult.rowCount || 0;
  }
  // SOMET-609: rewrite only the `entity` key; x/y/respawn_s stay. The
  // checked-in p5 spec (scripts/dungeon/content.js) still names the
  // old entity, so a later seed-map re-inserts it unless the spec is
  // updated to follow.
  let bossCount = 0;
  if (bossRef.rows.length > 0) {
    const bossResult = await client.query(
      `UPDATE worlds SET dungeon_boss = jsonb_set(dungeon_boss, '{entity}', to_jsonb($2::text))
               WHERE dungeon_boss->>'entity' = $1`,
      [oldName, name],
    );
    bossCount = bossResult.rowCount || 0;
  }
  return {
    worlds: worldsCount,
    biomes: biomesCount,
    hadPlacedCreatures: creaturesRef.rows.length > 0,
    dungeonBosses: bossCount,
  };
}

// SOMET-604: an aura rename cascades into entity_types.auras (the SOMET-228
// entity-rename pattern) instead of 409ing -- a typo'd aura name must be
// fixable. Rewrites the ONE matching element, keeps order. Returns the number
// of entity types rewritten. Caller guarantees oldName !== newName.
async function cascadeAuraRename(client, oldName, newName) {
  const u = await client.query(
    `UPDATE entity_types SET auras = (
             SELECT jsonb_agg(CASE WHEN elem.value = $1 THEN $2 ELSE elem.value END ORDER BY elem.ord)
               FROM jsonb_array_elements_text(auras) WITH ORDINALITY AS elem(value, ord))
            WHERE auras ? $1`, [oldName, newName]);
  return u.rowCount;
}

module.exports = { cascadeEntityRename, cascadeAuraRename };
