// SOMET-544. What kind of failure is this, and what should a human do about it?
//
// WHY THIS EXISTS. The art console could say a subject failed, but not whether
// that meant "the GPU box is unwell, this will succeed later" or "this subject
// cannot be drawn as configured". Those need opposite responses, and getting
// them backwards is expensive in both directions: requeueing a content failure
// burns generations to reproduce the same image, while NOT requeueing a
// provider failure strands a perfectly good subject forever.
//
// Measured on 2026-09-04/05: a provider fault marked 68 subjects failed in one
// batch, all of which generated fine afterwards; in the same run, one subject
// (`arrow`) failed for a reason no retry can fix. One button for both would be
// wrong for one of them.
//
// WHY BACKEND. The same question is asked by the admin page (grouping and
// buttons), by the requeue endpoint (refusing a pointless retry) and by the
// drain's circuit breaker (telling a dead provider from a bad subject). This
// repo already carries resolveMove duplicated byte-for-byte across the
// front/back split, and that is a standing hazard -- so the rule lives here
// and the ANSWER travels over the API. The page renders what it is told.
//
// THE SEED IS WHY `retryable` MATTERS. artJobQueue.seedFor derives a job's
// seed from (subject_kind, subject_key), deliberately, so that a regeneration
// reproduces the same image rather than rolling dice. That guarantee is
// exactly what makes a plain retry useless for a content failure: same
// subject, same seed, same pixels, same refusal. The escape hatch is the salt
// argument seedFor already takes -- hence 'reseed' as a distinct action.

const KINDS = {
  PROVIDER_FAULT: 'provider_fault',
  UNREACHABLE: 'unreachable',
  CONTENT_CUTOUT: 'content_cutout',
  CONTENT_UNKEYED: 'content_unkeyed',
  CONFIG: 'config',
  UNKNOWN: 'unknown',
};

// Ordered: the FIRST match wins, so the specific patterns precede the general
// ones. `answered 5` would otherwise swallow the CUDA and dtype cases, and the
// size refusal (a 400 we generate ourselves) would fall through to unknown.
const RULES = [
  {
    kind: KINDS.CONTENT_CUTOUT,
    // Deliberately narrow. Another 422 is a different problem and must not
    // inherit the "retry with a new seed" advice, which would not fix it.
    match: (e) => /cutout removed/i.test(e),
    label: 'Cutout keyed the subject away',
    detail: 'The background fill consumed the subject, which happens when subject '
      + 'and background share a colour. A plain retry regenerates the SAME image, '
      + 'because the seed is derived from the subject.',
    action: 'reseed',
    retryable: false,
  },
  {
    // The OPPOSITE keying failure, and it must not be filed with the one
    // above: there the fill ate the subject, here it could not separate it at
    // all. Two of these come from the provider (422) and one from OUR OWN
    // transparency floor -- "an alpha channel is not a cutout" -- so matching
    // only the provider's wording would leave a third of them unclassified.
    // Same remedy as the cutout case: the seed is derived from the subject, so
    // only a different seed can produce a different image.
    kind: KINDS.CONTENT_UNKEYED,
    match: (e) => /no transparency|not keyed out|not separable from its background|only \d+% transparent/i
      .test(e),
    label: 'Backdrop was not keyed out',
    detail: 'The subject could not be separated from its background -- the result '
      + 'would be an opaque square rather than a sprite. Usually the subject and '
      + 'backdrop are too close in colour or the subject fills the frame.',
    action: 'reseed',
    retryable: false,
  },
  {
    kind: KINDS.CONFIG,
    match: (e) => /below the \d+px minimum|provider_id is required|no provider chosen/i.test(e),
    label: 'Provider is misconfigured',
    detail: 'The provider cannot serve this kind of subject as configured. '
      + 'Retrying reproduces the error; change the provider or its settings.',
    action: 'fix_config',
    retryable: false,
  },
  {
    kind: KINDS.UNREACHABLE,
    match: (e) => /could not reach|fetch failed|ECONNREFUSED|ETIMEDOUT/i.test(e),
    label: 'Provider unreachable',
    detail: 'The request never got a reply. The machine or its service is down, '
      + 'or the network dropped. Safe to requeue once it answers again.',
    action: 'requeue',
    retryable: true,
  },
  {
    kind: KINDS.PROVIDER_FAULT,
    // The dtype variant belongs HERE, not under config. On 2026-09-04 it was a
    // symptom of a faulted CUDA context, not a real dtype bug -- classifying it
    // as configuration would strand every affected subject waiting for a fix
    // that is not needed.
    match: (e) => /handles_\.at|INTERNAL ASSERT|CUDA|device not ready|c10::Half|answered 5\d\d|presumed lost/i
      .test(e),
    label: 'Provider fault',
    detail: 'The generator failed on its own side (typically a faulted GPU context). '
      + 'These succeed once the machine recovers -- requeue them.',
    action: 'requeue',
    retryable: true,
  },
];

const UNKNOWN = {
  kind: KINDS.UNKNOWN,
  label: 'Unrecognised failure',
  detail: 'This error has not been seen before. Read it and decide; requeueing is '
    + 'offered because a transient error that is refused a retry strands the subject.',
  action: 'requeue',
  // Conservative in the direction that cannot destroy work: an extra failed
  // generation costs one attempt, whereas refusing to retry a transient error
  // loses the subject until someone notices.
  retryable: true,
};

function classify(lastError) {
  const e = String(lastError == null ? '' : lastError);
  if (!e) return { ...UNKNOWN, label: 'No error recorded' };
  const rule = RULES.find((r) => r.match(e));
  if (!rule) return UNKNOWN;
  const { match, ...rest } = rule;
  return rest;
}

// Failed rows -> one bucket per kind, each carrying its subjects.
//
// Ordered by how much a human can do about it: the things needing a decision
// come before the long list that will fix itself on the next requeue. A
// hundred provider faults scrolling above the one subject that needs thought
// is how the actionable item gets missed.
const ORDER = [KINDS.CONFIG, KINDS.CONTENT_CUTOUT, KINDS.CONTENT_UNKEYED, KINDS.UNKNOWN,
  KINDS.UNREACHABLE, KINDS.PROVIDER_FAULT];

function groupFailures(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const byKind = new Map();
  for (const row of rows) {
    const c = classify(row.last_error);
    if (!byKind.has(c.kind)) byKind.set(c.kind, { ...c, count: 0, subjects: [] });
    const g = byKind.get(c.kind);
    g.count += 1;
    // Capped: a batch can fail hundreds of subjects, and the page needs enough
    // to recognise them, not all of them. count stays exact.
    if (g.subjects.length < 25) {
      g.subjects.push({ kind: row.subject_kind, key: row.subject_key });
    }
    // The last error seen for this kind, verbatim -- the operator needs the
    // provider's own words, not only our label.
    g.example = row.last_error;
  }
  return [...byKind.values()].sort(
    (a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind),
  );
}

module.exports = { classify, groupFailures, KINDS };
