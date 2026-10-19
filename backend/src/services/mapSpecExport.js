// DB -> map spec writer (SOMET-641, Plan 4a Task 3). The inverse of
// applyMapSpec (scripts/seed-map.js): it reads what the database holds for one
// spec's worlds and writes it back into that spec, so a hand edit made in the
// World Map Editor travels between PCs as the .map.json the next PC seeds from.
//
// READ ONLY. It never writes the database or a file; the seed-sync Maps group
// (Task 4) writes the file and decides what a difference means.
//
// What it overwrites is what an admin route (or a seed-sync rename) can change
// in the database, read from the columns applyMapSpec writes:
//   worlds        name, seed, width, height, chunk_size, biomes, biome_cell,
//                 allowed_creature_types, entry_spawn, graph_x/graph_y,
//                 level_min/level_max, density, allows_fast_travel,
//                 safe_road_radius, safe_rects, dungeon_boss
//   map_links     compass doorways (POST/DELETE /api/worlds/:id/links), portal
//                 art (PUT /api/map-links/:id/art), is_waypoint
//   waypoints     position and art
//   villages      box, gate, spawn and the four post arts
//   world_chests  the vault chest's position, guard, level and art
// What it keeps from the input spec is everything the database cannot change
// or does not store: grid, is_entry (git decides the entry world, through the
// seed-sync manifest), roads, pens, portal guards, the spec's own top-level
// keys, and the key order of every object.
//
// Returns { spec, notes, externallyReachable }:
//   spec                 a new object; the input is never mutated
//   notes                what could not be written back as the database has it
//                        (a spec world missing from the DB, a link into a world
//                        no spec owns, ...). Empty for an unedited seed.
//   externallyReachable  Set of this spec's world keys that another spec's
//                        world links into -- pass it to validateMapSpec so a
//                        world reached only from outside is not "unreachable".
//   matchedWorlds        the spec's world keys found in the database (by name,
//                        or by seed as a rename); the seed-sync Maps group
//                        reads "none here" from it.
const { EDGE_DELTA, villagesOf } = require('../../seeds/mapSpec.js');
const { VILLAGE_POST_KINDS } = require('../../seeds/data/pointTypes.js');
const { oppositeEdge } = require('./mapService.js');

// Must equal GRID_SPACING in scripts/seed-map.js (not required from there: that
// script pulls in the whole seeding stack, and this module is read-only).
const GRID_SPACING = 220;

