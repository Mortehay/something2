'use strict';
// Image shrink: WebP "web copies" of game art (spec 2026-11-13-image-shrink).
// The catalog column keeps the original key; image_variants maps a subject
// (table, row natural key, column) to its web copy, and game-facing payloads
// swap keys through getServeMap + webArt. Originals are only ever read.
//
// A subject's key is seedSync's keyText of the exported row (by-uuid refs as
// the target's sync_uuid), so a variant travels with the seed (Task 7).
// A variant is STALE -- players get the original -- when the column no longer
// holds original_key or -- sheets -- original_manifest_key, or when stale_at
// is set. stale_at is persisted by the auto-shrink sweep (R15): its etag pass
// stats the originals and marks a variant whose original (or manifest) bytes
// changed under the same key; markMovedStale marks one whose column moved. So
// the serve map is built from the DB alone (no store call on a game request)
// and a shrink clears the mark. listImages still stats and reads an etag
// mismatch as stale too.
// A seeded variant arrives with original_key NULL and is bound (bindUnbound)
// only when the target's own original is the very art the source shrank: its
// key is seedsync/<source_asset_sha256>/... (R14). Otherwise it stays unbound
// (the original is served) and auto-shrink may replace it with its own copy.

const crypto = require('node:crypto');
const path = require('node:path');
const { getGroup, scopeSql, quoteIdent } = require('./seedSync/registry.js');
const { buildRefMaps, exportRow } = require('./seedSync/refs.js');
const { keyText } = require('./seedSync/assets.js');
const { imageColumns, defaultParams, isSheetKind } = require('./imageCatalog.js');
const { shrinkImage, shrinkSheet, shrinkStrip, ShrinkError } = require('./imageShrink.js');

const SERVE_TTL_MS = 60 * 1000;
const STAT_CONCURRENCY = 16;

// ---- subjects -------------------------------------------------------------

function columnOf(subject) {
  const col = subject && imageColumns().find((c) => c.table === subject.table && c.column === subject.column);
  if (!col) throw new Error(`image shrink: ${subject && subject.table}.${subject && subject.column} is not an image column`);
  return col;
}

function rowKind(col, row) {
  return col.kind === 'art' ? `art:${row.subject_kind}` : col.kind;
}

const present = (v) => typeof v === 'string' && v.trim() !== '';

// { original, manifest } keys the column holds now, or null when it holds no art.
function currentKeys(col, row) {
  const v = row && row[col.column];
  if (col.assetType === 'sprite') {
    if (!v || typeof v !== 'object' || !present(v.atlas_key)) return null;
    return { original: v.atlas_key, manifest: present(v.manifest_key) ? v.manifest_key : null };
  }
  return present(v) ? { original: v, manifest: null } : null;
}

function labelOf(row, key) {
  for (const c of ['name', 'label', 'subject_key']) if (present(row[c])) return row[c];
  return key;
}

// Map(subject key -> local row) of one art-group table.
async function loadRows(pool, table) {
  const spec = getGroup('art').tables.find((s) => s.table === table);
  if (!spec) throw new Error(`image shrink: ${table} is not in the art group`);
  const maps = await buildRefMaps(pool, spec);
  const { rows } = await pool.query(`SELECT * FROM ${quoteIdent(table)} WHERE true${scopeSql(spec)}`);
  return new Map(rows.map((r) => [keyText(spec, exportRow(r, spec, maps)), r]));
}

