// backend/src/services/audioLibrary.js
//
// Clips, bindings and misses (spec §1). DB functions take `db` first so a
// caller inside a transaction can pass its client.
const crypto = require('node:crypto');
const assetStore = require('./assetStore');
const {
  SUBJECT_KINDS, MAX_SUBJECT_KEY, isKnownKind, slotKind, isKnownSlot, existingSubjects, subjectExists,
} = require('./audioSubjects');

class AudioInputError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

const MAX_MISSES_PER_POST = 200;

// Storing a clip is two halves (spec §2): the object upload, which cannot be
// part of a DB transaction, and the row insert, which can. They are split so
// storeAndBindClip below can do the upload FIRST and then insert the row and
// its binding in ONE transaction -- the id is minted here (not by the DB) so
// the object key is known before any row exists.
async function uploadClipObject(c, { store = assetStore } = {}) {
  const id = crypto.randomUUID();
  const key = `audio/${c.kind}/${id}.ogg`;
  await store.putObject(key, c.buffer, 'audio/ogg');
  return { id, key };
}

async function insertClipRow(db, { id, key }, c) {
  const r = await db.query(
    `INSERT INTO audio_clips (id, kind, label, storage_key, bytes, duration_ms, loopable,
       loop_start_ms, loop_end_ms, source, provider_id, prompt, style_or_cue, engine, seed)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [id, c.kind, c.label, key, c.buffer.length, c.durationMs,
      c.kind !== 'sfx', c.loopStartMs ?? null, c.loopEndMs ?? null, c.source,
      c.providerId ?? null, c.prompt ?? null, c.styleOrCue ?? null, c.engine ?? null, c.seed ?? null],
  );
  return r.rows[0];
}

async function storeClip(db, c) {
  return insertClipRow(db, await uploadClipObject(c), c);
}

// Upload, then insert the clip row AND bind it in one transaction (spec §2).
// Committing the row on its own first (storeClip + a separate bindClip) left
// a window where the clip was committed but unbound, and a concurrent
// "Delete all unbound" in that window deleted it (row and object) -- after
// minutes of GPU time -- so the bind then failed on a clip that was gone.
// Inside one transaction the uncommitted row is invisible to every other
// connection until it is already bound. If the insert or the bind fails, the
// transaction rolls back and the already-uploaded object is removed (best
// effort, logged: an orphaned object is a cleanup nit, the row is the source
// of truth). `db` must be a pool (has .connect). `bind` is a test seam.
async function storeAndBindClip(db, c, target, { store = assetStore, bind = bindClip } = {}) {
  const obj = await uploadClipObject(c, { store });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const clip = await insertClipRow(client, obj, c);
    const binding = await bind(client, { ...target, clipId: clip.id });
    await client.query('COMMIT');
    return { clip, binding };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    try {
      await store.removeObject(obj.key);
    } catch (removeErr) {
      console.error(`storeAndBindClip: failed to remove object ${obj.key}`, removeErr);
    }
    throw err;
  } finally {
    client.release();
  }
}

async function bindClip(db, { subjectKind, subjectKey, slot, clipId, volume = 1, weight = 1 }) {
  if (!isKnownKind(subjectKind)) throw new AudioInputError(`unknown subject kind '${subjectKind}'`);
  const expected = slotKind(subjectKind, slot);
  if (!expected) throw new AudioInputError(`'${subjectKind}' has no slot '${slot}'`);
  // Subjects are keyed by NAME: a deleted or renamed world/biome must not
  // gain a binding from any path (route, generate, a stale queued job).
  if (!(await subjectExists(db, subjectKind, subjectKey))) throw new AudioInputError('unknown subject');
  const clip = (await db.query('SELECT kind FROM audio_clips WHERE id = $1', [clipId])).rows[0];
  if (!clip) throw new AudioInputError('clip not found');
  if (clip.kind !== expected) {
    throw new AudioInputError(`slot '${slot}' takes ${expected} clips, this clip's kind is ${clip.kind}`);
  }
  const insertBinding = async (client) => {
    try {
      const r = await client.query(
        `INSERT INTO audio_bindings (subject_kind, subject_key, slot, clip_id, volume, weight)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [subjectKind, subjectKey, slot, clipId, volume, weight]);
      await client.query(
        'DELETE FROM audio_misses WHERE subject_kind = $1 AND subject_key = $2 AND slot = $3',
        [subjectKind, subjectKey, slot]);
      return r.rows[0];
    } catch (err) {
      if (err.code === '23505') throw new AudioInputError('that clip is already bound to this slot');
      throw err;
    }
  };

  // A checked-out client (e.g. pool.connect()) has .release -- that means the
  // CALLER owns the transaction (they may already be mid-BEGIN), so we run
  // directly on it: no BEGIN/COMMIT/ROLLBACK, no release. A pool-like db (has
  // .connect, no .release) has no transaction of its own yet, so it gets one:
  // check out a client, BEGIN/COMMIT/ROLLBACK around the insert, and release
  // it here. Anything else (e.g. a bare `{ query }` stub) runs directly, like
  // the checked-out-client case.
  if (typeof db.release === 'function' || typeof db.connect !== 'function') {
    return insertBinding(db);
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const row = await insertBinding(client);
    await client.query('COMMIT');
    return row;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function updateBinding(db, id, { volume, weight }) {
  const r = await db.query(
    `UPDATE audio_bindings SET volume = COALESCE($2, volume), weight = COALESCE($3, weight)
      WHERE id = $1 RETURNING *`, [id, volume ?? null, weight ?? null]);
  return r.rows[0] || null;
}

async function unbind(db, id) {
  return (await db.query('DELETE FROM audio_bindings WHERE id = $1', [id])).rowCount > 0;
}

// The clip library (SOMET-591, game audio slice 2 §1): every stored clip,
// independent of any subject it happens to be bound to, so an admin can reuse
// a clip across subjects or clean up ones nothing points at any more.
// `unbound` filters to clips with zero bindings -- the set delete-unbound
// operates on -- via a LEFT JOIN + HAVING rather than NOT EXISTS, so the same
// join also produces binding_count for every row in one pass.
async function listClips(db, {
  kind, unbound = false, limit = 50, offset = 0,
} = {}) {
  const safeLimit = Math.min(Math.max(Number.isInteger(limit) ? limit : 50, 1), 200);
  const safeOffset = Math.max(Number.isInteger(offset) ? offset : 0, 0);
  const kindFilter = typeof kind === 'string' && kind ? kind : null;
  const having = unbound ? 'HAVING COUNT(b.id) = 0' : '';
  const rows = (await db.query(
    `SELECT c.*, COUNT(b.id)::int AS binding_count
       FROM audio_clips c LEFT JOIN audio_bindings b ON b.clip_id = c.id
      WHERE $1::text IS NULL OR c.kind = $1
      GROUP BY c.id
      ${having}
      ORDER BY c.created_at DESC
      LIMIT $2 OFFSET $3`,
    [kindFilter, safeLimit, safeOffset],
  )).rows;
  const total = (await db.query(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT c.id FROM audio_clips c LEFT JOIN audio_bindings b ON b.clip_id = c.id
        WHERE $1::text IS NULL OR c.kind = $1
        GROUP BY c.id
        ${having}
     ) t`,
    [kindFilter],
  )).rows[0].n;
  return { rows, total };
}

// Deletes the clip row (cascading to its bindings) and then its object in the
// store. The object removal happens AFTER the row is gone and its failure is
// only logged: the row is the source of truth for what the library shows, and
// once it is gone a leftover, unreferenced object in the bucket is a cleanup
// nit, not a correctness problem -- whereas leaving the row in place because
// the store call failed would keep offering a clip whose bytes may already be
// unreachable.
async function deleteClip(db, clipId, { store = assetStore } = {}) {
  const bindings = (await db.query(
    'SELECT COUNT(*)::int AS n FROM audio_bindings WHERE clip_id = $1', [clipId],
  )).rows[0].n;
  const r = await db.query('DELETE FROM audio_clips WHERE id = $1 RETURNING storage_key', [clipId]);
  if (r.rowCount === 0) return { deleted: false, bindings: 0 };
  try {
    await store.removeObject(r.rows[0].storage_key);
  } catch (err) {
    console.error(`deleteClip: failed to remove object ${r.rows[0].storage_key}`, err);
  }
  return { deleted: true, bindings };
}

// Bulk cousin of deleteClip, scoped to clips with zero bindings (spec: never
// touch a bound clip). One DELETE ... RETURNING does the qualifying and the
// deleting together -- NOT EXISTS keeps "has no binding" in one place rather
// than a separate SELECT whose result could go stale before the DELETE runs.
async function deleteUnboundClips(db, { kind, store = assetStore } = {}) {
  const kindFilter = typeof kind === 'string' && kind ? kind : null;
  const r = await db.query(
    `DELETE FROM audio_clips c
      WHERE NOT EXISTS (SELECT 1 FROM audio_bindings b WHERE b.clip_id = c.id)
        AND ($1::text IS NULL OR c.kind = $1)
      RETURNING storage_key`,
    [kindFilter],
  );
  await Promise.all(r.rows.map(async (row) => {
    try {
      await store.removeObject(row.storage_key);
    } catch (err) {
      console.error(`deleteUnboundClips: failed to remove object ${row.storage_key}`, err);
    }
  }));
  return { deleted: r.rowCount };
}

const BINDING_COLUMNS = `b.id AS binding_id, b.subject_kind, b.subject_key, b.slot, b.volume, b.weight,
  c.id AS clip_id, c.kind, c.label, c.storage_key, c.duration_ms, c.bytes, c.loopable,
  c.loop_start_ms, c.loop_end_ms`;

async function subjectSlots(db, subjectKind, subjectKey) {
  if (!isKnownKind(subjectKind)) throw new AudioInputError(`unknown subject kind '${subjectKind}'`);
  const k = SUBJECT_KINDS[subjectKind];
  const r = await db.query(
    `SELECT ${BINDING_COLUMNS} FROM audio_bindings b JOIN audio_clips c ON c.id = b.clip_id
      WHERE b.subject_kind = $1 AND b.subject_key = $2 ORDER BY b.sort, b.id`, [subjectKind, subjectKey]);
  const out = Object.fromEntries(Object.keys(k.slots).map((s) => [s, []]));
  for (const row of r.rows) if (out[row.slot]) out[row.slot].push(row);
  return out;
}

async function worldAudioBundle(db, worldId) {
  const w = (await db.query('SELECT name, biomes FROM worlds WHERE id = $1', [worldId])).rows[0];
  if (!w) return null;
  const biomes = Array.isArray(w.biomes) ? w.biomes.filter((b) => typeof b === 'string') : [];
  const r = await db.query(
    `SELECT ${BINDING_COLUMNS} FROM audio_bindings b JOIN audio_clips c ON c.id = b.clip_id
      WHERE (b.subject_kind = 'world' AND b.subject_key = $1)
         OR (b.subject_kind = 'biome' AND b.subject_key = ANY($2))
      ORDER BY b.sort, b.id`, [w.name, biomes]);
  const bindings = {};
  for (const row of r.rows) {
    const key = `${row.subject_kind}/${row.subject_key}/${row.slot}`;
    (bindings[key] = bindings[key] || []).push({
      key: row.storage_key, kind: row.kind, volume: row.volume, weight: row.weight,
      loopable: row.loopable, loop_start_ms: row.loop_start_ms, loop_end_ms: row.loop_end_ms,
    });
  }
  return { world: w.name, bindings };
}

// Spec §3: only registry kinds/slots AND subjects that exist are accepted, so
// a client cannot fill the table with junk. Duplicates in one post collapse
// into one row with their count (a single INSERT ... ON CONFLICT cannot touch
// the same row twice), and the upsert is one statement over unnest'ed arrays.
async function recordMisses(db, misses) {
  if (!Array.isArray(misses)) return 0;
  const shaped = misses.slice(0, MAX_MISSES_PER_POST).filter((m) => m
    && typeof m.subject_key === 'string' && m.subject_key && m.subject_key.length <= MAX_SUBJECT_KEY
    && isKnownSlot(m.subject_kind, m.slot));
  const existing = {};
  for (const kind of new Set(shaped.map((m) => m.subject_kind))) {
    // eslint-disable-next-line no-await-in-loop
    existing[kind] = await existingSubjects(db, kind,
      [...new Set(shaped.filter((m) => m.subject_kind === kind).map((m) => m.subject_key))]);
  }
  const ok = shaped.filter((m) => existing[m.subject_kind].has(m.subject_key));
  if (!ok.length) return 0;
  const rows = new Map();
  for (const m of ok) {
    const id = JSON.stringify([m.subject_kind, m.subject_key, m.slot]);
    const row = rows.get(id) || { kind: m.subject_kind, key: m.subject_key, slot: m.slot, n: 0 };
    row.n += 1;
    row.world = typeof m.world === 'string' ? m.world.slice(0, 200) : null;
    rows.set(id, row);
  }
  const r = [...rows.values()];
  await db.query(
    `INSERT INTO audio_misses (subject_kind, subject_key, slot, world, count)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[])
     ON CONFLICT (subject_kind, subject_key, slot)
     DO UPDATE SET count = audio_misses.count + EXCLUDED.count, last_seen = now(), world = EXCLUDED.world`,
    [r.map((x) => x.kind), r.map((x) => x.key), r.map((x) => x.slot), r.map((x) => x.world), r.map((x) => x.n)]);
  return ok.length;
}

async function listMisses(db) {
  return (await db.query('SELECT * FROM audio_misses ORDER BY count DESC, last_seen DESC LIMIT 500')).rows;
}

// The Audio tab's "filled/total" badge, for every subject at once.
//
// One query for the whole catalogue rather than one /admin/slots request per
// subject (which the admin UI originally did): with ~130 worlds+biomes in the
// dev DB, that fan-out could burn a third of the global per-IP rate limit
// just opening the tab. COUNT(DISTINCT slot) -- not COUNT(*) -- so a slot
// with several clips bound to it (unlimited per spec) still counts as one
// FILLED slot, not one per clip.
//
// Returns { [subject_kind]: { [subject_key]: filledSlotCount } }. A subject
// with no bindings at all is simply absent from its kind's map -- callers
// treat a missing key as 0 (the frontend's slotRows does this explicitly).
async function filledCounts(db) {
  const r = await db.query(
    'SELECT subject_kind, subject_key, COUNT(DISTINCT slot)::int AS filled FROM audio_bindings GROUP BY 1, 2');
  const out = {};
  for (const row of r.rows) {
    (out[row.subject_kind] = out[row.subject_kind] || {})[row.subject_key] = row.filled;
  }
  return out;
}

module.exports = {
  AudioInputError, storeClip, storeAndBindClip, bindClip, updateBinding, unbind, listClips, deleteClip, deleteUnboundClips,
  subjectSlots, worldAudioBundle, recordMisses, listMisses, filledCounts, MAX_MISSES_PER_POST,
};
