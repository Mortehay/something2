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
    `SELECT id, note, region, kind, created_at
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
    `SELECT id, note, region, kind, active, created_at
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

// The two routings a note can take (SOMET-558). RESHAPE is the default and the
// historical behaviour; AVOID is the one that had nowhere to go.
const KINDS = ['reshape', 'avoid'];

// Anything unrecognised becomes 'reshape' rather than being rejected.
//
// Same reasoning as normaliseRegion above: the note's TEXT is the valuable
// half. Refusing to save a correction because a client sent an unknown kind
// would lose the operator's words over a routing detail, and 'reshape' is the
// behaviour every note had before this column existed.
function normaliseKind(kind) {
  return KINDS.includes(kind) ? kind : 'reshape';
}

async function create(db, subjectKind, subjectKey, { note, region, kind } = {}) {
  const text = String(note == null ? '' : note).trim().slice(0, MAX_NOTE);
  if (!text) return null;
  const { rows } = await db.query(
    `INSERT INTO art_prompt_notes (subject_kind, subject_key, note, region, kind)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, note, region, kind, active, created_at`,
    [subjectKind, subjectKey, text, normaliseRegion(region), normaliseKind(kind)],
  );
  return rows[0];
}

// Split active notes by where they must go.
//
// A RESHAPE note becomes a correction phrase, region and all, exactly as
// before. An AVOID note contributes its bare text to negative_prompt and
// DELIBERATELY DROPS ITS REGION: "beneath it" is a spatial instruction that
// only means anything alongside a description, and a negative prompt is an
// unordered bag of terms the model steers away from. Appending the region
// phrase there would add the words "beneath it" to the things being avoided,
// which is not what the operator asked for.
function splitNotes(notes) {
  const corrections = [];
  const avoid = [];
  for (const n of notes || []) {
    if (n && n.kind === 'avoid') {
      const text = String((n.note || '')).trim();
      if (text) avoid.push(text);
    } else {
      const phrase = noteToCorrection(n);
      if (phrase) corrections.push(phrase);
    }
  }
  return { corrections, avoid };
}

async function deactivate(db, id) {
  const { rows } = await db.query(
    `UPDATE art_prompt_notes SET active = false
      WHERE id = $1 AND active RETURNING id`,
    [id],
  );
  return rows.length > 0;
}

// SOMET-549. A marked box, said in words.
//
// The mark tells the model WHERE, the note tells it WHAT. This turns the first
// half into language because that is all the generator can act on: it is a
// text-to-image call, not an inpainting one, so a mask has nowhere to go. (If
// the provider's /api/edit ever proves to support masks, this becomes the
// fallback rather than the mechanism.)
//
// Deliberately COARSE. "beneath the subject" is a phrase a diffusion model has
// seen a million times; "in the region from 0.31 to 0.67 horizontally" is not,
// and precision the model cannot use is precision that only makes the prompt
// longer. Nine boxes is as fine as this gets.
function regionPhrase(region) {
  const r = normaliseRegion(region);
  if (!r) return null;

  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;

  // A box covering most of the frame says nothing about position -- the
  // operator marked "all of it", and inventing "in the centre" from that would
  // put a false instruction in the prompt. Silence is the honest output.
  if (r.w >= 0.8 && r.h >= 0.8) return null;

  const band = (v) => (v < 0.34 ? 0 : (v < 0.67 ? 1 : 2));
  const col = band(cx);
  const row = band(cy);

  // A wide, short box is a band rather than a corner: "along the bottom" reads
  // better than "in the bottom-centre" and is what a shadow under an object
  // actually looks like.
  if (r.w >= 0.6) return ['along the top', 'across the middle', 'along the bottom'][row];
  if (r.h >= 0.6) return ['down the left side', 'through the centre', 'down the right side'][col];

  const vertical = ['top', 'middle', 'bottom'][row];
  const horizontal = ['left', 'centre', 'right'][col];
  if (row === 1 && col === 1) return 'in the centre';
  if (row === 2 && col === 1) return 'beneath the subject';
  if (row === 0 && col === 1) return 'above the subject';
  return `in the ${vertical}-${horizontal}`;
}

// The full instruction a note contributes to a prompt: the words, placed.
function noteToCorrection(note) {
  const text = String((note && note.note) || '').trim();
  if (!text) return '';
  const where = regionPhrase(note && note.region);
  return where ? `${text} ${where}` : text;
}

module.exports = {
  listActive, listAll, create, deactivate, normaliseRegion, normaliseKind,
  regionPhrase, noteToCorrection, splitNotes, KINDS, MAX_NOTE,
};
