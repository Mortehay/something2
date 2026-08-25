// The progression side-channel the Character tab reads (SOMET-483). PURE:
// no fetch, no clock, no Game -- every rule below is a unit test.
//
// WHY THIS MODULE IS SMALL, AND WHY IT DOES NOT HOLD sources/modifiers.
//
// CharacterSheet.jsx -- the standalone level popup SOMET-483 deleted -- carried
// an "F1" header, and this module is where that record now lives. It documented
// a real,
// browser-reproduced race: the HTTP allocate response travels on a brand-new
// connection with NO ordering guarantee against a websocket push sent moments
// earlier, so a late, stale HTTP response overwrote a newer level-up. It was
// fixed by removing the second writer, not by guessing an ordering predicate
// -- and NOT by an "only apply if experience increased" guard, because death
// LOWERS experience, so that predicate is wrong in the other direction.
//
// Since SOMET-475, `progression` on the wire is the COMPOSED row
// (passiveTreeStore.js#composeProgression): it already carries `sources`,
// `modifiers`, `passivePoints`, `allocatedNodeIds` and the six effective
// stats, on the join frame and on every `progression` push alike. So the tab
// reads all of those straight off `Game.progression`, whose single writer is
// still `onProgression`. There is nothing to merge and nothing to race: this
// module deliberately does NOT keep a second copy of them, because a second
// copy is the shape the F1 race takes.
//
// What is left over -- the fields `progression` does NOT carry -- is exactly
// what lives here:
//
//   * `stats`, the derived bundle (playerStats.js#derivePlayerStats). It rides
//     every websocket `progression` frame beside the row (contract §6.3) but
//     NOT the join frame, so the HTTP bundle may SEED it once and is latched
//     off permanently the moment any socket frame has carried it. After the
//     latch there is exactly one writer again.
//   * `xpFloor` / `xpToNext` / `respecCost`, which have exactly ONE sender
//     (GET /api/progression -- no websocket frame carries them), so there is
//     nothing to race and they are applied unconditionally. They are COPIED,
//     never computed: that is the F2 lesson, and the reason xpCurve.js was
//     deleted.

export function emptyExtras() {
  return {
    stats: null,
    xpFloor: null,
    xpToNext: null,
    respecCost: null,
  };
}

// True when a websocket frame carried the derived bundle. Checked against
// `undefined` rather than truthiness: a frame that genuinely sent `stats: null`
// is still a frame that spoke about stats, and treating it as silence would
// leave the HTTP seed armed against a socket that is already talking.
export function frameCarriesStats(msg) {
  return !!msg && msg.stats !== undefined;
}

export function mergeFrameStats(extras, msg) {
  const base = extras || emptyExtras();
  if (!frameCarriesStats(msg)) return base;
  return { ...base, stats: msg.stats };
}

// The HTTP bundle's one-shot seed of `stats`. `latched` is the caller's record
// of "a socket frame has already carried this", and when it is true this is a
// no-op -- the exact F1 race, in the one field that still has two senders.
export function mergeSeedStats(extras, bundle, latched) {
  const base = extras || emptyExtras();
  if (latched || !bundle || bundle.stats === undefined) return base;
  return { ...base, stats: bundle.stats };
}

// The three level-dependent curve numbers. Unconditional: no websocket frame
// sends them, so there is no second writer to lose a race to. Field-by-field,
// so a bundle that omits one leaves the last known value rather than blanking
// it -- and `null` is a REAL value here (JSON's encoding of the backend's
// Infinity at max level), which is why this tests for `undefined`.
export function mergeLevelInfo(extras, bundle) {
  const base = extras || emptyExtras();
  if (!bundle) return base;
  return {
    ...base,
    xpFloor: bundle.xpFloor !== undefined ? bundle.xpFloor : base.xpFloor,
    xpToNext: bundle.xpToNext !== undefined ? bundle.xpToNext : base.xpToNext,
    respecCost: bundle.respecCost !== undefined ? bundle.respecCost : base.respecCost,
  };
}

// The one object the inventory panel's Character pane consumes. Null before
// the first join lands, so the pane renders its own "Loading character…".
//
// `sources`, `modifiers` and `passivePoints` are LIFTED off the progression row
// rather than recomputed or re-stored: they are the server's own composeStats()
// output, and this is the whole point of contract §6.2. A `sources` of null (an
// older server, or a row from before T7) renders as em dashes, not as zeros.
export function buildCharacterView({ progression, extras, className, mainStat }) {
  if (!progression) return null;
  const e = extras || emptyExtras();
  return {
    className: className || null,
    mainStat: mainStat || null,
    level: progression.level,
    experience: progression.experience,
    xpFloor: e.xpFloor,
    xpToNext: e.xpToNext,
    passivePoints: progression.passivePoints != null
      ? progression.passivePoints
      : (progression.passive_points || 0),
    sources: progression.sources || null,
    modifiers: Array.isArray(progression.modifiers) ? progression.modifiers : [],
    stats: e.stats,
  };
}
