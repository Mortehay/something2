// URL builder for assets served through the backend proxy (/api/assets/<key>).
// MinIO's own port is not reachable from the browser in every deployment, so
// nothing in the game should address it directly.

// SOMET-235: generated asset keys are now job-id-scoped and never reused
// across generations (e.g. sprites/objects/Wolf/<job_id>/static.png), so a
// fresh generation is structurally a fresh URL and caching alone can't serve
// stale art. This `version` param is now redundant-but-harmless rather than
// load-bearing: /api/assets sends `Cache-Control: max-age=300`, and a `?v=`
// query string is still cheap insurance against any cache layer that keys on
// the bare path. `version` is the row's updated_at, which approval bumps;
// without one the URL is left bare rather than made unique.
export function assetUrl(apiUrl, key, version = null) {
  if (!key) return null;
  const url = `${apiUrl}/api/assets/${key}`;
  return version ? `${url}?v=${encodeURIComponent(version)}` : url;
}
