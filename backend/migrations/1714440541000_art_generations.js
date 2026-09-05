/* eslint-disable camelcase */

// SOMET-547. What prompt produced which image.
//
// WHY. Nothing recorded this. The cutout backdrop moved magenta -> white ->
// grey inside two days (SOMET-536, SOMET-545), so an image sitting in the
// catalogue cannot be traced to what it was actually asked for -- and the
// prompts that FAILED, which are the ones most worth reading, were kept only in
// art_jobs.last_error, overwritten on the next attempt.
//
// APPEND-ONLY, AND SEPARATE FROM art_prompt_notes (SOMET-548). This table is
// what HAPPENED; notes are what we WANT. Keeping corrections in here would mean
// editing the record of the past, and keeping history in the notes table would
// make an append-only fact revocable.
//
// NOT A REPLACEMENT FOR art_jobs. A job is the unit of work and is deleted or
// re-queued; a generation is a historical event that outlives it. art_job_id is
// therefore nullable and carries no foreign key: losing the job must not lose
// the record of what it produced.
//
// ONE ROW PER ATTEMPT, not per subject. Three attempts against a faulted GPU
// are three rows, which is what makes "it failed the same way three times"
// distinguishable from "it failed three different ways".

exports.up = (pgm) => {
  pgm.createTable('art_generations', {
    id: { type: 'bigserial', primaryKey: true },
    subject_kind: { type: 'text', notNull: true },
    subject_key: { type: 'text', notNull: true },
    // Deliberately no FK: see the header. The job may be gone.
    art_job_id: { type: 'bigint' },
    // The FULL composed prompt actually sent, not the catalogue's base. The
    // base can be re-derived at any time; what was sent cannot.
    composed_prompt: { type: 'text' },
    seed: { type: 'bigint' },
    model: { type: 'text' },
    provider_id: { type: 'integer' },
    // Width, height, steps, cfg and anything else the template carried. jsonb
    // rather than columns because it is a PROVIDER's shape, not ours, and a new
    // provider parameter must not require a migration to be recorded.
    params: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    image_key: { type: 'text' },
    // 'done' | 'failed'
    outcome: { type: 'text', notNull: true },
    error: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // The only access pattern: one subject's history, newest first.
  pgm.createIndex('art_generations', [
    'subject_kind', 'subject_key', { name: 'created_at', sort: 'DESC' },
  ], { name: 'art_generations_subject_idx' });
};

exports.down = (pgm) => {
  pgm.dropTable('art_generations');
};
