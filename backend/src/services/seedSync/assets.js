// Asset columns (plan 3). A TableSpec may declare `assets: { [col]: AssetSpec }`:
//   { type: 'image',  dir: string | (row) => string, maxEdge?: number | (row) => number|null }
// image and sprite take an optional `name: (row) => string`: the file's base
// name (through safeName) on a first export; default the natural key joined
// by '|'.
//   { type: 'sprite', dir }   -- jsonb { atlas_key, manifest_key, ...rest }
//   { type: 'audio',  dir: (row) => string }  -- storage_key; the row needs label, kind, sha1
// Locally the column holds object-store keys. In a sync file (and in the
// diff's local form) it holds repo files plus content hashes:
//   image:  { file: '<dir>/<name>.png', sha256 }
//   sprite: { atlas: { file, sha256 }, manifest: { file, sha256 }, ...rest }
//   audio:  { file: '<dir>/<safeName(label)>-<uuid8>.ogg', sha1 }  (from the row alone)
// NULL and '' travel unchanged. Files live under assetsRoot(); `file` is
// relative to it. A per-PC cache (seed_asset_hashes: object_key -> sha256,
// file, bytes) translates keys to files with no download at status time; a
// key with no cache entry reads as { unhashed: key }, which never equals a git
// value (the row reads as a local edit until an export hashes it).
//
// Export downloads into the repo (prepareExportAssets, outside the seed_sync
// lock, cancellable); seed uploads git files content-addressed
// (uploadGitAssets, also outside the lock) and writes the keys in the locked
// transaction, recording the cache entries there (recordCache).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getGroup, tableSpecs, scopeSql, quoteIdent } = require('./registry.js');
const { compareNaturalKey } = require('./canonical.js');
const { buildRefMaps, exportRow } = require('./refs.js');
const { SyncRefused } = require('./errors.js');
const { safeName, matchOwner, readObject } = require('../artSeed.js');
const { shrinkToEdge } = require('../pngResample.js');

const ASSET_TYPES = ['image', 'sprite', 'audio'];
// blockedReasons of a git row whose asset file cannot be uploaded.
const ASSET_FILE_MISSING = 'asset_file_missing';
const ASSET_FILE_MISMATCH = 'asset_file_mismatch';
const ASSET_REASONS = new Set([ASSET_FILE_MISSING, ASSET_FILE_MISMATCH]);
const BLOCKED_MESSAGES = {
  [ASSET_FILE_MISSING]: 'its asset file is missing from the repo; pull again or keep it local',
  [ASSET_FILE_MISMATCH]: 'its asset file does not match the export (edited or corrupt); restore it or keep it local',
};

let tmpCounter = 0;

function assetsRoot() {
  return process.env.SEED_ASSETS_ROOT || path.join(__dirname, '../../../seeds');
}

const assetEntries = (spec) => Object.entries(spec.assets || {});
const hasAssets = (spec) => assetEntries(spec).length > 0;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isEmpty = (v) => v === null || v === undefined || v === '';
const valueOf = (fnOrValue, row) => (typeof fnOrValue === 'function' ? fnOrValue(row) : fnOrValue);
const sha256Of = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sha1Of = (b) => crypto.createHash('sha1').update(b).digest('hex');

