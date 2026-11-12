# Dev tunnel tab — design

Date: 2026-11-12. Owner request, brainstormed in chat.

## Intent

Friends (last time 5–6 at once) want to play the game running on the owner's laptop. Today the
owner runs `make tunnel` (ngrok) or `make tunnel-cf` / `make tunnel-cf-prod` (Cloudflare quick
tunnel) in a terminal, digs the public address out of the output, sends it, and has to remember
to stop it. The tab replaces that with buttons, shows the address with a copy button, and keeps
a history of what happened, problems included.

This is the **developer PC** only. The Orange Pi board's tunnel switch (SOMET-738, Orange Pi tab)
is a different thing and is not touched.

## Goals

- An admin-only tab in `/game` (sidebar, admin section), e.g. "Tunnels", with two sub-tabs:
  **Tunnels** and **History**.
- **Tunnels sub-tab — two cards side by side, Cloudflare and ngrok** (owner chose layout A).
  Each card independently:
  - on/off switch; both can run at the same time;
  - status (Off / Starting / On / Failed / Busy);
  - the public address with a **Copy link** button (Cloudflare: new random address every start;
    ngrok: the reserved `NGROK_DOMAIN`, same every time);
  - **how long it has been on** ("On for 1 h 24 min");
  - **how many players are connected through it right now**;
  - a **"Live version"** option (my call, owner did not object): default is the fast **built**
    frontend (what `make tunnel-cf-prod` serves — quick first load, code as of switch-on);
    "Live version" serves vite's dev server (slow first load, edits reach friends instantly).
- **Lifecycle (owner):** a tunnel turns on **only** when the owner clicks; it stays on until the
  owner switches it off, the laptop shuts down, or the containers go down. Nothing ever starts it
  automatically — not `make up`, not `make dev`, not a reboot, not a helper restart.
- **ngrok busy (owner):** another project on this laptop (`auto-orbit`) runs its own ngrok agent on
  the same account. The free plan allows one online agent, so starting ngrok here may be refused.
  The tab must leave the other agent alone and show "ngrok is busy with another project".
- **History sub-tab (owner approved):** one row per tunnel session:
  - service and address;
  - start, stop, duration;
  - how it ended: switched off by owner / laptop or containers went down / crashed / failed to start;
  - most players at once, and which accounts joined;
  - problems: failed to start (with reason, e.g. ngrok busy, no Cloudflare address within the
    wait), tunnel dropped and came back (times), errors friends hit while connecting through it.
  - Rows kept 30 days (my call).
- Local development keeps working untouched while a tunnel is on or after it is switched off
  (`http://localhost:15173` and the backend on `:13101`).
- Emailed links (invite, verify, reset — email-accounts branch) built for someone who came
  through a tunnel use that tunnel's address. The email branch already makes this true when the
  proxy in front of the backend preserves `Host` (it fixed vite's `/api` proxy); every path this
  feature adds must preserve `Host` too.

## Non-goals

- The Orange Pi board's tunnels.
- Named/stable Cloudflare tunnels, custom domains, paid ngrok features.
- Auto-start, schedules, auto-off timers.
- Showing friends anything new; this is an admin tool.

## Anti-goals

- A click that breaks the owner's local dev stack (e.g. the frontend left pointed at a dead
  public origin after the tunnel is off — the reason `make tunnel-stop` recreates the frontend).
- Touching or stopping another project's containers or agents (the `auto-orbit` ngrok).
- Leaking `NGROK_AUTHTOKEN` or any `.env` value to the browser, logs or history.
- A tunnel silently coming back on by itself.

## Constraints

- The backend runs in a container and cannot run docker compose; the existing pattern for
  host-side actions is a **host helper**: `tools/git-helper` / `tools/pi-helper` built on
  `tools/helper-core` (unix socket in `backend/run/`, per-start token file, allow-listed API,
  backend proxies to it behind `requireAdmin`). Follow that pattern.
- Existing compose services/profiles to build on: `ngrok` (profile `tunnel`), `cloudflared`
  (profile `tunnel-cf`), `web` + `cloudflared-prod` (profile `tunnel-cf-prod`) in
  `compose/develop/docker-compose.yml`. The `make` targets must keep working.
- Today's live-version tunnel mode recreates the frontend with an absolute `VITE_API_URL` and
  `TUNNEL_HOST` — a single public origin. Two tunnels at once (and live + local at once) need the
  client to talk to whatever origin it was loaded from; the builder decides how.
- Free ngrok: one online agent per account; a warning page on first load ("Visit Site" once).
- Dev `REGISTRATION_MODE` defaults to `open`: anyone with the address can register. The card shows
  the current registration mode next to the address as a warning (my call); it does not change it.
- Admin only, on both the tab and every API route. Values from `.env` never leave the server side.
- Shared checkout rules (AGENTS.md): this is built in its own worktree.

## Decided by the owner

Layout A (two independent cards); manual on only; stays on until switched off / laptop off /
containers down; show address + copy, uptime, connected-player count; History sub-tab with
statistics and issues/failures; leave the other project's ngrok alone and show "busy".

## My calls (owner can override)

- Default served version is the built frontend; "Live version" is a per-card option.
- History kept 30 days.
- Registration mode shown as a warning on the cards.
- Tab name "Tunnels".

### Settled after the builder check (my calls)

- **Which stack:** the helper drives the running dev stack — compose project and files of the
  checkout it is started from; in normal use that is the shared checkout (`make` from the repo
  root). Verification during development uses a private stack, never the shared one.
- **Two origins at once:** the client must use same-origin relative `/api` and `/authority`
  (leave `VITE_API_URL` unset — `frontend/src/config.js` already yields relative URLs when it is
  unset). Switching a tunnel must **not** recreate the frontend or interrupt the other tunnel or
  local dev; vite accepts the tunnel hosts via `allowedHosts` (`.trycloudflare.com` and
  `NGROK_DOMAIN`) set once, not per tunnel. HMR for remote players may simply be off (they reload).
- **Built vs live:** one `web` (built) service and the one vite `frontend` service are shared; each
  card's tunnel points at whichever its option selects, independently. Both cards may be Live at
  once. The built bundle is rebuilt when a card turns on in built mode (cached if unchanged).
- **Host preserved everywhere:** vite's `/api` (done on the email branch) **and** `/authority`
  proxies keep `Host`; the built `web` Caddy keeps it by default. Players are attributed to a
  tunnel by the `Host` of their authority WebSocket upgrade.
- **State and history store:** a backend DB table (migration — check timestamp collisions). The
  backend is the writer: the helper reports start/stop/failure/drop events and current state; the
  backend records players and errors. On helper start (and on backend start) any session still
  open whose tunnel container is not running is closed as "laptop or containers went down" —
  never restarted.
- **ngrok busy:** detected only by trying to start and reading the agent's failure (e.g.
  ERR_NGROK_108 "1 simultaneous session"); nothing inspects or touches the other project.
- **Helper start:** `make dev` may start the helper (a host process, like git-helper); it never
  starts a tunnel. The tab shows how to start the helper if it is not running.
- **"Errors friends hit":** server-side only — backend 5xx and refused WebSocket upgrades that
  arrived through a tunnel host, plus tunnel-log events (dropped / reconnected). No new
  client-side error reporting.

## Left to the builder

- How the helper is started (e.g. `make` target, or started with `make dev`) and what the tab
  shows when the helper is not running (it must say how to start it).
- Exact schema, polling vs push for live status, and UI details within the cards above.
- How "dropped and came back" and "errors friends hit" are detected.
