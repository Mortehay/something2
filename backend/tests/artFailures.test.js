const test = require('node:test');
const assert = require('node:assert');
const { classify, groupFailures, KINDS } = require('../src/services/artFailures.js');

// The art console's failure triage. One rule, one place.
//
// WHY THIS IS BACKEND CODE AND NOT FRONTEND CODE. The same question -- "is
// this failure the provider's fault or the subject's?" -- is asked by the
// admin page (to group failures and offer the right button), by the requeue
// endpoint (to refuse a pointless retry) and, later, by the drain's circuit
// breaker (to tell a dead provider from a bad subject). This repo already
// carries one rule duplicated across the front/back split -- resolveMove, kept
// byte-for-byte in two files -- and that duplication is a standing hazard. So
// the rule lives here and the classification travels over the API; the page
// renders what it is told and owns no copy it could disagree with.
//
// EVERY STRING BELOW IS REAL. They were collected from art_jobs.last_error
// during the 2026-09-04/05 incident, not invented. A classifier tested against
// invented strings tests the author's imagination; this one is tested against
// what the provider actually said.

// --- the real corpus -------------------------------------------------------
const CUDA_ASSERT = 'provider answered 500: {"detail":"!handles_.at(i) INTERNAL ASSERT FAILED at '
  + '\\"/__w/pytorch/pytorch/c10/cuda/CUDACachingAllocator.cpp\\":467, please report a bug to PyTorch."}';
const DTYPE = 'provider answered 500: {"detail":"Input type (c10::Half) and bias type (float) '
  + 'should be the same"}';
const UNREACHABLE = 'could not reach http://192.168.0.217:8001/sdapi/v1/txt2img: fetch failed';
const CUTOUT = 'provider answered 422: {"detail":"cutout removed 97.9% of the image - there is '
  + 'essentially no subject left. The background flood fill consumed the subject, which happens '
  + 'when subject and background share a colour."}';
const TOO_SMALL = 'provider "desktop gpu" renders at 512x512, below the 1024px minimum for an '
  + 'isolated object. Below SDXL\'s native resolution the model repeats the subject';
const STRANDED = 'claimed but never resolved; worker presumed lost';

test('a faulted GPU is a PROVIDER failure -- retrying it is correct', () => {
  for (const err of [CUDA_ASSERT, DTYPE, UNREACHABLE]) {
    const c = classify(err);
    assert.equal(c.kind, err === UNREACHABLE ? KINDS.UNREACHABLE : KINDS.PROVIDER_FAULT,
      `not classified as a provider problem: ${err.slice(0, 60)}`);
    assert.equal(c.retryable, true, 'a provider failure must be retryable -- it succeeds later');
  }
});

test('a cutout that keyed the subject away is a CONTENT failure -- retrying is pointless', () => {
  const c = classify(CUTOUT);
  assert.equal(c.kind, KINDS.CONTENT_CUTOUT);
  // THE POINT OF THE WHOLE MODULE. The seed is derived from (kind, key), so a
  // plain requeue regenerates a byte-identical image and fails identically.
  // Offering "Requeue" here would be a button that cannot work.
  assert.equal(c.retryable, false,
    'a content failure must NOT be plainly retryable -- the same seed gives the same image');
  assert.equal(c.action, 'reseed', 'the only useful retry is a different seed');
  assert.match(c.detail, /colour|color/i, 'the operator needs the reason, not just the label');
});

test('a misconfigured provider is neither -- it needs a human, not a retry', () => {
  const c = classify(TOO_SMALL);
  assert.equal(c.kind, KINDS.CONFIG);
  assert.equal(c.retryable, false, 'retrying a config error just reproduces it');
  assert.equal(c.action, 'fix_config');
});

test('a stranded job is a provider-side loss, and safe to retry', () => {
  const c = classify(STRANDED);
  assert.equal(c.retryable, true);
});

