// Cache policy for /api/assets/*.
//
// Seed-synced art lives at `<bucket>/seedsync/<sha256>/<file>` (see
// services/seedSync/assets.js): the path IS the hash of the bytes, so the
// content behind a given URL can never change and the browser may keep it
// indefinitely. Everything else (tiles, character appearances, audio) can be
// replaced under the same key, so it keeps the short lifetime it always had.
//
// This matters because the game requests hundreds of these PNGs per session.
// With a 5-minute lifetime every visit after the first five minutes re-downloaded
// the whole catalogue; behind a tunnel that was the dominant cost of loading.
const CONTENT_ADDRESSED = /(?:^|\/)seedsync\/[0-9a-f]{64}\//i;

const IMMUTABLE = 'public, max-age=31536000, immutable';
const SHORT = 'public, max-age=300';

function assetCacheControl(key) {
  return CONTENT_ADDRESSED.test(String(key || '')) ? IMMUTABLE : SHORT;
}

module.exports = { assetCacheControl };
