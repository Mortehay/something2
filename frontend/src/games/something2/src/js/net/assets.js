// URL builder for assets served through the backend proxy (/api/assets/<key>).
// MinIO's own port is not reachable from the browser in every deployment, so
// nothing in the game should address it directly.

// Generated asset keys are STABLE across regenerations — approving a new sprite
// overwrites sprites/objects/Wolf/static.png in place — and /api/assets sends
// `Cache-Control: max-age=300`. An unversioned URL therefore keeps rendering
// the PREVIOUS art for five minutes after an approval, which reads as "the
// approval silently did nothing". `version` is the row's updated_at, which the
// approval bumps; without one the URL is left bare rather than made unique, so
// this never defeats caching for rows that have no version to key on.
export function assetUrl(apiUrl, key, version = null) {
  if (!key) return null;
  const url = `${apiUrl}/api/assets/${key}`;
  return version ? `${url}?v=${encodeURIComponent(version)}` : url;
}