test('an unrecognised error is UNKNOWN and conservatively retryable', () => {
  const c = classify('something nobody has seen before');
  assert.equal(c.kind, KINDS.UNKNOWN);
  // Conservative in the direction that cannot destroy work: offering a retry
  // that fails again costs one generation; refusing to offer one on a
  // transient error strands a subject forever.
  assert.equal(c.retryable, true);
});

test('null and empty errors do not throw', () => {
  for (const v of [null, undefined, '']) {
    const c = classify(v);
    assert.ok(c && c.kind, `classify(${JSON.stringify(v)}) must return a shape, not throw`);
  }
});

// A 422 that is NOT the cutout must not be swallowed into the cutout bucket --
// that would offer "retry with a new seed" for something a new seed cannot fix.
test('a different 422 is not mistaken for the cutout case', () => {
  const c = classify('provider answered 422: {"detail":"prompt exceeds the token limit"}');
  assert.notEqual(c.kind, KINDS.CONTENT_CUTOUT);
});

// The dtype error was, on 2026-09-04, a symptom of a faulted CUDA context --
// NOT a real dtype bug. Classifying it as a provider fault (retryable) rather
// than as a config problem is what makes the queue recover by itself once the
// box is restarted. Getting this backwards would strand every affected subject.
test('the dtype error is treated as a fault, not as a configuration mistake', () => {
  const c = classify(DTYPE);
  assert.equal(c.kind, KINDS.PROVIDER_FAULT);
  assert.notEqual(c.kind, KINDS.CONFIG);
});

// Real strings, collected from art_jobs.last_error on 2026-09-05. Two come
// from the provider and one from OUR transparency floor -- a classifier that
// matched only the provider's wording left a third of them unclassified, which
// is how this case was found: the page showed them as "Unrecognised".
const UNKEYED_PROVIDER = 'provider answered 422: {"detail":"cutout produced no transparency '
  + '(0.4%): the subject is not separable from its background. This would be an opaque square."}';
const UNKEYED_OURS = 'image sprites/objects/crude-hood/rmt_dfd561.../static.png was generated '
  + 'but could not be recorded: the provider returned an image that is only 21% transparent '
  + '(floor 25%); the backdrop was not keyed out';

test('an unkeyed backdrop is a content failure too -- and a DIFFERENT one', () => {
  for (const err of [UNKEYED_PROVIDER, UNKEYED_OURS]) {
    const c = classify(err);
    assert.equal(c.kind, KINDS.CONTENT_UNKEYED, `unclassified: ${err.slice(0, 50)}`);
    assert.equal(c.retryable, false, 'same seed, same image -- a plain retry cannot help');
    assert.equal(c.action, 'reseed');
  }
  // The two keying failures are OPPOSITE symptoms (subject eaten vs subject
  // not separable) and must stay distinct, or the page reports one cause for
  // two different problems and the prompt fix aims at the wrong one.
  assert.notEqual(classify(UNKEYED_PROVIDER).kind, classify(CUTOUT).kind);
});

test('groupFailures buckets rows by kind and keeps the subjects with each', () => {
  const rows = [
    { subject_kind: 'item', subject_key: 'astral-helm', last_error: CUDA_ASSERT },
    { subject_kind: 'item', subject_key: 'crude-wand', last_error: CUDA_ASSERT },
    { subject_kind: 'item', subject_key: 'arrow', last_error: CUTOUT },
  ];
  const groups = groupFailures(rows);
  const byKind = Object.fromEntries(groups.map((g) => [g.kind, g]));

  assert.equal(byKind[KINDS.PROVIDER_FAULT].count, 2);
  assert.deepEqual(byKind[KINDS.PROVIDER_FAULT].subjects.map((s) => s.key).sort(),
    ['astral-helm', 'crude-wand']);
  assert.equal(byKind[KINDS.CONTENT_CUTOUT].count, 1);

  // Ordered most-actionable-first so the operator reads the fixable thing
  // before the long list of things that will fix themselves.
  assert.ok(groups.length === 2);
});

test('groupFailures on an empty list is an empty list, not a crash', () => {
  assert.deepEqual(groupFailures([]), []);
  assert.deepEqual(groupFailures(null), []);
});
