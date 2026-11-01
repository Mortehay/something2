// Enchant scrolls that DROP: from creatures (rarely), chests (sometimes) and bosses (often).
//
// The odds live in services/enchant.js (`scrollDrops`), each source as { chance, max }:
// it rolls `max` independent times at `chance`, so a boss that is {0.5, 2} drops 0, 1 or 2
// scrolls (25% / 50% / 25%).
//
// HOW IT IS WIRED. Every call site takes an OPT-IN `scrollRng` and rolls nothing when it is
// absent. The production callers (server.js, bossLoot.js, worldBoss.js) pass Math.random; the
// hundreds of tests that pin an exact drop table pass nothing, so a scroll can never turn up in
// their expectations and no extra random number is drawn out of their seeded sequences.

const { ENCHANT_CONFIG } = require('../services/enchant.js');

const typeIdCache = new WeakMap();

// The scroll's item_types id in a loaded catalog (a Map id -> type), or null when the catalog
// has none (a fixture world, or a database the migration has not reached).
function scrollTypeId(itemTypes, cfg = ENCHANT_CONFIG) {
  if (!itemTypes || typeof itemTypes.values !== 'function') return null;
  const key = cfg.scrollItemName;
  let perCatalog = typeIdCache.get(itemTypes);
  if (!perCatalog) { perCatalog = new Map(); typeIdCache.set(itemTypes, perCatalog); }
  if (perCatalog.has(key)) return perCatalog.get(key);
  let found = null;
  for (const t of itemTypes.values()) if (t && t.name === key) { found = t.id; break; }
  perCatalog.set(key, found);
  return found;
}

// How many scrolls a `kind` of source ('creature' | 'chest' | 'boss') drops this time.
function scrollRollCount(kind, rng, cfg = ENCHANT_CONFIG) {
  const d = cfg.scrollDrops && cfg.scrollDrops[kind];
  if (!d || typeof rng !== 'function') return 0;
  let n = 0;
  for (let i = 0; i < d.max; i += 1) if (rng() < d.chance) n += 1;
  return n;
}

// Appends this chest opening's scrolls (if any) to `itemTypeIds` IN PLACE and returns the scroll's
// type id, or null when none can drop (no rng supplied, or the catalog has no scroll). The caller
// uses the returned id to recognise scroll entries and skip rarity/affix rolling for them.
function appendChestScrolls(itemTypeIds, itemTypes, scrollRng, cfg = ENCHANT_CONFIG) {
  const id = scrollRng ? scrollTypeId(itemTypes, cfg) : null;
  if (id == null) return null;
  for (let i = scrollRollCount('chest', scrollRng, cfg); i > 0; i -= 1) itemTypeIds.push(id);
  return id;
}

// Puts `count` scrolls on the ground at (x, y), one row each (the same one-row-per-unit shape
// creature drops use), and hands them to the world's ground-item index. `db` is a pool or a
// connected client mid-transaction. Returns the inserted rows.
async function spawnScrollsOnGround(db, entry, count, x, y, { ttlMs = 180000, cfg = ENCHANT_CONFIG } = {}) {
  if (!(count > 0)) return [];
  const typeId = scrollTypeId(entry && entry.world && entry.world.weapons, cfg);
  if (typeId == null) return [];
  const ids = Array.from({ length: count }, () => typeId);
  const ins = await db.query(
    `INSERT INTO world_items (world_id, item_type_id, x, y, expires_at, quantity)
     SELECT $1, t.item_type_id, $2, $3, now() + ($4::int * interval '1 millisecond'), 1
       FROM unnest($5::int[]) AS t(item_type_id)
     RETURNING id, item_type_id, x, y, expires_at, quantity`,
    [entry.worldId, Math.round(x), Math.round(y), ttlMs, ids],
  );
  entry.world.groundItems.add(ins.rows);
  return ins.rows;
}

module.exports = { scrollTypeId, scrollRollCount, appendChestScrolls, spawnScrollsOnGround };
