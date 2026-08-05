// backend/src/services/dungeonGuards.js
// A portal's guard pack. Same structural-spawn shape villages.js already
// uses for its gate guards (a direct INSERT, faction resolved later via
// entity_types, never a random roll) -- extended with blocks_portal_id so
// the authority's portal-trigger check can gate on this specific pack's
// liveness. home_x/home_y is set to the same tile the guard is placed near,
// exactly like a village guard leashes to its post, so a displaced guard
// (knocked around, chasing) still recovers back to defending the portal.
//
// A pack of more than one guard is spread in a small ring around the portal
// tile rather than stacked on the identical pixel, matching how creature
// placement elsewhere in this codebase avoids exact-overlap spawns.
const RING_OFFSETS = [
  [0, 0], [60, 0], [-60, 0], [0, 60], [0, -60], [45, 45], [-45, 45], [45, -45],
];

async function insertPortalGuards(db, worldId, portalLinkId, x, y, creatureType, count) {
  for (let i = 0; i < count; i++) {
    const [dx, dy] = RING_OFFSETS[i % RING_OFFSETS.length];
    await db.query(
      `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, home_x, home_y, blocks_portal_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [worldId, creatureType, x + dx, y + dy, 300, 'S', x, y, portalLinkId],
    );
  }
}

module.exports = { insertPortalGuards };
