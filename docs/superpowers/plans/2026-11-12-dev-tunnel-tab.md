# Dev Tunnel Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin "Tunnels" tab in `/game` that turns the laptop's Cloudflare quick tunnel and ngrok tunnel on/off independently, shows address/uptime/players, and keeps a 30-day history with problems.

**Architecture:** A host-side `tools/tunnel-helper` (helper-core pattern, unix socket + token in `backend/run/`) drives the existing compose tunnel services. The backend proxies admin requests to it, attributes authority WebSocket players to a tunnel by `Host`, and a recorder writes sessions/players/events to the dev DB. The frontend always talks same-origin, so tunnels never recreate the frontend.

**Tech Stack:** Node (CommonJS) helper + Express backend, raw pg + node-pg-migrate, node:test; React 19 + styled-components + TanStack Query, vitest (node env, pure models); docker compose profiles.

**Spec:** `docs/superpowers/specs/2026-11-12-dev-tunnel-tab-design.md`

## Global Constraints

- Developer PC only; never touch the Orange Pi tunnel switch (SOMET-738) or `tools/pi-helper` behaviour.
- A tunnel starts only on an explicit admin click. Nothing restarts it: not `make up`, `make dev`, a reboot, a helper or backend restart. Tunnel services have no `restart:` policy.
- Stays on until switched off, the laptop shuts down, or the containers go down.
- Both tunnels can run at once; switching one never recreates the frontend and never interrupts the other tunnel or local dev (`http://localhost:15173`, backend `:13101`).
- Default served version per card is `built`; `live` is the per-card option.
- ngrok "busy" = the agent refused because another session is online (e.g. ERR_NGROK_108); detected only from this stack's own ngrok container. Never inspect, stop or touch another project's containers (`auto-orbit-ngrok-1`).
- `Host` is preserved on every proxy hop this feature uses (vite `/api` and `/authority`, built `web` Caddy).
- History retention: 30 days.
- Admin only on every route and the tab; the tab 404s/hides when `TUNNEL_TAB_ENABLED` is not `true` (set in `compose/develop/docker-compose.yml` only).
- `NGROK_AUTHTOKEN` and other `.env` values never reach responses, logs or history.
- Copy (exact): tab label `Tunnels`; sub-tabs `Tunnels`, `History`; busy text `ngrok is busy with another project`; uptime `On for {h} h {m} min` (`On for {m} min` under an hour); option label `Live version`; button `Copy link`.
- Migration timestamp `1714440887000` (the email-accounts branch owns `1714440886000`).
- Verification never starts a real public tunnel without the owner's OK, and never uses the shared dev stack/DB; use a private stack and a fake runner.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Helper or backend restart while a tunnel is on → the tunnel keeps running and is shown On (re-adopted from `docker compose ps`), not restarted and not closed. (Task 2 test `adopts a running container after restart`.)
2. Laptop/containers went down while a session was open → on next start the session is closed as `went_down`, never restarted. (Task 4 test `closes an open session whose container is gone`.)
3. Cloudflare gives no address within 40 s → state `failed`, event recorded, container removed. (Task 2 test `no address within the wait`.)
4. Turning one tunnel off while the other is on → the other's container is untouched (no compose call names it). (Task 2 test `stop touches only its own services`.)
5. A player connected through localhost (or the other tunnel) is never counted for a tunnel. (Task 3 test `counts only matching hosts`.)

---

### Task 1: Same-origin tunnels in compose, vite and make

**Files:**
- Modify: `frontend/vite.config.js` (proxy `/api` and `/authority` without `changeOrigin`; `allowedHosts`; HMR for remote hosts), `compose/develop/docker-compose.yml` (new `ngrok-prod` service; `NGROK_DOMAIN` passed to `frontend`; `TUNNEL_TAB_ENABLED=true` and nothing else on backend), `Makefile` (`tunnel`, `tunnel-stop`, `tunnel-cf`, `tunnel-cf-stop`, `tunnel-cf-prod`, `tunnel-cf-prod-stop` stop recreating the frontend or setting `VITE_API_URL`/`TUNNEL_HOST`)
- Test: `frontend/src/__tests__/viteTunnelConfig.test.js`

