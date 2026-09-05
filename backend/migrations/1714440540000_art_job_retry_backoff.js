/* eslint-disable camelcase */

// SOMET-543. Delay a retry instead of firing it immediately.
//
// MEASURED, NOT HYPOTHETICAL. On 2026-09-04 the image provider faulted for
// TWENTY-FOUR SECONDS (22:28:30-22:28:54). In that window this queue spent 150
// provider calls -- about 6 per second -- and marked 50 subjects permanently
// `failed`. Every one of them generated fine two minutes later. The provider
// was a remote GPU box whose card runs at ~0 MB free VRAM in normal operation,
// so the burst may well have kept re-triggering the fault it was reacting to.
//
// The cause was that `fail()` returned a job to `queued` with nothing to say
// "not yet", and the drain loop re-claimed it on the very next pass. Three
// attempts were therefore spent in well under a second, which makes a
// transient provider indistinguishable from a subject that cannot be drawn.
//
// The attempt cap already defends against a poison subject -- one that kills
// its worker every time. NOTHING defended against a provider that was briefly
// unwell, which is the far more common failure when the GPU is someone else's
// machine on a Wi-Fi link.
//
// WHY A COLUMN AND NOT A SLEEP IN THE DISPATCHER. The delay has to survive our
// own restart, and it has to be visible to the claim query so that two workers
// cannot disagree about whether a job is ready. A sleep in the caller is lost
// on restart and invisible to a second dispatcher.
//
// NULLABLE, and null means ready. Existing rows and every freshly enqueued job
// have no delay, so enqueue-then-dispatch stays immediate -- the delay is a
// property of having failed, not of being queued.

exports.up = (pgm) => {
  pgm.addColumn('art_jobs', {
    not_before: {
      type: 'timestamptz',
      notNull: false,
      comment: 'Earliest time this job may be claimed again. NULL means ready now.',
    },
  });

  // Partial, and deliberately mirrors the claim query's shape: the claim scans
  // queued rows ordered by id and now also filters on this column. The
  // existing art_jobs_claim_idx covers (state, id); this one keeps the added
  // predicate from turning that scan into a filter over the whole queue once a
  // batch has a few hundred delayed rows in it.
  pgm.createIndex('art_jobs', ['not_before'], {
    name: 'art_jobs_not_before_idx',
    where: "state = 'queued'",
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('art_jobs', ['not_before'], { name: 'art_jobs_not_before_idx' });
  pgm.dropColumn('art_jobs', 'not_before');
};
