// World point art (SOMET-581). Which entity type draws a portal, waypoint,
// village post or chest. Three concerns, one file, because they must agree
// on the kind names:
//   - resolution (pure): instance binding -> kind default -> null
//   - catalog loaders for the authority (defaults) and the validator (names)
//   - seed convergence: every instance a spec touches is written, NULL when
//     the spec is silent, so the spec stays the source of truth (memory:
//     spec-beats-migration-on-reseed).
//
// Imports nothing from the authority (the authority requires this).
const { VILLAGE_POST_KINDS, villageArtColumn } = require('../../seeds/data/pointTypes.js');
// SOMET-576: reuse mapSpec.js's villagesOf rather than keep a private copy.
// The private copy here concatenated `village` AND `villages` when both were
// present; mapSpec's version (shared by the validator and scripts/seed-map.js)
// treats `villages` as authoritative and ignores `village` whenever `villages`
// is an array. Two different answers for "which villages does this world
// have" is exactly the kind of drift VILLAGE_LIMITS is already shared to
// avoid -- see mapSpec.js's own comment on this function. mapSpec.js is
// already required by seed-map.js at import time, so this adds no new
// require-time cost.
const { villagesOf } = require('../../seeds/mapSpec.js');

function chestPointKind(chestKind) {
  if (chestKind === 'vault') return 'chest_vault';
  if (chestKind === 'field') return 'chest_field';
  throw new Error(`unknown chest kind "${chestKind}"`);
}

// `defaults` is Map<kind, entity type name>. Returns a NAME, not an id: the
// client resolves names against the /api/map/config catalog it already holds.
function resolvePointArt(kind, instanceArt, defaults) {
  if (typeof instanceArt === 'string' && instanceArt !== '') return instanceArt;
  const d = defaults && typeof defaults.get === 'function' ? defaults.get(kind) : null;
  return typeof d === 'string' && d !== '' ? d : null;
}

async function loadPointKindDefaults(db) {
  const r = await db.query(
    `SELECT k.kind, e.name
       FROM world_point_kinds k
       LEFT JOIN entity_types e ON e.id = k.default_entity_type_id
      ORDER BY k.kind ASC`,
  );
  return new Map(r.rows.filter((row) => row.name).map((row) => [row.kind, row.name]));
}

async function loadPointTypeNames(db) {
  const r = await db.query(
    'SELECT name, point_kind FROM entity_types WHERE point_kind IS NOT NULL ORDER BY id ASC',
  );
  return new Map(r.rows.map((row) => [row.name, row.point_kind]));
}

// Seed convergence. `idByKey` is seed-map's Map<world key, world id>. Runs
// AFTER the portal, waypoint, village and chest passes so every row exists.
// Portal rows are addressed by tile because setPortalLink writes the mirror
// row itself and only returns the forward id.
async function applyPointArt(client, spec, idByKey) {
  const types = new Map(
    (await client.query('SELECT id, name, point_kind FROM entity_types WHERE point_kind IS NOT NULL')).rows
      .map((r) => [r.name, { id: r.id, kind: r.point_kind }]),
  );
  // Validated up front so a bad spec writes nothing (the caller's transaction
  // would roll back anyway; this keeps the error at the first bad name).
  const idFor = (name, kind, label) => {
    if (name === undefined || name === null) return null;
    const t = types.get(name);
    if (!t || t.kind !== kind) throw new Error(`${label}: "${name}" is not a ${kind} type`);
    return t.id;
  };

  const n = { portals: 0, waypoints: 0, villages: 0, chests: 0 };
  const links = Array.isArray(spec.links) ? spec.links : [];
  const worlds = Array.isArray(spec.worlds) ? spec.worlds : [];

  for (const l of links) {
    if (l.kind !== 'portal') continue;
    const typeId = idFor(l.art, 'portal', `portal link ${l.from}->${l.to} art`);
    const sql = `UPDATE map_links SET entity_type_id = $4
                  WHERE from_world_id = $1 AND edge = 'PORTAL' AND from_x = $2 AND from_y = $3`;
    await client.query(sql, [idByKey.get(l.from), l.from_x, l.from_y, typeId]);
    await client.query(sql, [idByKey.get(l.to), l.to_x, l.to_y, typeId]);
    n.portals += 1;
    if (l.is_waypoint === true) {
      const wpId = idFor(l.waypoint_art, 'waypoint', `portal link ${l.from}->${l.to} waypoint_art`);
      await client.query('UPDATE waypoints SET entity_type_id = $2 WHERE name = $1', [l.waypoint_name, wpId]);
      n.waypoints += 1;
    }
  }

  for (const w of worlds) {
    for (const wp of w.waypoints ?? []) {
      const wpId = idFor(wp.art, 'waypoint', `world "${w.key}" waypoint "${wp.name}" art`);
      await client.query('UPDATE waypoints SET entity_type_id = $2 WHERE name = $1', [wp.name, wpId]);
      n.waypoints += 1;
    }
    for (const v of villagesOf(w)) {
      const art = v.art || {};
      const ids = VILLAGE_POST_KINDS.map((k) => idFor(art[k], k, `world "${w.key}" village "${v.key}" art ${k}`));
      const sets = VILLAGE_POST_KINDS.map((k, i) => `${villageArtColumn(k)} = $${i + 3}`).join(', ');
      await client.query(
        `UPDATE villages SET ${sets} WHERE world_id = $1 AND spec_key = $2`,
        [idByKey.get(w.key), v.key, ...ids],
      );
      n.villages += 1;
    }
    if (w.chest) {
      const chestId = idFor(w.chest.art, 'chest_vault', `world "${w.key}" chest art`);
      await client.query(
        `UPDATE world_chests SET entity_type_id = $2 WHERE world_id = $1 AND kind = 'vault'`,
        [idByKey.get(w.key), chestId],
      );
      n.chests += 1;
    }
  }
  return n;
}

module.exports = {
  chestPointKind, resolvePointArt, loadPointKindDefaults, loadPointTypeNames, applyPointArt,
};
