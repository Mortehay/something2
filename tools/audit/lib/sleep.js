'use strict';

// Shared by lib/plane.js (retry backoff) and lib/sync.js (write throttling).
// Both accept a `sleepImpl` override so tests never actually wait.
function defaultSleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { defaultSleep };
