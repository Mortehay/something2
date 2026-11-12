// Tunnels tab: the backend is the one writer of tunnel history. Every tick it reads the tunnel
// helper (current state, then the event log after its in-memory cursor) and the in-memory
// traffic notes, and writes:
//   - tunnel_sessions: one row per tunnel run, closed as
//       switched_off    the helper reported `stopped` (an owner click),
//       crashed         the helper reported `failed` while the session was open,
//       went_down       the helper says it is not on and nobody stopped it (containers or the
//                       laptop went down, or a backend that was down missed the stop),
//       failed_to_start a `failed` / `busy` start (closed at once, with the error);
//   - tunnel_session_players: accounts whose authority socket came in on the tunnel's Host;
//   - tunnel_session_events: dropped / reconnected, plus 5xx and refused upgrades on that Host.
// Helper events are replayed from 0 on a backend start (and resent from 0 after a helper
// restart); each is applied exactly once, keyed on (provider, helper event id, event time) in
// tunnel_helper_events_seen. An event only ever closes or lands on a session that had started
// by the event's time, and no session ends before it started.
// It never starts, stops or restarts a tunnel.
const tunnelHelper = require('./tunnelHelperClient.js');
const tunnelTraffic = require('./tunnelTraffic.js');

const PROVIDERS = ['cloudflare', 'ngrok'];
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PURGE_EVERY_MS = 60 * 60 * 1000;
// A status read can see a tunnel gone before its `stopped` event lands; a went_down that close
// to a stop is relabelled as the stop.
const STOP_RELABEL_MS = 60 * 1000;
const NOTE_KINDS = new Set(['dropped', 'reconnected']);
const KNOWN_KINDS = new Set(['started', 'stopped', 'failed', 'busy', ...NOTE_KINDS]);
const LOCK_KEY = 'tunnel_recorder';

// The in-memory cursor: helper event id read up to, and when the last purge ran.
const sharedCursor = { since: 0, lastPurgeAt: null };

function hostOf(url) {
  try { return new URL(url).host.toLowerCase().replace(/:\d+$/, ''); } catch { return ''; }
}

function toDate(v, fallback) {
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : fallback;
}

const short = (v) => (v == null ? null : String(v).slice(0, 500));

