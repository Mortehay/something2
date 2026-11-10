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

// A unique violation from the description write: a per-row Regenerate / edit
// replaced the same subject's description at the same moment.
const CONCURRENT_PROMPT_ERROR = 'prompt changed concurrently — queue again';

function isBusy(err) {
  return Boolean(err && (err.busy === true || remote.isCardHeld(err.message)));
}

// Run one prompt write, waiting out busy answers. Never throws: the result
// says whether it worked, and if not whether the text model was busy (worth
// trying again later) or the write itself failed.
//
// `deadline` (an absolute time on the `now` clock) bounds the waiting by time instead of by
// count: the effect lane passes its queue cap, so a prompt rewrite outlasts a creature sheet
// the box is drawing ("a sheet job has been running") instead of failing after maxWaits.
async function runPromptWithWaits(write, {
  sleep, shouldStop = () => false, maxWaits = maxHeldWaits(), deadline = null, now = Date.now,
} = {}) {
  let waits = 0;
  const started = now();
  for (;;) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return { ok: true, value: await write() };
    } catch (err) {
      const msg = (err && err.message) || String(err);
      if (err && err.code === '23505') return { ok: false, busy: false, error: CONCURRENT_PROMPT_ERROR };
      if (!isBusy(err)) return { ok: false, busy: false, error: msg };
      if (deadline != null) {
        if (now() >= deadline) {
          const min = Math.max(1, Math.round((now() - started) / 60000));
          return { ok: false, busy: true, error: `text model busy for ${min} min: ${msg}` };
        }
      } else if (waits >= maxWaits) {
        return { ok: false, busy: true, error: `text model busy after ${maxWaits} waits: ${msg}` };
      }
      if (shouldStop()) return { ok: false, busy: true, stopped: true, error: msg };
      const wait = busyWaitMs(msg, waits);
      // eslint-disable-next-line no-await-in-loop
      await sleep(deadline != null ? Math.max(0, Math.min(wait, deadline - now())) : wait);
      waits += 1;
      if (shouldStop()) return { ok: false, busy: true, stopped: true, error: msg };
    }
  }
}

// Measured live on 2026-11-10 (Task 10, brain:qwen3.6-35b-a3b on the GPU box): the first
// /api/text call after an image model took 104 s (load 97 s + one prompt); the per-prompt wall
// times were 7, 2 and 6 s (median 6). Switch = 104 - 6 = 98, rounded to 100.
const PROMPT_ETA = Object.freeze({ switchSeconds: 100, perPromptSeconds: 6, placeholder: false });

function promptPhaseSeconds(n, eta = PROMPT_ETA) {
  if (!(n > 0)) return 0;
  return eta.switchSeconds + n * eta.perPromptSeconds;
}

module.exports = {
  maxHeldWaits, SWITCH_WAIT_MS, busyWaitMs, runPromptWithWaits, CONCURRENT_PROMPT_ERROR, PROMPT_ETA, promptPhaseSeconds,
};
