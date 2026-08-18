// Single source for the backend base URL. The auth context and the login route
// both talk to the same API; one definition stops them drifting apart in a
// container where VITE_API_URL is only half configured.
//
// Unset (the default, and the normal production case for compose/orangepi)
// means SAME-ORIGIN: every caller builds URLs as `${API_URL}/api/...`, so an
// empty string yields a relative `/api/...` that goes through whatever proxy
// or reverse proxy is serving the page (vite's dev proxy, or Caddy in prod).
// Set VITE_API_URL to an absolute origin only when the frontend and backend
// are deployed on genuinely different origins.
export const API_URL = import.meta.env.VITE_API_URL || '';