function rowLoader(pool) {
  const cache = new Map();
  return (table) => {
    if (!cache.has(table)) cache.set(table, loadRows(pool, table));
    return cache.get(table);
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Size + etag of the subject's current original and (sheets) manifest.
async function statKeys(store, cur) {
  if (!cur) return { st: null, mst: null };
  const [st, mst] = await Promise.all([
    store.statObject(cur.original),
    cur.manifest ? store.statObject(cur.manifest) : null,
  ]);
  return { st, mst };
}

// The variant still describes what the column holds now: same original key
// and etag and, for a sheet, same manifest key and etag (R5).
function isFresh(variant, cur, { st, mst }) {
  if (!cur || !st || variant.original_key !== cur.original || variant.original_etag !== st.etag) return false;
  if ((variant.original_manifest_key || null) !== (cur.manifest || null)) return false;
  return !cur.manifest || (!!mst && variant.original_manifest_etag === mst.etag);
}

function stateOf(variant, cur, stats) {
  if (!variant) return 'original';
  if (variant.stale_at || !isFresh(variant, cur, stats)) return 'stale';
  return variant.active ? 'shrunk' : 'undone';
}

const tripleKey = (table, key, column) => `${table}\u0000${key}\u0000${column}`;

// The target's original is the art the source shrank: seed uploads a git
// file as <bucket>/seedsync/<sha256 of the file>/<name> (assets.uploadGitAssets).
function seededFrom(originalKey, sha) {
  return typeof sha === 'string' && /^[0-9a-f]{64}$/.test(sha) && typeof originalKey === 'string'
    && (originalKey.startsWith(`seedsync/${sha}/`) || originalKey.includes(`/seedsync/${sha}/`));
}

// Bind seeded variants (original_key NULL) to the subject's current original
// and its etag -- only when that original is the source's exported art
// (seededFrom; for a sheet the atlas, the manifest is not compared). A subject
// with no row, no art, other art or a missing object stays unbound.
async function bindUnbound(pool, store) {
  const { rows } = await pool.query('SELECT * FROM image_variants WHERE original_key IS NULL');
  if (!rows.length) return 0;
  const cols = imageColumns();
  const load = rowLoader(pool);
  let bound = 0;
  for (const v of rows) {
    const col = cols.find((c) => c.table === v.subject_table && c.column === v.subject_column);
    if (!col) continue;
    const cur = currentKeys(col, (await load(v.subject_table)).get(v.subject_key));
    if (!cur || !seededFrom(cur.original, v.source_asset_sha256)) continue;
    const { st, mst } = await statKeys(store, cur);
    if (!st || (cur.manifest && !mst)) continue;
    const r = await pool.query(
      `UPDATE image_variants SET original_key = $2, original_etag = $3, original_bytes = $4,
              original_manifest_key = $5, original_manifest_etag = $6, stale_at = NULL, updated_at = now()
        WHERE id = $1 AND original_key IS NULL`,
      [v.id, cur.original, st.etag, st.size, cur.manifest, mst ? mst.etag : null]);
    bound += r.rowCount;
  }
  if (bound) invalidateServeMap();
  return bound;
}

// ---- persisted staleness (R15) --------------------------------------------

async function markStale(pool, ids) {
  if (!ids.length) return 0;
  const r = await pool.query(
    'UPDATE image_variants SET stale_at = now() WHERE id = ANY($1::int[]) AND stale_at IS NULL', [ids]);
  if (r.rowCount) invalidateServeMap();
  return r.rowCount;
}

// [{ v, cur }] of bound, unmarked variants (cur: the column's keys now, or
// null). `only(subject)` narrows it (tests).
async function boundVariants(pool, only) {
  const { rows } = await pool.query(
    'SELECT * FROM image_variants WHERE original_key IS NOT NULL AND stale_at IS NULL');
  const cols = imageColumns();
  const load = rowLoader(pool);
  const out = [];
  for (const v of rows) {
    if (typeof only === 'function'
      && !only({ table: v.subject_table, key: v.subject_key, column: v.subject_column })) continue;
    const col = cols.find((c) => c.table === v.subject_table && c.column === v.subject_column);
    if (!col) continue;
    out.push({ v, cur: currentKeys(col, (await load(v.subject_table)).get(v.subject_key)) });
  }
  return out;
}

// Mark bound variants whose column no longer holds original_key (or, for a
// sheet, original_manifest_key) -- including a deleted subject. DB only.
async function markMovedStale(pool, { only = null } = {}) {
  const ids = (await boundVariants(pool, only))
    .filter(({ v, cur }) => !cur || cur.original !== v.original_key
      || (v.original_manifest_key || null) !== (cur.manifest || null))
    .map(({ v }) => v.id);
  return markStale(pool, ids);
}

// The etag pass: stat the original (and manifest) of every bound, unmarked
// variant whose keys still match and mark the ones whose bytes changed under
// the same key. A missing object is left alone (nothing better to serve).
// Returns the number marked.
async function markEtagStale(pool, store, { only = null } = {}) {
  const live = (await boundVariants(pool, only)).filter(({ v, cur }) => cur && cur.original === v.original_key);
  const stats = await mapLimit(live, STAT_CONCURRENCY, (x) => statKeys(store, x.cur));
  const ids = [];
  live.forEach(({ v, cur }, i) => {
    if (stats[i].st && !isFresh(v, cur, stats[i])) ids.push(v.id);
  });
  return markStale(pool, ids);
}

// ---- seed export (R14) ----------------------------------------------------

// Stamp source_asset_sha256 on every variant the art export writes (bound,
// active, unmarked): the sha256 of the file the export writes for the
// subject's current original (the atlas for a sheet) -- the seed_asset_hashes
// entry prepareExportAssets recorded, else computed the same way (download,
// PNG resampled to the column's maxEdge). Unbound (seeded) rows keep theirs.
async function stampSourceSha(pool, store) {
  const { rows } = await pool.query(
    'SELECT * FROM image_variants WHERE active AND original_key IS NOT NULL AND stale_at IS NULL');
  if (!rows.length) return 0;
  const { tableSpecs } = require('./seedSync/registry.js');
  const specs = new Map(tableSpecs(getGroup('art')).map((s) => [s.table, s]));
  const cols = imageColumns();
  const exported = new Map(); // table -> Map(key -> exported row)
  const exportedOf = async (table) => {
    if (!exported.has(table)) {
      const spec = specs.get(table);
      const maps = await buildRefMaps(pool, spec);
      const { rows: rs } = await pool.query(`SELECT * FROM ${quoteIdent(table)} WHERE true${scopeSql(spec)}`);
      exported.set(table, new Map(rs.map((r) => { const e = exportRow(r, spec, maps); return [keyText(spec, e), e]; })));
    }
    return exported.get(table);
  };
  let n = 0;
  for (const v of rows) {
    const col = cols.find((c) => c.table === v.subject_table && c.column === v.subject_column);
    if (!col) continue;
    const row = (await exportedOf(col.table)).get(v.subject_key);
    const cur = currentKeys(col, row);
    if (!cur || cur.original !== v.original_key) continue;
    const sha = await exportedSha(pool, store, specs.get(col.table).assets[col.column], row, cur.original);
    if (!sha || sha === v.source_asset_sha256) continue;
    await pool.query('UPDATE image_variants SET source_asset_sha256 = $2 WHERE id = $1', [v.id, sha]);
    n += 1;
  }
  return n;
}

async function exportedSha(pool, store, asset, row, key) {
  const { rows } = await pool.query('SELECT sha256 FROM seed_asset_hashes WHERE object_key = $1', [key]);
  if (rows[0]) return rows[0].sha256;
  let buf;
  try { buf = await store.readObject(key); } catch (e) { return null; }
  const maxEdge = asset.type === 'image' && !/\.webp$/i.test(key)
    ? (typeof asset.maxEdge === 'function' ? asset.maxEdge(row) : asset.maxEdge) || null : null;
  if (maxEdge) buf = require('./pngResample.js').shrinkToEdge(buf, maxEdge).buffer;
  return sha256(buf);
}

// ---- listing --------------------------------------------------------------

// Every subject whose column holds art now, with its variant (or null). DB
// only: no object-store stats. Callers bind seeded variants first.
async function catalogEntries(pool, { kind } = {}) {
  const { rows: variants } = await pool.query('SELECT * FROM image_variants');
  const byTriple = new Map(variants.map((v) => [tripleKey(v.subject_table, v.subject_key, v.subject_column), v]));
  const load = rowLoader(pool);
  const found = [];
  for (const col of imageColumns()) {
    if (kind && col.kind !== 'art' && col.kind !== kind) continue;
    for (const [key, row] of await load(col.table)) {
      const k = rowKind(col, row);
      if (kind && k !== kind) continue;
      const cur = currentKeys(col, row);
      if (!cur) continue;
      found.push({ col, key, row, kind: k, cur, variant: byTriple.get(tripleKey(col.table, key, col.column)) || null });
    }
  }
  return found;
}

async function listImages(pool, store, { kind, state, minBytes } = {}) {
  await bindUnbound(pool, store);
  const found = await catalogEntries(pool, { kind });
  const stats = await mapLimit(found, STAT_CONCURRENCY, (f) => statKeys(store, f.cur));
  const serving = await servingVariants(pool);
  const out = [];
  found.forEach((f, i) => {
    const { st } = stats[i];
    const by = serving.get(f.cur.original);
    const servedBy = by && tripleKey(by.subject_table, by.subject_key, by.subject_column)
      !== tripleKey(f.col.table, f.key, f.col.column)
      ? { table: by.subject_table, key: by.subject_key, column: by.subject_column } : null;
    const item = {
      subject: { table: f.col.table, key: f.key, column: f.col.column },
      kind: f.kind,
      label: labelOf(f.row, f.key),
      original_key: f.cur.original,
      manifest_key: f.cur.manifest,
      bytes: st ? st.size : null,
      state: stateOf(f.variant, f.cur, stats[i]),
      variant: f.variant,
      // Another subject's web copy is what players get for this original key.
      served_by: servedBy,
    };
    if (state && item.state !== state) return;
    if (minBytes != null && !(item.bytes != null && item.bytes >= minBytes)) return;
    out.push(item);
  });
  return out;
}

// ---- shrink / undo / reactivate -------------------------------------------

// Validated params for this kind (defaults filled in), or null when invalid.
// Sheets and strips take `scale` in (0, 1]; single images a positive integer
// `maxEdge`; both an integer `quality` 1..100.
function resolveParams(kind, params) {
  if (params != null && (typeof params !== 'object' || Array.isArray(params))) return null;
  // R8: supplied params must carry the field that applies; extras are ignored.
  if (params != null && !((isSheetKind(kind) ? 'scale' : 'maxEdge') in params)) return null;
  const p = { ...defaultParams(kind), ...(params || {}) };
  if (!Number.isInteger(p.quality) || p.quality < 1 || p.quality > 100) return null;
  if (isSheetKind(kind)) {
    if (typeof p.scale !== 'number' || !Number.isFinite(p.scale) || p.scale <= 0 || p.scale > 1) return null;
    return { scale: p.scale, quality: p.quality };
  }
  if (!Number.isInteger(p.maxEdge) || p.maxEdge < 1) return null;
  return { maxEdge: p.maxEdge, quality: p.quality };
}

// A variant's params with the log-only `auto` marker stripped, or null.
// Reused by a re-shrink that names no params (manual or auto, R16).
function previousParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const { auto, auto_src: autoSrc, ...rest } = params; // eslint-disable-line no-unused-vars
  return Object.keys(rest).length ? rest : null;
}

// Same rule as the client's spriteFrameCount: floor, clamp 1..64.
function stripFrames(row) {
  const n = Math.floor(Number(row && row.sprite_frames));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 64) : 1;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function webName(originalKey) {
  const base = path.posix.basename(originalKey).replace(/\.[^.]*$/, '');
  return base || 'image';
}

class OpFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}

