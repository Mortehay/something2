// SOMET-644 Task 6. The LOCAL fallback for the Generated Worlds tab: when the
// GPU box is unreachable, generate a region on this PC with the JS port of the
// box's rules generator (services/worldGen/worldGen.js), preview its report,
// and save it as a seeds/maps spec. The Seed / Export Maps group reads only
// specs listed in its manifest (<SEED_SYNC_DIR>/maps.json); a Maps Export
// lists the new file, after which it reads `new` there and can be seeded.
//
// Rules only: there is no LLM here, so `theme`, `author` and `sfx_engine` are
// IGNORED (and the response says so), the biomes are the deterministic descent
// the box itself uses for author "rules", and there is no preview image.
//
// VALIDATE TYPES BEFORE planRegion. The port faithfully reproduces Python's
// arithmetic but not its type errors: given "3" or 2.5 for a world count it
// silently produces something, where the box raises. Every field is checked
// here against the box's own WorldSpec bounds, and anything else is a 400.
//
// THE NAME. The box's region-name rule (ASCII, lowercase, hyphens) is applied
// AFTER a light slug (trim, lowercase, whitespace/underscore runs -> '-'), and
// the slug is then BOTH the spec's `name` and its file stem: the Maps group
// requires the two to be equal, and the box's own create stores a region the
// same way (spec.name == region name == the download route's file stem).
// ASCII-only also removes the Unicode-version drift between Python's and
// Node's isalnum tables in the port's slug().
const fs = require('node:fs');
const path = require('node:path');
const { planRegion, report, toJson, title } = require('./worldGen/worldGen.js');
const { dumpsPy } = require('./worldGen/pyCompat.js');
const { WorldGenError } = require('./worldGenService.js');
const { validateMapSpec } = require('../../seeds/mapSpec.js');
const { matchOwner } = require('./artSeed.js');
// The Maps group's manifest lives in syncDir() (SEED_SYNC_DIR, read at call time).
const { syncDir } = require('./seedSync/exportGroup.js');

const LOCAL_AUTHOR = 'rules (local fallback)';
const REGION_NAME_RE = /^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$/;
const IGNORED_FIELDS = ['theme', 'author', 'sfx_engine'];

// The box's WorldSpec bounds and defaults (planRegion's defaults).
const INT_FIELDS = [
  // [body field, min, max, default]
  ['worlds', 1, 36, 6],
  ['size', 32, 224, 128],
  ['chunk_size', 8, 64, 32],
  ['biome_cell', 8, 64, 32],
];
const TARGET = { min: 0.5, max: 25, dflt: 6 };

function mapsDir() {
  return process.env.SEED_MAPS_DIR || path.join(__dirname, '..', '..', 'seeds', 'maps');
}


const SYNCED_MSG = 'this spec is synced through Seed / Export; edit it in the World Map Editor instead';

// Is `name` listed in the Maps manifest? A listed spec belongs to seed sync
// (its hash and base are tracked there), so the local fallback never writes
// it, overwrite or not. Fails CLOSED: a manifest that exists but cannot be
// read or parsed refuses the write rather than guessing it is unlisted.
function assertNotSynced(name) {
  const file = path.join(syncDir(), 'maps.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw new WorldGenError('manifest_unreadable', `Could not read the Maps manifest (${e.message}), so it is not safe to write ${name}.map.json.`, { status: 409 });
  }
  let doc;
  try { doc = JSON.parse(text); } catch {
    throw new WorldGenError('manifest_unreadable', `The Maps manifest is not valid JSON, so it is not safe to write ${name}.map.json.`, { status: 409 });
  }
  const specs = doc && Array.isArray(doc.specs) ? doc.specs : [];
  if (specs.some((e) => e && e.name === name)) {
    throw new WorldGenError('synced', `${name}.map.json: ${SYNCED_MSG}.`, { status: 409 });
  }
}

// Was <dir>/<name>.map.json made by this generator for this same region?
// Only then may it be replaced. A generated spec names every world
// title(name, i) for its index, so a hand-authored spec (vale-region,
// p5-descent: 'Vale Crossing', 'The Catacombs: Entry', ...) never matches.
// This holds with no Maps manifest at all, where assertNotSynced passes.
// Fails CLOSED: a file that cannot be read or parsed counts as authored.
function isGeneratedFor(file, name) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
  const worlds = doc && Array.isArray(doc.worlds) ? doc.worlds : null;
  if (!worlds || worlds.length === 0) return false;
  return worlds.every((w, i) => w && w.name === title(name, i));
}

function assertNotAuthored(file, fileName, name) {
  if (!fs.existsSync(file)) return;
  if (!isGeneratedFor(file, name)) {
    throw new WorldGenError('authored', `seeds/maps/${fileName} is an authored map spec, not a generated region — choose another name`, { status: 409 });
  }
}

const bad = (message) => new WorldGenError('bad_params', message, { status: 400 });

function slugName(raw) {
  if (typeof raw !== 'string') throw bad('name is required and must be a string.');
  const s = raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!REGION_NAME_RE.test(s)) {
    throw bad(`name "${raw}" does not fit the region-name rule: after trimming, lowercasing and turning `
      + 'spaces/underscores into hyphens it must be 2-60 ASCII letters, digits or hyphens, '
      + 'starting and ending with a letter or digit.');
  }
  return s;
}

