'use strict';
// The cached BoardStatus behind GET /status. Reading it runs tunnel.sh status for both tunnels, and
// that curls the public tunnel URLs, so it must not run once per poll: ngrok's free plan may cap
// monthly requests and the tab polls every 15 s. The cache is therefore refreshed by the 60 s timer
// and after a job, never by a poll that finds it young.
const TTL_MS = 60_000;
// A sample older than this says nothing about the board right now (the sampler may be stuck).
const SAMPLE_FRESH_MS = 45_000;

function createStatusCache({ read, latestSample = () => null, now = Date.now, ttlMs = TTL_MS } = {}) {
  let value = null;
  let at = 0;
  let gen = 0;
  let inflight = null;

  function refresh() {
    // Only a read that started under the current generation may be joined: after an invalidation
    // (a job ended) a read already in flight may predate the change, so start a new one.
    if (inflight && inflight.gen === gen) return inflight.p;
    const startedGen = gen;
    const p = Promise.resolve().then(read).then((v) => {
      // A newer read has started since: this answer is stale, serve it to its own callers only.
      if (gen === startedGen) { value = v; at = now(); }
      else if (!inflight || inflight.p === p) { value = v; at = 0; }
      return v;
    }).finally(() => { if (inflight && inflight.p === p) inflight = null; });
    inflight = { p, gen: startedGen };
    return p;
  }

  // The 15 s sample is the source for "is the board up": a board going off shows within one sample.
  function overlay(v) {
    const s = latestSample();
    if (s && s.online === false && v.online !== false) return { ...v, online: false };
    return v;
  }

  async function get() {
    const s = latestSample();
    const sampleFresh = s && Number.isFinite(s.t) && now() - s.t <= SAMPLE_FRESH_MS;
    // The cache says offline but the board answered a sample: do not keep showing a stale "offline".
    const contradicted = value && value.online === false && sampleFresh && s.online === true;
    const fresh = value && !contradicted && now() - at < ttlMs;
    const v = fresh ? value : await refresh();
    return sampleFresh ? overlay(v) : v;
  }

  const invalidate = () => { gen += 1; at = 0; };

  return {
    get,
    refresh,
    // For the timer: refresh only when the cache is about to expire, so a poll just before it does not double up.
    refreshIfOlder: (ms) => (!value || now() - at >= ms ? refresh() : Promise.resolve(value)),
    invalidate,
    // Wire to createJobs({ onDone }): drop the cache and re-read now, so a new tunnel link shows at once.
    onJobDone() {
      invalidate();
      return refresh().catch(() => {});
    },
  };
}

module.exports = { createStatusCache, TTL_MS };