// Throws on a malformed `assets` declaration (registry checkSpec calls it).
function checkAssets(spec) {
  if (spec.assets === undefined) return;
  const where = `seed-sync: ${spec.table}`;
  if (!isObj(spec.assets)) throw new Error(`${where}: assets must be an object`);
  for (const [col, a] of Object.entries(spec.assets)) {
    if (!isObj(a) || !ASSET_TYPES.includes(a.type)) throw new Error(`${where}: asset ${col} needs a type (${ASSET_TYPES.join('/')})`);
    if (typeof a.dir !== 'string' && typeof a.dir !== 'function') throw new Error(`${where}: asset ${col} needs a dir`);
    if (a.type === 'audio' && typeof a.dir !== 'function') throw new Error(`${where}: audio asset ${col} needs dir: (row) => string`);
    if (a.name !== undefined && (typeof a.name !== 'function' || a.type === 'audio')) {
      throw new Error(`${where}: asset ${col} name must be (row) => string (image/sprite only)`);
    }
    if (spec.naturalKey.includes(col) || Object.prototype.hasOwnProperty.call(spec.refs || {}, col)) {
      throw new Error(`${where}: asset ${col} cannot be a key or ref column`);
    }
    if (Object.prototype.hasOwnProperty.call(spec.omit || {}, col)) throw new Error(`${where}: asset ${col} is omitted`);
    if (spec.slice && !spec.columns.includes(col)) throw new Error(`${where}: asset ${col} is not a slice column`);
  }
}

