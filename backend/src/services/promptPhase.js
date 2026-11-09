// The prompt phase: writing sprite prompts with the box's text model before
// any image is drawn. Pure apart from the sleep the caller hands in.
//
// One held-wait rule for both lanes: artDispatcher reads maxHeldWaits() from
// here, so a box that never lets go of its card stops the art drain and the
// prompt phase after the same number of waits.
'use strict';

const remote = require('./remoteImageProvider.js');

// SOMET-684. Held-card (or busy) answers tolerated before giving up as busy.
// A garbled env value falls back to the default, so the wait loop is always
// bounded (NaN would compare false against every count and never stop it).
function envInt(name, fallback) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
const maxHeldWaits = () => envInt('ART_MAX_HELD_WAITS', 3);

// The first wait after a busy answer; the art drain reads it from here too.
const SWITCH_WAIT_MS = () => envInt('ART_SWITCH_WAIT_MS', 5000);
const MAX_BUSY_WAIT_MS = 60000;

// How long to wait before asking again: the idle time the box names when its
// card is held, else an exponential backoff capped at a minute.
function busyWaitMs(message, attempt) {
  if (remote.isCardHeld(message)) return remote.cardHeldWaitMs(message);
  return Math.min(SWITCH_WAIT_MS() * 2 ** Math.max(0, attempt), MAX_BUSY_WAIT_MS);
}

function isBusy(err) {
  return Boolean(err && (err.busy === true || remote.isCardHeld(err.message)));
}

// Run one prompt write, waiting out busy answers. Never throws: the result
// says whether it worked, and if not whether the text model was busy (worth
// trying again later) or the write itself failed.
async function runPromptWithWaits(write, { sleep, shouldStop = () => false, maxWaits = maxHeldWaits() } = {}) {
  let waits = 0;
  for (;;) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return { ok: true, value: await write() };
    } catch (err) {
      const msg = (err && err.message) || String(err);
      if (!isBusy(err)) return { ok: false, busy: false, error: msg };
      if (waits >= maxWaits) {
        return { ok: false, busy: true, error: `text model busy after ${maxWaits} waits: ${msg}` };
      }
      if (shouldStop()) return { ok: false, busy: true, stopped: true, error: msg };
      // eslint-disable-next-line no-await-in-loop
      await sleep(busyWaitMs(msg, waits));
      waits += 1;
      if (shouldStop()) return { ok: false, busy: true, stopped: true, error: msg };
    }
  }
}

// PLACEHOLDER: not measured. Task 10 replaces it with the live run's text-model switch and per-prompt seconds.
const PROMPT_ETA = Object.freeze({ switchSeconds: 120, perPromptSeconds: 20, placeholder: true });

function promptPhaseSeconds(n, eta = PROMPT_ETA) {
  if (!(n > 0)) return 0;
  return eta.switchSeconds + n * eta.perPromptSeconds;
}

module.exports = {
  maxHeldWaits, SWITCH_WAIT_MS, busyWaitMs, runPromptWithWaits, PROMPT_ETA, promptPhaseSeconds,
};
