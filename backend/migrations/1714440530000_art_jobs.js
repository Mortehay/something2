/* eslint-disable camelcase */

// SOMET-540. The durable art-generation queue.
//
// WHY A TABLE AND NOT THE EXISTING REGISTRY. remoteImageProvider.js already
// has a job registry, and it is deliberately in-memory: it exists so the admin
// UI can poll ONE generation to completion, and its own header calls the
// restart-loses-it property "parity with sprite-gen's JobManager, not a new
// class of fragility". That reasoning holds for a single interactive
// generation and fails completely for a batch: 617 subjects against a remote
// GPU is measured in hours, and the machine doing the work is not ours. It can
// reboot, empty its queue or rotate its token without telling us, and a
// process restart on this side must not lose the record of what still needs
// drawing.
//
// So this table is the batch's memory. The in-memory registry stays exactly as
// it is for the interactive path.
//
// WHAT IT IS NOT: a progress counter. Whether a subject HAS art is answered by
// the catalog (item_types.icon, catalog_art), because that is the thing a
// human actually sees; a job row saying `done` while the catalog is empty
// would be a second source of truth for the same question. These rows exist to
// decide what to attempt next and to explain what went wrong.

exports.up = (pgm) => {
  pgm.createTable('art_jobs', {
    id: { type: 'bigserial', primaryKey: true },
    // The subject registry's vocabulary (SOMET-535), stored as text rather
    // than an enum: a new subject kind is a registry entry, and it must not
    // also require a migration to become queueable.
    subject_kind: { type: 'text', notNull: true },
    subject_key: { type: 'text', notNull: true },
    // 'connector' (a registered ai_providers row) or 'local' (sprite-gen).
    backend: { type: 'text', notNull: true },
    // Nullable because a local job has no provider. ON DELETE SET NULL rather
    // than CASCADE: deleting a provider must not silently delete the history
    // of what was generated with it.
    provider_id: {
      type: 'integer',
      references: 'ai_providers',
      onDelete: 'SET NULL',
    },
    // Recorded, not derived at dispatch time. A re-run must reproduce the same
    // image, and a batch that shares one seed collapses to one composition --
    // 50 tiles generated at seed 0 once did exactly that and read as a broken
    // model.
    seed: { type: 'bigint', notNull: true },
    state: { type: 'text', notNull: true, default: 'queued' },
    attempts: { type: 'integer', notNull: true, default: 0 },
    last_error: { type: 'text' },
    claimed_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('art_jobs', 'art_jobs_state_check',
    "CHECK (state IN ('queued','running','done','failed'))");

  pgm.addConstraint('art_jobs', 'art_jobs_backend_check',
    "CHECK (backend IN ('connector','local'))");

  // THE IDEMPOTENCY GUARANTEE, ENFORCED BY THE DATABASE.
  //
  // "Enqueueing a subject that is already queued or in flight must not create
  // a second job" is an acceptance criterion on both this item and SOMET-538.
  // Written as an application check it is a race: two admins hitting Enqueue
  // on overlapping selections, or one double-click, both read "not present"
  // before either writes. With 617 subjects a double-enqueue doubles a batch
  // measured in hours.
  //
  // PARTIAL, on the two live states only. A subject may be enqueued again
  // after its job is done or failed -- that is a retry, and refusing it would
  // make a failed subject permanently unfixable.
  pgm.createIndex('art_jobs', ['subject_kind', 'subject_key'], {
    name: 'art_jobs_one_live_per_subject',
    unique: true,
    where: "state IN ('queued','running')",
  });

  // The claim loop's access path: oldest queued first.
  pgm.createIndex('art_jobs', ['state', 'id'], { name: 'art_jobs_claim_idx' });
};

// Dropping the table drops its indexes and constraints with it. Safe to
// reverse: these rows are a work list, not player data -- anything already
// generated lives in the catalog and in object storage, and re-running the
// migration re-creates an empty queue rather than losing art.
exports.down = (pgm) => {
  pgm.dropTable('art_jobs');
};
