# Orange Pi Admin Tab, Stage 1: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin tab on the workstation that updates the Orange Pi to the latest `main`, seeds it from git, starts and stops ngrok and Cloudflare links, and charts the board's CPU, memory, disk, ping and network.

**Architecture:** `browser -> dev backend (/api/board, admin only, flagged) -> tools/pi-helper (host process, unix socket) -> ssh -> board`. The helper holds the SSH key and calls the existing `compose/orangepi/scripts/`, keeps recent samples in memory, and runs one long job at a time. New board behaviour (ngrok, tunnel state, deploy lock) goes in those scripts, so `make pi-*` and the tab cannot drift apart.

**Tech Stack:** Node 20 stdlib (helper), Express and `pg` (backend), React 19, styled-components, TanStack Query (frontend), bash and Docker Compose (board), `node --test` and vitest (tests).

**Spec:** `docs/superpowers/specs/2026-11-04-orangepi-admin-tab-design.md`. Stage 2 (players, kills, bosses) gets its own plan.

## Global Constraints

- The backend routes mount only when `BOARD_TAB_ENABLED=1`. That flag goes in `compose/develop/docker-compose.yml` and never in `compose/orangepi`.
- Passwords, tokens and keys never appear in a response or in a log shown in the tab.
- Update pushes without force: `git push origin <sha>:refs/heads/orangepi`. It never touches the local checkout. Other sessions share it.
- A link is shown only after `/api/health` returned 200 through it.
- Nothing in this work restarts `cloudflared` except the owner pressing Start after Stop. Never touch auto-orbit's ngrok.
- Seed never changes player tables, and git wins on catalog rows (`--resolve=git`).
- Seed groups, in this order: `ai_providers`, `tile_types`, `items`, `attack_effects`, `aura_effects`, `creature_behaviors`, `entities`, `biomes`, `skill_tree`, `progression`, `quests`. Excluded: `ai_provider_templates`, `art`, `audio`, `maps`.
- Samples every 15 s, 1440 kept (6 hours), ranges `15m`, `1h`, `6h`. A failed sample is stored with nulls, and is never drawn as zero.
- No new chart library. Use the `dataviz` skill and `--s2-*` tokens, in both light and dark.
- Project rules: worktree `.worktrees/orangepi-admin-tab`, branch `feat/orangepi-admin-tab`, commit subject `type(scope): summary (SOMET-NNN)` with the Co-Authored-By trailer. File the Plane epic and children before Task 1.
- Backend DB tests: set both `TEST_DATABASE_URL` and `DATABASE_URL` to a scratch database, and never mutate the shared dev database. Read the exit code, not the summary line.
- No test may reach the real board or the owner's `.env`. Use `PI_LOCAL=1`, a scratch `REPO_ROOT` and a stub `docker` on `PATH`.
- Editing the dev compose `environment` recreates the backend on the next `up`, which can stop vite for every session. Afterwards run `make dev` and tell the owner.

## Review Focus

- The board goes off during a sample or a job: charts show a gap, and the job fails naming the step, without hanging. *(Tasks 4, 5, 6)*
- A second action is pressed while a job runs, including from a second browser tab: it gets `409 busy` and nothing starts. *(Task 6)*
- CI's hook deploy and the helper's SSH deploy overlap: one waits or stands down, and the board is never stopped twice. *(Tasks 2, 7)*
- ngrok fails: the agent is already running on the laptop (`ERR_NGROK_334`), the token is missing, or the tunnel starts but the game does not answer. The owner reads a plain sentence and sees no link. *(Tasks 1, 6)*
- A secret appears in script output (for example a token echoed by a failing command): the tab shows it redacted. *(Task 4)*

---

## Helper API (used by Tasks 4 to 9)

All requests need header `X-Pi-Helper-Token`. Backend routes at `/api/board/*` mirror these paths, behind `adminGuard`.

