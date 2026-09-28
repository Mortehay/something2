// backend/src/services/audioLibrary.js
//
// Clips, bindings and misses (spec §1). DB functions take `db` first so a
// caller inside a transaction can pass its client.
const assetStore = require('./assetStore');
const { SUBJECT_KINDS, slotKind, isKnownSlot } = require('./audioSubjects');

class AudioInputError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

const MAX_MISSES_PER_POST = 200;

async function storeClip(db, c) {
  const id = (await db.query('SELECT gen_random_uuid() AS id')).rows[0].id;
  const key = `audio/${c.kind}/${id}.ogg`;
  await assetStore.putObject(key, c.buffer, 'audio/ogg');
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

async function bindClip(db, { subjectKind, subjectKey, slot, clipId, volume = 1, weight = 1 }) {
  if (!SUBJECT_KINDS[subjectKind]) throw new AudioInputError(`unknown subject kind '${subjectKind}'`);
  const expected = slotKind(subjectKind, slot);
  if (!expected) throw new AudioInputError(`'${subjectKind}' has no slot '${slot}'`);
  const clip = (await db.query('SELECT kind FROM audio_clips WHERE id = $1', [clipId])).rows[0];
  if (!clip) throw new AudioInputError('clip not found');
  if (clip.kind !== expected) {
    throw new AudioInputError(`slot '${slot}' takes ${expected} clips, this clip's kind is ${clip.kind}`);
  }
  const client = db.connect ? await db.connect() : db;
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO audio_bindings (subject_kind, subject_key, slot, clip_id, volume, weight)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [subjectKind, subjectKey, slot, clipId, volume, weight]);
    await client.query(
      'DELETE FROM audio_misses WHERE subject_kind = $1 AND subject_key = $2 AND slot = $3',
      [subjectKind, subjectKey, slot]);
    await client.query('COMMIT');
    return r.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') throw new AudioInputError('that clip is already bound to this slot');
    throw err;
  } finally {
    if (client !== db) client.release();
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

async function deleteClip(db, clipId) {
  return (await db.query('DELETE FROM audio_clips WHERE id = $1', [clipId])).rowCount > 0;
}

const BINDING_COLUMNS = `b.id AS binding_id, b.subject_kind, b.subject_key, b.slot, b.volume, b.weight,
  c.id AS clip_id, c.kind, c.label, c.storage_key, c.duration_ms, c.bytes, c.loopable,
  c.loop_start_ms, c.loop_end_ms`;

async function subjectSlots(db, subjectKind, subjectKey) {
  const k = SUBJECT_KINDS[subjectKind];
  if (!k) throw new AudioInputError(`unknown subject kind '${subjectKind}'`);
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

async function recordMisses(db, misses) {
  if (!Array.isArray(misses)) return 0;
  const ok = misses.slice(0, MAX_MISSES_PER_POST).filter((m) => m
    && typeof m.subject_key === 'string' && m.subject_key.length <= 200
    && isKnownSlot(m.subject_kind, m.slot));
  for (const m of ok) {
    // eslint-disable-next-line no-await-in-loop
    await db.query(
      `INSERT INTO audio_misses (subject_kind, subject_key, slot, world) VALUES ($1,$2,$3,$4)
       ON CONFLICT (subject_kind, subject_key, slot)
       DO UPDATE SET count = audio_misses.count + 1, last_seen = now(), world = EXCLUDED.world`,
      [m.subject_kind, m.subject_key, m.slot, typeof m.world === 'string' ? m.world.slice(0, 200) : null]);
  }
  return ok.length;
}

async function listMisses(db) {
  return (await db.query('SELECT * FROM audio_misses ORDER BY count DESC, last_seen DESC LIMIT 500')).rows;
}

module.exports = {
  AudioInputError, storeClip, bindClip, updateBinding, unbind, deleteClip,
  subjectSlots, worldAudioBundle, recordMisses, listMisses, MAX_MISSES_PER_POST,
};
