// Reverse spec-file locator (SOMET-587). An admin can set a live portal's /
// waypoint's / village post's / chest's art straight from the World Map tab,
// but the checked-in spec files in seeds/maps/ are the one durable source of
// truth (memory: "spec-beats-migration-on-reseed") -- `make seed-map` upserts
// every instance FROM the spec, so a write that only lands in the database is
// erased on the next reseed with no warning.
//
// This module answers one question: "which spec file, and where in it, does
// this live row's art actually come from?" -- by re-parsing the current spec
// files and matching on `worlds.name`, which is globally unique and durable
// (unlike a spec's in-memory `key`, which exists only for the duration of one
// `make seed-map` run -- see scripts/seed-map.js's idByKey). There is no
// tracking column that records which file/array-position seeded a given row;
// `villages.spec_key` is the one exception, and it answers "which village
// inside this world", not "which file".
//
// SAFETY POSTURE: a lookup that finds zero or more than one matching entry is
// UNSAFE to write through, full stop. The caller must refuse (4xx) rather than
// guess which file/entry to touch, and rather than writing only to the
// database and leaving the admin with a false sense of durability. Every
// locator in this file returns `null` on an ambiguous or missing match -- it
// never throws for that reason, and it never narrows its own refusal logic to
// make a caller's life easier.
//
// NO CACHING. These are tiny, rarely-written files, and a stale in-memory
// copy would risk writing over another admin action (or `make seed-map`
// itself) that landed since this process last read the file. Every exported
// function re-reads from disk.
//
// Deliberately DB-free, like seeds/mapSpec.js itself: this module only reads
// and writes JSON files on disk. The caller (src/index.js) is responsible for
// loading the live entity-type catalog and handing it in as `catalogs` for
// the write-back's validateMapSpec call.
const fs = require('fs');
const path = require('path');
const { validateMapSpec } = require('../../seeds/mapSpec.js');

// backend/src/services/specFileLocator.js -> backend/seeds/maps
const DEFAULT_SPEC_DIR = path.join(__dirname, '..', '..', 'seeds', 'maps');

function listSpecFiles(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  // Sorted so a deliberately-ambiguous fixture (two files defining the same
  // world name, in tests) reports deterministically regardless of readdir's
  // own (platform-dependent) ordering -- not load-bearing for correctness
  // (an ambiguous match is refused either way), only for repeatable tests.
  return names.filter((f) => f.endsWith('.map.json')).sort().map((f) => path.join(dir, f));
}

function readSpecSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    // A file that is missing or fails to parse is not a match for anything --
    // not an error to throw, since a locator's whole contract is "find a
    // unique match or return null", and a second, well-formed spec file
    // should still be searchable even if a sibling is briefly mid-write.
    return null;
  }
}

// The one spec-file location of a world, found by NAME (the durable, globally
// unique identity -- see this file's header comment). Returns
// `{ filePath, spec, world, worldIndex }` for a world named exactly once
// across every spec file in `dir`, or `null` for zero or more than one.
function findWorldLocation(worldName, dir = DEFAULT_SPEC_DIR) {
  const hits = [];
  for (const filePath of listSpecFiles(dir)) {
    const spec = readSpecSafe(filePath);
    if (!spec) continue;
    const worlds = Array.isArray(spec.worlds) ? spec.worlds : [];
    const idx = worlds.findIndex((w) => w && w.name === worldName);
    if (idx !== -1) hits.push({ filePath, spec, world: worlds[idx], worldIndex: idx });
  }
  return hits.length === 1 ? hits[0] : null;
}

// A portal link's `art` field (the departure/declared-`from` row) or `to_art`
// field (the arrival/mirror `to` row -- SOMET-586 lets the two differ; a
// dungeon mouth and its inside can want different art), or a compass link's
// edge (which carries no art today, but the selector shape is supported for
// the same reason the ticket names it).
//
// `worldName` is the name of whichever map_links ROW the caller is holding --
// which may be either the spec's declared `from` side or the implicit mirror
// `to` side (setPortalLink writes both, and a clicked graph edge could be
// either one). Which side matched is returned as `side` so the caller can
// resolve the right field (`art` vs `to_art`) AND write back only the one
// physical DB row that side corresponds to -- the two rows no longer share a
// single field, so they must no longer share a single write either.
function findLinkInSpecs(worldName, selector, dir = DEFAULT_SPEC_DIR) {
  const loc = findWorldLocation(worldName, dir);
  if (!loc) return null;
  const { filePath, spec, world } = loc;
  const links = Array.isArray(spec.links) ? spec.links : [];
  const matches = [];
  links.forEach((l, i) => {
    if (!l) return;
    if (selector && selector.edge !== undefined) {
      if (l.kind === 'portal') return;
      if (l.from === world.key && l.edge === selector.edge) matches.push({ i, side: 'departure' });
    } else if (selector && selector.from_x !== undefined && selector.from_y !== undefined) {
      if (l.kind !== 'portal') return;
      const departure = l.from === world.key && l.from_x === selector.from_x && l.from_y === selector.from_y;
      const arrival = l.to === world.key && l.to_x === selector.from_x && l.to_y === selector.from_y;
      // Both branches can only push once each (different `side`): a self-loop
      // portal whose from/to tiles are identical would otherwise satisfy
      // `departure` and `arrival` at once, and that ambiguity must still
      // refuse via the matches.length check below, not silently pick one.
      if (departure) matches.push({ i, side: 'departure' });
      if (arrival) matches.push({ i, side: 'arrival' });
    }
  });
  if (matches.length !== 1) return null;
  const { i, side } = matches[0];
  const fieldPath = side === 'arrival' ? ['to_art'] : ['art'];
  return { filePath, path: ['links', i], fieldPath, side };
}