// -> { params: { name, worlds, target_per_screen, size, chunk_size, biome_cell }, ignored }
// Absent (undefined) numeric fields take the defaults; anything present must
// be the right type and in range -- null included.
function parseLocalParams(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('The request body must be a JSON object.');
  const params = { name: slugName(body.name) };
  for (const [field, min, max, dflt] of INT_FIELDS) params[field] = intField(body, field, min, max, dflt);
  const t = body.target_per_screen;
  if (t === undefined) {
    params.target_per_screen = TARGET.dflt;
  } else if (typeof t !== 'number' || !Number.isFinite(t) || t < TARGET.min || t > TARGET.max) {
    throw bad(`target_per_screen must be a number from ${TARGET.min} to ${TARGET.max} (got ${JSON.stringify(t)}).`);
  } else {
    params.target_per_screen = t;
  }
  const ignored = IGNORED_FIELDS.filter((f) => body[f] !== undefined && body[f] !== null && body[f] !== '');
  return { params, ignored };
}

function intField(body, field, min, max, dflt) {
  const v = body[field];
  if (v === undefined) return dflt;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw bad(`${field} must be an integer from ${min} to ${max} (got ${JSON.stringify(v)}).`);
  }
  return v;
}

// Deterministic: the same params always give the same bytes.
// -> { spec (plain JSON), specText (the file's bytes), report (plain JSON) }
function generateLocal(params) {
  const raw = planRegion({
    name: params.name,
    world_count: params.worlds,
    target_per_screen: params.target_per_screen,
    size: params.size,
    chunk_size: params.chunk_size,
    biome_cell: params.biome_cell,
  });
  const specText = toJson(raw);
  // Through the Python-format JSON text, so any pyFloat in the report reaches
  // the client as the number Python would print, never as a wrapper object.
  return {
    spec: JSON.parse(specText),
    specText,
    report: JSON.parse(dumpsPy(report(raw, params.target_per_screen))),
  };
}

function ignoredNote(ignored) {
  return ignored.length
    ? `${ignored.join(', ')} ignored: the local fallback has no LLM, so biomes are chosen by the rules.`
    : null;
}

function preview(body, catalogs) {
  const { params, ignored } = parseLocalParams(body);
  const { spec, report: rep } = generateLocal(params);
  const errors = validateMapSpec(spec, catalogs);
  return {
    name: params.name,
    params,
    author: LOCAL_AUTHOR,
    spec,
    report: rep,
    valid: errors.length === 0,
    errors,
    ignored,
    note: ignoredNote(ignored),
  };
}

// Regenerates from params (a client-supplied spec is never accepted),
// validates, and writes <dir>/<slug>.map.json tmp-then-rename. Without
// `overwrite: true` an existing file is a 409 (a spec listed in the Maps
// manifest, or one this generator did not make for this region, is a 409 even
// with it: see assertNotSynced, assertNotAuthored) -- checked atomically with a
// hard link, so a concurrent writer cannot be clobbered between check and write.
function save(body, catalogs, { dir = mapsDir() } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('The request body must be a JSON object.');
  const { params, ignored } = parseLocalParams(body.params);
  if (body.name !== undefined && slugName(body.name) !== params.name) {
    throw bad(`name "${body.name}" does not match params.name "${body.params.name}".`);
  }
  const overwrite = body.overwrite === true;
  assertNotSynced(params.name);
  const { spec, specText } = generateLocal(params);
  const errors = validateMapSpec(spec, catalogs);
  if (errors.length) {
    const err = new WorldGenError('invalid_spec', `"${params.name}" does not validate against this database, so it was not written`, { status: 422 });
    err.errors = errors;
    throw err;
  }

  fs.mkdirSync(dir, { recursive: true });
  const fileName = `${params.name}.map.json`;
  const file = path.join(dir, fileName);
  // Before the `exists` 409, so an authored spec never offers an overwrite.
  assertNotAuthored(file, fileName, params.name);
  const tmp = path.join(dir, `.${fileName}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, specText, 'utf8');
  let overwrote = false;
  try {
    if (overwrite) {
      overwrote = fs.existsSync(file);
      fs.renameSync(tmp, file);
    } else {
      try {
        fs.linkSync(tmp, file);
      } catch (e) {
        if (e.code === 'EEXIST') {
          throw new WorldGenError('exists', `${fileName} already exists in seeds/maps. Send overwrite: true to replace it.`, { status: 409 });
        }
        throw e;
      }
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  // Root inside the container, a bind mount on the host: hand the file to
  // whoever owns the maps directory, as the art exporter does.
  matchOwner(file, dir);
  return {
    name: params.name,
    file: fileName,
    overwrote,
    worlds: spec.worlds.length,
    author: LOCAL_AUTHOR,
    ignored,
    note: ignoredNote(ignored),
    next: `Saved as seeds/maps/${fileName}. In Seed / Export → Maps, run Export to list it, `
      + 'then Seed to build it on this PC. Commit seeds/ to share it.',
  };
}

module.exports = {
  LOCAL_AUTHOR, REGION_NAME_RE, parseLocalParams, generateLocal, preview, save, mapsDir,
};
