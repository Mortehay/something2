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
| `POST /start` | `{ provider: 'cloudflare' or 'ngrok', mode: 'built' or 'live' }` | the card's state |
| `POST /stop` | `{ provider }` | the card's state |
| `GET /events?since=N` | | `{ events, next }` |

Errors: 400 `bad_request`; 401 `unauthorized`; 409 `busy_op` (one start/stop at a time; a
start can take up to 40 s); 503 `docker_unavailable` (status could not read docker) and
`shutting_down`; 500 `internal`.

## Run

```
make tunnel-helper          # start (pid file backend/run/tunnel-helper.pid)
make tunnel-helper-status
make tunnel-helper-stop     # SIGTERM, drains an in-flight start (up to 100 s)
```

Tests inject a fake `createTunnels`, so they need no docker: `node --test 'tools/tunnel-helper/**/*.test.js'`.