// `file` (from a sync file: untrusted) as an absolute path inside root, or
// null when it is not a plain relative path that stays inside.
function resolveFile(root, file) {
  if (typeof file !== 'string' || !file || path.isAbsolute(file) || file.includes('\0')) return null;
  const abs = path.resolve(root, file);
  const rel = path.relative(path.resolve(root), abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

function audioFile(asset, row) {
  return `${valueOf(asset.dir, row)}/${safeName(row.label)}-${String(row.sync_uuid).slice(0, 8)}.ogg`;
}

const cachedPart = (key, cache) => {
  const c = cache.get(key);
  return c ? { file: c.file, sha256: c.sha256 } : { unhashed: key };
};

// Object keys of one local asset value that the cache translates.
function cacheKeys(asset, value) {
  if (asset.type === 'image') return typeof value === 'string' && value ? [value] : [];
  if (asset.type === 'sprite' && isObj(value)) {
    return [value.atlas_key, value.manifest_key].filter((k) => typeof k === 'string' && k);
  }
  return [];
}

// Local (DB) value of `col` in the sync-file form. Pure. `spec` is the
// TableSpec, `row` holds the column (and, for audio, label/kind/sha1/sync_uuid),
// `cache` is loadCache's Map.
function localAssetValue(spec, col, row, cache) {
  const asset = spec.assets[col];
  const v = row[col];
  if (isEmpty(v)) return v === undefined ? null : v;
  if (asset.type === 'image') return typeof v === 'string' ? cachedPart(v, cache) : v;
  if (asset.type === 'sprite') {
    if (!isObj(v)) return v;
    const { atlas_key: atlasKey, manifest_key: manifestKey, ...rest } = v;
    const out = { ...rest };
    if (!isEmpty(atlasKey)) out.atlas = cachedPart(atlasKey, cache);
    if (!isEmpty(manifestKey)) out.manifest = cachedPart(manifestKey, cache);
    return out;
  }
  return { file: audioFile(asset, row), sha1: row.sha1 === undefined ? null : row.sha1 };
}

// `row` with every asset column in sync-file form.
function translateRow(spec, row, cache) {
  if (!hasAssets(spec)) return row;
  const out = { ...row };
  for (const [col] of assetEntries(spec)) out[col] = localAssetValue(spec, col, row, cache);
  return out;
}

// Every key the cache translates for these local rows of `spec`.
function rowCacheKeys(spec, rows) {
  const keys = new Set();
  for (const r of rows) for (const [col, a] of assetEntries(spec)) for (const k of cacheKeys(a, r[col])) keys.add(k);
  return [...keys];
}

// Does a translated (sync-file form) value still name an uncached key?
function hasUnhashed(v) {
  if (!isObj(v)) return false;
  if (Object.prototype.hasOwnProperty.call(v, 'unhashed')) return true;
  return hasUnhashed(v.atlas) || hasUnhashed(v.manifest);
}

async function loadCache(db, keys) {
  if (!keys.length) return new Map();
  const { rows } = await db.query(
    'SELECT object_key, sha256, file, bytes FROM seed_asset_hashes WHERE object_key = ANY($1::text[])', [keys]);
  return new Map(rows.map((r) => [r.object_key, { sha256: r.sha256, file: r.file, bytes: r.bytes }]));
}

// entries: [{ key, sha256, file, bytes }] -> upserted.
async function recordCache(db, entries) {
  for (const e of entries) {
    await db.query(
      `INSERT INTO seed_asset_hashes (object_key, sha256, file, bytes) VALUES ($1, $2, $3, $4)
       ON CONFLICT (object_key) DO UPDATE SET sha256 = EXCLUDED.sha256, file = EXCLUDED.file, bytes = EXCLUDED.bytes`,
      [e.key, e.sha256, e.file, e.bytes]);
  }
}

function checkCancel(signal) {
  if (signal && signal.aborted) throw new SyncRefused('cancelled', 'cancelled');
}

// The first path component of `abs` below `root` that is a symlink ('link'),
// or 'missing' when one does not exist, else 'ok'. With leaf false the last
// component is not looked at (a write replaces it, link or not).
async function walkUnder(root, abs, leaf) {
  const parts = path.relative(root, abs).split(path.sep);
  if (!leaf) parts.pop();
  let p = root;
  for (const part of parts) {
    p = path.join(p, part);
    let st;
    try {
      st = await fs.promises.lstat(p);
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return 'missing';
      throw e;
    }
    if (st.isSymbolicLink()) return 'link';
  }
  return 'ok';
}

// A repo asset file read without following a symlink anywhere below root
// (a symlink could point a hand-edited sync file at any file on the PC):
// { buf } | { missing: true } | { symlink: true }.
async function readRepoFile(root, file) {
  const abs = resolveFile(root, file);
  if (!abs) return { missing: true };
  const walk = await walkUnder(path.resolve(root), abs, true);
  if (walk === 'link') return { symlink: true };
  if (walk === 'missing') return { missing: true };
  let fh;
  try {
    fh = await fs.promises.open(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e) {
    if (e.code === 'ELOOP') return { symlink: true };
    if (e.code === 'ENOENT' || e.code === 'EISDIR' || e.code === 'ENOTDIR') return { missing: true };
    throw e;
  }
  try {
    if (!(await fh.stat()).isFile()) return { missing: true };
    return { buf: await fh.readFile() };
  } finally {
    await fh.close();
  }
}

const unsafeWrite = (file) => new SyncRefused('asset_path_unsafe',
  'an asset directory is a symlink or leads outside the seeds tree; fix it first', { file });

// tmp, rename, chown like the rest of the seeds tree (artSeed.matchOwner: the
// backend runs as root in compose, the repo belongs to the host user). Never
// through a symlinked directory: checked before mkdir (no stray dirs outside)
// and by realpath after it.
async function writeAtomic(root, abs, buf) {
  const dir = path.dirname(abs);
  const rel = path.relative(root, abs);
  if ((await walkUnder(root, abs, false)) === 'link') throw unsafeWrite(rel);
  await fs.promises.mkdir(dir, { recursive: true });
  const realRoot = await fs.promises.realpath(root);
  const realDir = await fs.promises.realpath(dir);
  if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) throw unsafeWrite(rel);
  for (let d = dir; d.startsWith(root) && d !== root; d = path.dirname(d)) matchOwner(d, root);
  const tmp = `${abs}.${process.pid}.${tmpCounter++}.tmp`;
  try {
    await fs.promises.writeFile(tmp, buf);
    await fs.promises.rename(tmp, abs);
  } catch (e) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw e;
  }
  matchOwner(abs, root);
}

// Download one object; null when the store does not have it (any other error
// -- network, auth -- throws: "missing" would then be a lie).
async function download(store, key) {
  try {
    return await readObject(store, key);
  } catch (e) {
    if (!(await store.objectExists(key))) return null;
    throw e;
  }
}

// Exported-form rows (refs translated, natural-key order) of one spec, as the
// export would read them, with display key text.
async function exportedRows(db, spec) {
  const maps = await buildRefMaps(db, spec);
  const { rows } = await db.query(`SELECT * FROM ${quoteIdent(spec.table)} WHERE true${scopeSql(spec)}`);
  return rows.map((r) => exportRow(r, spec, maps)).sort((a, b) => compareNaturalKey(a, b, spec.naturalKey));
}

const keyText = (spec, row) => spec.naturalKey.map((k) => (typeof row[k] === 'string' ? row[k] : JSON.stringify(row[k]))).join('|');

// Download every local asset of `group` into assetsRoot() and cache its hash.
// A key is fetched only when uncached, or its cached file is missing on disk
// or differs from the cached sha256 (then it keeps its recorded path). Audio is
// fetched when its file is missing or its sha1 differs from the row's sha1.
// Every object to fetch is checked first: any missing -> nothing is written
// and `missing` lists them. An audio row with no sha1 -> nothing is fetched
// or written and `sha1Missing` lists them ({ table, key, label }). Never under
// the seed_sync lock (long); the export re-reads the cache under the lock and
// refuses a key it does not find.
async function prepareExportAssets(pool, store, group, { onProgress, signal } = {}) {
  const root = path.resolve(assetsRoot());
  const tasks = []; // { kind: 'cached'|'audio', key, base, ext, maxEdge, file, sha1, table, rowKey }
  // Audio travels by the row's sha1 (no cache): without one the value would
  // read as a mismatch on every other PC. Refused before any file is written.
  const sha1Missing = [];
  const seenKeys = new Set();
  const dirs = new Set();
  for (const spec of tableSpecs(group)) {
    if (!hasAssets(spec)) continue;
    for (const [, a] of assetEntries(spec)) if (typeof a.dir === 'string') dirs.add(a.dir);
    const rows = await exportedRows(pool, spec);
    for (const row of rows) {
      for (const [col, a] of assetEntries(spec)) {
        const v = row[col];
        if (isEmpty(v)) continue;
        const name = safeName(a.name ? String(a.name(row)) : keyText(spec, row));
        const dir = valueOf(a.dir, row);
        dirs.add(dir);
        const base = { table: spec.table, rowKey: keyText(spec, row) };
        const add = (t) => { if (!seenKeys.has(t.key)) { seenKeys.add(t.key); tasks.push({ ...base, ...t }); } };
        if (a.type === 'image' && typeof v === 'string') {
          add({ kind: 'cached', key: v, base: `${dir}/${name}`, ext: 'png', maxEdge: valueOf(a.maxEdge, row) || null });
        } else if (a.type === 'sprite' && isObj(v)) {
          if (!isEmpty(v.atlas_key)) add({ kind: 'cached', key: v.atlas_key, base: `${dir}/${name}.atlas`, ext: 'png' });
          if (!isEmpty(v.manifest_key)) add({ kind: 'cached', key: v.manifest_key, base: `${dir}/${name}.manifest`, ext: 'json' });
        } else if (a.type === 'audio' && typeof v === 'string') {
          if (isEmpty(row.sha1)) sha1Missing.push({ table: spec.table, key: keyText(spec, row), label: row.label });
          add({ kind: 'audio', key: v, file: audioFile(a, row), sha1: row.sha1 });
        }
      }
    }
  }
  if (sha1Missing.length) return { downloaded: 0, reused: 0, missing: [], sha1Missing, orphanFiles: 0 };
  const cache = await loadCache(pool, tasks.filter((t) => t.kind === 'cached').map((t) => t.key));

  // Which tasks need a download (and the bytes of what is on disk now).
  const fetch = [];
  let reused = 0;
  for (const t of tasks) {
    checkCancel(signal);
    if (t.kind === 'cached') {
      const c = cache.get(t.key);
      if (c) {
        t.file = c.file;
        const { buf: disk } = await readRepoFile(root, c.file);
        if (disk && sha256Of(disk) === c.sha256) { reused += 1; continue; }
      }
    } else {
      const { buf: disk } = await readRepoFile(root, t.file);
      if (disk && t.sha1 && sha1Of(disk) === t.sha1) { reused += 1; continue; }
    }
    fetch.push(t);
  }
  const missing = [];
  for (const t of fetch) {
    checkCancel(signal);
    if (!(await store.objectExists(t.key))) missing.push({ table: t.table, key: t.rowKey, objectKey: t.key });
  }
  if (missing.length) return { downloaded: 0, reused, missing, sha1Missing: [], orphanFiles: 0 };

  await fs.promises.mkdir(root, { recursive: true });
  matchOwner(root, path.dirname(root));
  // File names: a cached key keeps its recorded path; a new one takes
  // <base>.<ext>, or <base>-<sha8>.<ext> when a key earlier in this export
  // (natural-key order) holds that name.
  const claimed = new Map();
  for (const t of tasks) if (t.file) claimed.set(t.file, t.key);
  let downloaded = 0;
  const total = fetch.length;
  for (const t of fetch) {
    checkCancel(signal);
    const raw = await download(store, t.key);
    if (raw === null) throw new SyncRefused('assets_changed', 'art changed during export, run it again', { objectKey: t.key });
    const buf = t.maxEdge ? shrinkToEdge(raw, t.maxEdge).buffer : raw;
    const sha = sha256Of(buf);
    if (!t.file) {
      t.file = `${t.base}.${t.ext}`;
      if (claimed.has(t.file) && claimed.get(t.file) !== t.key) t.file = `${t.base}-${sha.slice(0, 8)}.${t.ext}`;
      claimed.set(t.file, t.key);
    }
    const abs = resolveFile(root, t.file);
    if (!abs) throw new Error(`seed-sync: asset file ${JSON.stringify(t.file)} is outside ${root}`);
    await writeAtomic(root, abs, buf);
    if (t.kind === 'cached') await recordCache(pool, [{ key: t.key, sha256: sha, file: t.file, bytes: buf.length }]);
    downloaded += 1;
    if (onProgress) onProgress({ phase: 'download', done: downloaded, total, key: t.key });
  }

  // Orphans: files in a group-managed dir that no row of this export uses.
  const used = new Set(tasks.map((t) => path.resolve(root, t.file)));
  let orphanFiles = 0;
  for (const dir of dirs) {
    const abs = resolveFile(root, dir);
    if (!abs) continue;
    let names;
    try { names = await fs.promises.readdir(abs, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    for (const d of names) if (d.isFile() && !used.has(path.join(abs, d.name))) orphanFiles += 1;
  }
  return { downloaded, reused, missing: [], sha1Missing: [], orphanFiles };
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const SHA1_RE = /^[0-9a-f]{40}$/;
// An audio kind is a path segment of the clip's object key.
const AUDIO_KIND_RE = /^[a-z0-9_-]+$/;

// Git-side parts of one asset value that reference repo files:
// [{ file, sha256 } | { file, sha1 }], or null when the value is malformed
// (an audio value needs a 40-hex sha1 and its row a plain `kind`).
function gitParts(asset, v, row) {
  if (isEmpty(v)) return [];
  if (!isObj(v)) return null;
  const okHash = (p) => isObj(p) && typeof p.file === 'string' && SHA256_RE.test(p.sha256);
  if (asset.type === 'image') return okHash(v) ? [v] : null;
  if (asset.type === 'sprite') {
    // Object keys never travel (uploadGitAssets would write them verbatim:
    // a hand-edited file could point the row at any object), and a sprite
    // without a single part is not one an export wrote.
    if (v.atlas_key !== undefined || v.manifest_key !== undefined) return null;
    if (v.atlas === undefined && v.manifest === undefined) return null;
    const parts = [];
    for (const k of ['atlas', 'manifest']) {
      if (v[k] === undefined) continue;
      if (!okHash(v[k])) return null;
      parts.push(v[k]);
    }
    return parts;
  }
  const ok = typeof v.file === 'string' && SHA1_RE.test(v.sha1) && !!row && AUDIO_KIND_RE.test(row.kind);
  return ok ? [{ file: v.file, sha1: v.sha1 }] : null;
}

// Per process: abs path -> { dev, ino, size, mtimeMs, sha256, sha1 }. A
// preview checks every differing git file (a first sync: ~1000 files,
// ~200 MB); an unchanged file (same inode, size and mtime) is not re-read.
const HASH_MEMO_MAX = 20000;
const hashMemo = new Map();
let hashedFiles = 0;

// Hashes of a repo file, with readRepoFile's checks (no symlink anywhere
// below root): { sha256, sha1 } | { missing: true } | { symlink: true }.
async function hashRepoFile(root, file) {
  const abs = resolveFile(root, file);
  if (!abs) return { missing: true };
  const walk = await walkUnder(path.resolve(root), abs, true);
  if (walk === 'link') return { symlink: true };
  if (walk === 'missing') return { missing: true };
  let fh;
  try {
    fh = await fs.promises.open(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e) {
    if (e.code === 'ELOOP') return { symlink: true };
    if (e.code === 'ENOENT' || e.code === 'EISDIR' || e.code === 'ENOTDIR') return { missing: true };
    throw e;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { missing: true };
    const m = hashMemo.get(abs);
    if (m && m.dev === st.dev && m.ino === st.ino && m.size === st.size && m.mtimeMs === st.mtimeMs) {
      return { sha256: m.sha256, sha1: m.sha1 };
    }
    const buf = await fh.readFile();
    hashedFiles += 1;
    const h = { sha256: sha256Of(buf), sha1: sha1Of(buf) };
    if (hashMemo.size >= HASH_MEMO_MAX) hashMemo.clear();
    hashMemo.set(abs, { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ...h });
    return h;
  } finally {
    await fh.close();
  }
}

// Per call memo of file -> hashRepoFile result (never look at a file twice).
function fileReader(root) {
  const memo = new Map();
  return async (file) => {
    if (!memo.has(file)) memo.set(file, await hashRepoFile(root, file));
    return memo.get(file);
  };
}

const partMatches = (part, buf) => (part.sha256 !== undefined ? sha256Of(buf) === part.sha256 : sha1Of(buf) === part.sha1);
const hashMatches = (part, h) => (part.sha256 !== undefined ? h.sha256 === part.sha256 : h.sha1 === part.sha1);

// Map(sync_uuid -> 'asset_file_missing' | 'asset_file_mismatch') for the git
// (file-form) `rows` of `spec` whose asset files are not on disk or do not
// match their hash. Only the files of the rows passed are read. `read` (a
// fileReader) shares the memo across specs of one call.
async function checkGitAssets(root, rows, spec, read = fileReader(root)) {
  const out = new Map();
  for (const row of rows) {
    let reason = null;
    for (const [col, a] of assetEntries(spec)) {
      const parts = gitParts(a, row[col], row);
      if (parts === null) { reason = reason || ASSET_FILE_MISMATCH; continue; }
      for (const p of parts) {
        const f = await read(p.file);
        if (f.missing) reason = ASSET_FILE_MISSING;
        else if (f.symlink || !hashMatches(p, f)) reason = reason || ASSET_FILE_MISMATCH;
      }
    }
    if (reason) out.set(row.sync_uuid, reason);
  }
  return out;
}

// Object-key name of a repo file: the whole relative path through safeName,
// extension kept ('sx_tiles/a b.png' -> 'sx_tiles_a_b.png').
function fileKeyName(file) {
  const ext = path.extname(file);
  return `${safeName(ext ? file.slice(0, -ext.length) : file)}${ext ? `.${safeName(ext.slice(1))}` : ''}`;
}

// Uploads the asset files of git `rows` of `spec` (the rows a seed writes from
// git; their unchanged columns already blanked by the caller). Returns
// { values: Map(sync_uuid -> { [col]: local DB value }), cacheEntries } --
// cacheEntries are what recordCache stores once the keys are written. Every
// key is new or immutable, so an apply that fails later never changes the
// bytes a live row is served:
//  - image / sprite part: `${BUCKET()}/seedsync/<sha256>/<fileKeyName(file)>`
//    (content-addressed AND file-scoped: two files with the same bytes get
//    two keys, so each cache entry keeps its own file);
//  - audio: `audio/<kind>/<sync_uuid>-<sha1 first 8>.ogg` (the clip's old
//    object stays as an orphan).
// Both are skipped when the object exists. A file that no longer matches its
// hash refuses 'assets_changed' (re-preview). Outside the lock; checks
// `signal` between files.
async function uploadGitAssets(store, rows, spec, { onProgress, signal, root = path.resolve(assetsRoot()) } = {}) {
  const values = new Map();
  const cacheEntries = [];
  const uploaded = new Set(); // object keys put or found in this call
  const total = rows.reduce((n, r) => n + assetEntries(spec).filter(([c]) => !isEmpty(r[c])).length, 0);
  let done = 0;
  const readChecked = async (part) => {
    const { buf } = await readRepoFile(root, part.file);
    if (!buf || !partMatches(part, buf)) {
      throw new SyncRefused('assets_changed', 'an asset file changed since the preview; preview again', { file: part.file });
    }
    return buf;
  };
  const putOnce = async (key, buf, contentType) => {
    if (uploaded.has(key)) return;
    if (!(await store.objectExists(key))) await store.putObject(key, buf, contentType);
    uploaded.add(key);
  };
  const putHashed = async (part, contentType) => {
    checkCancel(signal);
    const buf = await readChecked(part);
    const key = `${store.BUCKET()}/seedsync/${part.sha256}/${fileKeyName(part.file)}`;
    await putOnce(key, buf, contentType);
    cacheEntries.push({ key, sha256: part.sha256, file: part.file, bytes: buf.length });
    return key;
  };
  checkCancel(signal);
  for (const row of rows) {
    const vals = {};
    for (const [col, a] of assetEntries(spec)) {
      const v = row[col];
      if (isEmpty(v)) continue;
      const parts = gitParts(a, v, row);
      if (parts === null) throw new SyncRefused(ASSET_FILE_MISMATCH, BLOCKED_MESSAGES[ASSET_FILE_MISMATCH], { uuids: [row.sync_uuid] });
      if (a.type === 'image') {
        vals[col] = await putHashed(v, 'image/png');
      } else if (a.type === 'sprite') {
        const { atlas, manifest, ...rest } = v;
        const sprite = { ...rest };
        if (atlas !== undefined) sprite.atlas_key = await putHashed(atlas, 'image/png');
        if (manifest !== undefined) sprite.manifest_key = await putHashed(manifest, 'application/json');
        vals[col] = sprite;
      } else {
        checkCancel(signal);
        const buf = await readChecked(parts[0]);
        const key = `audio/${row.kind}/${row.sync_uuid}-${parts[0].sha1.slice(0, 8)}.ogg`;
        await putOnce(key, buf, 'audio/ogg');
        vals[col] = key;
      }
      done += 1;
      if (onProgress) onProgress({ phase: 'upload', done, total });
    }
    values.set(row.sync_uuid, vals);
  }
  return { values, cacheEntries };
}

module.exports = {
  ASSET_FILE_MISSING, ASSET_FILE_MISMATCH, ASSET_REASONS, BLOCKED_MESSAGES,
  isEmpty, assetsRoot, hasAssets, checkAssets, localAssetValue, translateRow, rowCacheKeys, hasUnhashed,
  loadCache, recordCache, prepareExportAssets, checkGitAssets, fileReader, uploadGitAssets,
  _hashedFiles: () => hashedFiles,
};
