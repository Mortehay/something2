// Dependency-free fetcher + refetch predicate for the minimap's player-centered
// overview. Kept React/query-free so it is unit-testable in the node vitest env,
// mirroring worldPreviewClient.js.
import { API_URL } from '../../../../../config.js';

export async function fetchWorldOverview(worldId, centerCol, centerRow) {
  const res = await fetch(`${API_URL}/api/worlds/${worldId}/overview?cx=${centerCol}&cy=${centerRow}`);
  if (!res.ok) throw new Error(`Failed to fetch world overview: HTTP ${res.status}`);
  return res.json();
}

// True when there is no cached window, or the player has moved within `margin`
// tiles of its edge (so terrain would run out before the next fetch lands).
export function needsRefetch(cached, playerCol, playerRow, margin) {
  if (!cached) return true;
  const maxCol = cached.originCol + cached.cols * cached.step;
  const maxRow = cached.originRow + cached.rows * cached.step;
  return playerCol < cached.originCol + margin || playerCol > maxCol - margin
      || playerRow < cached.originRow + margin || playerRow > maxRow - margin;
}

// Backoff-guarded driver for the fetch above.
//
// This is called from the minimap's TICK, i.e. every animation frame -- see
// minimapLoop.js on why the edge check cannot be throttled down to the draw
// cadence. That makes failure handling load-bearing in a way it is not for a
// normal fetch: `needsRefetch(null, ...)` is true by definition, so a caller
// that simply retries "on the next frame that still needs it" will, while the
// request keeps failing, leave the window null, keep the condition true, and
// re-request at ~60Hz for as long as the failure lasts.
//
// That turned one transient error into a self-sustaining flood. Observed live:
// a sprite-preload burst tripped the backend's 300/min limiter, this fetch got
// a 429, and the retry loop then held the bucket saturated indefinitely --
// hundreds of 429s on /api/worlds/:id/overview and a minimap that never
// recovered, because the retry rate was itself what kept the limiter tripped.
//
// So consecutive failures back off, and the first success clears the delay.
// The ceiling is well under the time it takes to walk out of a fetched window,
// so streaming is unaffected once the backend is answering again.
//
// Lives here rather than inline in Minimap.jsx so the loop can actually be
// asserted: this project has no component-render harness, so a driver left
// inside the component could only be verified by reading it.
//
//   store  - the caller's overview ref ({ current }); written on success
//   margin - needsRefetch's edge margin, in tiles
//   fetchOverview / clock - seams for the test
//
// Returns maybeFetch(worldId, playerCol, playerRow, now) -> void.
export function createOverviewFetcher({
  store,
  margin,
  fetchOverview = fetchWorldOverview,
  clock = () => performance.now(),
  minBackoffMs = 500,
  maxBackoffMs = 8000,
} = {}) {
  let inFlight = false;
  let retryAt = 0;
  let step = 0;

  return function maybeFetch(worldId, playerCol, playerRow, now) {
    const cached = store.current;
    // A window fetched for a world the player has since left is unusable, so a
    // world change forces a refetch even from mid-window.
    const stale = cached && cached.world_id !== worldId;
    if (inFlight) return;
    // `now` is rAF's timestamp. Guard against an absent one (a caller that
    // ticks without a clock) by treating it as "no wait", never as "wait
    // forever" -- failing open here costs a request, failing closed would
    // silently stop the map streaming.
    if (Number.isFinite(now) && now < retryAt) return;
    if (!stale && !needsRefetch(cached, playerCol, playerRow, margin)) return;

    inFlight = true;
    fetchOverview(worldId, Math.round(playerCol), Math.round(playerRow))
      .then((ov) => {
        store.current = ov;
        retryAt = 0;
        step = 0;
      })
      .catch(() => {
        // Keep the last window and try again after the delay, not next frame.
        step = Math.min(maxBackoffMs, step ? step * 2 : minBackoffMs);
        // Stamped from the clock at FAILURE time, not from the tick's `now`: a
        // request that takes longer to fail than the delay itself (a timeout, a
        // slow 429) would otherwise land its deadline already in the past and
        // retry on the very next frame -- exactly the loop being fixed.
        retryAt = clock() + step;
      })
      .finally(() => { inFlight = false; });
  };
}
