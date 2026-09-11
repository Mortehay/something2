// SOMET-572. One export/seed path for every art subject.
//
// THE PROBLEM. A generated image lives in two places git cannot see: the
// object store holds the pixels and a catalog row holds a job-scoped key
// pointing at them. Clone the repo onto another machine and you get neither.
// Tiles and entities each had a hand-written export script and seed script
// for this; the three subjects SOMET-535 added (class skills, passive labels,
// item icons) had none, so 593 images existed on exactly one machine.
//
// This module replaces the four scripts with one pair driven by a per-kind
// POLICY. The common work -- pull bytes, write a PNG and a manifest, read them
// back, upload under a stable key, point the row at it -- is written once in
// exportArt/seedArt. Everything that differs between kinds is a named field
// or function on SEED_POLICY[kind], so the rules the old scripts encoded are
// still explicit rather than inferred:
//
//   * tiles are ground: never trimmed, gated on render_mode = 'color';
//   * entities are silhouettes: export only `static` rows (a directional set
//     is an atlas, not one still), seed only entries that have been cut out,
//     never flatten existing art unless --force, trim on the way up;
//   * skills / passive labels / items have one image column and no render
//     mode: gate on "already has art", trim as an object, key by SUBJECT KEY
//     -- the generator stores skills under their display name (`Tumble`), and
//     display names are not unique across classes; ids are. Their COMMITTED
//     copy is capped at 256 px on the longest edge (SOMET-573): the game
//     draws them at 30-48 px, and uncapped they were 96 MB. The object store
//     keeps the original; tiles and entities are never resampled.
//
// A kind in SUBJECTS with no entry here is a test failure, not a silent gap.
//
// STABLE KEYS. A seeded asset must not claim to be the output of a job id that
// only existed on somebody else's machine, so every kind uploads under
// `<prefix>/<safe>/seeded/static.png`. The prefix per kind matches what
// remoteImageProvider.storageKey and sprite-gen write, because that is where
// GET /api/assets/* looks.

const fs = require('fs');
const path = require('path');
const { SUBJECTS } = require('./catalogSubjects.js');
const { SKILLS } = require('../../seeds/data/skills.js');
const { shrinkToEdge } = require('./pngResample.js');
const { alphaProfile } = require('./pngAlpha.js');

const SEEDS_ROOT = path.resolve(__dirname, '../../seeds/textures');

function safeName(name) {
  return String(name).replace(/[^A-Za-z0-9_-]/g, '_');
}

// Object-key prefix per kind. `objects/` is what storageKey writes for
// generationKind 'object' subjects; entities are the exception (no prefix),
// matching the creature path sprite-gen's storage.py has always used.
const KEY_PREFIX = { tile: 'tiles/', entity: '', skill: 'objects/', passive_label: 'objects/', item: 'objects/' };

function seededKey(bucket, kind, key) {
  if (!(kind in KEY_PREFIX)) throw new Error(`unknown kind: ${kind}`);
  return `${bucket}/${KEY_PREFIX[kind]}${safeName(key)}/seeded/static.png`;
}

// Shared by the three catalog-art kinds: "does this subject already have
// art" is the whole gate, and the registry's artIndex already answers it.
function catalogArtGate(kind) {
  return async (db, entry, { force = false } = {}) => {
    const index = await SUBJECTS[kind].artIndex(db);
    if (index.has(entry.key) && !force) return { skip: 'has-art' };
    return null;
  };
}

// Registry write, adapted to the (db, entry, key) shape the seeder calls.
function catalogArtLink(kind) {
  return (db, entry, key) => SUBJECTS[kind].write(db, entry.key, key, null);
}

const SKILL_BY_ID = new Map(SKILLS.map((s) => [s.id, s]));

// Longest edge of a committed icon. Measured 2026-09-11 over all 593: p50
// 45 KB, p90 62 KB, max 78 KB, 26 MB total; 192 would be 17 MB but only 4x
// over the 48 px skill grid, which is too little margin for a 2x display.
const ICON_MAX_EDGE = 256;