**Interfaces:**
- Produces compose services: `cloudflared` (→ `frontend:5173`, profile `tunnel-cf`), `cloudflared-prod` (→ `web:80`, profile `tunnel-cf-prod`), `ngrok` (→ `frontend:5173`, profile `tunnel`), `ngrok-prod` (→ `web:80`, profile `tunnel-prod`, `--url=https://${NGROK_DOMAIN}`, no published inspector port clash: `127.0.0.1:14041:4040`).

- [ ] **Step 1: Failing test** — import the vite config factory with `process.env.NGROK_DOMAIN='x.ngrok-free.app'`; assert `server.proxy['/api'].changeOrigin` and `server.proxy['/authority'].changeOrigin` are not `true`, `server.allowedHosts` contains `'.trycloudflare.com'` and `'x.ngrok-free.app'`, and no tunnel host appears in `hmr` (a remote page must not retry a dead HMR socket: HMR is limited to localhost, e.g. `hmr: { host: 'localhost' }` or equivalent the builder verifies).
- [ ] **Step 2:** `cd frontend && npx vitest run src/__tests__/viteTunnelConfig.test.js` → FAIL.
- [ ] **Step 3:** Implement. Keep the existing comments' intent; remove the `TUNNEL_HOST`/`VITE_API_URL` tunnel-mode plumbing (the client is same-origin via `frontend/src/config.js`).
- [ ] **Step 4:** Test PASS; `docker compose --project-directory . --env-file .env.example -f compose/develop/docker-compose.yml --profile tunnel --profile tunnel-prod --profile tunnel-cf --profile tunnel-cf-prod config -q` exits 0; `make -n tunnel tunnel-cf tunnel-cf-prod` shows no `--force-recreate frontend`.
- [ ] **Step 5:** Commit `feat(dev): tunnels are same-origin and never recreate the frontend`.

### Task 2: Tunnel helper core

**Files:**
- Create: `tools/tunnel-helper/tunnels.js`, `tools/tunnel-helper/tunnels.test.js`

**Interfaces:**
- Produces: `createTunnels({ compose, logs, now = Date.now, ngrokDomain, waitMs = 40000, pollMs = 1000 })` where `compose(args: string[]) -> Promise<{ code, stdout, stderr }>` runs `docker compose --project-directory <root> --env-file .env -f compose/develop/docker-compose.yml ...args` and `logs(service) -> Promise<string>`. Returns:
  - `status() -> Promise<{ cloudflare: TunnelState, ngrok: TunnelState }>`
  - `start(provider: 'cloudflare'|'ngrok', mode: 'built'|'live') -> Promise<TunnelState>`
  - `stop(provider) -> Promise<TunnelState>`
  - `events(since: number) -> { events: TunnelEvent[], next: number }`
- `TunnelState = { provider, state: 'off'|'starting'|'on'|'failed'|'busy', mode: 'built'|'live'|null, url: string|null, startedAt: ISO|null, error: string|null }`
- `TunnelEvent = { id: number, at: ISO, provider, kind: 'started'|'stopped'|'failed'|'busy'|'dropped'|'reconnected', detail: string|null }` (in-memory ring of 500).
- Service map: cloudflare live `cloudflared`/built `cloudflared-prod`; ngrok live `ngrok`/built `ngrok-prod`; built start first runs `up -d --build --no-deps web`.

