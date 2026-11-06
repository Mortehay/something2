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

`GET /status` returns `{ online, host, commit, behindMain, healthCode, checkedAt, tunnels, watcher }`.

`GET /players`, `GET /bosses` and `POST /bosses/summon` read the game's live state on the board, only
when asked (the tab polls the reads while it is open, a 5 s cache shares one). All of it reaches a listener
bound to 127.0.0.1 inside the backend container (`BOARD_INTERNAL_PORT`, set in `compose/orangepi`, never
proxied). Reads and the sampler's counters use `docker exec ... wget` over the shared ssh connection; only a
summon boots node, through `remote.sh backend`. An older board image has no listener: the answer is "press
Update" and null chart readings, never an error.

## Start and stop

    make pi-helper           # start (pid/log/socket/token under backend/run/)
    make pi-helper-status
    make pi-helper-stop      # SIGTERM; running board scripts get 30 s to finish, then their process groups are killed

It refuses to start if another helper is live on the socket. It runs on the
workstation only and never on the board.

## History files

Under `backend/run/` (git-ignored, mode 0600): `pi-metrics.jsonl` (chart samples, 30 days),
`pi-actions.jsonl` (the last 50 finished actions with their logs) and `pi-releases.jsonl` (this PC's
copy of the release log; the board keeps the main copy in `$ORANGEPI_DATA_DIR/locks/releases.jsonl`).
The metrics file is read once at start: a full 30 days (about 170k lines) takes a couple of seconds
before the helper answers, and the start rewrites it compactly if it holds old raw lines or a bad line.
