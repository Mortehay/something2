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
// Helper events are replayed from 0 on a backend start (and when the helper restarted), so
// every write is idempotent on what the event carries (provider + kind + its own timestamp).
// It never starts, stops or restarts a tunnel.
const tunnelHelper = require('./tunnelHelperClient.js');
const tunnelTraffic = require('./tunnelTraffic.js');

const PROVIDERS = ['cloudflare', 'ngrok'];
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const NOTE_KINDS = new Set(['dropped', 'reconnected']);
const LOCK_KEY = 'tunnel_recorder';

const sharedCursor = { since: 0 };

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
  const errors = traffic.takeErrors();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [LOCK_KEY]);

    const openOf = async (provider) => (await client.query(
      'SELECT id, url, mode FROM tunnel_sessions WHERE provider = $1 AND ended_at IS NULL ORDER BY id DESC LIMIT 1',
      [provider])).rows[0] || null;
    const close = (id, when, reason, error = null) => client.query(
      'UPDATE tunnel_sessions SET ended_at = $2, end_reason = $3, error = COALESCE($4, error) WHERE id = $1',
      [id, when, reason, error]);
    const exists = async (sql, params) => (await client.query(sql, params)).rowCount > 0;

    const openedNow = new Set();
    const closedNow = new Set();

    const events = [...batch.events].sort((a, b) => Number(a.id) - Number(b.id));
    for (const e of events) {
      if (!e || !PROVIDERS.includes(e.provider)) continue;
      const p = e.provider;
      const when = toDate(e.at, at);
      const st = status[p] || {};
      if (e.kind === 'started') {
        const open = await openOf(p);
        if (open && open.url === e.detail) continue; // the tunnel this event started
        if (await exists('SELECT 1 FROM tunnel_sessions WHERE provider = $1 AND started_at = $2', [p, when])) continue;
        if (open) await close(open.id, when, 'went_down'); // a stop nobody saw
        await client.query(
          'INSERT INTO tunnel_sessions (provider, mode, url, started_at) VALUES ($1, $2, $3, $4)',
          [p, st.url && st.url === e.detail ? st.mode || null : null, short(e.detail), when]);
        openedNow.add(p);
      } else if (e.kind === 'stopped' || e.kind === 'failed' || e.kind === 'busy') {
        if (await exists('SELECT 1 FROM tunnel_sessions WHERE provider = $1 AND ended_at = $2', [p, when])) continue;
        const open = await openOf(p);
        if (e.kind === 'stopped') {
          if (open) { await close(open.id, when, 'switched_off'); closedNow.add(p); }
        } else if (open && e.kind === 'failed') {
          await close(open.id, when, 'crashed', short(e.detail));
          closedNow.add(p);
        } else {
          await client.query(
            `INSERT INTO tunnel_sessions (provider, mode, url, started_at, ended_at, end_reason, error)
             VALUES ($1, $2, NULL, $3, $3, 'failed_to_start', $4)`,
            [p, st.state === 'failed' || st.state === 'busy' ? st.mode || null : null, when, short(e.detail)]);
        }
      } else if (NOTE_KINDS.has(e.kind)) {
        if (await exists('SELECT 1 FROM tunnel_session_events WHERE provider = $1 AND kind = $2 AND at = $3', [p, e.kind, when])) continue;
        const open = await openOf(p);
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

    // Players seen through each live tunnel host.
    for (const [host, { sessionId }] of hosts) {
      const ids = [...new Set(traffic.usersFor(host).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
      if (!ids.length) continue;
      await client.query(
        `INSERT INTO tunnel_session_players (session_id, user_id, first_seen)
         SELECT $1, u.id, $3 FROM users u WHERE u.id = ANY($2::int[])
         ON CONFLICT (session_id, user_id) DO NOTHING`,
        [sessionId, ids, at]);
      await client.query('UPDATE tunnel_sessions SET peak_players = GREATEST(peak_players, $2) WHERE id = $1', [sessionId, ids.length]);
    }

    // Errors friends hit: only those that arrived on a live tunnel's host.
    for (const err of errors) {
      const hit = err && hosts.get(String(err.host || '').toLowerCase());
      if (!hit) continue;
      await client.query(
        'INSERT INTO tunnel_session_events (session_id, provider, at, kind, detail) VALUES ($1, $2, $3, $4, $5)',
        [hit.sessionId, hit.provider, toDate(err.at, at), String(err.kind).slice(0, 40), short(err.detail)]);
    }

    // 30-day retention. An open session stays however old it is.
    const cutoff = new Date(at.getTime() - RETENTION_MS);
    await client.query('DELETE FROM tunnel_sessions WHERE ended_at IS NOT NULL AND ended_at < $1', [cutoff]);
    await client.query('DELETE FROM tunnel_session_events WHERE session_id IS NULL AND at < $1', [cutoff]);

    await client.query('COMMIT');
    if (Number.isFinite(Number(batch.next))) cursor.since = Number(batch.next);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw e;
  } finally {
    client.release();
  }
}

// Polls every intervalMs (first tick at once); ticks never overlap. Returns stop().
function startTunnelRecorder(pool, { intervalMs = 10000, ...opts } = {}) {
  let running = false;
  let stopped = false;
  let lastError = null;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await syncOnce(pool, opts);
      lastError = null;
    } catch (e) {
      // Log a failure once, not every 10 s.
      if (e.message !== lastError) console.error('tunnel recorder:', e.message);
      lastError = e.message;
    } finally {
      running = false;
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}

module.exports = { syncOnce, startTunnelRecorder, RETENTION_MS };
