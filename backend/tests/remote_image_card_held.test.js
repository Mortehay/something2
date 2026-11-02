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
