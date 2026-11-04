# pi-helper

The Orange Pi admin tab's powers live here, not in the backend container. The
helper is a host process running as you: it holds the board SSH key and the
repo-root `.env`, and the dev backend reaches it over a unix socket
(`backend/run/pi-helper.sock`, header `X-Pi-Helper-Token`, token in
`backend/run/pi-helper.token`). The container never sees the key.

## What it runs

Only an allow-list of scripts from `compose/orangepi/scripts/` (`deploy.sh`,
`backup.sh`, `tunnel.sh`, `reconcile-url.sh`, `remote.sh`), a short `ssh`
probe, and read-only `git` (`fetch`, `rev-list`). Output is redacted against
the secrets in `.env` (names containing PASSWORD, TOKEN, SECRET, KEY).

`GET /status` returns `{ online, host, commit, behindMain, healthCode, checkedAt, tunnels }`.

## Start and stop

    make pi-helper           # start (pid/log/socket/token under backend/run/)
    make pi-helper-status
    make pi-helper-stop      # SIGTERM; running board scripts get 30 s to finish, then their process groups are killed

It refuses to start if another helper is live on the socket. It runs on the
workstation only and never on the board.