async function syncOnce(pool, { helper = tunnelHelper.helper, traffic = tunnelTraffic.shared, now = Date.now, cursor = sharedCursor } = {}) {
  // Status first, then events: a stop or start that lands between the two reads shows up as an
  // event, and the status reconcile below knows not to undo what the events just did.
  let status;
  let batch;
  try {
    status = await helper.status();
    batch = await helper.events(cursor.since);
  } catch {
    return; // helper not running or docker down: nothing is known, nothing is written
  }
  if (!status || typeof status !== 'object' || !batch || !Array.isArray(batch.events)) return;

  const at = toDate(now(), new Date());
  const cutoff = new Date(at.getTime() - RETENTION_MS);
  const purge = cursor.lastPurgeAt == null || at.getTime() - cursor.lastPurgeAt >= PURGE_EVERY_MS;
  const client = await pool.connect(); // a refused connect throws before any note is taken
  // Taken only once connected, put back if the write fails.
  const errors = traffic.takeErrors();
  const seen = traffic.takeSeen ? traffic.takeSeen() : {};
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [LOCK_KEY]);

    // The provider's open session that had started by `when` (default: any open one).
    const openOf = async (provider, when = null) => (await client.query(
      `SELECT id, url, mode, started_at FROM tunnel_sessions
        WHERE provider = $1 AND ended_at IS NULL AND ($2::timestamptz IS NULL OR started_at <= $2)
        ORDER BY started_at DESC, id DESC LIMIT 1`,
      [provider, when])).rows[0] || null;
    const close = (id, when, reason, error = null) => client.query(
      `UPDATE tunnel_sessions SET ended_at = GREATEST(started_at, $2::timestamptz), end_reason = $3, error = COALESCE($4, error)
        WHERE id = $1`,
      [id, when, reason, error]);
    const exists = async (sql, params) => (await client.query(sql, params)).rowCount > 0;

    const openedNow = new Set();
    const closedNow = new Set();

    const events = [...batch.events].sort((a, b) => Number(a.id) - Number(b.id));
    for (const e of events) {
      // Only events this recorder understands are marked seen, so a kind added to the helper
      // later is still applied once a newer backend knows it.
      if (!e || !PROVIDERS.includes(e.provider) || !KNOWN_KINDS.has(e.kind) || !Number.isSafeInteger(Number(e.id))) continue;
      const when = toDate(e.at, null);
      if (!when) continue; // no time of its own: nothing to key it on
      const p = e.provider;
      // Applied exactly once per (provider, helper id, the event's own time): a restarted helper
      // whose clock stepped back can reuse an id, never with the same time.
      const fresh = await client.query(
        `INSERT INTO tunnel_helper_events_seen (provider, helper_event_id, at, seen_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [p, Number(e.id), when, at]);
      if (!fresh.rowCount) continue;
      if (when < cutoff) continue; // older than history keeps
      const st = status[p] || {};
      if (e.kind === 'started') {
        const open = await openOf(p);
        if (open && open.started_at > when) continue; // a newer run is already recorded
        if (open && open.url === e.detail && open.started_at.getTime() === when.getTime()) continue;
        if (open) await close(open.id, when, 'went_down'); // a stop nobody saw
        await client.query(
          'INSERT INTO tunnel_sessions (provider, mode, url, started_at) VALUES ($1, $2, $3, $4)',
          [p, st.url && st.url === e.detail ? st.mode || null : null, short(e.detail), when]);
        openedNow.add(p);
      } else if (e.kind === 'stopped') {
        const open = await openOf(p, when);
        if (open) {
          await close(open.id, when, 'switched_off');
          closedNow.add(p);
        } else {
          // A status read saw the tunnel gone before this stop landed: it was the stop.
          await client.query(
            `UPDATE tunnel_sessions SET end_reason = 'switched_off', ended_at = GREATEST(started_at, $2::timestamptz)
              WHERE id = (SELECT id FROM tunnel_sessions
                           WHERE provider = $1 AND end_reason = 'went_down' AND started_at <= $2
                             AND ended_at BETWEEN $2::timestamptz - $3 * interval '1 millisecond'
                                              AND $2::timestamptz + $3 * interval '1 millisecond'
                           ORDER BY ended_at DESC LIMIT 1)`,
            [p, when, STOP_RELABEL_MS]);
        }
      } else if (e.kind === 'failed' || e.kind === 'busy') {
        const open = e.kind === 'failed' ? await openOf(p, when) : null;
        if (open) {
          await close(open.id, when, 'crashed', short(e.detail));
          closedNow.add(p);
        } else {
          await client.query(
            `INSERT INTO tunnel_sessions (provider, mode, url, started_at, ended_at, end_reason, error)
             VALUES ($1, $2, NULL, $3, $3, 'failed_to_start', $4)`,
            [p, st.state === 'failed' || st.state === 'busy' ? st.mode || null : null, when, short(e.detail)]);
        }
      } else if (NOTE_KINDS.has(e.kind)) {
        const open = await openOf(p, when);
        await client.query(
          'INSERT INTO tunnel_session_events (session_id, provider, at, kind, detail) VALUES ($1, $2, $3, $4, $5)',
          [open ? open.id : null, p, when, e.kind, short(e.detail)]);
      }
    }

    // Bring open sessions in line with what the helper says is running now.
    const hosts = new Map(); // tunnel host -> { provider, sessionId }
    for (const p of PROVIDERS) {
      const st = status[p] || {};
      let open = await openOf(p);
      if (st.state === 'on') {
        if (open && st.url && open.url && open.url !== st.url) { // a different run (new address)
          await close(open.id, at, 'went_down');
          open = null;
        }
        if (open && st.url && (!open.url || !open.mode)) {
          await client.query('UPDATE tunnel_sessions SET url = COALESCE(url, $2), mode = COALESCE(mode, $3) WHERE id = $1', [open.id, st.url, st.mode || null]);
        }
        if (!open && !closedNow.has(p)) {
          // Running but not recorded: adopted after a helper restart lost the started event.
          const startedAt = toDate(st.startedAt, at);
          if (!(await exists('SELECT 1 FROM tunnel_sessions WHERE provider = $1 AND started_at = $2', [p, startedAt]))) {
            const r = await client.query(
              'INSERT INTO tunnel_sessions (provider, mode, url, started_at) VALUES ($1, $2, $3, $4) RETURNING id, url, mode',
              [p, st.mode || null, short(st.url), startedAt]);
            open = r.rows[0];
          }
        }
        const host = hostOf(st.url);
        if (open && host) hosts.set(host, { provider: p, sessionId: open.id });
      } else if (open && !openedNow.has(p)) {
        await close(open.id, at, 'went_down');
      }
    }

    // Players seen through each live tunnel host: everyone connected now or since the last tick.
    for (const [host, { sessionId }] of hosts) {
      const live = traffic.usersFor(host);
      const since = seen[host] || { users: [], peak: 0 };
      const ids = [...new Set([...live, ...since.users].map(Number).filter((n) => Number.isInteger(n) && n > 0))];
      if (!ids.length) continue;
      const peak = Math.max(new Set(live.map(String)).size, Number(since.peak) || 0);
      await client.query(
        `INSERT INTO tunnel_session_players (session_id, user_id, first_seen)
         SELECT $1, u.id, $3 FROM users u WHERE u.id = ANY($2::int[])
         ON CONFLICT (session_id, user_id) DO NOTHING`,
        [sessionId, ids, at]);
      await client.query('UPDATE tunnel_sessions SET peak_players = GREATEST(peak_players, $2) WHERE id = $1', [sessionId, peak]);
    }

    // Errors friends hit: only those that arrived on a live tunnel's host.
    for (const err of errors) {
      const hit = err && hosts.get(String(err.host || '').toLowerCase());
      if (!hit) continue;
      await client.query(
        'INSERT INTO tunnel_session_events (session_id, provider, at, kind, detail) VALUES ($1, $2, $3, $4, $5)',
        [hit.sessionId, hit.provider, toDate(err.at, at), String(err.kind).slice(0, 40), short(err.detail)]);
    }

    // 30-day retention, at most hourly. An open session stays however old it is.
    if (purge) {
      await client.query('DELETE FROM tunnel_sessions WHERE ended_at IS NOT NULL AND ended_at < $1', [cutoff]);
      await client.query('DELETE FROM tunnel_session_events WHERE session_id IS NULL AND at < $1', [cutoff]);
      await client.query('DELETE FROM tunnel_helper_events_seen WHERE seen_at < $1', [cutoff]);
    }

    await client.query('COMMIT');
    if (Number.isFinite(Number(batch.next))) cursor.since = Number(batch.next);
    if (purge) cursor.lastPurgeAt = at.getTime();
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    if (traffic.restore) traffic.restore({ errors, seen });
    throw e;
  } finally {
    client.release();
  }
}

// Polls every intervalMs (first tick at once); ticks never overlap. Returns stop(), which
// resolves once a tick in flight has finished (the shutdown drain awaits it before the pool ends).
function startTunnelRecorder(pool, { intervalMs = 10000, cursor = { since: 0, lastPurgeAt: null }, ...opts } = {}) {
  let current = null;
  let stopped = false;
  let lastError = null;
  const tick = () => {
    if (current || stopped) return current;
    current = (async () => {
      try {
        await syncOnce(pool, { ...opts, cursor });
        lastError = null;
      } catch (e) {
        // Log a failure once, not every 10 s.
        if (e.message !== lastError) console.error('tunnel recorder:', e.message);
        lastError = e.message;
      } finally {
        current = null;
      }
    })();
    return current;
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    if (current) await current;
  };
}

module.exports = { syncOnce, startTunnelRecorder, RETENTION_MS };