// A world's waypoint, authored either as a standalone `worlds[i].waypoints[]`
// entry or as a portal link flagged `is_waypoint: true` (whose own art field
// is `waypoint_art`, not `art` -- see mapSpec.js's checkArt call sites). Both
// routes are database-unique per world (waypoints_world_unique,
// 1714440270000) and validator-unique per world (SOMET-300's one-per-world
// ceiling), so a world-name match alone disambiguates -- no x/y selector is
// needed the way the portal locator needs one. Still refuses (returns null)
// rather than guessing if a spec somehow carries both or neither route for a
// world this waypoint claims to belong to.
function findWaypointInSpecs(worldName, dir = DEFAULT_SPEC_DIR) {
  const loc = findWorldLocation(worldName, dir);
  if (!loc) return null;
  const { filePath, spec, world, worldIndex } = loc;
  const standalone = Array.isArray(world.waypoints) ? world.waypoints : [];
  const links = Array.isArray(spec.links) ? spec.links : [];
  const portalFlagged = [];
  links.forEach((l, i) => {
    if (l && l.kind === 'portal' && l.from === world.key && l.is_waypoint === true) portalFlagged.push(i);
  });
  const candidates = [];
  if (standalone.length === 1) {
    candidates.push({ filePath, path: ['worlds', worldIndex, 'waypoints', 0], fieldPath: ['art'] });
  }
  if (portalFlagged.length === 1) {
    candidates.push({ filePath, path: ['links', portalFlagged[0]], fieldPath: ['waypoint_art'] });
  }
  return candidates.length === 1 ? candidates[0] : null;
}

// A world's vault chest. One per world by construction (seed-map.js's
// applyPointArt keys its UPDATE on `WHERE world_id = $1 AND kind = 'vault'`
// with no further disambiguator), so a world-name match alone is enough.
function findChestInSpecs(worldName, dir = DEFAULT_SPEC_DIR) {
  const loc = findWorldLocation(worldName, dir);
  if (!loc) return null;
  const { filePath, world, worldIndex } = loc;
  if (!world.chest || typeof world.chest !== 'object' || Array.isArray(world.chest)) return null;
  return { filePath, path: ['worlds', worldIndex, 'chest'], fieldPath: ['art'] };
}

// A village's post art. `specKey` is `villages.spec_key` -- the identity a
// village row already carries for exactly this "which spec entry is this row"
// problem (SOMET-312/SOMET-591; do not touch how that column is populated).
// A village with a NULL spec_key (one hand-created before specs existed, or
// since) can never match here, which is the correct, safe refusal: there is
// no spec entry to write back to.
//
// Handles both authoring shapes mapSpec.js's villagesOf() treats as
// equivalent -- the plural `villages` array (matched by `.key`) and the
// singular `village` object (whose own `.key` must equal specKey). The two
// are mutually exclusive in any spec that already passes validateMapSpec
// (worlds.village+villages is itself a validation error), so at most one of
// the two branches below can ever produce a candidate.
function findVillageInSpecs(worldName, specKey, dir = DEFAULT_SPEC_DIR) {
  if (specKey === null || specKey === undefined) return null;
  const loc = findWorldLocation(worldName, dir);
  if (!loc) return null;
  const { filePath, world, worldIndex } = loc;
  if (Array.isArray(world.villages)) {
    const matches = [];
    world.villages.forEach((v, i) => { if (v && v.key === specKey) matches.push(i); });
    if (matches.length !== 1) return null;
    return { filePath, path: ['worlds', worldIndex, 'villages', matches[0]], fieldPath: ['art'] };
  }
  if (world.village && typeof world.village === 'object' && world.village.key === specKey) {
    return { filePath, path: ['worlds', worldIndex, 'village'], fieldPath: ['art'] };
  }
  return null;
}