- [ ] **Step 1: Failing tests** with a fake `compose`/`logs` recording every call:
  - `start cloudflare built`: calls `up -d --build --no-deps web` then `--profile tunnel-cf-prod up -d --no-deps --force-recreate cloudflared-prod`; log yields `https://a-b.trycloudflare.com` → state `on`, url set, `startedAt` = now, event `started`.
  - `no address within the wait`: logs never contain an address → state `failed`, error mentions 40 s, `rm -sf cloudflared-prod` called, event `failed`.
  - `ngrok busy`: ngrok log contains `ERR_NGROK_108` → state `busy`, error `ngrok is busy with another project`, its own container removed, event `busy`; no compose call names any service outside the four tunnel services and `web`.
  - `stop touches only its own services`: with both on, `stop('ngrok')` calls only `rm -sf ngrok-prod` (or `ngrok`) → cloudflare state unchanged, event `stopped`.
  - `adopts a running container after restart`: a fresh `createTunnels` whose `compose ps` reports `cloudflared` running and logs have its URL → `status()` returns `on`, mode `live`, url, `startedAt` from the container start time; no `up` call.
  - `dropped and reconnected`: log lines of a lost/re-registered connection between two `status()` calls produce `dropped` then `reconnected` events once each.
  - `start while on` → returns current state, no compose call; unknown provider/mode → throws `BadRequest`.
  - `NGROK_AUTHTOKEN` value present in a log never appears in any state, event or error.