const SEED_POLICY = Object.freeze({
  tile: {
    kind: 'tile',
    dir: 'tiles',
    manifest: 'tiles.json',
    trim: null,
    maxEdge: null,
    // The prompt and biome ride along so a reader can tell what a committed
    // PNG was drawn from without the database it came out of.
    async exportRows(db) {
      const { rows } = await db.query(
        `SELECT name, image, prompt, art_biome FROM tile_types
          WHERE render_mode = 'image' AND image <> '' ORDER BY name`,
      );
      return rows.map((r) => ({
        key: r.name, name: r.name, image: r.image, prompt: r.prompt, art_biome: r.art_biome || '',
      }));
    },
    async gate(db, entry, { force = false } = {}) {
      const { rows } = await db.query('SELECT id, render_mode FROM tile_types WHERE name = $1', [entry.name]);
      if (!rows[0]) return { skip: 'missing-row' };
      if (rows[0].render_mode !== 'color' && !force) return { skip: 'has-art' };
      return null;
    },
    async link(db, entry, key) {
      await db.query(
        `UPDATE tile_types SET image = $1, sprite = NULL, render_mode = 'image',
          art_biome = CASE WHEN art_biome = '' THEN $2 ELSE art_biome END,
          updated_at = CURRENT_TIMESTAMP WHERE name = $3`,
        [key, entry.art_biome || '', entry.name],
      );
    },
  },

  entity: {
    kind: 'entity',
    dir: 'entities',
    manifest: 'entities.json',
    // SOMET-564: trim on the way up rather than rewriting the checked-in
    // files. The PNGs on disk stay as the generator drew them -- source.
    trim: 'object',
    maxEdge: null,
    // ONLY `static` rows. A 'directional' or 'animated' entity carries an
    // atlas plus a manifest, and pretending one PNG represents it would
    // quietly downgrade it on the next seed.
    async exportRows(db) {
      const { rows } = await db.query(
        `SELECT name, image, prompt, is_creature FROM entity_types
          WHERE render_mode = 'static' AND image IS NOT NULL AND image <> '' ORDER BY name`,
      );
      return rows.map((r) => ({
        key: r.name, name: r.name, image: r.image, prompt: r.prompt, is_creature: r.is_creature,
      }));
    },
    // The store already holds keyed silhouettes for most entities (sprite-gen
    // and the CORE path cut the backdrop out before upload), so a fresh
    // export can tell from the bytes whether an image needs the host-side
    // cutout pass. Marking it here is what lets `make art-seed` accept a
    // fresh export without a destructive re-cut of already-feathered edges.
    // The threshold mirrors the cutout tool's own "backdrop survived" rule
    // (coverage > 90%). `needs_regen` is never set here: that is the tool's
    // judgment about a subject, not a property of the bytes.
    annotate(buffer) {
      const profile = alphaProfile(buffer);
      if (profile && profile.transparentPct >= 10) return { cutout: true };
      return {};
    },
    // Refuse a manifest where NOTHING was cut out: the step was skipped and
    // every prop would ship inside an opaque square, which looks like a
    // rendering bug rather than a missing pipeline step. A manifest that is
    // mostly cut out with a few opaque stragglers is not that case -- those
    // wait individually (see gate) while the rest seed. One opaque file used
    // to block all 308, which read as "the seed is missing art".
    preflight(entries) {
      if (entries.length && !entries.some((m) => m.cutout)) {
        throw new Error('none of these images have been cut out -- run `make entities-cutout` first, '
          + 'or they will render as subjects inside opaque rectangles');
      }
    },
    async gate(db, entry, { force = false } = {}) {
      // Flagged by the cutout pass as still carrying a background or as an
      // erased subject. Seeding one puts a visible box where a sprite should
      // be, which is worse than the coloured rectangle it would replace.
      if (entry.needs_regen) return { skip: 'needs-regen' };
      if (!entry.cutout) return { skip: 'not-cut-out' };
      const { rows } = await db.query('SELECT id, render_mode FROM entity_types WHERE name = $1', [entry.name]);
      if (!rows[0]) return { skip: 'missing-row' };
      // 'rect' is "no art". Anything else is art this machine already has,
      // and a directional set in particular must not be flattened to one
      // still by a seed run. --force is the one deliberate way to do it.
      if (rows[0].render_mode !== 'rect' && !force) return { skip: 'has-art' };
      return null;
    },
    async link(db, entry, key) {
      await db.query(
        `UPDATE entity_types SET image = $1, sprite = NULL, render_mode = 'static',
          updated_at = CURRENT_TIMESTAMP WHERE name = $2`,
        [key, entry.name],
      );
    },
  },

  skill: {
    kind: 'skill',
    dir: 'skills',
    manifest: 'skills.json',
    trim: 'object',
    maxEdge: ICON_MAX_EDGE,
    // catalog_art can outlive a skill that was renamed or removed from
    // seeds/data/skills.js. Art with no subject is not exported: nothing
    // could seed it back, and its manifest entry would only mislead.
    async exportRows(db) {
      const index = await SUBJECTS.skill.artIndex(db);
      const rows = [];
      for (const [key, art] of index) {
        const skill = SKILL_BY_ID.get(key);
        if (!skill) continue;
        rows.push({ key, name: skill.nameEn, image: art.image });
      }
      return rows.sort((a, b) => a.key.localeCompare(b.key));
    },
    gate: catalogArtGate('skill'),
    link: catalogArtLink('skill'),
  },

  passive_label: {
    kind: 'passive_label',
    dir: 'passives',
    manifest: 'passives.json',
    trim: 'object',
    maxEdge: ICON_MAX_EDGE,
    // Keyed by the label text, which is the subject key by design (art is per
    // label, and the key survives a --force reseed that renumbers node ids).
    async exportRows(db) {
      const index = await SUBJECTS.passive_label.artIndex(db);
      return [...index].map(([key, art]) => ({ key, name: key, image: art.image }))
        .sort((a, b) => a.key.localeCompare(b.key));
    },
    gate: catalogArtGate('passive_label'),
    link: catalogArtLink('passive_label'),
  },

  item: {
    kind: 'item',
    dir: 'items',
    manifest: 'items.json',
    trim: 'object',
    maxEdge: ICON_MAX_EDGE,
    async exportRows(db) {
      const index = await SUBJECTS.item.artIndex(db);
      return [...index].map(([key, art]) => ({ key, name: key, image: art.image }))
        .sort((a, b) => a.key.localeCompare(b.key));
    },
    gate: catalogArtGate('item'),
    link: catalogArtLink('item'),
  },
});