| Request | Answer |
|---|---|
| `GET /status` | `BoardStatus` |
| `GET /metrics?range=15m\|1h\|6h` | `{ samples: Sample[] }` |
| `GET /job` | `Job` or `null` (latest job, kept until the next one starts) |
| `GET /seed/preview` | `{ needsUpdate: boolean, groups: [{ group, add, change, remove, overwrite, refused }] }` |
| `POST /update`, `/seed/apply`, `/restart` | `202 Job`, or `409 { error: 'busy', message }` |
| `POST /tunnel/cloudflare\|ngrok/start\|stop` | same as above |

```
BoardStatus = { online, host, commit, behindMain, healthCode, checkedAt,
  tunnels: { cloudflare: Tunnel, ngrok: Tunnel } }
Tunnel = { state: 'on'|'off', url: string|null, verified: boolean, ageSeconds: number|null }
Sample = { t, online, cpuPct, memUsedMb, memTotalMb, diskPct, connections,
  net: { [iface]: { inBps, outBps } }, pingMs, cloudflareMs, ngrokMs }
Job = { id, kind: 'update'|'seed'|'restart'|'tunnel', state: 'running'|'ok'|'failed',
  startedAt, finishedAt, steps: [{ name, state, detail }], log, error, targetSha, ciUrl }
```

---

### Task 1: ngrok service and remembered tunnel state on the board

**Files:**
- Modify: `compose/orangepi/docker-compose.yml`, `compose/orangepi/scripts/lib.sh` (`pi_profiles`), `compose/orangepi/scripts/deploy.sh` ("ensure the tunnel is running"), `Makefile`
- Create: `compose/orangepi/scripts/tunnel.sh`
- Test: `backend/tests/orangepi_scripts.test.js`, `backend/tests/orangepi_compose.test.js`

**Interfaces:**
- Produces: `tunnel.sh start|stop|status cloudflare|ngrok`. `start` prints `url=<url>` on success, or `error=<code or reason>` and exits 1. `status` prints `state=`, `url=`, `verified=`, `age=`, one per line. Also `pi_tunnel_wanted <name>`, returning 0 when wanted. State files: `$ORANGEPI_DATA_DIR/tunnel-cloudflare.off`, `$ORANGEPI_DATA_DIR/tunnel-ngrok.on`.

