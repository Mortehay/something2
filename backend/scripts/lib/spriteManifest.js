const crypto = require('node:crypto');
const fs = require('node:fs');

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KINDS = new Set(['creature', 'object']);
const MIN_DIM = 8;
const MAX_DIM = 512;

function _requireString(v, field) {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`entity ${field} must be a non-empty string`);
  return v;
}

function _validateSize(size) {
  if (!Array.isArray(size) || size.length !== 2) throw new Error('size must be a [width, height] pair');
  for (const dim of size) {
    if (!Number.isInteger(dim) || dim < MIN_DIM || dim > MAX_DIM) {
      throw new Error(`size dimensions must be integers in [${MIN_DIM}, ${MAX_DIM}] (got ${dim})`);
    }
  }
  return size;
}

function parseManifest(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('manifest must be an object');
  if (raw.version !== 1) throw new Error(`unsupported manifest version (expected 1, got ${raw.version})`);
  const defaults = raw.defaults && typeof raw.defaults === 'object' ? raw.defaults : {};
  if (defaults.size !== undefined) _validateSize(defaults.size);
  if (!Array.isArray(raw.entities) || raw.entities.length === 0) {
    throw new Error('manifest must list at least one entity');
  }
  const seen = new Set();
  for (const e of raw.entities) {
    if (!e || typeof e !== 'object') throw new Error('each entity must be an object');
    if (typeof e.name !== 'string' || !NAME_RE.test(e.name)) {
      throw new Error(`entity name must match ${NAME_RE} (got ${JSON.stringify(e.name)})`);
    }
    if (seen.has(e.name)) throw new Error(`duplicate entity name '${e.name}'`);
    seen.add(e.name);
    if (!KINDS.has(e.kind)) throw new Error(`entity '${e.name}' kind must be 'creature' or 'object'`);
    _requireString(e.prompt, 'prompt');
    if (e.seed !== undefined && !Number.isInteger(e.seed)) throw new Error(`entity '${e.name}' seed must be an integer`);
    if (e.size !== undefined) _validateSize(e.size);
  }
  return { version: 1, defaults, entities: raw.entities };
}

function loadManifest(filePath) {
  return parseManifest(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

function resolveEntity(defaults, entity) {
  const size = entity.size || defaults.size || [128, 160];
  const backend = entity.backend !== undefined ? entity.backend : (defaults.backend ?? null);
  const seed = entity.seed !== undefined ? entity.seed : (defaults.seed ?? 0);
  return {
    name: entity.name,
    kind: entity.kind,
    prompt: entity.prompt,
    seed,
    size: [size[0], size[1]],
    backend,
    frames: 1,
  };
}

function fingerprint(resolved) {
  const str = `${resolved.kind}|${resolved.prompt}|${resolved.seed}|${resolved.size[0]}x${resolved.size[1]}`;
  return crypto.createHash('sha256').update(str).digest('hex');
}

function selectEntities(manifest, opts = {}) {
  if (!opts.only || opts.only.length === 0) return manifest.entities;
  const wanted = new Set(opts.only);
  return manifest.entities.filter((e) => wanted.has(e.name));
}

function shouldSkip(resolved, lock, force) {
  if (force) return false;
  const entry = lock[resolved.name];
  return Boolean(entry && entry.fingerprint === fingerprint(resolved));
}

function loadLock(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

function saveLock(filePath, lock) {
  fs.writeFileSync(filePath, `${JSON.stringify(lock, null, 2)}\n`);
}

module.exports = {
  parseManifest, loadManifest, resolveEntity, fingerprint,
  selectEntities, shouldSkip, loadLock, saveLock,
};
