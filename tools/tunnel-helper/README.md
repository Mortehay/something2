# Tunnel helper

Host-side process behind the admin "Tunnels" tab. The backend container has no docker
socket, so this helper (run as the host user) starts, stops and watches this dev stack's
Cloudflare quick tunnel and ngrok agent through `docker compose`. Core logic: `tunnels.js`.

## Never auto-start

A tunnel starts only on an explicit admin click. `make dev`, `make up`, a reboot, or a
helper/backend restart never start one, and tunnel services have no `restart:` policy.
`make dev` starts only the helper (when no live pid file exists). Stopping the helper
leaves running tunnels running.

## Transport and auth

- Unix socket `backend/run/tunnel-helper.sock` (mode 0600), or `127.0.0.1:$TUNNEL_HELPER_PORT`.
- Shared secret in `backend/run/tunnel-helper.token`, sent as `X-Tunnel-Helper-Token`.
  Missing or wrong token: 401.
- `.env` values (`NGROK_AUTHTOKEN`, `NGROK_DOMAIN`) are read by the helper only; the
  authtoken is used solely to redact output and never appears in a response or log.

## API

| Method and path | Body | Result |
| --- | --- | --- |
| `GET /status` | | `{ cloudflare, ngrok }` each `{ provider, state, mode, url, startedAt, error }` |
| `POST /start` | `{ provider: 'cloudflare' or 'ngrok', mode: 'built' or 'live' }` | the card's state, as soon as it is `starting` (see below) |
| `POST /stop` | `{ provider }` | the card's state |
| `GET /events?since=N` | | `{ events, next }` |

Errors: 400 `bad_request`; 401 `unauthorized`; 409 `busy_op` (one start/stop at a time, see
below); 503 `docker_unavailable` (status could not read docker) and `shutting_down`; 500 `internal`.

### How a start runs

`POST /start` answers as soon as the card is `starting`. The rest carries on in the background
under the same one-at-a-time lock, so another start or stop gets 409 `busy_op` until it ends:

1. live: check that vite answers on `http://127.0.0.1:15173/`; if not, the card fails with
   `vite is not running — make dev first` and no tunnel container starts.
2. built: `up -d --build --no-deps web` (its own 10 min limit; every other compose call has
   120 s). Skipped while the other provider's built tunnel is on and `web` is running: that
   tunnel keeps being served the bundle `web` already has (a rebuild would recreate `web` under
   it). The next built start with no built tunnel on rebuilds.
3. `up -d --no-deps --force-recreate <service>`, then up to 40 s for the address.

How it ends (on, failed, busy) shows in `GET /status` and as a `started` / `failed` / `busy` event.
Events that end a start attempt carry `phase: 'start'`, so a failed start is never recorded as a
crash of an earlier run. The backend waits 60 s for any helper answer; a start/stop it gave up on
is shown as 504 `helper_timeout` ("Still working on it — watch the card."), not as a missing helper.

`GET /events` returns `next` = the newest event id this helper has handed out. Ids start at the
helper's start clock; when a reader's `since` is above `next` (a restart after the clock stepped
back), the helper resends from 0.

### Stopping a built tunnel

Stopping `cloudflare` or `ngrok` built removes only that tunnel's container. `web` keeps running
on `127.0.0.1:18081` (loopback only, harmless); `make tunnel-cf-prod-stop` removes it, and the
next built start rebuilds it.

## Run

```
make tunnel-helper          # start (pid file backend/run/tunnel-helper.pid)
make tunnel-helper-status
make tunnel-helper-stop     # SIGTERM, drains an in-flight start (up to 100 s)
```

Tests inject a fake `createTunnels` (or fake compose/logs/vite probes), so they need no docker: `node --test 'tools/tunnel-helper/**/*.test.js'`.

## Rollout

After merging this to `main` on the dev PC:

1. `make up` — recreates `frontend` without `VITE_API_URL` (the tunnel-safe proxy setup) and
   `backend` with `TUNNEL_TAB_ENABLED=true`.
2. `make dev` — starts the dev servers and the helper (when no live pid file exists). The
   backend applies the `tunnel_sessions` migration itself on boot (`MIGRATE_ON_BOOT=true`).

Neither step starts a tunnel.
