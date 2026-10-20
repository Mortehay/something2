# git-helper

Host-side helper for the Seed/Export tab's git buttons (SOMET-642). The backend
container has no git and must never hold the push key, so it asks this process,
which runs as your host user with your own git and SSH setup.

    make git-helper          # start (detached); pid + log in backend/run/
    make git-helper-status
    make git-helper-stop     # SIGTERM by pid file, waits up to 70s for the drain, then verifies with ss

## Transport and auth
- Default: unix socket `backend/run/git-helper.sock`.
- `GIT_HELPER_PORT=<n> make git-helper`: TCP on `127.0.0.1:<n>` instead. This is for
  Docker Desktop only (it cannot share unix sockets; the backend reaches it as
  `host.docker.internal:<n>`). On native-Linux Docker, 127.0.0.1 on the host is not
  reachable from the container, so use the socket.
- Starting while another helper is live on the same socket/port refuses (exit 1,
  "a git helper is already listening on ...") and leaves its token alone. A stale
  socket (nothing answering) is replaced.
- SIGTERM/SIGINT drains: no new connections, requests on open connections get 503
  `shutting_down`, the in-flight op finishes and its response flushes, then exit 0
  and the socket is removed. After 65 s the git child is killed and it exits 1.
- Every request needs header `X-Git-Helper-Token` = contents of
  `backend/run/git-helper.token` (0600, regenerated at each start). Missing or wrong: 401.
- Env overrides: `GIT_HELPER_ROOT` (repo to operate on, default this repo),
  `GIT_HELPER_RUN_DIR` (socket/token dir, default `<root>/backend/run`).

## API (allow-list; nothing else exists)
| Request | Behaviour |
|---|---|
| `GET /status` | `{ branch, upstream, ahead, behind, seedsDirty, otherDirty, headSubject, lastFetchAt }` |
| `POST /fetch` | `git fetch --prune` |
| `POST /pull` | `git fetch`, then `git pull --ff-only`; refused when the tree is dirty anywhere or diverged |
| `POST /commit` `{message}` | `git add -- backend/seeds`, then commits only `backend/seeds`; message stored byte-exact (`--cleanup=verbatim`) |
| `POST /push` | `git fetch origin`, then ahead/behind against `origin/<branch>`; `git push origin refs/heads/X:refs/heads/X`, never forced. `no_upstream` when origin lacks the branch |

Results are `{ ok, op, output, status }` (output capped at 4 KB; HTTP 502 when git itself
failed). Refusals are 409 `{ error, message }` with `dirty`, `nothing_to_commit`,
`behind` ("pull first"), `diverged`, `no_upstream`, `busy` (one mutating op at a time).
A bad body is 400 `bad_request`.

Git runs with `GIT_TERMINAL_PROMPT=0` and ssh `BatchMode=yes` (unless you set
`GIT_SSH_COMMAND`), with a 60 s timeout, so missing credentials fail with a message
instead of hanging.

## Tests
`node --test tools/git-helper/*.test.js` (Node 22 does not accept a bare directory).
They use temp repos under the OS temp dir only.
