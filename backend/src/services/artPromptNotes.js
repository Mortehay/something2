// SOMET-548. Per-subject prompt corrections, layered on the catalogue's base.
//
// Read the migration header for why these are layered rather than an override,
// and why deactivating is not deleting.
//
// This module owns the STORAGE and the ORDER. Where the corrections land
// inside the prompt is objectPrompt.js's business, because that is where the
// rest of the prompt's word order is reasoned about, and the ordering there is
// load-bearing rather than cosmetic.

const MAX_NOTE = 300;

// Longest-standing first, so a later correction cannot be buried under a pile
// of newer ones, and so the prompt a subject gets is stable between two
// dispatches with no edits in between. Stability matters more than recency
// here: an unstable prompt makes two runs incomparable.
async function listActive(db, subjectKind, subjectKey) {
  const { rows } = await db.query(
    `SELECT id, note, region, created_at
       FROM art_prompt_notes
      WHERE subject_kind = $1 AND subject_key = $2 AND active
      ORDER BY created_at ASC, id ASC`,
    [subjectKind, subjectKey],
  );
  return rows;
}

// Every note ever written for a subject, active or not. The history (SOMET-547)
// records prompts that contained notes since revoked, and a prompt nobody can
// explain afterwards is not much of a record.
async function listAll(db, subjectKind, subjectKey) {
  const { rows } = await db.query(
    `SELECT id, note, region, active, created_at
       FROM art_prompt_notes
      WHERE subject_kind = $1 AND subject_key = $2
      ORDER BY created_at DESC, id DESC`,
    [subjectKind, subjectKey],
  );
  return rows;
}

// A region is only accepted as four numbers inside the unit square. Anything
// else is stored as NULL rather than rejected: the note itself is the valuable
// half, and refusing to save "no shadow beneath it" because a drag produced a
// malformed box would lose the useful part over the decorative one.
function normaliseRegion(region) {
  if (!region || typeof region !== 'object') return null;
  const nums = ['x', 'y', 'w', 'h'].map((k) => Number(region[k]));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [x, y, w, h] = nums;
  if (w <= 0 || h <= 0) return null;
  const clamp = (n) => Math.min(1, Math.max(0, n));
  return { x: clamp(x), y: clamp(y), w: clamp(w), h: clamp(h) };
}

async function create(db, subjectKind, subjectKey, { note, region } = {}) {
  const text = String(note == null ? '' : note).trim().slice(0, MAX_NOTE);
  if (!text) return null;
  const { rows } = await db.query(
    `INSERT INTO art_prompt_notes (subject_kind, subject_key, note, region)
     VALUES ($1, $2, $3, $4) RETURNING id, note, region, active, created_at`,
    [subjectKind, subjectKey, text, normaliseRegion(region)],
  );
  return rows[0];
}

async function deactivate(db, id) {
  const { rows } = await db.query(
    `UPDATE art_prompt_notes SET active = false
      WHERE id = $1 AND active RETURNING id`,
    [id],
  );
  return rows.length > 0;
}

module.exports = { listActive, listAll, create, deactivate, normaliseRegion, MAX_NOTE };
