'use strict';
// The tunnel helper's core: starts, stops and watches this dev stack's Cloudflare quick
// tunnel and ngrok agent through injected runners, so it is testable without docker.
//
//   compose(args) -> { code, stdout, stderr }  runs `docker compose --project-directory <root>
//                    --env-file .env -f compose/develop/docker-compose.yml ...args`
//   logs(service) -> text                     that service's log (defaults to compose logs)
//
// Only ever names the four tunnel services and `web`, always with the service's profile.
// Nothing here restarts a tunnel by itself: state comes from `compose ps`, and a container
// that went away just turns the card off.
const http = require('node:http');
const { BadRequest } = require('../helper-core/helperServer');

const SERVICES = {
  cloudflare: { live: { service: 'cloudflared', profile: 'tunnel-cf' }, built: { service: 'cloudflared-prod', profile: 'tunnel-cf-prod' } },
  ngrok: { live: { service: 'ngrok', profile: 'tunnel' }, built: { service: 'ngrok-prod', profile: 'tunnel-prod' } },
};
const PROVIDERS = Object.keys(SERVICES);
const MODES = ['built', 'live'];
const ALL = PROVIDERS.flatMap((p) => MODES.map((m) => ({ provider: p, mode: m, ...SERVICES[p][m] })));
const BY_SERVICE = new Map(ALL.map((s) => [s.service, s]));

const BUSY_TEXT = 'ngrok is busy with another project';
const VITE_DOWN_TEXT = 'vite is not running — make dev first';
// A cold `up --build web` (npm ci + vite build) can take minutes; every other compose call
// keeps the runner's default limit.
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
// vite's dev server as the host sees it (compose maps 15173:5173). A live tunnel points at it.
const VITE_URL = 'http://127.0.0.1:15173/';
const MAX_EVENTS = 500;
// The tunnel's own address. cloudflared's failure line names its API host
// (`failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel"`), which is not one.
const CF_URL = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/g;
// The free plan's one-agent limit (108) and "endpoint already online" (334): another session holds it.
const NGROK_BUSY = /ERR_NGROK_(108|334)\b/;
const NGROK_ERROR = /ERR_NGROK_\d+/;
// ngrok v3 logs only with --log=stdout (set in compose); then: msg="started tunnel" obj=tunnels ... url=...
const NGROK_STARTED = /msg="?started tunnel/;
// A container that exits with one of these was stopped (make down, laptop shutdown), not crashed.
// 137 (SIGKILL: docker kill, stop timeout, OOM kill) counts as clean on purpose: it reads as
// "went down", not as a tunnel crash.
const CLEAN_EXIT = new Set([0, 130, 137, 143]);
// How each agent says it lost and regained the edge. cloudflared keeps several connections
// and logs per connection, so a burst of lines is one outage: the first drop line opens it,
// the first registration after it closes it. Start-up registrations are not reconnects.
const LINK = {
  cloudflare: {
    drop: /Connection terminated|Serve tunnel error|failed to serve tunnel connection|Retrying connection|Unregistered tunnel connection|Lost connection/i,
    back: /Registered tunnel connection/i,
  },
  ngrok: {
    // msg="session closed, starting reconnect loop", msg="failed to reconnect session" err=...
    drop: /session closing|session closed|failed to reconnect session|heartbeat timeout/i,
    back: /client session established/i,
  },
};

