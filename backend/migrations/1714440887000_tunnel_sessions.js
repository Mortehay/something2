/* eslint-disable camelcase */
// Tunnels admin tab (dev PC only): one row per public tunnel session (Cloudflare quick tunnel or
// ngrok), the accounts that played through it, and what went wrong along the way (tunnel dropped /
// reconnected, backend 5xx and refused WebSocket upgrades that arrived through the tunnel host),
// plus the helper event ids already applied.
// Runtime dev data, written by backend/src/services/tunnelRecorder.js and kept 30 days; never
// seed-synced (see seedSync/coverage.js).
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`CREATE TABLE tunnel_sessions (
    id serial PRIMARY KEY,
    provider text NOT NULL,
    mode text,
    url text,
    started_at timestamptz NOT NULL,
    ended_at timestamptz,
    end_reason text CHECK (end_reason IN ('switched_off', 'went_down', 'crashed', 'failed_to_start')),
    peak_players integer NOT NULL DEFAULT 0,
    error text
  )`);
  pgm.sql('CREATE INDEX tunnel_sessions_started_at_idx ON tunnel_sessions (started_at)');

  pgm.sql(`CREATE TABLE tunnel_session_players (
    session_id integer NOT NULL REFERENCES tunnel_sessions(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    first_seen timestamptz NOT NULL,
    PRIMARY KEY (session_id, user_id)
  )`);

  pgm.sql(`CREATE TABLE tunnel_session_events (
    id serial PRIMARY KEY,
    session_id integer REFERENCES tunnel_sessions(id) ON DELETE CASCADE,
    provider text NOT NULL,
    at timestamptz NOT NULL,
    kind text NOT NULL,
    detail text
  )`);
  pgm.sql('CREATE INDEX tunnel_session_events_session_idx ON tunnel_session_events (session_id)');

  // Helper events already applied, so a replay from 0 (backend restart, helper resend) applies
  // each exactly once. Helper ids restart from the helper's start clock, so a restart after a
  // backward clock step can reuse an id: the key also holds the event's own time (`at`).
  pgm.sql(`CREATE TABLE tunnel_helper_events_seen (
    provider text NOT NULL,
    helper_event_id bigint NOT NULL,
    at timestamptz NOT NULL,
    seen_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, helper_event_id, at)
  )`);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS tunnel_helper_events_seen');
  pgm.sql('DROP TABLE IF EXISTS tunnel_session_events');
  pgm.sql('DROP TABLE IF EXISTS tunnel_session_players');
  pgm.sql('DROP TABLE IF EXISTS tunnel_sessions');
};