// Where a key the writer ADDS goes: right after the nearest key before it in
// this list that the object already has. Keys already present never move.
const WORLD_ORDER = [
  'key', 'name', 'allows_fast_travel', 'grid', 'graph', 'seed', 'width', 'height', 'chunk_size',
  'biomes', 'biome_cell', 'allowed_creature_types', 'is_entry', 'entry_spawn', 'level_band',
  'density', 'village', 'villages', 'chest', 'safe_road_radius', 'safe_rects', 'roads', 'pens',
  'waypoints', 'boss',
];
const PORTAL_ORDER = [
  'kind', 'from', 'from_x', 'from_y', 'to', 'to_name', 'to_x', 'to_y', 'guard',
  'art', 'to_art', 'is_waypoint', 'waypoint_name', 'waypoint_art',
];
const COMPASS_ORDER = ['kind', 'from', 'edge', 'to', 'to_name'];
const VILLAGE_ORDER = ['key', 'min_row', 'min_col', 'width', 'height', 'gate_edge', 'spawn_x', 'spawn_y', 'art'];
const CHEST_ORDER = ['x', 'y', 'guard_creature_type', 'level', 'art'];
const WAYPOINT_ORDER = ['x', 'y', 'name', 'art'];
const EDGE_ORDER = ['N', 'E', 'S', 'W'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Set `key` on `obj`, in place when it exists, else at its WORLD_ORDER-style
// position. Returns the (possibly new) object.
function withKey(obj, key, value, order) {
  if (Object.prototype.hasOwnProperty.call(obj, key)) { obj[key] = value; return obj; }
  const want = order.indexOf(key);
  const entries = Object.entries(obj);
  let at = want === -1 ? entries.length : 0;
  if (want !== -1) {
    entries.forEach(([k], i) => {
      const j = order.indexOf(k);
      if (j !== -1 && j < want) at = i + 1;
    });
  }
  entries.splice(at, 0, [key, value]);
  return Object.fromEntries(entries);
}

// Set when `value` is not the column default, or when the spec already says it;
// otherwise leave the key out, as the authored spec did.
function withOptional(obj, key, value, isDefault, order) {
  if (isDefault && !Object.prototype.hasOwnProperty.call(obj, key)) return obj;
  return withKey(obj, key, value, order);
}

// The database value laid onto the spec value's key order. jsonb does not keep
// key order, so a boss or entry_spawn read back would otherwise reorder.
function mergeOrdered(prev, next) {
  if (isObj(prev) && isObj(next)) {
    const out = {};
    for (const k of Object.keys(prev)) if (k in next) out[k] = mergeOrdered(prev[k], next[k]);
    for (const k of Object.keys(next)) if (!(k in out)) out[k] = next[k];
    return out;
  }
  if (Array.isArray(prev) && Array.isArray(next)) return next.map((v, i) => mergeOrdered(prev[i], v));
  return next;
}

// '<world name>:<edge>' for every compass link a spec declares -- the format
// applyMapSpec's keepSlots takes, and the one specFromDb takes to know which
// links other specs own.
function compassSlots(spec) {
  const nameOf = new Map((spec.worlds || []).map((w) => [w.key, w.name]));
  return (spec.links || []).filter((l) => l.kind !== 'portal' && nameOf.has(l.from))
    .map((l) => `${nameOf.get(l.from)}:${l.edge}`);
}

function canonicalSpecJson(spec) {
  return `${JSON.stringify(spec, null, 2)}\n`;
}

// Reads everything the writer needs in one REPEATABLE READ snapshot when given
// a pool (a caller's client is read inside whatever it already holds), so the
// reads describe one moment.
//
// world key -> DB row is decided HERE, before the link reads: only the worlds
// this spec owns may widen what is read. A world PUT /api/worlds/:id renamed is
// found by its seed, but only when exactly one world no spec names carries it
// and only one missing spec world claims it -- deduction, never a guess.
async function readState(db, worlds, otherNames, notes) {
  const isPool = typeof db.connect === 'function' && typeof db.release !== 'function'
    && typeof db.totalCount === 'number';
  const q = isPool ? await db.connect() : db;
  try {
    if (isPool) await q.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const cols = `id, name, seed, chunk_size, width, height, allowed_creature_types, entry_spawn, biomes,
      biome_cell, graph_x, graph_y, level_min, level_max, density, allows_fast_travel, safe_road_radius,
      safe_rects, dungeon_boss`;
    const names = worlds.map((w) => w.name);
    const byName = new Map((await q.query(
      `SELECT ${cols} FROM worlds WHERE name = ANY($1::text[])`, [names])).rows.map((r) => [r.name, r]));
    const rowOf = new Map();
    for (const w of worlds) if (byName.has(w.name)) rowOf.set(w.key, byName.get(w.name));
    const missing = worlds.filter((w) => !rowOf.has(w.key));
    const seeds = missing.map((w) => w.seed).filter(Number.isInteger).map(String);
    const candidates = seeds.length ? (await q.query(
      `SELECT ${cols} FROM worlds WHERE seed = ANY($1::bigint[]) AND name <> ALL($2::text[])`,
      [seeds, [...names, ...otherNames]])).rows : [];
    for (const w of missing) {
      const cands = candidates.filter((r) => Number(r.seed) === w.seed);
      const rivals = missing.filter((x) => x.seed === w.seed);
      // Noted even when it matches, so the admin can confirm it is a rename
      // and not an unrelated world that happens to share the seed.
      if (cands.length === 1 && rivals.length === 1) {
        rowOf.set(w.key, cands[0]);
        notes.push(`world "${w.key}" matched by seed ${w.seed} as "${cands[0].name}", renamed from "${w.name}"`);
      } else notes.push(`world "${w.key}" ("${w.name}") is not in the database; kept as the spec has it`);
    }

    const ids = [...rowOf.values()].map((w) => w.id);
    const links = (await q.query(
      `SELECT ml.id, ml.edge, ml.from_world_id, ml.to_world_id, wf.name AS from_name, wt.name AS to_name,
              ml.from_x, ml.from_y, ml.to_x, ml.to_y, ml.is_waypoint, et.name AS art
         FROM map_links ml
         JOIN worlds wf ON wf.id = ml.from_world_id
         JOIN worlds wt ON wt.id = ml.to_world_id
         LEFT JOIN entity_types et ON et.id = ml.entity_type_id
        WHERE ml.from_world_id = ANY($1::uuid[]) OR ml.to_world_id = ANY($1::uuid[])
        ORDER BY wf.name, ml.edge, ml.from_x, ml.from_y`, [ids])).rows;
    const waypoints = (await q.query(
      `SELECT wp.world_id, wp.x, wp.y, wp.name, wp.map_link_id, et.name AS art
         FROM waypoints wp LEFT JOIN entity_types et ON et.id = wp.entity_type_id
        WHERE wp.world_id = ANY($1::uuid[]) ORDER BY wp.created_at, wp.name`, [ids])).rows;
    const villages = (await q.query(
      `SELECT v.world_id, v.spec_key, v.min_row, v.min_col, v.width, v.height, v.gate_edge,
              v.spawn_x, v.spawn_y, m.name AS merchant, b.name AS bank,
              g.name AS gem_merchant, s.name AS skill_merchant
         FROM villages v
         LEFT JOIN entity_types m ON m.id = v.merchant_entity_type_id
         LEFT JOIN entity_types b ON b.id = v.bank_entity_type_id
         LEFT JOIN entity_types g ON g.id = v.gem_merchant_entity_type_id
         LEFT JOIN entity_types s ON s.id = v.skill_merchant_entity_type_id
        WHERE v.world_id = ANY($1::uuid[]) ORDER BY v.created_at, v.id`, [ids])).rows;
    // expires_at IS NULL: a boss-death chest (SOMET-611) is not the authored one.
    const chests = (await q.query(
      `SELECT c.world_id, c.x, c.y, c.guard_level, g.name AS guard, a.name AS art
         FROM world_chests c
         LEFT JOIN entity_types g ON g.id = c.guard_entity_type_id
         LEFT JOIN entity_types a ON a.id = c.entity_type_id
        WHERE c.world_id = ANY($1::uuid[]) AND c.kind = 'vault' AND c.expires_at IS NULL
        ORDER BY c.created_at, c.id`, [ids])).rows;
    if (isPool) await q.query('COMMIT');
    return { rowOf, links, waypoints, villages, chests, notes };
  } catch (err) {
    if (isPool) await q.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    if (isPool) q.release();
  }
}

function writeWorld(w, row, rows) {
  let o = w;
  const set = (k, v) => { o = withKey(o, k, v, WORLD_ORDER); };
  const opt = (k, v, isDefault) => { o = withOptional(o, k, v, isDefault, WORLD_ORDER); };
  set('name', row.name);
  set('seed', Number(row.seed));
  set('width', row.width);
  set('height', row.height);
  opt('chunk_size', row.chunk_size, row.chunk_size === 64);
  opt('biomes', row.biomes ?? [], !(row.biomes ?? []).length);
  opt('biome_cell', row.biome_cell, row.biome_cell == null);
  opt('allowed_creature_types', row.allowed_creature_types ?? [], !(row.allowed_creature_types ?? []).length);
  if (row.entry_spawn) set('entry_spawn', mergeOrdered(o.entry_spawn, row.entry_spawn));
  else delete o.entry_spawn;
  opt('level_band', [row.level_min, row.level_max], row.level_min === 1 && row.level_max === 1);
  opt('density', row.density, row.density === 'normal');
  opt('allows_fast_travel', row.allows_fast_travel === true, row.allows_fast_travel !== true);
  opt('safe_road_radius', row.safe_road_radius, !row.safe_road_radius);
  opt('safe_rects', mergeOrdered(o.safe_rects, row.safe_rects ?? []), !(row.safe_rects ?? []).length);
  if (row.dungeon_boss) set('boss', mergeOrdered(o.boss, row.dungeon_boss));
  else delete o.boss;

  // graph: only when the stored position is not the one apply derives.
  if (row.graph_x != null && row.graph_y != null) {
    const pos = [row.graph_x, row.graph_y];
    const derived = Array.isArray(o.grid) ? [o.grid[0] * GRID_SPACING, o.grid[1] * GRID_SPACING] : null;
    if (same(o.graph, pos)) { /* authored and unchanged */ } else if (same(derived, pos)) delete o.graph;
    else set('graph', pos);
  } else {
    // NULL in the DB. With a grid, apply's grid-derived position is the closest
    // a spec can say; without one, NULL is what omitting the key applies.
    delete o.graph;
  }

  // Standalone waypoints (no map_link_id), matched by name.
  const wpRows = rows.waypoints.filter((r) => r.world_id === row.id && r.map_link_id == null);
  const used = new Set();
  const wps = [];
  for (const wp of o.waypoints ?? []) {
    const r = wpRows.find((x) => x.name === wp.name);
    if (!r) { rows.notes.push(`world "${o.key}" waypoint "${wp.name}" is not in the database; dropped`); continue; }
    used.add(r);
    wps.push(writeWaypoint(wp, r));
  }
  for (const r of wpRows) if (!used.has(r)) wps.push(writeWaypoint({}, r));
  if (wps.length) set('waypoints', wps); else delete o.waypoints;

  // Villages by spec_key; an unkeyed row (POST /api/worlds/:id/villages stores
  // none) is matched by the same "last one standing" deduction seed-map's
  // village pass uses, else gets a key derived from its box.
  const vRows = rows.villages.filter((r) => r.world_id === row.id);
  const specVs = villagesOf(o);
  const matched = new Map();
  for (const v of specVs) {
    const r = vRows.find((x) => x.spec_key === v.key);
    if (r) matched.set(v, r);
  }
  const claimed = new Set(matched.values());
  const orphanSpec = specVs.filter((v) => !matched.has(v));
  const orphanRows = vRows.filter((r) => !claimed.has(r));
  if (orphanSpec.length === 1 && orphanRows.length === 1 && orphanRows[0].spec_key == null) {
    matched.set(orphanSpec[0], orphanRows[0]);
    claimed.add(orphanRows[0]);
  }
  const vs = [];
  for (const v of specVs) {
    const r = matched.get(v);
    if (!r) { rows.notes.push(`world "${o.key}" village "${v.key}" is not in the database; dropped`); continue; }
    vs.push(writeVillage(v, r));
  }
  for (const r of vRows) {
    if (claimed.has(r)) continue;
    const key = r.spec_key ?? `village-${r.min_row}-${r.min_col}`;
    vs.push(writeVillage({ key }, r));
  }
  // The authored form survives: a `villages` array stays an array, a singular
  // `village` stays singular until there are two, and then becomes `villages`
  // in the same place.
  if (Array.isArray(o.villages)) set('villages', vs);
  else if (vs.length > 1 && 'village' in o) {
    o = Object.fromEntries(Object.entries(o).map(([k, v]) => (k === 'village' ? ['villages', vs] : [k, v])));
  } else if (vs.length > 1) set('villages', vs);
  else if (vs.length === 1) set('village', vs[0]);
  else delete o.village;

  // The vault chest (one per world).
  const c = rows.chests.find((r) => r.world_id === row.id);
  if (c) {
    let chest = o.chest ? { ...o.chest } : {};
    chest = withKey(chest, 'x', c.x, CHEST_ORDER);
    chest = withKey(chest, 'y', c.y, CHEST_ORDER);
    if (c.guard) chest = withKey(chest, 'guard_creature_type', c.guard, CHEST_ORDER);
    chest = withKey(chest, 'level', c.guard_level, CHEST_ORDER);
    if (c.art) chest = withKey(chest, 'art', c.art, CHEST_ORDER); else delete chest.art;
    set('chest', chest);
  } else if (o.chest) {
    rows.notes.push(`world "${o.key}" chest is not in the database; dropped`);
    delete o.chest;
  }
  return o;
}

function writeWaypoint(wp, r) {
  let o = { ...wp };
  o = withKey(o, 'x', r.x, WAYPOINT_ORDER);
  o = withKey(o, 'y', r.y, WAYPOINT_ORDER);
  o = withKey(o, 'name', r.name, WAYPOINT_ORDER);
  if (r.art) o = withKey(o, 'art', r.art, WAYPOINT_ORDER); else delete o.art;
  return o;
}

function writeVillage(v, r) {
  let o = { ...v };
  for (const k of ['min_row', 'min_col', 'width', 'height']) o = withKey(o, k, r[k], VILLAGE_ORDER);
  o = withKey(o, 'gate_edge', String(r.gate_edge).trim(), VILLAGE_ORDER);
  o = withKey(o, 'spawn_x', Number(r.spawn_x), VILLAGE_ORDER);
  o = withKey(o, 'spawn_y', Number(r.spawn_y), VILLAGE_ORDER);
  let art = isObj(o.art) ? { ...o.art } : {};
  for (const k of VILLAGE_POST_KINDS) {
    if (r[k]) art = withKey(art, k, r[k], VILLAGE_POST_KINDS); else delete art[k];
  }
  if (Object.keys(art).length) o = withKey(o, 'art', art, VILLAGE_ORDER); else delete o.art;
  return o;
}

async function specFromDb(db, spec, { otherSpecWorlds = new Map(), keepSlots = [] } = {}) {
  const out = structuredClone(spec);
  const notes = [];
  const worlds = out.worlds || [];
  const rows = await readState(db, worlds, [...otherSpecWorlds.keys()], notes);
  const { rowOf } = rows;
  const keyOfId = new Map([...rowOf].map(([k, r]) => [r.id, k]));
  const ourIds = new Set(keyOfId.keys());

  for (let i = 0; i < worlds.length; i++) {
    const row = rowOf.get(worlds[i].key);
    if (row) worlds[i] = writeWorld(worlds[i], row, rows);
  }
  const worldByKey = new Map(worlds.map((w) => [w.key, w]));

  // ---- links ---------------------------------------------------------------
  const compass = rows.links.filter((l) => l.edge !== 'PORTAL');
  const portals = rows.links.filter((l) => l.edge === 'PORTAL');
  const slot = (id, edge) => `${id}:${edge}`;
  const compassAt = new Map(compass.map((l) => [slot(l.from_world_id, l.edge), l]));
  const portalAt = new Map(portals.map((l) => [`${l.from_world_id}:${l.from_x},${l.from_y}`, l]));
  const idOfName = new Map();
  for (const l of rows.links) { idOfName.set(l.from_name, l.from_world_id); idOfName.set(l.to_name, l.to_world_id); }
  const consumed = new Set();
  const targetId = (l) => (l.to_name !== undefined ? idOfName.get(l.to_name) : rowOf.get(l.to)?.id);

  const keptLinks = [];
  for (const l of out.links || []) {
    const fromId = rowOf.get(l.from)?.id;
    const toId = targetId(l);
    // A link touching a world the DB does not have is kept as the spec has it.
    const fromMissing = !fromId;
    const toMissing = l.to_name === undefined ? !rowOf.has(l.to) : false;
    if (fromMissing || toMissing) { keptLinks.push(l); continue; }

    if (l.kind === 'portal') {
      const fwd = portalAt.get(`${fromId}:${l.from_x},${l.from_y}`);
      if (!fwd) { notes.push(`portal ${l.from}@${l.from_x},${l.from_y} is not in the database; dropped`); continue; }
      const back = portalAt.get(`${fwd.to_world_id}:${fwd.to_x},${fwd.to_y}`);
      consumed.add(fwd.id); if (back) consumed.add(back.id);
      keptLinks.push(writePortal(l, fwd, back, keyOfId, rows));
      continue;
    }
    const fwd = compassAt.get(slot(fromId, l.edge));
    // A to_name doorway whose slot still leads, both ways, to a world this spec
    // does not own: its target was renamed (that spec's own writer follows the
    // rename the same way), so follow the database.
    if (l.to_name !== undefined && fwd && !ourIds.has(fwd.to_world_id) && fwd.to_name !== l.to_name) {
      const m = compassAt.get(slot(fwd.to_world_id, oppositeEdge(l.edge)));
      if (m && m.to_world_id === fromId) {
        consumed.add(fwd.id); consumed.add(m.id);
        keptLinks.push(withKey({ ...l }, 'to_name', fwd.to_name, COMPASS_ORDER));
        continue;
      }
    }
    const back = toId ? compassAt.get(slot(toId, oppositeEdge(l.edge))) : undefined;
    const fwdOk = fwd && fwd.to_world_id === toId;
    const backOk = back && back.to_world_id === fromId;
    // Kept only while BOTH sides agree, or one agrees and the other slot is
    // empty. Gone from both sides is DELETE /api/worlds/:id/links/:edge: the
    // link goes, which IS the edit. Either slot now leading elsewhere is
    // POST /api/worlds/:id/links re-pointing the doorway FROM THAT SIDE: the
    // new pair is written below, and the half of this link left behind is a
    // one-way row the loose pass names in a note.
    const keepIt = (fwdOk && (backOk || !back)) || (backOk && !fwd);
    if (!keepIt) continue;
    if (fwdOk) consumed.add(fwd.id);
    if (backOk) consumed.add(back.id);
    keptLinks.push(l);
  }

  // Undeclared compass rows: hand-drawn doorways, as pairs.
  const keep = new Set(keepSlots);
  const added = [];
  const byFrom = (a, b) => worlds.findIndex((w) => w.key === keyOfId.get(a.from_world_id))
    - worlds.findIndex((w) => w.key === keyOfId.get(b.from_world_id))
    || EDGE_ORDER.indexOf(a.edge) - EDGE_ORDER.indexOf(b.edge);
  const loose = compass.filter((l) => !consumed.has(l.id));
  // Prefer the row leaving one of our worlds, so `from` is always ours.
  loose.sort((a, b) => (ourIds.has(a.from_world_id) ? 0 : 1) - (ourIds.has(b.from_world_id) ? 0 : 1)
    || (ourIds.has(a.from_world_id) && ourIds.has(b.from_world_id) ? byFrom(a, b) : 0));
  for (const l of loose) {
    if (consumed.has(l.id)) continue;
    const mirror = compassAt.get(slot(l.to_world_id, oppositeEdge(l.edge)));
    const pairOk = mirror && mirror.to_world_id === l.from_world_id;
    consumed.add(l.id); if (pairOk) consumed.add(mirror.id);
    // Orient from our side.
    // A one-way row whose mirror slot holds a doorway to somewhere else (what a
    // re-pointed doorway leaves behind) cannot be written: the spec form is a
    // pair, and that slot is already taken. One with an EMPTY mirror slot is
    // written; the next apply restores the mirror.
    if (!pairOk && (mirror || !ourIds.has(l.from_world_id))) {
      notes.push(`one-way doorway ${l.from_name} -${l.edge}-> ${l.to_name} `
        + `(${mirror ? `its mirror slot leads to ${mirror.to_name}` : 'no mirror'}); not written`);
      continue;
    }
    const r = ourIds.has(l.from_world_id) ? l : mirror;
    const fromKey = keyOfId.get(r.from_world_id);
    if (ourIds.has(r.to_world_id)) {
      const toKey = keyOfId.get(r.to_world_id);
      const a = worldByKey.get(fromKey); const b = worldByKey.get(toKey);
      const d = EDGE_DELTA[r.edge];
      const onGrid = Array.isArray(a.grid) && Array.isArray(b.grid)
        && b.grid[0] === a.grid[0] + d[0] && b.grid[1] === a.grid[1] + d[1];
      added.push(onGrid ? { from: fromKey, edge: r.edge, to: toKey }
        : { kind: 'edge', from: fromKey, edge: r.edge, to: toKey });
      continue;
    }
    // A link into another spec's world. Owned by whichever spec declares it
    // (keepSlots); a hand-drawn one nobody declares yet goes into the spec whose
    // name sorts first, so exactly one of the two writers claims it.
    const otherSpec = otherSpecWorlds.get(r.to_name);
    if (otherSpec === undefined) {
      notes.push(`doorway ${r.from_name} -${r.edge}-> ${r.to_name} leads to a world no map spec owns; not written`);
      continue;
    }
    if (keep.has(`${r.from_name}:${r.edge}`) || keep.has(`${r.to_name}:${oppositeEdge(r.edge)}`)) continue;
    if (!(String(out.name) < String(otherSpec))) continue;
    added.push({ from: fromKey, edge: r.edge, to_name: r.to_name });
  }

  // Undeclared portal rows. No admin route creates, moves or deletes a portal,
  // so one here was declared by another spec (to_name) or written by hand in
  // SQL; only the latter is worth a note.
  for (const l of portals) {
    if (consumed.has(l.id)) continue;
    const foreign = [l.from_world_id, l.to_world_id].find((id) => !ourIds.has(id));
    const foreignName = foreign === l.from_world_id ? l.from_name : l.to_name;
    if (foreign && otherSpecWorlds.has(foreignName)) continue;
    notes.push(`portal ${l.from_name}@${l.from_x},${l.from_y} -> ${l.to_name} is declared by no spec; not written`);
  }

  if (out.links || added.length) out.links = [...keptLinks, ...added];

  // Worlds another spec's links reach (from a world that spec owns).
  const externallyReachable = new Set();
  for (const l of rows.links) {
    if (ourIds.has(l.to_world_id) && !ourIds.has(l.from_world_id) && otherSpecWorlds.has(l.from_name)) {
      externallyReachable.add(keyOfId.get(l.to_world_id));
    }
  }

  return { spec: out, notes, externallyReachable, matchedWorlds: [...rowOf.keys()] };
}

function writePortal(l, fwd, back, keyOfId, rows) {
  let o = { ...l };
  const set = (k, v) => { o = withKey(o, k, v, PORTAL_ORDER); };
  const toKey = keyOfId.get(fwd.to_world_id);
  if (toKey !== undefined) { set('to', toKey); delete o.to_name; } else { set('to_name', fwd.to_name); delete o.to; }
  set('to_x', fwd.to_x);
  set('to_y', fwd.to_y);
  // to_art only when the arrival row differs from the departure row: the same
  // collapse PUT /api/map-links/:id/art makes.
  const backArt = back ? back.art : null;
  if (fwd.art) set('art', fwd.art); else delete o.art;
  if (backArt && backArt !== fwd.art) set('to_art', backArt); else delete o.to_art;
  // Art on the departure row and none on the arrival row has no spec form
  // (apply writes `to_art ?? art` to the arrival row).
  if (back && fwd.art && !back.art) {
    rows.notes.push(`portal ${l.from}@${l.from_x},${l.from_y}: the arrival row has no art but the departure `
      + `row has "${fwd.art}" -- a spec cannot say that; the arrival row will get "${fwd.art}"`);
  }
  if (fwd.is_waypoint === true) {
    const wp = rows.waypoints.find((r) => r.map_link_id === fwd.id);
    set('is_waypoint', true);
    if (wp) set('waypoint_name', wp.name);
    if (wp && wp.art) set('waypoint_art', wp.art); else delete o.waypoint_art;
  } else {
    if ('is_waypoint' in o) set('is_waypoint', false);
    delete o.waypoint_name;
    delete o.waypoint_art;
  }
  return o;
}

module.exports = { specFromDb, canonicalSpecJson, compassSlots };