// Hides the given secret values, and any authtoken=... shape, from text that leaves the helper.
function redact(text, secrets) {
  let out = String(text == null ? '' : text);
  for (const s of secrets || []) if (s) out = out.split(s).join('***');
  return out.replace(/(authtoken["'=:\s]+)[A-Za-z0-9_-]{8,}/gi, '$1***');
}

// `compose ps --format json` prints one object per line (v2.21+) or one array (older).
function parsePs(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return [];
  if (text.startsWith('[')) return JSON.parse(text);
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// The container's creation time. Every start force-recreates, so this is when it started.
function createdIso(row) {
  if (typeof row.Created === 'number' && row.Created > 0) return new Date(row.Created * 1000).toISOString();
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})/.exec(String(row.CreatedAt || ''));
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const lastMatch = (text, re) => { const all = String(text).match(re); return all ? all[all.length - 1] : null; };
const lines = (text) => String(text || '').split('\n').filter((l) => l.trim());
const tail = (text, n = 3, max = 300) => lines(text).slice(-n).join(' | ').slice(-max);

// Does vite answer at all? Any HTTP answer below 500 counts; refused, hung or 5xx does not.
function viteProbe(url = VITE_URL, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => { res.resume(); resolve(res.statusCode < 500); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(false));
  });
}

function createTunnels({
  compose, logs, now = Date.now, ngrokDomain, waitMs = 40000, pollMs = 1000,
  secrets = [], sleep = (ms) => new Promise((r) => setTimeout(r, ms)), viteUp = () => viteProbe(),
} = {}) {
  if (typeof compose !== 'function') throw new TypeError('createTunnels needs a compose runner');
  const secretList = () => (typeof secrets === 'function' ? secrets() : secrets);
  const hide = (text) => redact(text, secretList());
  const readLogs = logs || (async (service) => {
    const { profile } = BY_SERVICE.get(service);
    const r = await compose(['--profile', profile, 'logs', '--no-log-prefix', service]);
    return `${r.stdout || ''}${r.stderr || ''}`;
  });
  const ngrokUrl = ngrokDomain ? `https://${ngrokDomain}` : null;

  // Per card: the public state plus the log cursor used to spot drops.
  const cards = Object.fromEntries(PROVIDERS.map((p) => [p, blank(p)]));
  function blank(provider) {
    return { provider, state: 'off', mode: null, url: null, startedAt: null, error: null, cursor: 0, dropped: false };
  }
  // A start or stop in flight owns its card: a status read meanwhile must not blank or adopt it
  // (a stop's `rm -sf` removes the container before compose returns, which would otherwise read
  // as "went away" with no event).
  const inFlight = Object.fromEntries(PROVIDERS.map((p) => [p, 0]));
  async function owning(provider, fn) {
    inFlight[provider] += 1;
    try { return await fn(); } finally { inFlight[provider] -= 1; }
  }
  const view = (c) => ({ provider: c.provider, state: c.state, mode: c.mode, url: c.url, startedAt: c.startedAt, error: c.error });

  // Ids start at the creation clock so a restarted helper never reuses an id a reader has seen.
  const ring = [];
  let lastId = Math.floor(now());
  // phase 'start': the event ends a start attempt (it never was on), as opposed to a running
  // tunnel that crashed, so the recorder does not close an older session as crashed.
  function emit(provider, kind, detail = null, phase = null) {
    lastId += 1;
    const e = { id: lastId, at: new Date(now()).toISOString(), provider, kind, detail: detail == null ? null : hide(detail) };
    if (phase) e.phase = phase;
    ring.push(e);
    if (ring.length > MAX_EVENTS) ring.splice(0, ring.length - MAX_EVENTS);
  }

  function check(provider, mode) {
    if (typeof provider !== 'string' || !Object.prototype.hasOwnProperty.call(SERVICES, provider)) {
      throw new BadRequest(`Unknown tunnel provider: ${String(provider).slice(0, 40)}.`);
    }
    if (mode !== undefined && !MODES.includes(mode)) throw new BadRequest(`Unknown tunnel mode: ${String(mode).slice(0, 40)}.`);
  }

  async function run(args, opts) {
    const r = await (opts ? compose(args, opts) : compose(args));
    if (r.code !== 0) throw new Error(hide(tail(`${r.stderr || ''}\n${r.stdout || ''}`) || `docker compose exited ${r.code}`));
    return r;
  }

  async function containers() {
    const args = [...ALL.flatMap((s) => ['--profile', s.profile]), 'ps', '-a', '--format', 'json', ...ALL.map((s) => s.service)];
    return parsePs((await run(args)).stdout).filter((r) => BY_SERVICE.has(r.Service));
  }

  // Is the built frontend (`web`) up? It serves both built tunnels.
  async function webRunning() {
    const r = await run(['--profile', 'tunnel-cf-prod', '--profile', 'tunnel-prod', 'ps', '-a', '--format', 'json', 'web']);
    return parsePs(r.stdout).some((row) => row.Service === 'web' && row.State === 'running');
  }

  const remove = (service) => run(['--profile', BY_SERVICE.get(service).profile, 'rm', '-sf', service]);

  // Feeds log lines after the cursor through the drop/reconnect detector.
  function scan(card, text, { silent = false } = {}) {
    const all = lines(text);
    if (all.length < card.cursor) card.cursor = all.length; // log rotated or truncated
    const link = LINK[card.provider];
    for (const line of all.slice(card.cursor)) {
      if (!card.dropped && link.drop.test(line)) {
        card.dropped = true;
        if (!silent) emit(card.provider, 'dropped', line.slice(0, 200));
      } else if (card.dropped && link.back.test(line)) {
        card.dropped = false;
        if (!silent) emit(card.provider, 'reconnected', null);
      }
    }
    card.cursor = all.length;
  }

  async function adopt(card, row, owner) {
    const { mode, service } = BY_SERVICE.get(row.Service);
    const text = await readLogs(service);
    if (inFlight[card.provider] && card.provider !== owner) return;
    Object.assign(card, {
      state: 'on', mode, error: null, startedAt: createdIso(row), cursor: 0, dropped: false,
      url: card.provider === 'cloudflare' ? lastMatch(text, CF_URL) : ngrokUrl,
    });
    scan(card, text, { silent: true }); // what happened while nobody watched is not replayed
    card.dropped = false; // a later registration must not read as a lone reconnect
  }

  // Brings each card in line with what is actually running. Never starts anything.
  // owner: the provider whose own start is calling this (its card is not skipped).
  async function refresh(owner = null) {
    const rows = await containers();
    for (const provider of PROVIDERS) {
      const card = cards[provider];
      if (card.state === 'starting') continue;
      if (inFlight[provider] && provider !== owner) continue;
      const mine = rows.filter((r) => BY_SERVICE.get(r.Service).provider === provider);
      const running = mine.find((r) => r.State === 'running');
      if (card.state === 'on') {
        const service = SERVICES[provider][card.mode].service;
        const row = mine.find((r) => r.Service === service);
        if (row && row.State === 'running') {
          const text = await readLogs(service);
          if (!card.url && provider === 'cloudflare') card.url = lastMatch(text, CF_URL);
          scan(card, text);
          continue;
        }
        // Gone or exited: off. Only a crash is an event; a removal or clean stop is "went down".
        if (row && !CLEAN_EXIT.has(Number(row.ExitCode))) emit(provider, 'failed', `${service} exited with code ${row.ExitCode}`);
        cards[provider] = blank(provider);
        if (running) await adopt(cards[provider], running, owner);
        continue;
      }
      if (running) await adopt(card, running, owner);
    }
  }

  async function status() {
    await refresh();
    return { cloudflare: view(cards.cloudflare), ngrok: view(cards.ngrok) };
  }

  // What the logs say so far: { url } when it is up, { busy } or { error } when it refused.
  async function probe(provider, service) {
    const text = await readLogs(service);
    if (provider === 'cloudflare') {
      const url = lastMatch(text, CF_URL);
      return url ? { url, text } : { text };
    }
    if (NGROK_BUSY.test(text)) return { busy: true, text };
    const code = lastMatch(text, NGROK_ERROR);
    if (code) return { error: `ngrok refused to start (${code}): ${tail(text)}`, text };
    // Only its own "started tunnel" line counts: a silent or stuck agent is not on.
    if (NGROK_STARTED.test(text)) return { url: ngrokUrl, text };
    return { text };
  }

  async function fail(card, service, kind, error) {
    // Stopped while starting: the stop already removed the container and reset the card.
    if (cards[card.provider] !== card) return view(cards[card.provider]);
    try { await remove(service); } catch { /* reported below; the start already failed */ }
    Object.assign(card, { state: kind === 'busy' ? 'busy' : 'failed', url: null, startedAt: null, error: hide(error) });
    emit(card.provider, kind, card.error, 'start');
    return view(card);
  }

  // onStarting(view): called once the card is `starting` (the slow part begins), so a caller
  // can answer early and let the rest run. Not called when the start ends before that.
  async function start(provider, mode, { onStarting } = {}) {
    check(provider, mode);
    if (mode === undefined) throw new BadRequest('Tunnel mode is required.');
    return owning(provider, () => startOwned(provider, mode, onStarting));
  }

  async function startOwned(provider, mode, onStarting) {
    if (cards[provider].state === 'on' || cards[provider].state === 'starting') return view(cards[provider]);
    await refresh(provider); // adopt one already running (e.g. after a helper restart) instead of recreating it
    const card = cards[provider];
    if (card.state === 'on') return view(card);
    if (provider === 'ngrok' && !ngrokUrl) throw new BadRequest('NGROK_DOMAIN is not set in .env.');

    const { service, profile } = SERVICES[provider][mode];
    Object.assign(card, { state: 'starting', mode, url: null, startedAt: null, error: null, cursor: 0, dropped: false });
    if (onStarting) { try { onStarting(view(card)); } catch { /* the caller's problem, not the start's */ } }
    try {
      // A live tunnel only forwards to vite: no point opening a public address to nothing.
      if (mode === 'live' && !(await viteUp())) return fail(card, service, 'failed', VITE_DOWN_TEXT);
      // ngrok's two modes share the one reserved domain: one card, one container.
      if (provider === 'ngrok') {
        const other = SERVICES.ngrok[mode === 'built' ? 'live' : 'built'].service;
        await remove(other);
      }
      // Rebuilding recreates `web`, which would cut the other provider's built tunnel off
      // mid-game: while that one is on, serve the bundle `web` already has. The next built
      // start with no built tunnel on rebuilds.
      const otherCard = cards[PROVIDERS.find((p) => p !== provider)];
      const shareWeb = mode === 'built' && otherCard.state === 'on' && otherCard.mode === 'built' && await webRunning();
      if (mode === 'built' && !shareWeb) {
        try { await run(['--profile', profile, 'up', '-d', '--build', '--no-deps', 'web'], { timeoutMs: BUILD_TIMEOUT_MS }); } catch (e) {
          return fail(card, service, 'failed', `Building web failed: ${e.message}`);
        }
      }
      await run(['--profile', profile, 'up', '-d', '--no-deps', '--force-recreate', service]);
      const t0 = now();
      for (;;) {
        if (cards[provider] !== card) return view(cards[provider]); // stopped while starting
        const got = await probe(provider, service);
        if (cards[provider] !== card) return view(cards[provider]);
        if (got.busy) return fail(card, service, 'busy', BUSY_TEXT);
        if (got.error) return fail(card, service, 'failed', got.error);
        if (got.url) {
          Object.assign(card, { state: 'on', url: got.url, startedAt: new Date(now()).toISOString() });
          scan(card, got.text, { silent: true });
          card.dropped = false; // start-up retries before the address are not an outage
          emit(provider, 'started', got.url);
          return view(card);
        }
        if (now() - t0 >= waitMs) {
          const what = provider === 'cloudflare' ? 'Cloudflare gave no address' : 'ngrok did not come online';
          return fail(card, service, 'failed', `${what} within ${Math.round(waitMs / 1000)} s.`);
        }
        await sleep(pollMs);
      }
    } catch (e) {
      return fail(card, service, 'failed', e.message);
    }
  }

  async function stop(provider) {
    check(provider);
    return owning(provider, () => stopOwned(provider));
  }

  async function stopOwned(provider) {
    const card = cards[provider];
    const wasOn = card.state === 'on';
    // The card's own container; when it does not know one, whatever of this card's services exist.
    const services = card.mode && card.state !== 'off'
      ? [SERVICES[provider][card.mode].service]
      : (await containers()).filter((r) => BY_SERVICE.get(r.Service).provider === provider).map((r) => r.Service);
    for (const s of services) await remove(s);
    cards[provider] = blank(provider);
    if (wasOn) emit(provider, 'stopped', null);
    return view(cards[provider]);
  }

  function events(since = 0) {
    const from = Number(since) || 0;
    const out = ring.filter((e) => e.id > from);
    // The newest id this helper has handed out, never the reader's own cursor echoed back: after a
    // restart with a clock that stepped back it is below a stale cursor, and the server resends.
    return { events: out, next: ring.length ? ring[ring.length - 1].id : lastId };
  }

  return { status, start, stop, events };
}

module.exports = { createTunnels, SERVICES, BUSY_TEXT, VITE_DOWN_TEXT, BUILD_TIMEOUT_MS, VITE_URL, viteProbe, redact };
