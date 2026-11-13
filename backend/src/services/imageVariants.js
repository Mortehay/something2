'use strict';
// Image shrink: WebP "web copies" of game art (spec 2026-11-13-image-shrink).
// The catalog column keeps the original key; image_variants maps a subject
// (table, row natural key, column) to its web copy, and game-facing payloads
// swap keys through getServeMap + webArt. Originals are only ever read.
//
// A subject's key is seedSync's keyText of the exported row (by-uuid refs as
// the target's sync_uuid), so a variant travels with the seed (Task 7).
// A variant is STALE -- players get the original -- when the column no longer
// holds original_key or the original object's etag differs from
// original_etag (art rewritten under the same key), or -- sheets -- the
// manifest key/etag differ from original_manifest_key/etag. A seeded variant arrives
// with original_key NULL and is bound to the target's current original on
// first use (bindUnbound).

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
  if (!isFresh(variant, cur, stats)) return 'stale';
  return variant.active ? 'shrunk' : 'undone';
}

const tripleKey = (table, key, column) => `${table}\u0000${key}\u0000${column}`;

// Bind seeded variants (original_key NULL) to the subject's current original
// and its etag. A subject with no row, no art or a missing object stays unbound.
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
    if (!cur) continue;
    const { st, mst } = await statKeys(store, cur);
    if (!st || (cur.manifest && !mst)) continue;
    const r = await pool.query(
      `UPDATE image_variants SET original_key = $2, original_etag = $3, original_bytes = $4,
              original_manifest_key = $5, original_manifest_etag = $6, updated_at = now()
        WHERE id = $1 AND original_key IS NULL`,
      [v.id, cur.original, st.etag, st.size, cur.manifest, mst ? mst.etag : null]);
    bound += r.rowCount;
  }
  return bound;
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
  const serving = await servingVariants(pool, store);
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
async function shrinkSubject(pool, store, subject, params, { actor, batchId, auto = false } = {}) {
  const col = columnOf(subject);
  const who = { actor, batchId };
  const tag = (p) => (auto ? { ...(p || {}), auto: true } : p);
  let originalKey = null;
  let logParams = params;
  try {
    const row = (await loadRows(pool, col.table)).get(subject.key);
    if (!row) throw new OpFailure('missing_subject');
    const cur = currentKeys(col, row);
    if (!cur) throw new OpFailure('no_image');
    originalKey = cur.original;
    const kind = rowKind(col, row);
    const p = resolveParams(kind, params);
    if (!p) throw new OpFailure('bad_params');
    logParams = p;
    if (col.assetType === 'sprite' && !cur.manifest) throw new OpFailure('missing_manifest');

    // Stat before reading: if the original is rewritten in between, the
    // recorded etag is the older one and the variant reads as stale (safe).
    const { st, mst } = await statKeys(store, cur);
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
                                     original_manifest_key, original_manifest_etag)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, true, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (subject_table, subject_key, subject_column) DO UPDATE SET
           original_key = EXCLUDED.original_key, original_etag = EXCLUDED.original_etag,
           original_manifest_key = EXCLUDED.original_manifest_key,
           original_manifest_etag = EXCLUDED.original_manifest_etag,
           web_key = EXCLUDED.web_key, web_sprite = EXCLUDED.web_sprite, active = true,
           params = EXCLUDED.params, original_bytes = EXCLUDED.original_bytes, web_bytes = EXCLUDED.web_bytes,
           original_width = EXCLUDED.original_width, original_height = EXCLUDED.original_height,
           web_width = EXCLUDED.web_width, web_height = EXCLUDED.web_height, updated_at = now()`,
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
      ...who, status: 'failed', error: code, original_key: originalKey, params: tag(sanitizeParams(logParams)),
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

let serveCache = null; // { at, promise }

function invalidateServeMap() {
  serveCache = null;
}

// Map(original key -> variant) of what players get: active, non-stale
// variants, the most recently updated one per original key (R7: subjects
// sharing an original get one deterministic copy). Callers bind first.
async function servingVariants(pool, store) {
  const { rows } = await pool.query(
    'SELECT * FROM image_variants WHERE active AND original_key IS NOT NULL ORDER BY updated_at DESC, id DESC');
  const cols = imageColumns();
  const load = rowLoader(pool);
  const live = [];
  for (const v of rows) {
    const col = cols.find((c) => c.table === v.subject_table && c.column === v.subject_column);
    if (!col) continue;
    const cur = currentKeys(col, (await load(v.subject_table)).get(v.subject_key));
    if (cur && cur.original === v.original_key) live.push({ v, cur });
  }
  const stats = await mapLimit(live, STAT_CONCURRENCY, (x) => statKeys(store, x.cur));
  const out = new Map();
  live.forEach(({ v, cur }, i) => {
    if (!out.has(v.original_key) && isFresh(v, cur, stats[i])) out.set(v.original_key, v);
  });
  return out;
}

async function buildServeMap(pool, store) {
  await bindUnbound(pool, store);
  const map = new Map();
  for (const [key, v] of await servingVariants(pool, store)) {
    map.set(key, v.web_key ? { web_key: v.web_key } : { web_sprite: v.web_sprite });
  }
  return map;
}

// Map(original key -> { web_key } | { web_sprite: { atlas_key, manifest_key } })
// of active, non-stale variants. Cached SERVE_TTL_MS; a failed build is not cached.
function getServeMap(pool, store) {
  if (serveCache && Date.now() - serveCache.at < SERVE_TTL_MS) return serveCache.promise;
  const entry = { at: Date.now(), promise: null };
  entry.promise = buildServeMap(pool, store).catch((e) => {
    if (serveCache === entry) serveCache = null;
    throw e;
  });
  serveCache = entry;
  return entry.promise;
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
  bindUnbound, resolveParams, catalogEntries, statKeys, isFresh,
};
