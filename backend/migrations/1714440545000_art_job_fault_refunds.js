// SOMET-558. How many times a job's attempt was given back because the
// PROVIDER faulted rather than the subject failing.
//
// WHY A COUNTER AND NOT JUST A BOOLEAN RULE. artJobQueue.fail() refunds the
// attempt when the provider answers faster than it could possibly have drawn
// anything -- a wedged CUDA context rejects in ~200ms, and charging a subject
// its whole three-attempt lifetime for the machine being down is what left
// seven items permanently `failed` on 2026-09-10 having never been drawn.
//
// But an unbounded refund is its own bug, and the test that caught it says so:
// a subject that instantly 500s for ITS OWN reasons would cycle forever, be
// re-claimed every backoff, and keep a 530-subject batch from ever finishing.
// The circuit breaker does not save us there, because other subjects
// succeeding in between clear its consecutive-failure set.
//
// So refunds are counted and capped. Total tries become bounded by
// MAX_ATTEMPTS + the refund cap, which survives ordinary outage windows while
// still terminating on a genuinely poisonous subject.
//
// Not reset on success: the count is a property of how much this subject has
// already cost us, and zeroing it would let a subject that fails, succeeds and
// fails again refund without limit.
exports.up = (pgm) => {
  pgm.addColumn('art_jobs', {
    fault_refunds: {
      type: 'integer',
      notNull: true,
      default: 0,
      comment: 'Attempts given back because the provider faulted, not the subject. Capped.',
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('art_jobs', 'fault_refunds');
};