- [ ] **Step 1: Write the failing tests** (real bash against a stub `docker`, `PI_LOCAL=1`, scratch data directory):
  - `pi_profiles omits tunnel when cloudflare is marked off`, and includes it with no state file (today's behaviour).
  - `pi_profiles includes the ngrok profile only when tunnel-ngrok.on exists`.
  - `deploy leaves a stopped cloudflare stopped`: the stub docker log has no `up ... cloudflared` when the off file exists.
  - `tunnel.sh stop removes the container`: the stub log contains `rm -sf` (`pi_tunnel_url` reads a stopped container's old logs, so `stop` alone would report a dead address).
  - `tunnel.sh start ngrok with no token` exits 1 with `error=no_token`, and calls no docker.
  - `tunnel.sh start ngrok reports the ngrok error code`: stub logs contain `ERR_NGROK_334`, stdout has `error=ERR_NGROK_334`.
  - `tunnel.sh shows no url when health fails through the tunnel`: stub `curl` returns 502, so `error=not_answering` and no `url=` line.
  - `the token never reaches argv`: the stub ssh and docker logs do not contain the token value.
  - Compose test: `ngrok` has `profiles: ["ngrok"]`, a pinned image with an exact version, and upstream `caddy:80`. It publishes no host port.

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && node --test tests/orangepi_scripts.test.js tests/orangepi_compose.test.js`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement**
  - Compose service: `command: http caddy:80` with no url flag, so ngrok uses the account's assigned domain. `NGROK_AUTHTOKEN=${NGROK_AUTHTOKEN:-}`, `restart: unless-stopped`. Choose the exact image tag from Docker Hub and confirm it has an arm64 image.
  - `tunnel.sh start ngrok`: read the token from the workstation's `.env` and write it to `$DATA/.env` by sending it over stdin to a remote script that replaces that one key. Create the state file, `up -d --no-deps --no-recreate`, read `url=` from the container's logs, then `curl` `$url/api/health` from the workstation with header `ngrok-skip-browser-warning: 1`, retrying for up to 60 s.
  - `tunnel.sh start cloudflare`: remove the off file, `up`, verify the same way, then run `reconcile-url.sh` as a soft step, because the address has changed.
  - `tunnel.sh stop`: write or remove the state file, then `compose rm -sf <service>`.
  - Make targets: `pi-tunnel-start NAME=`, `pi-tunnel-stop NAME=`.

- [ ] **Step 4: Run to verify they pass**

Run: same command. Expected: exit 0.

- [ ] **Step 5: Commit** `feat(orangepi): ngrok service and remembered tunnel state (SOMET-NNN)`

---

### Task 2: One deploy at a time, from any entry point

**Files:**
- Modify: `compose/orangepi/scripts/lib.sh`, `compose/orangepi/scripts/deploy.sh`
- Test: `backend/tests/orangepi_scripts.test.js`

**Interfaces:**
- Produces: `pi_deploy_lock` and `pi_deploy_unlock` in `lib.sh`. `deploy.sh` exits with code **75** when another deploy holds the lock, and exits 0 without restarting when `PI_SKIP_IF_CURRENT=1` and the board is already at the target and healthy. `PI_LOCAL=1` implies skip-if-current, since the hook's own image is not rebuilt by a deploy. A plain `make pi-deploy` still always redeploys.

The workstation path makes many separate SSH calls, so the lock cannot be `flock`. Use `mkdir "$DATA/deploy.lock"`, with a `trap` to remove it on exit, treating a lock older than 45 minutes as stale.

- [ ] **Step 1: Write the failing tests:**
  - `a second deploy exits 75 and stops nothing`: lock directory exists, stub docker log has no `stop`.
  - `the lock is released when a step fails`: a stub failing mid-deploy leaves no lock directory.
  - `a stale lock is taken over`: lock directory older than 45 minutes, and the deploy proceeds.
  - `skip-if-current does nothing when at target and healthy`: stub docker log has no `stop`, exit 0.
  - `skip-if-current still deploys when at target but unhealthy`: stub health returns 502.

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && node --test tests/orangepi_scripts.test.js`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement** the lock around the whole of `deploy.sh`, taken before `fetch_and_reset`. The at-target check runs after `git fetch`, before the reset.

- [ ] **Step 4: Run to verify they pass**

Run: same command. Expected: exit 0.

- [ ] **Step 5: Commit** `feat(orangepi): one deploy at a time from CI or the workstation (SOMET-NNN)`

---

### Task 3: Seed preview command, and proof that seeding spares players

**Files:**
- Modify: `backend/scripts/seed-sync.js`
- Create: `backend/src/services/seedSync/boardSeedGroups.js`
- Test: `backend/tests/seed_sync_preview.test.js`, `backend/tests/board_seed_scope_db.test.js`

**Interfaces:**
- Produces: `summarizePreview(rows, resolve) -> { add, change, remove, overwrite }`, exported from `seed-sync.js`. `seed-sync.js preview --group=g --resolve=git` prints one line per group: `<group> preview {"add":n,"change":n,"remove":n,"overwrite":n}`, or `<group> refused:<code> <message>`. It writes nothing. `BOARD_SEED_GROUPS`: the ordered list from Global Constraints, in a file with no imports, because the helper on the host requires it directly and the host has no backend dependencies guaranteed.

- [ ] **Step 1: Write the failing tests:**
  - `summarizePreview counts by decision`: a `new` row counts as `add`, a row whose decision is `delete` counts as `remove`, a row with a default decision of `git` counts as `change`, and a row with no default decision resolved to `git` counts as `overwrite`.
  - `summarizePreview never counts a blocked row as removed`.
  - `preview writes nothing`: on a scratch DB, row counts and `seed_export_runs` are the same before and after.
  - `BOARD_SEED_GROUPS touch no player table`: every table in those registry groups is outside a list of player tables (`users`, `characters`, and every table with a `character_id` or `user_id` column, read from `information_schema`).
  - `seeding leaves player tables unchanged`: on a scratch DB with a user, a character, items and passives, run all groups with `--resolve=git`. A `count(*)` and `md5` of each player table match before and after.
  - `ai_providers seeds with no token`: `auth_token` is unset after seeding.

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && node --test tests/seed_sync_preview.test.js tests/board_seed_scope_db.test.js`
Expected: FAIL, `summarizePreview` not exported.

- [ ] **Step 3: Implement** using `previewSeed` and the existing `decide`. Extend `parseArgs` to accept `preview`. If the scope test finds a group writing a player table, stop and tell the owner rather than editing the test.

- [ ] **Step 4: Run to verify they pass**

Run: same command. Expected: exit 0.

- [ ] **Step 5: Commit** `feat(seed): preview command and board seed group list (SOMET-NNN)`

---

### Task 4: Helper skeleton, board runner, status

**Files:**
- Create: `tools/pi-helper/server.js`, `tools/pi-helper/boardRunner.js`, `tools/pi-helper/status.js`, `tools/pi-helper/README.md`
- Modify: `tools/git-helper/server.js` (add `probeLive` and `tokenOk` to its exports), `Makefile`
- Test: `tools/pi-helper/boardRunner.test.js`, `tools/pi-helper/status.test.js`, `tools/pi-helper/server.test.js`

**Interfaces:**
- Produces: `createRunner({ root, env, spawn }) -> { script(name, args, { env, timeoutMs, onLine }), ssh(command, { timeoutMs }), secrets() }`. `script` accepts only names in an allow-list: `deploy.sh`, `backup.sh`, `tunnel.sh`, `reconcile-url.sh`, `remote.sh`. It resolves to `{ code, output }` and never rejects on a non-zero exit. `redact(text, secrets) -> string`. `readStatus(runner) -> BoardStatus`. `createServer({ root, runDir, routes })`, with socket `backend/run/pi-helper.sock`, token `backend/run/pi-helper.token`, header `X-Pi-Helper-Token`.
- Consumes: `tunnel.sh status` (Task 1).

- [ ] **Step 1: Write the failing tests:**
  - `script refuses a name outside the allow-list`.
  - `script kills the child at the timeout and reports code null` (a stub script that sleeps).
  - `output is redacted`: a stub prints `ORANGEPI_PASSWORD` and `NGROK_AUTHTOKEN` values from a scratch `.env`, and neither value appears in `output` or `onLine`.
  - `readStatus reports offline quickly`: stub ssh exits 255, giving `{ online: false, commit: null }`, not a throw.
  - `readStatus parses commit, tunnels and behindMain` from stub output.
  - `server answers 401 with no token, 404 for unknown routes`, and refuses to start if a helper is already live on the socket.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tools/pi-helper/*.test.js`
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement.** Follow `tools/git-helper/server.js` for the socket, token, drain and pid behaviour. `behindMain` is `git rev-list --count <boardSha>..origin/main`, or null when the commit is unknown locally, with a `git fetch origin main orangepi` at most every 5 minutes. Make targets: `pi-helper`, `pi-helper-stop`, `pi-helper-status`, copying the `git-helper` targets. The drain cap must allow for a running deploy: on stop, a job's child is killed after 30 s and the job is marked failed.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tools/pi-helper/*.test.js tools/git-helper/*.test.js`
Expected: exit 0.

- [ ] **Step 5: Commit** `feat(pi-helper): host helper with board runner and status (SOMET-NNN)`

---

### Task 5: Sampling and metrics

**Files:**
- Create: `tools/pi-helper/sampler.js`, `tools/pi-helper/procParse.js`
- Modify: `tools/pi-helper/server.js`
- Test: `tools/pi-helper/procParse.test.js`, `tools/pi-helper/sampler.test.js`

**Interfaces:**
- Consumes: `runner.ssh` (Task 4).
- Produces: `parseSnapshot(text) -> { cpu: { busy, total }, memUsedMb, memTotalMb, diskPct, connections, net: { [iface]: { rx, tx } } }`. `nextSample(prev, snapshot, now) -> Sample`. `createSampler({ runner, ping, fetchLatency, intervalMs, capacity }) -> { start(), stop(), samples(range) }`.

The snapshot is one fixed remote command printing `/proc/stat`, `/proc/meminfo`, `/proc/net/dev`, `df -P /` and a count of established TCP connections, between delimiters. Reuse one SSH connection using `ControlMaster=auto`, `ControlPersist=60` and a `ControlPath` under the run directory. Do not use `docker stats`, which reports 0 on this kernel.

- [ ] **Step 1: Write the failing tests:**
  - `parseSnapshot reads a real capture`: use a fixture captured from the board with `ssh` (read-only). Values match by hand.
  - `net excludes lo, docker*, veth* and br-*`.
  - `nextSample computes rates`: 15 s apart, rx up by 1500000 bytes gives `inBps` 100000, and CPU percent comes from the busy and total deltas.
  - `the first sample has null rates and CPU`, and a counter that went backwards (board reboot) gives null rather than a negative.
  - `a failed snapshot stores online false and null metrics`, and the next good sample has null rates, since its previous sample is unusable.
  - `the ring keeps 1440 samples`, and `samples('15m')` returns only the last 15 minutes.
  - `a hung snapshot does not stack`: no second snapshot starts while one is running.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tools/pi-helper/procParse.test.js tools/pi-helper/sampler.test.js`
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement.** `pingMs` from `ping -c1 -W2 <host>`, null on failure. `cloudflareMs` and `ngrokMs` time a `GET <url>/api/health` (5 s limit, with `ngrok-skip-browser-warning: 1`) for tunnels that are on, null otherwise. Add `GET /metrics`, rejecting any other range with 400.

- [ ] **Step 4: Run to verify they pass**

Run: same command. Expected: exit 0.

- [ ] **Step 5: Measure the load.** Run the sampler against the board for 5 minutes and record its CPU cost on the board in the PR description.

- [ ] **Step 6: Commit** `feat(pi-helper): board sampling and metrics history (SOMET-NNN)`

---

### Task 6: Jobs: tunnels, restart, seed

**Files:**
- Create: `tools/pi-helper/jobs.js`, `tools/pi-helper/boardJobs.js`, `tools/pi-helper/tunnelErrors.js`
- Modify: `tools/pi-helper/server.js`
- Test: `tools/pi-helper/jobs.test.js`, `tools/pi-helper/boardJobs.test.js`

**Interfaces:**
- Consumes: `createRunner` (Task 4), `BOARD_SEED_GROUPS` and `seed-sync.js preview` (Task 3), `tunnel.sh` (Task 1).
- Produces: `createJobs() -> { start(kind, stepFns) -> Job (throws BusyError), current() }`, where a step function is `async ({ step, log }) => void` and a throw fails the job at that step. Job log capped at 16 KB, keeping the end. `explainTunnelError(code) -> string`. Job factories `tunnelJob(runner, name, action)`, `restartJob(runner)`, `seedJob(runner)`, and `readSeedPreview(runner)`.

- [ ] **Step 1: Write the failing tests:**
  - `a second start throws BusyError while one runs`, and the server answers 409 `busy`.
  - `a step that throws fails the job and names the step`.
  - `explainTunnelError(ERR_NGROK_334)` mentions `make tunnel` on the laptop and "one agent". `no_token` names `NGROK_AUTHTOKEN` in `.env`. An unknown code still produces a sentence including the code.
  - `restart runs compose restart for backend and caddy only`: the runner call has neither `cloudflared` nor `ngrok`.
  - `seed runs seed-catalogs, then each group in order, with --resolve=git`.
  - `seed stops at the first refused group`, naming the group and reason.
  - `readSeedPreview reports needsUpdate` when the board's `seed-sync.js` doesn't know `preview`. Applying while `needsUpdate` is true fails with a sentence telling the owner to update first.
  - `seed never names art, audio, maps or ai_provider_templates`.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tools/pi-helper/jobs.test.js tools/pi-helper/boardJobs.test.js`
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement** and add the routes. Seed runs via `remote.sh backend node scripts/seed-sync.js ...`, which uses the seed files in the running image, so seeds match the board's commit.

- [ ] **Step 4: Run to verify they pass**

Run: same command. Expected: exit 0.

- [ ] **Step 5: Commit** `feat(pi-helper): tunnel, restart and seed jobs (SOMET-NNN)`

---

### Task 7: Update job

**Files:**
- Create: `tools/pi-helper/updateJob.js`
- Modify: `tools/pi-helper/server.js`
- Test: `tools/pi-helper/updateJob.test.js`

**Interfaces:**
- Consumes: `createRunner`, `createJobs`, exit code 75 and `PI_SKIP_IF_CURRENT` (Task 2).
- Produces: `updateJob({ runner, git, gh, clock, sleep, timeouts }) -> stepFns`, with step names exactly `backup`, `push`, `ci`, `deploy`, `verify`. `git` and `gh` are injected wrappers around `execFile`, so tests use fakes and temp repos only.

Behaviour:
1. `backup`: `backup.sh`. Non-zero stops the update.
2. `push`: `git fetch origin main orangepi`, `git merge-base --is-ancestor origin/orangepi origin/main` (if not, stop with a "diverged" sentence), then `git push origin <sha>:refs/heads/orangepi`. Skipped when they are already equal. Sets `job.targetSha`.
3. `ci`: poll every 20 s, up to 40 min, with `gh run list --workflow orangepi-images.yml --commit <sha> --json databaseId,status,conclusion,url` and `gh run view <id> --json jobs`. **The step passes when the `manifest` job has succeeded.** It does not wait for the `deploy` job, since a stale hook URL fails that job while the images are fine. A failed `manifest` stops, showing the run URL. Sets `job.ciUrl`.
4. `deploy`: poll the board's commit for up to 3 min. If it reaches `<sha>`, the hook took it, so wait for health. Otherwise run `deploy.sh` with `PI_SKIP_IF_CURRENT=1`. On exit 75, go back to polling, for at most 25 min in total.
5. `verify`: the board is at `<sha>`, `pi_health_url` returns 200, and the backend container started after the job did. A healthy old backend must not pass for a finished deploy.

- [ ] **Step 1: Write the failing tests:**
  - `a failed backup pushes nothing`: the fake git has no `push` call.
  - `diverged orangepi stops before pushing`.
  - `push never forces`: every recorded push has no `--force`, and its refspec has no `+`.
  - `push is skipped when already at main`.
  - `ci passes on manifest success even if the deploy job failed`.
  - `ci failure shows the run url`, and `ci times out` with a failing `ci` step.
  - `deploy waits when the hook takes it`: the board reaches the target within the wait, so no `deploy.sh` call.
  - `deploy falls back to ssh when the hook never lands`.
  - `deploy retries on exit 75` rather than failing.
  - `verify rejects a backend started before the job`.
  - `the board going offline mid-deploy fails at the deploy step with a sentence`.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tools/pi-helper/updateJob.test.js`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement** and add `POST /update`.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tools/pi-helper/*.test.js`
Expected: exit 0.

- [ ] **Step 5: Commit** `feat(pi-helper): update the board to latest main (SOMET-NNN)`

---

### Task 8: Backend routes

**Files:**
- Create: `backend/src/services/helperClient.js`, `backend/src/services/piHelperClient.js`, `backend/src/api/boardRoutes.js`
- Modify: `backend/src/services/gitHelperClient.js` (uses the shared client), `backend/src/index.js`, `compose/develop/docker-compose.yml`, `.env.example`
- Test: `backend/tests/board_routes_db.test.js`, existing `backend/tests/seed_export_git_routes_db.test.js`, `backend/tests/orangepi_compose.test.js`

**Interfaces:**
- Consumes: Helper API.
- Produces: `createHelperClient({ socketEnv, urlEnv, tokenEnv, defaultSocket, defaultTokenFile, tokenHeader, label, timeoutMs }) -> { call, HelperUnavailable }`, and `boardRoutes(pool) -> Router`.

- [ ] **Step 1: Write the failing tests** against a fake helper on a temp socket, copying `fakeHelper` from `seed_export_git_routes_db.test.js`:
  - `every route needs admin`: no token gives 401, a player gives 403, for each route in the Helper API table.
  - `helper down`: `GET /status` gives 200 `{ available: false, reason: 'helper_unavailable', hint: 'Run make pi-helper on this PC' }`, and a POST gives 503.
  - `a request mid-action reports midAction`.
  - `busy passes through as 409`.
  - `an unknown tunnel name or action gives 400 and never reaches the helper`.
  - `the app mounts no /api/board without BOARD_TAB_ENABLED=1`: 404.
  - Compose test: `compose/orangepi/docker-compose.yml` does not contain `BOARD_TAB_ENABLED`, and the dev compose file does.
  - The existing git route tests still pass, with no edits to them.

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && TEST_DATABASE_URL=$SCRATCH DATABASE_URL=$SCRATCH node --test tests/board_routes_db.test.js tests/seed_export_git_routes_db.test.js tests/orangepi_compose.test.js`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement.** Use a 150 s client timeout, since the seed preview is slow. POSTs return 202 straight away, because the job runs in the helper.

- [ ] **Step 4: Run to verify they pass**

Run: same command. Expected: exit 0.

- [ ] **Step 5: Commit** `feat(board): admin routes proxied to the pi helper (SOMET-NNN)`

---

### Task 9: The tab

**Files:**
- Create: `frontend/src/games/something2/BoardAdmin.jsx`, `BoardChart.jsx`, `BoardActions.jsx`, `useBoard.js`, `boardModel.js`
- Modify: `frontend/src/App.jsx`, `frontend/src/ui/navSections.js`
- Test: `frontend/src/games/something2/__tests__/boardModel.test.js`, `boardAdmin.render.test.js`

**Interfaces:**
- Consumes: `/api/board/*`, using `authHeaders` and `apiFetch`. `Btn`, `Badge`, `Muted`, `Modal` from `seedUi.jsx`.
- Produces: `chartPoints(samples, read, { width, height, max }) -> string[]`, returning one polyline per unbroken run, so a null makes a gap. `statusLine(status) -> { tone, text }`. `confirmText(kind, status) -> string`. `BoardAdminView({ status, samples, job, preview, range, onAction, onRange })`, presentational for SSR tests. Route `board`, nav `{ id: 'board', label: 'Orange Pi', path: '/game/board' }`, placed directly above Seed / Export.

Layout B from the spec: status line; left column Game version, ngrok link, Cloudflare link, Last action; right, a grid of CPU, Memory, Disk, Ping, Network charts with the range selector. Load the `dataviz` skill before writing `BoardChart.jsx`. Ping draws up to three series, labelled directly: Board, Cloudflare, ngrok. Network draws in and out per interface. Poll status and metrics every 15 s, and the job every 2 s while running.

Exact dialog copy:
- Update: `Move the board to the latest main ({n} commits). The game restarts and players are disconnected. The update can change characters. The backup taken first is the way back.`
- Seed: `{add} added, {change} changed, {remove} removed, {overwrite} overwritten with git's version. Balance changes made directly on the board are lost. Players and progress are not touched. Art, audio and maps are not included.`
- Cloudflare stop: `The current link stops working. Starting it again gives a new address, and CI deploys need repairing, which Start does for you.`

- [ ] **Step 1: Write the failing tests:**
  - `chartPoints splits on null`: `[1, null, 2, 3]` gives two runs, and never a point at zero.
  - `statusLine`: online and behind names the count, offline says the board is off or unreachable, `behindMain` null says unknown.
  - `helper down shows the start command`: `make pi-helper` appears and action buttons are absent.
  - `404 from status explains the tab only works on the workstation`.
  - `a tunnel link renders only when verified`: `{ url, verified: false }` shows no link or Copy.
  - `actions are disabled with a reason while a job runs` and when offline.
  - `the failed job shows the step and error`, and `ciUrl` as a link.
  - `the seed note says art is not included`.
  - `a finished seed offers Restart`: it says the running game still uses the old data until restarted, and the button calls `POST /restart`.
  - `navRoutes.test.js` still passes for the new route.

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/boardModel.test.js src/games/something2/__tests__/boardAdmin.render.test.js src/ui/__tests__`
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement.** Do not interpolate chart values or logs as HTML. Render non-finite values as gaps.

- [ ] **Step 4: Run to verify they pass**

Run: same command. Expected: exit 0.

- [ ] **Step 5: Check it in a browser, against the running helper and with the board reachable.** Use Chrome with `--mute-audio`. Check both themes, helper stopped, and read-only views only. No Update yet.

- [ ] **Step 6: Commit** `feat(board): Orange Pi admin tab (SOMET-NNN)`

---

### Task 10: The first real update, and verification on the board

This task pushes to GitHub, restarts the board and opens public links. **Get the owner's go-ahead at the start of this task, and merge the branch to `main` first**, so the update delivers the new scripts. Note that a hook-triggered deploy runs the *old* `deploy.sh` already on the board, and the hook's own image only changes on `make pi-up`.

**Files:**
- Modify: `README.md` (the tab, `make pi-helper`, the first-update map step, the `ngrok` free-plan warning page)

- [ ] **Step 1: Find out what the laptop's other 35 worlds are** (read-only query comparing `worlds` to the two specs). Report to the owner if testers would miss them.
- [ ] **Step 2: Press Update in the tab.** Expected: all five steps pass, and the board is at `origin/main`. Log anything that only fails on hardware and fix it.
- [ ] **Step 3: Run the map step:** `make pi-seed-map SPEC=p5-descent`, `make pi-seed-map SPEC=vale-region`, `make pi-restart`. Expected: Vale Crossing is the entry world, and there are 6 dungeon boss placements.
- [ ] **Step 4: Seed from git.** Check the preview, apply, and restart. Expected: board player tables match before and after by `count(*)`.
- [ ] **Step 5: Start ngrok.** Open the link in a fresh browser profile, and through a phone on mobile data if possible. Register or log in and play: the websocket connects, and the character moves with a held key.
- [ ] **Step 6: Tunnels.** Run `make tunnel` on the workstation, then confirm that the tab's ngrok start gives the plain `334` sentence. Stop `make tunnel`. Stop Cloudflare, press Update with nothing new, and confirm it stays stopped. Start it, and confirm that the new address appears and the published page follows.
- [ ] **Step 7: Failure states.** Make the board unreachable (for example, temporarily point `ORANGEPI_ADDRESS` at an unused LAN address, using a helper started just for this): the tab reports it within 15 s and the charts show a gap. Stop the helper: the tab shows the command.
- [ ] **Step 8: Prove the tab isn't on the board.** Through the public link, `GET /api/board/status` gives 404, with an admin token too.
- [ ] **Step 9: Full suites.** `cd backend && npm test; echo $?` with scratch DB variables set, `cd frontend && npx vitest run; echo $?`, and `node --test tools/pi-helper/*.test.js`. Compare any failure against main's known-red list.
- [ ] **Step 10: Commit** `docs(orangepi): the admin tab and first-update steps (SOMET-NNN)`
