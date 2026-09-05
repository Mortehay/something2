/* eslint-disable camelcase */

// SOMET-548. Per-subject prompt corrections.
//
// WHY. When a subject comes back wrong there is nowhere to say so. `darts`
// generated "successfully" -- 95% transparent, recorded, passing every guard --
// as a DARTBOARD with an opaque grey shadow attached, when the subject is
// throwing darts. The only recourse was editing the catalogue's base prompt,
// which is not where a correction about ONE subject belongs.
//
// LAYERED, NOT AN OVERRIDE, and the reason is measured rather than aesthetic.
// On 2026-09-05 a single global backdrop change (SOMET-545) fixed 21 subjects
// at once. Under per-subject overrides, every corrected subject would have
// silently missed that fix -- the corrected ones being, by definition, the ones
// somebody already cared about. So the base keeps coming from the catalogue and
// these are appended.
//
// DEACTIVATED, NEVER DELETED. A note that was in force when an image was made
// has to stay readable, or the generation history (SOMET-547) records a prompt
// nobody can explain afterwards.
//
// REGION IS NORMALISED (0..1), NOT PIXELS. This same batch has already run at
// 512 and at 1024; a pixel box would silently mean a different part of the
// picture after a size change. Nullable because a note needs no region -- "these
// are throwing darts, not a dartboard" is about the whole subject.

exports.up = (pgm) => {
  pgm.createTable('art_prompt_notes', {
    id: { type: 'bigserial', primaryKey: true },
    subject_kind: { type: 'text', notNull: true },
    subject_key: { type: 'text', notNull: true },
    // What the operator wants changed, in their own words. This goes into the
    // prompt, so it is a phrase, not a paragraph -- length is capped in the API
    // rather than here, where a limit could not be raised without a migration.
    note: { type: 'text', notNull: true },
    // {x, y, w, h} as fractions of the image, or null.
    region: { type: 'jsonb' },
    active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // The access pattern is "the active notes for this subject", run on every
  // dispatch of that subject.
  pgm.createIndex('art_prompt_notes', ['subject_kind', 'subject_key'], {
    name: 'art_prompt_notes_subject_idx',
    where: 'active',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('art_prompt_notes');
};