// Mutate a FRESHLY RE-READ copy of the located file (not whatever the caller
// read at the start of the request) at `located.path`, setting or clearing
// `[...located.fieldPath, ...extraFieldPath]`, validate the WHOLE mutated
// spec, and only write if it is still valid. No partial write: a failed
// validation or a failed fs write leaves the file byte-for-byte as it was.
//
// `value === null || value === undefined` DELETES the field rather than
// writing `null` into it -- mapSpec.js's checkArt treats an explicitly
// authored non-string value (including `null`) as a shape error ("must be an
// entity type name"), so clearing an art binding has to mean "this spec is
// silent about it again", which is the absence of the key, not the key set to
// null. That silence is exactly what resolvePointArt (pointArt.js) already
// reads as "fall back to the kind default".
//
// Re-reading here (rather than reusing the spec object the caller already
// parsed to FIND this location) shrinks, but does not close, the race window
// with a concurrent writer -- see this file's header comment on why there is
// no caching. If the file changed shape since `located.path` was computed
// (e.g. another admin's edit inserted/removed a links[] entry), the indexed
// path may no longer point at the same logical entry; this is treated as a
// concurrent-change failure (refuse, do not write) rather than silently
// writing to whatever now happens to sit at that path.
//
// `siblingFallbackKey` (SOMET-586/587): when set, and the field being
// written is a TOP-LEVEL field of the located entry (`extraFieldPath` is
// empty -- a village post's nested `art.<slot>` has no such sibling), a
// non-clearing write whose value equals `target[siblingFallbackKey]` is
// downgraded to a clear instead. This is for the portal arrival override:
// setting `to_art` to the SAME name the departure `art` field already
// carries is functionally a no-op (`to_art ?? art` already resolves to that
// value with no key at all), and writing a redundant explicit duplicate only
// risks the two silently drifting apart on some future hand-edit. The caller
// passes `'art'` here only for the arrival side of a portal link; every
// other caller leaves this `null` and gets the old, purely mechanical
// set-or-delete behaviour.
function writeSpecFieldChange(located, value, catalogs, extraFieldPath = [], siblingFallbackKey = null) {
  let fresh;
  try {
    fresh = JSON.parse(fs.readFileSync(located.filePath, 'utf8'));
  } catch (err) {
    return { ok: false, status: 500, error: `failed to re-read spec file before writing: ${err.message}` };
  }

  let target = fresh;
  for (const key of located.path) {
    if (target === null || target === undefined) { target = undefined; break; }
    target = target[key];
  }
  if (target === null || target === undefined || typeof target !== 'object' || Array.isArray(target)) {
    return {
      ok: false, status: 409,
      error: 'the spec file changed since this edit was located — the entry no longer sits where it '
        + 'was found, so refusing to write (re-open the picker and try again)',
    };
  }

  const fieldPath = [...located.fieldPath, ...extraFieldPath];
  let clearing = value === null || value === undefined;
  if (!clearing && siblingFallbackKey && extraFieldPath.length === 0 && target[siblingFallbackKey] === value) {
    clearing = true;
  }
  let cursor = target;
  for (let i = 0; i < fieldPath.length - 1; i++) {
    const key = fieldPath[i];
    if (clearing && (cursor[key] === undefined || typeof cursor[key] !== 'object')) {
      // Nothing to walk into, and clearing a field that was never set (or
      // whose container was never created) is already a no-op.
      cursor = null;
      break;
    }
    if (typeof cursor[key] !== 'object' || cursor[key] === null || Array.isArray(cursor[key])) {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  if (cursor) {
    const lastKey = fieldPath[fieldPath.length - 1];
    if (clearing) delete cursor[lastKey];
    else cursor[lastKey] = value;
  }

  const errors = validateMapSpec(fresh, catalogs);
  if (errors.length) {
    return { ok: false, status: 400, error: `this change would make the spec invalid:\n  - ${errors.join('\n  - ')}` };
  }

  try {
    // The one established convention for writing one of these files (see
    // POST /api/world-gen/worlds/:name/download and
    // scripts/dungeon/gen-p5-map-content.js's writeOutput()).
    fs.writeFileSync(located.filePath, `${JSON.stringify(fresh, null, 2)}\n`);
  } catch (err) {
    return { ok: false, status: 500, error: `failed to write spec file: ${err.message}` };
  }
  return { ok: true, spec: fresh };
}

module.exports = {
  DEFAULT_SPEC_DIR,
  findWorldLocation,
  findLinkInSpecs,
  findWaypointInSpecs,
  findChestInSpecs,
  findVillageInSpecs,
  writeSpecFieldChange,
};
