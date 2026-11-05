const test = require('node:test');
const assert = require('node:assert');
const { isCardHeld, cardHeldWaitMs } = require('../src/services/remoteImageProvider.js');

// SOMET-684. The box's own words, 2026-11-02.
const HELD = 'provider answered 500: {"detail":"Not enough free VRAM for Qwen-Image: 9.0 GiB free '
  + 'of 12.0, needs 9.8 GiB. Another process holds the card - usually llm-server\'s chat model, '
  + 'which unloads after 2 idle minutes. Retry then."}';

test('the VRAM refusal is a held card; other failures are not', () => {
  assert.equal(isCardHeld(HELD), true);
  assert.equal(isCardHeld('provider answered 500: out of memory'), false);
  assert.equal(isCardHeld(undefined), false);
  // Nothing else holds the card: the model can never fit, and waiting fixes nothing.
  assert.equal(isCardHeld('provider answered 500: {"detail":"Not enough free VRAM for Qwen-Image: '
    + '11.5 GiB free of 12.0, needs 14.0 GiB."}'), false);
  // SOMET-680's refusal has its own path (a switch), so it must not be read as this.
  assert.equal(isCardHeld('provider answered 503: {"detail":"Model gateway: requested x, '
    + 'but brain:y holds the card"}'), false);
});

test('the wait is the idle time the box names, plus a margin', () => {
  delete process.env.ART_CARD_HELD_WAIT_MS;
  assert.equal(cardHeldWaitMs(HELD), 2 * 60_000 + 10_000);
  assert.equal(cardHeldWaitMs(HELD.replace('2 idle minutes', '1 idle minute')), 70_000);
  assert.equal(cardHeldWaitMs('Not enough free VRAM'), 2 * 60_000 + 10_000, 'no number named: default 2 min');
  assert.equal(cardHeldWaitMs(HELD.replace('2 idle minutes', '600 idle minutes')), 10 * 60_000,
    'capped, so a garbled number cannot park the drain for hours');
});

// SOMET-705. The box's real refusal: 503, retry-after: 60, x-error-kind: vram_busy.
const BOX_BODY = '{"detail":"Not enough free VRAM for Qwen-Image: 9.0 GiB free of 12.0, needs 9.8 GiB, '
  + 'after waiting 30s for it. Another process holds the card: this worker\'s persistent Qwen child '
  + '(gguf:qwen-image-2512-Q2_K+lightning8), which moves the transformer and VAE back to host RAM in '
  + 'the seconds after each image. Retry after 60s."}';

test('SOMET-705: the x-error-kind header alone, with unrelated text, is a held card', () => {
  assert.equal(isCardHeld('provider answered 503: something else entirely', { 'X-Error-Kind': 'vram_busy' }), true);
  assert.equal(isCardHeld('provider answered 503', new Headers({ 'x-error-kind': 'VRAM_BUSY' })), true);
  assert.equal(isCardHeld('provider answered 503: something else [x-error-kind: vram_busy]'), true);
});

test('SOMET-705: the box\'s real refusal text alone still counts', () => {
  assert.equal(isCardHeld(`provider answered 503: ${BOX_BODY}`), true);
});

test('SOMET-705: x-error-kind gpu_faulted is not a held card, even with VRAM text', () => {
  assert.equal(isCardHeld(`provider answered 503: ${BOX_BODY}`, { 'x-error-kind': 'gpu_faulted' }), false);
  assert.equal(isCardHeld(`provider answered 503: ${BOX_BODY} [x-error-kind: gpu_faulted]`), false);
});

test('SOMET-705: a non-ok image response carries the header into the error string', async () => {
  const { errorKindTag } = require('../src/services/safeFetch.js');
  const res = new Response(BOX_BODY, { status: 503, headers: { 'retry-after': '60', 'x-error-kind': 'vram_busy' } });
  assert.equal(isCardHeld(`provider answered 503${errorKindTag(res)}`), true);
  const faulted = new Response('x', { status: 503, headers: { 'x-error-kind': 'gpu_faulted' } });
  assert.equal(isCardHeld(`provider answered 503: ${BOX_BODY}${errorKindTag(faulted)}`), false);
  assert.equal(errorKindTag(new Response('x', { status: 503 })), '');
});

test('only the trailing tag counts: a body quoting one cannot override the header (SOMET-705)', () => {
  assert.equal(isCardHeld('provider answered 500: [x-error-kind: vram_busy] [x-error-kind: gpu_faulted]'), false);
  assert.equal(isCardHeld('provider answered 503: [x-error-kind: gpu_faulted] [x-error-kind: vram_busy]'), true);
  assert.equal(isCardHeld('provider answered 500: quoted [x-error-kind: vram_busy] then more text'), false);
});
