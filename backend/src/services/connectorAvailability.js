'use strict';

// Is a connector usable right now? Answered with an AUTHENTICATED read, because
// the box serves its catalog without auth and would pass with a stale key.
// Measured on the box: GET /api/jobs and GET /sdapi/v1/sd-models both answer 401
// without a valid key, in under 150 ms.
//
// Not the provider Test button: for an image provider that draws a real picture
// (SOMET-542), which is far too heavy for opening a page. So `available` means
// "reachable and the key is accepted", not "the GPU will draw".
const TIMEOUT_MS = 5000;
const TTL_MS = 30 * 1000;

function createConnectorProbe({
  loadProvider, box, discovery, now = Date.now, timeoutMs = TIMEOUT_MS, ttlMs = TTL_MS,
}) {
  const cache = new Map();

  async function check(id) {
    const provider = await loadProvider(id);
    if (!provider) return { ok: false, error: 'provider no longer exists' };
    return provider.modality === 'image' ? discovery.fetchModels(provider) : box.checkAuth(provider);
  }

  return async function probeConnector(id) {
    const hit = cache.get(id);
    if (hit && now() - hit.at < ttlMs) return hit.result;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, error: `no answer within ${timeoutMs / 1000}s` }), timeoutMs);
    });
    let r;
    try {
      r = await Promise.race([check(id), timeout]);
    } catch (err) {
      r = { ok: false, error: err.message };
    } finally {
      clearTimeout(timer);
    }
    const result = { available: r.ok === true, reason: r.ok === true ? null : (r.error || 'unavailable') };
    cache.set(id, { at: now(), result });
    return result;
  };
}

module.exports = { createConnectorProbe };