- [ ] **Step 2:** `node --test tools/tunnel-helper/tunnels.test.js` → FAIL.
- [ ] **Step 3:** Implement. Running/started-at from `compose ps --format json`; ngrok URL is `https://<ngrokDomain>`; redact log excerpts.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(dev): tunnel helper core`.

### Task 3: Tunnel helper server and make targets

**Files:**
- Create: `tools/tunnel-helper/server.js`, `tools/tunnel-helper/server.test.js`, `tools/tunnel-helper/README.md`
- Modify: `Makefile` (`tunnel-helper`, `tunnel-helper-stop`, `tunnel-helper-status`, modelled on `git-helper*`; `dev` starts the helper if not running and never starts a tunnel), `.gitignore` if `backend/run/` entries need it

**Interfaces:**
- Consumes: `createTunnels` (Task 2), `createHelperServer`/`serve` from `tools/helper-core/helperServer.js`.
- Produces helper API (socket `backend/run/tunnel-helper.sock`, token `backend/run/tunnel-helper.token`, header `X-Tunnel-Helper-Token`): `GET /status`, `POST /start {provider, mode}`, `POST /stop {provider}`, `GET /events?since=N`. Errors: 400 `bad_request`, 409 `busy_op` (one start/stop at a time).

- [ ] **Step 1: Failing test** — server on a temp dir with an injected fake `createTunnels`: no token ⇒ 401; `POST /start {provider:'ngrok', mode:'built'}` ⇒ 200 TunnelState; second concurrent start ⇒ 409 `busy_op`; `POST /start {provider:'x'}` ⇒ 400; `GET /events?since=0` ⇒ `{events, next}`.
- [ ] **Step 2:** `node --test tools/tunnel-helper/` → FAIL.
- [ ] **Step 3:** Implement; `make -n dev` shows the helper start guarded by its pid file.
- [ ] **Step 4:** PASS; `node --test tools/helper-core/ tools/git-helper/` still green.
- [ ] **Step 5:** Commit `feat(dev): tunnel helper server`.

### Task 4: Backend — schema, traffic attribution, recorder

**Files:**
- Create: `backend/migrations/1714440887000_tunnel_sessions.js`, `backend/src/services/tunnelHelperClient.js`, `backend/src/services/tunnelTraffic.js`, `backend/src/services/tunnelRecorder.js`
- Modify: `backend/src/authority/server.js` (upgrade handler notes `req.headers.host` + user id on accepted sockets, and refused upgrades as errors), `backend/src/index.js` (5xx responses noted via `tunnelTraffic.noteError`; start the recorder when `TUNNEL_TAB_ENABLED === 'true'`), `backend/src/services/seedSync/coverage.js` (exclude the three tables: runtime dev data)
- Test: `backend/tests/tunnel_traffic.test.js`, `backend/tests/tunnel_recorder_db.test.js`

**Interfaces:**
- Tables: `tunnel_sessions(id serial pk, provider text, mode text, url text, started_at timestamptz, ended_at timestamptz null, end_reason text null CHECK in ('switched_off','went_down','crashed','failed_to_start'), peak_players int default 0, error text null)`; `tunnel_session_players(session_id fk cascade, user_id fk users cascade, first_seen timestamptz, pk(session_id,user_id))`; `tunnel_session_events(id serial pk, session_id fk cascade null, provider text, at timestamptz, kind text, detail text null)`; index on `started_at`.
- `tunnelHelperClient`: `createHelperClient({ socketEnv:'TUNNEL_HELPER_SOCKET', urlEnv:'TUNNEL_HELPER_URL', tokenEnv:'TUNNEL_HELPER_TOKEN_FILE', defaultSocket:'/app/run/tunnel-helper.sock', defaultTokenFile:'/app/run/tunnel-helper.token', tokenHeader:'X-Tunnel-Helper-Token', label:'tunnel helper', timeoutMs:60000 })`; `HINT = 'Run make tunnel-helper on this PC'`.
- `tunnelTraffic`: `noteConnection({ host, userId }) -> release()`, `countFor(host) -> number`, `usersFor(host) -> number[]`, `noteError({ host, kind: 'http_5xx'|'ws_refused', detail })`, `takeErrors() -> [{host, kind, detail, at}]`. Host compared case-insensitively without port.
- `tunnelRecorder`: `syncOnce(pool, { helper, traffic, now }) -> Promise<void>`; `startTunnelRecorder(pool, { intervalMs = 10000 }) -> stop()`.

- [ ] **Step 1: Failing tests**
  - `tunnel_traffic`: `counts only matching hosts` (localhost and the other tunnel's host not counted); release decrements; `usersFor` distinct ids; errors drained once.
  - `tunnel_recorder_db` (private DB, fake helper/traffic): helper `on` with no open session ⇒ one session opened; players ⇒ `peak_players` = max seen and player rows; helper `off` after `stopped` event ⇒ `switched_off`; `closes an open session whose container is gone` (helper state off, no `stopped` event) ⇒ `went_down`; helper `failed`/`busy` ⇒ session with `failed_to_start` + error; `dropped`/`reconnected` and traffic errors ⇒ event rows on the open session; rows older than 30 days purged; helper unavailable ⇒ no writes, no throw.
- [ ] **Step 2:** Run with the private-DB command from AGENTS.md → FAIL.
- [ ] **Step 3:** Implement. Event cursor kept in memory; on backend start, helper events since 0 are reconciled idempotently (no duplicate rows).
- [ ] **Step 4:** PASS; `tests/seed_sync_coverage_db.test.js` and `tests/auth_email_gate.test.js` (if present) still green.
- [ ] **Step 5:** Commit `feat(dev): record tunnel sessions, players and problems`.

### Task 5: Backend — admin routes

**Files:**
- Create: `backend/src/api/tunnelRoutes.js`
- Modify: `backend/src/index.js` (mount `/api/admin/tunnels`)
- Test: `backend/tests/tunnel_routes_db.test.js`

**Interfaces:**
- `GET /api/admin/tunnels` ⇒ `{ available: true, registrationMode, tunnels: { cloudflare: TunnelState & { players }, ngrok: TunnelState & { players } } }`; helper down ⇒ 200 `{ available: false, hint }`.
- `POST /api/admin/tunnels/:provider/start {mode}` ⇒ TunnelState; `POST /api/admin/tunnels/:provider/stop` ⇒ TunnelState; helper down ⇒ 503 `{ error:'helper_unavailable', hint }`.
- `GET /api/admin/tunnels/history?days=30` ⇒ `{ sessions: [{ id, provider, mode, url, startedAt, endedAt, endReason, durationSec, peakPlayers, players: [username], error, events: [{ at, kind, detail }] }] }` newest first.
- All behind `requireAdmin`; 404 when `TUNNEL_TAB_ENABLED !== 'true'`.

- [ ] **Step 1: Failing tests** (fake helper client): non-admin 403; disabled ⇒ 404; status merges `players` from traffic; bad provider ⇒ 400; mode defaults to `built`; history shape and order; no `.env` value (seed a fake `NGROK_AUTHTOKEN` env) appears in any response.
- [ ] **Step 2–4:** FAIL → implement → PASS (private DB).
- [ ] **Step 5:** Commit `feat(dev): tunnel admin routes`.

### Task 6: Frontend — Tunnels tab

**Files:**
- Create: `frontend/src/games/something2/TunnelsAdmin.jsx`, `useTunnels.js`, `tunnelsModel.js`, `__tests__/tunnelsModel.test.js`
- Modify: `frontend/src/ui/navSections.js` (`{ id: 'tunnels', label: 'Tunnels', path: '/game/tunnels', Icon: HiOutlineGlobeAlt }` after `board`), `frontend/src/App.jsx` (route inside `RequireAdmin`), nav tests that enumerate entries, `frontend/src/games/something2/src/js/i18n/uk/react.js`

**Interfaces:**
- `tunnelsModel.js`: `formatUptime(startedAt, now) -> string` (exact copy from Global Constraints), `statusLabel(state)` (`off` "Off", `starting` "Starting…", `on` "On", `failed` "Failed", `busy` "ngrok is busy with another project"), `endReasonLabel(reason)` (`switched_off` "You switched it off", `went_down` "Laptop or containers went down", `crashed` "Crashed", `failed_to_start` "Failed to start"), `canToggle(card, pending) -> boolean`.
- Hook: TanStack keys `['tunnels']` (refetch every 5 s while the tab is open) and `['tunnels-history']`; mutations `start(provider, mode)`, `stop(provider)` invalidate both.
- UI: two cards side by side (stack on narrow screens): name, status, address + **Copy link** (clipboard failure falls back to a toast with the address), uptime, players, **Live version** checkbox (only editable while off), on/off button, registration-mode warning when `open`; helper unavailable ⇒ the hint text; History sub-tab table per spec columns with events listed under each row. `--s2-*` tokens only.

- [ ] **Step 1: Failing tests** for `formatUptime` (59 s ⇒ `On for 0 min`, 84 min ⇒ `On for 1 h 24 min`), `statusLabel`, `endReasonLabel`, `canToggle` (false while a mutation for that card is pending or state `starting`).
- [ ] **Step 2–4:** `cd frontend && npx vitest run src/games/something2/__tests__/tunnelsModel.test.js` FAIL → implement → PASS; full vitest (known pre-existing reds only); eslint changed files; `npx vite build`.
- [ ] **Step 5:** Commit `feat(dev): Tunnels admin tab`.

### Task 7: Whole-branch verification

- [ ] **Step 1:** Backend suite on a private DB (`node scripts/testdb.js run`), compared against a baseline run on `main` — no new failures.
- [ ] **Step 2:** `node --test tools/tunnel-helper/ tools/helper-core/ tools/git-helper/`; frontend `npx vitest run` — only pre-existing reds.
- [ ] **Step 3:** Browser on a private stack with the helper's `compose` swapped for a fake (env `TUNNEL_HELPER_FAKE=1` is NOT allowed in production code — use a test-only launcher script in the scratchpad that injects the fake): both cards on/off, copy link, uptime ticking, players count from a second browser context through a fake tunnel host, History rows incl. a `busy` and a `went_down`. Screenshots. Chrome muted.
- [ ] **Step 4:** **Ask the owner first**, then one real run on the owner's stack: Cloudflare on (built) → open the address from outside → off; ngrok on → busy expected while `auto-orbit` runs, or on → off.
- [ ] **Step 5:** Report; merge only on owner OK.