// The export runs as root inside the backend container and writes onto a bind
// mount, so without this every exported PNG lands root-owned and the host user
// cannot re-touch it -- the seamless/cutout tools, an editor, or a plain rm
// all fail with EPERM. Match whatever owns the PARENT of the textures root
// (backend/seeds, which the host user cloned): textures/ itself was created
// by an earlier root export and matching it would be a no-op. Best effort.
function matchOwner(target, referenceDir) {
  try {
    const ref = fs.statSync(referenceDir);
    fs.chownSync(target, ref.uid, ref.gid);
  } catch (_) { /* not fatal -- the bytes are written either way */ }
}

async function readObject(store, key) {
  const stream = await store.getObjectStream(key);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function readManifest(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
}

// Manifest entries are matched by `key` for the catalog-art kinds and by
// `name` for tiles and entities, whose existing manifests predate `key` and
// whose Python tools look them up by name.
const entryId = (m) => (m.key !== undefined ? m.key : m.name);

// Copy every subject's art out of the object store into seeds/textures/<dir>/
// and (re)write <manifest>. With `only`, the named subjects are re-exported
// and the rest of the manifest is kept, including flags the host-side tools
// wrote (seamless, cutout, needs_regen) -- a full export drops those on
// purpose, because the bytes it writes are fresh from the generator.
async function exportArt({
  db, store, root = SEEDS_ROOT, kinds = Object.keys(SEED_POLICY), only = null, log = console.log,
}) {
  const results = {};
  for (const kind of kinds) {
    const policy = SEED_POLICY[kind];
    const outDir = path.join(root, policy.dir);
    const manifestPath = path.join(root, policy.manifest);
    fs.mkdirSync(outDir, { recursive: true });
    const owner = path.dirname(root);
    matchOwner(root, owner);

    const all = await policy.exportRows(db);
    const rows = only ? all.filter((r) => only.includes(r.key) || only.includes(r.name)) : all;

    // Two subjects that sanitise to the same file name would silently
    // overwrite each other's PNG and the manifest would point both at it.
    const seen = new Map();
    for (const r of rows) {
      const file = `${safeName(r.key)}.png`;
      if (seen.has(file)) throw new Error(`${kind}: "${seen.get(file)}" and "${r.key}" collide on ${file}`);
      seen.set(file, r.key);
    }

    const fresh = [];
    const failed = [];
    let bytes = 0;
    for (const r of rows) {
      try {
        const raw = await readObject(store, r.image);
        // The committed copy of a capped kind is display-sized; `source`
        // records what it was reduced from. Uncapped kinds are byte-for-byte.
        const shrunk = policy.maxEdge ? shrinkToEdge(raw, policy.maxEdge) : null;
        const buf = shrunk ? shrunk.buffer : raw;
        const file = `${safeName(r.key)}.png`;
        const dest = path.join(outDir, file);
        fs.writeFileSync(dest, buf);
        matchOwner(dest, owner);
        bytes += buf.length;
        const { image, ...manifestFields } = r;
        // Tiles and entities keep their historical shape (name-first, no key).
        const marks = policy.annotate ? policy.annotate(buf) : {};
        const entry = (kind === 'tile' || kind === 'entity')
          ? { name: r.name, file, bytes: buf.length, ...omit(manifestFields, ['key', 'name']), ...marks }
          : { ...manifestFields, file, bytes: buf.length, ...(shrunk ? { source: shrunk.source } : {}), ...marks };
        fresh.push(entry);
        log(`  ${r.name}: ${(buf.length / 1024).toFixed(0)} KB`
          + (shrunk && shrunk.resized ? ` (from ${shrunk.source.width}x${shrunk.source.height})` : ''));
      } catch (err) {
        // A row pointing at a key the store no longer has is worth reporting,
        // not crashing on: it means that subject needs regenerating.
        log(`  ${r.name}: FAILED ${err.message}`);
        failed.push(r.key);
      }
    }

    let manifest = fresh;
    if (only) {
      const replaced = new Set(fresh.map(entryId));
      manifest = readManifest(manifestPath).filter((m) => !replaced.has(entryId(m))).concat(fresh);
    }
    manifest.sort((a, b) => String(entryId(a)).localeCompare(String(entryId(b))));
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    matchOwner(manifestPath, owner);
    matchOwner(outDir, owner);
    results[kind] = { exported: fresh.length, bytes, failed };
  }
  return results;
}

function omit(obj, keys) {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}

// Replay the committed art into the object store and point each catalog row
// at it. `trim` is applied on the way up (see the entity policy); passing
// `trimForStorage` explicitly keeps this module free of the image code path
// in tests.
async function seedArt({
  db, store, root = SEEDS_ROOT, kinds = Object.keys(SEED_POLICY), only = null, force = false,
  trimForStorage = null, log = console.log,
}) {
  const results = {};
  for (const kind of kinds) {
    const policy = SEED_POLICY[kind];
    const inDir = path.join(root, policy.dir);
    const manifestPath = path.join(root, policy.manifest);
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`no manifest at ${manifestPath} -- run \`make art-export KIND=${kind}\` first`);
    }
    const manifest = readManifest(manifestPath);
    const wanted = only
      ? manifest.filter((m) => only.includes(entryId(m)) || only.includes(m.name))
      : manifest;
    if (policy.preflight) policy.preflight(wanted);

    await store.ensureBucket();
    const bucket = store.BUCKET();
    const stats = { linked: 0, skipped: 0, needsRegen: 0, notCutOut: 0, missingFile: 0, missingRow: 0, trimmed: 0 };

    for (const entry of wanted) {
      const entryKey = entryId(entry);
      const verdict = await policy.gate(db, { ...entry, key: entryKey }, { force });
      if (verdict) {
        if (verdict.skip === 'has-art') stats.skipped += 1;
        else if (verdict.skip === 'needs-regen') stats.needsRegen += 1;
        else if (verdict.skip === 'not-cut-out') {
          log(`  ${entry.name}: SKIP (not cut out -- run \`make entities-cutout\`)`);
          stats.notCutOut += 1;
        }
        else if (verdict.skip === 'missing-row') {
          log(`  ${entry.name}: SKIP (no such ${kind} -- seed the catalogue first)`);
          stats.missingRow += 1;
        }
        continue;
      }
      const file = path.join(inDir, entry.file);
      if (!fs.existsSync(file)) {
        log(`  ${entry.name}: FAILED ${entry.file} is in the manifest but not on disk`);
        stats.missingFile += 1;
        continue;
      }
      let buffer = fs.readFileSync(file);
      if (policy.trim && trimForStorage) {
        const trimmed = trimForStorage(buffer, policy.trim);
        buffer = trimmed.buffer;
        if (trimmed.ratio < 1) stats.trimmed += 1;
      }
      const key = seededKey(bucket, kind, entryKey);
      await store.putObject(key, buffer, 'image/png');
      await policy.link(db, { ...entry, key: entryKey }, key);
      stats.linked += 1;
      log(`  ${entry.name}: seeded`);
    }
    results[kind] = stats;
  }
  return results;
}

// Flags the Makefile passes: --kind=a,b --only=x,y --force
function parseArgs(argv) {
  const out = { kinds: Object.keys(SEED_POLICY), only: null, force: false };
  for (const arg of argv) {
    const [flag, value = ''] = arg.split('=');
    if (flag === '--kind' && value) {
      out.kinds = value.split(',').map((s) => s.trim()).filter(Boolean);
      for (const k of out.kinds) if (!SEED_POLICY[k]) throw new Error(`unknown kind: ${k} (expected one of ${Object.keys(SEED_POLICY).join(', ')})`);
    } else if (flag === '--only' && value) {
      out.only = value.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (flag === '--force') {
      out.force = true;
    }
  }
  return out;
}

module.exports = {
  SEED_POLICY, SEEDS_ROOT, seededKey, safeName, exportArt, seedArt, parseArgs,
};