async function logOp(db, op, subject, f) {
  const { rows } = await db.query(
    `INSERT INTO image_operations (op, subject_table, subject_key, subject_column, original_key, web_key, params,
                                   bytes_before, bytes_after, actor, batch_id, status, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13) RETURNING *`,
    [op, subject.table, subject.key, subject.column, f.original_key ?? null, f.web_key ?? null,
      f.params === undefined ? null : JSON.stringify(f.params), f.bytes_before ?? null, f.bytes_after ?? null,
      f.actor ?? null, f.batchId ?? null, f.status, f.error ?? null]);
  return rows[0];
}

async function inTxn(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// Make (or remake) the subject's web copy. Never throws for a per-image
// failure: it logs a 'failed' operation and returns it. Throws only for an
// unknown table/column (a caller bug) or when the log itself cannot be written.
// `auto` (the auto-shrink sweep) marks the logged params with auto: true; the
// variant's own params stay clean so a later re-shrink reuses them as given.
// A failed auto op also records what it tried (auto_src: manifest key and the
// original/manifest etags) so the sweep retries only once the art changed.
// `params` null: an existing variant's previous params (R16), else the kind's
// defaults. A shrink clears the stale mark and the seeded source sha (the copy
// is now this PC's own).
async function shrinkSubject(pool, store, subject, params, { actor, batchId, auto = false } = {}) {
  const col = columnOf(subject);
  const who = { actor, batchId };
  const tag = (p) => (auto ? { ...(p || {}), auto: true } : p);
  let tried = { manifest_key: null, etag: null, manifest_etag: null };
  let originalKey = null;
  let logParams = params;
  try {
    const row = (await loadRows(pool, col.table)).get(subject.key);
    if (!row) throw new OpFailure('missing_subject');
    const cur = currentKeys(col, row);
    if (!cur) throw new OpFailure('no_image');
    originalKey = cur.original;
    // Known before any store call: a store outage then still records the
    // manifest key, so the sweep does not read it as new art every tick.
    tried = { manifest_key: cur.manifest, etag: null, manifest_etag: null };
    // Stat before reading: if the original is rewritten in between, the
    // recorded etag is the older one and the variant reads as stale (safe).
    // Before any refusal, so a failed auto op always records what it saw.
    const { st, mst } = await statKeys(store, cur);
    tried = { manifest_key: cur.manifest, etag: st ? st.etag : null, manifest_etag: mst ? mst.etag : null };
    const kind = rowKind(col, row);
    const prev = params == null ? await selectVariant(pool, subject) : null;
    const p = resolveParams(kind, prev ? previousParams(prev.params) : params);
    if (!p) throw new OpFailure('bad_params');
    logParams = p;
    if (col.assetType === 'sprite' && !cur.manifest) throw new OpFailure('missing_manifest');
    if (!st) throw new OpFailure('missing_original');
    if (cur.manifest && !mst) throw new OpFailure('missing_manifest');
    const buf = await store.readObject(originalKey);

    let out; // { buffer, width, height, manifest? }
    let src;
    if (col.assetType === 'sprite') {
      let manifest;
      try {
        manifest = JSON.parse((await store.readObject(cur.manifest)).toString('utf8'));
      } catch (e) {
        throw new OpFailure(e && e.code === 'NoSuchKey' ? 'missing_manifest' : 'bad_manifest');
      }
      if (!manifest || !Array.isArray(manifest.cell) || !manifest.frames || typeof manifest.frames !== 'object') {
        throw new OpFailure('bad_manifest');
      }
      out = await shrinkSheet(buf, manifest, p);
      src = { width: Math.round(out.width / p.scale), height: Math.round(out.height / p.scale) };
    } else if (col.strip) {
      out = await shrinkStrip(buf, stripFrames(row), p);
      src = { width: Math.round(out.width / p.scale), height: Math.round(out.height / p.scale) };
    } else {
      out = await shrinkImage(buf, p);
      src = { width: out.srcWidth, height: out.srcHeight };
    }

    const webKey = `seedsync/${sha256(out.buffer)}/${webName(originalKey)}.webp`;
    let webSprite = null;
    let manifestBuf = null;
    if (out.manifest) {
      manifestBuf = Buffer.from(JSON.stringify(out.manifest));
      webSprite = { atlas_key: webKey, manifest_key: `seedsync/${sha256(manifestBuf)}/manifest.json` };
    }
    await store.putObject(webKey, out.buffer, 'image/webp');
    if (webSprite) await store.putObject(webSprite.manifest_key, manifestBuf, 'application/json');

    const op = await inTxn(pool, async (c) => {
      await c.query(
        `INSERT INTO image_variants (subject_table, subject_key, subject_column, original_key, original_etag,
                                     web_key, web_sprite, active, params, original_bytes, web_bytes,
                                     original_width, original_height, web_width, web_height,
                                     original_manifest_key, original_manifest_etag, stale_at, source_asset_sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, true, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16, NULL, NULL)
         ON CONFLICT (subject_table, subject_key, subject_column) DO UPDATE SET
           original_key = EXCLUDED.original_key, original_etag = EXCLUDED.original_etag,
           original_manifest_key = EXCLUDED.original_manifest_key,
           original_manifest_etag = EXCLUDED.original_manifest_etag,
           web_key = EXCLUDED.web_key, web_sprite = EXCLUDED.web_sprite, active = true,
           params = EXCLUDED.params, original_bytes = EXCLUDED.original_bytes, web_bytes = EXCLUDED.web_bytes,
           original_width = EXCLUDED.original_width, original_height = EXCLUDED.original_height,
           web_width = EXCLUDED.web_width, web_height = EXCLUDED.web_height,
           stale_at = NULL, source_asset_sha256 = NULL, updated_at = now()`,
        [subject.table, subject.key, subject.column, originalKey, st.etag,
          webSprite ? null : webKey, webSprite ? JSON.stringify(webSprite) : null, JSON.stringify(p),
          st.size, out.buffer.length, src.width, src.height, out.width, out.height,
          cur.manifest, mst ? mst.etag : null]);
      return logOp(c, 'shrink', subject, {
        ...who, status: 'ok', original_key: originalKey, web_key: webKey, params: tag(p),
        bytes_before: st.size, bytes_after: out.buffer.length,
      });
    });
    invalidateServeMap();
    return op;
  } catch (e) {
    const code = (e instanceof OpFailure || e instanceof ShrinkError) ? e.code : (e && e.message) || String(e);
    return logOp(pool, 'shrink', subject, {
      ...who, status: 'failed', error: code, original_key: originalKey,
      params: auto ? { ...tag(sanitizeParams(logParams)), auto_src: tried } : sanitizeParams(logParams),
    });
  }
}

// jsonb cannot hold NaN/Infinity (JSON.stringify writes null); keep the log row
// writable whatever a caller sent.
function sanitizeParams(params) {
  if (params == null || typeof params !== 'object') return params == null ? null : { value: String(params) };
  return params;
}

const variantWebKey = (v) => v.web_key || (v.web_sprite && v.web_sprite.atlas_key) || null;

async function selectVariant(db, subject) {
  const { rows } = await db.query(
    `SELECT * FROM image_variants WHERE subject_table = $1 AND subject_key = $2 AND subject_column = $3`,
    [subject.table, subject.key, subject.column]);
  return rows[0] || null;
}

// Players get the original again; the web copy stays for reactivate.
async function undoSubject(pool, subject, { actor, batchId } = {}) {
  columnOf(subject);
  const op = await inTxn(pool, async (c) => {
    const { rows } = await c.query(
      `UPDATE image_variants SET active = false, updated_at = now()
        WHERE subject_table = $1 AND subject_key = $2 AND subject_column = $3 RETURNING *`,
      [subject.table, subject.key, subject.column]);
    const v = rows[0];
    if (!v) return logOp(c, 'undo', subject, { actor, batchId, status: 'failed', error: 'no_variant' });
    return logOp(c, 'undo', subject, {
      actor, batchId, status: 'ok', original_key: v.original_key, web_key: variantWebKey(v), params: v.params,
    });
  });
  invalidateServeMap();
  return op;
}

// Serve an undone web copy again. Refused ('stale') when the original changed
// since it was made: shrink again instead.
async function reactivateSubject(pool, store, subject, { actor, batchId } = {}) {
  const col = columnOf(subject);
  await bindUnbound(pool, store);
  const v = await selectVariant(pool, subject);
  if (!v) return logOp(pool, 'reactivate', subject, { actor, batchId, status: 'failed', error: 'no_variant' });
  const base = { actor, batchId, original_key: v.original_key, web_key: variantWebKey(v), params: v.params };
  const cur = currentKeys(col, (await loadRows(pool, col.table)).get(subject.key));
  if (stateOf(v, cur, await statKeys(store, cur)) === 'stale') {
    return logOp(pool, 'reactivate', subject, { ...base, status: 'failed', error: 'stale' });
  }
  const op = await inTxn(pool, async (c) => {
    await c.query('UPDATE image_variants SET active = true, updated_at = now() WHERE id = $1', [v.id]);
    return logOp(c, 'reactivate', subject, { ...base, status: 'ok' });
  });
  invalidateServeMap();
  return op;
}

// ---- serving --------------------------------------------------------------

// Stale-while-revalidate (R15): a game request never waits on a rebuild once a
// map exists -- past the TTL it gets the previous map and a rebuild starts in
// the background. An invalidation (a shrink, undo, seed, stale mark) instead
// makes the next caller wait for a map built after it, so players never get
// a web copy the server already knows is old. The build is DB only.
let serveCache = null; // { map, at, gen }
let inflight = null; // { gen, promise }
let serveGen = 0;

function invalidateServeMap() {
  serveGen += 1;
}

// Map(original key -> variant) of what players get: active, unmarked
// variants whose column still holds their original (and manifest) key, the
// most recently updated one per original key (R7: subjects sharing an
// original get one deterministic copy). DB only.
async function servingVariants(pool) {
  const { rows } = await pool.query(
    `SELECT * FROM image_variants WHERE active AND original_key IS NOT NULL AND stale_at IS NULL
      ORDER BY updated_at DESC, id DESC`);
  const cols = imageColumns();
  const load = rowLoader(pool);
  const out = new Map();
  for (const v of rows) {
    if (out.has(v.original_key)) continue;
    const col = cols.find((c) => c.table === v.subject_table && c.column === v.subject_column);
    if (!col) continue;
    const cur = currentKeys(col, (await load(v.subject_table)).get(v.subject_key));
    if (cur && cur.original === v.original_key && (v.original_manifest_key || null) === (cur.manifest || null)) {
      out.set(v.original_key, v);
    }
  }
  return out;
}

async function buildServeMap(pool) {
  const map = new Map();
  for (const [key, v] of await servingVariants(pool)) {
    map.set(key, v.web_key ? { web_key: v.web_key } : { web_sprite: v.web_sprite });
  }
  return map;
}

function startBuild(pool) {
  if (inflight && inflight.gen === serveGen) return inflight.promise;
  const gen = serveGen;
  const promise = buildServeMap(pool).then((map) => {
    if (!serveCache || serveCache.gen <= gen) serveCache = { map, at: Date.now(), gen };
    return map;
  }).finally(() => {
    if (inflight && inflight.promise === promise) inflight = null;
  });
  inflight = { gen, promise };
  return promise;
}

// Map(original key -> { web_key } | { web_sprite: { atlas_key, manifest_key } })
// of served variants. `store` is unused (kept for callers); a failed build
// is not cached (an awaited one rejects, a background one keeps the old map).
function getServeMap(pool, store) { // eslint-disable-line no-unused-vars
  if (serveCache && serveCache.gen === serveGen) {
    if (Date.now() - serveCache.at >= SERVE_TTL_MS) {
      startBuild(pool).catch((e) => console.error('image serve map rebuild failed:', e && e.message));
    }
    return Promise.resolve(serveCache.map);
  }
  return startBuild(pool);
}

const KEY_FIELDS = ['image', 'icon', 'sprite_image'];

// A shallow copy of `def` with mapped art keys swapped for their web copies;
// `def` itself when nothing is mapped. Other sprite fields are kept.
function webArt(map, def) {
  if (!def || typeof def !== 'object' || !map || !map.size) return def;
  let out = null;
  for (const f of KEY_FIELDS) {
    const e = typeof def[f] === 'string' ? map.get(def[f]) : null;
    if (e && e.web_key) {
      out = out || { ...def };
      out[f] = e.web_key;
    }
  }
  const s = def.sprite;
  const e = s && typeof s === 'object' && typeof s.atlas_key === 'string' ? map.get(s.atlas_key) : null;
  if (e && e.web_sprite) {
    out = out || { ...def };
    out.sprite = { ...s, atlas_key: e.web_sprite.atlas_key, manifest_key: e.web_sprite.manifest_key };
  }
  return out || def;
}

module.exports = {
  listImages, shrinkSubject, undoSubject, reactivateSubject, getServeMap, invalidateServeMap, webArt,
  bindUnbound, resolveParams, catalogEntries, statKeys, isFresh, previousParams,
  markMovedStale, markEtagStale, stampSourceSha, seededFrom,
};
