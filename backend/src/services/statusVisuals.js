// How a timed status on a character draws: one status_visuals row per (status_key, variant)
// (migration 1714440885000). Amber stance has ten variants, each its own Sprite-tab subject
// `amber_stance_<n>`. The row's `key` is that subject key.
'use strict';

const AMBER_VARIANTS = 10;
const STATUS_KEYS = Object.freeze(Array.from({ length: AMBER_VARIANTS }, (_, i) => `amber_stance_${i + 1}`));
// The status rows carry no colour column; the Sprite tab draws every status in its amber.
const STATUS_COLOR = '#d9891a';

async function listStatusVisuals(db) {
  const { rows } = await db.query(
    `SELECT subject_key AS key, status_key, variant, sprite_image, sprite_frames, sprite_additive, sprite_fps, display
       FROM status_visuals ORDER BY status_key, variant`);
  return rows;
}

// SOMET-769: the one admin write a status row has -- its display. The row as the list shows it,
// or null when `key` names no row.
async function setStatusDisplay(db, key, display) {
  const { rows } = await db.query(
    `UPDATE status_visuals SET display = $2, updated_at = now() WHERE subject_key = $1
       RETURNING subject_key AS key, status_key, variant, sprite_image, sprite_frames, sprite_additive, sprite_fps, display`,
    [String(key), display]);
  return rows[0] || null;
}

module.exports = { listStatusVisuals, setStatusDisplay, STATUS_KEYS, STATUS_COLOR, AMBER_VARIANTS };
