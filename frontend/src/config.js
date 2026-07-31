// Single source for the backend base URL. The auth context and the login route
// both talk to the same API; one definition stops them drifting apart in a
// container where VITE_API_URL is only half configured.
export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:13101';
