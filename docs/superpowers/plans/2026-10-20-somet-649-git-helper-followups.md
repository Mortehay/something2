# SOMET-649: Git Helper Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the items deferred from SOMET-642's final review:
- a helper stopped mid-action no longer reports a landed push as failed;
- every seed mutation is serialised against git actions;
- the git strip stops showing wrong or confusing text in edge states.

**Architecture:** These are small changes inside the three layers Plan 5 built:
- the host helper (`tools/git-helper/`);
- the backend proxy (`backend/src/api/seedExportRoutes.js`, `backend/src/services/gitHelperClient.js`, `backend/src/services/seedSync/jobs.js`);
- the frontend strip (`frontend/src/games/something2/SeedGitStrip.jsx`, `seedExportModel.js`, `useSeedExport.js`, `SeedExportAdmin.jsx`).

**Spec:** `docs/superpowers/specs/2026-10-18-seed-export-tab-design.md`, section "Git strip and buttons", plus the SOMET-649 ticket text.

## Global Constraints
- Everything from Plan 5 still holds:
  - allow-list only;
  - pull `--ff-only`;
  - commit stages only `backend/seeds/`;
  - push never forces and always uses `refs/heads/X:refs/heads/X`;
  - the token never leaves the PC;
  - one git op at a time.
- Tests never run git against a real repo. They use temp repos under os.tmpdir() only.
- DB tests set BOTH `DATABASE_URL` and `TEST_DATABASE_URL` to `game_db_seedsync`. Derive the URL from `.env`'s DATABASE_URL by swapping host to localhost, port to 15432 and the db name; `.env` has no POSTGRES_USER. Never use game_db, and never print secrets.
- Worktree `.worktrees/wt-649`, branch `feat/somet-649`. Never touch the shared checkout. Never push.
- Commits use `type(scope): summary (SOMET-649)` and end with the Co-Authored-By trailer.

## Review Focus
1. **Stop during push:** `make git-helper-stop` while a push runs. The push completes, the helper exits after it, and the backend gets the real result. The helper never hangs forever (cap). → Task 1.
2. **Data-group export racing a commit:** a single-group export or seed started while a git commit runs gets 409 busy. A git action started while a data-group export runs also gets 409. → Task 2.
3. **Helper up but git broken:** when the helper answers 500 for status, the tab says git failed, not "run make git-helper". → Task 2 and Task 3.
4. **Second helper start while one is live:** it refuses and leaves the live socket and token intact. → Task 1.
5. **Detached HEAD or no upstream:** the strip shows meaningful text, never "null", and Push is not offered as "Nothing to push". → Task 3.

---

### Task 1: Helper hardening
**Files:** `tools/git-helper/server.js`, `gitOps.js`, `gitOps.test.js`, `README.md`, `Makefile`.

**Behaviour:**
- **SIGTERM/SIGINT drain:**
  1. Stop accepting new connections. Requests arriving during the drain get 503 `{error:'shutting_down'}`.
  2. Wait for the in-flight op (the `busy` flag) to finish, capped at 65s, slightly over the per-call git timeout.
  3. Let its response flush, then remove the socket and exit 0. If the cap is reached, kill the git child, then exit 1.
- **Live-socket probe at start:** before unlinking an existing socket, try to connect to it.
  - If the connect succeeds, refuse to start: exit 1 with "a git helper is already listening on <path>". Do not rewrite the token.
  - ECONNREFUSED or ENOENT means the socket is stale: remove it and continue.
- **Commit:** pass `--cleanup=verbatim`, so the message is byte-exact.
- **Push:** run `git fetch origin` first, then compute ahead/behind against `refs/remotes/origin/<branch>` (not `@{u}`).
  - Refuse `behind` / `diverged` from those fresh counts.
  - If `origin/<branch>` doesn't exist, refuse `no_upstream`.
  - A fetch failure returns the git failure (502).
- **Pull:** also fetches first. Its diverged/behind decision comes from fresh counts.
- **Makefile `git-helper-stop`:**
  1. SIGTERM, then wait up to 70s for the pid to exit.
  2. If it is still alive, print an error and exit non-zero; keep the pid file.
  3. Verify with `ss` scoped to this run dir's absolute socket path (and `GIT_HELPER_PORT` if set).
  4. Print "stopped" only when both checks pass.
- **README:** the TCP fallback (`GIT_HELPER_PORT`) is for Docker Desktop only. On native-Linux Docker, 127.0.0.1 is not reachable from the container, so use the socket.

**Tests:** temp repos and temp run dirs, `node --test tools/git-helper/*.test.js`:
- **drain:** a fake slow op is in flight, SIGTERM is sent to a spawned server, the response completes, then the process exits 0 and the socket is gone;
- **second start:** refused while the first is live, and the first's token file is unchanged;
- **stale socket:** a stale socket file is replaced;
- **verbatim message:** a message with a double blank line and trailing spaces is stored byte-exact;
- **push after fetch:** push is refused `behind` when origin moved and the local tracking ref was stale before the push;
- **no upstream:** push gets `no_upstream` when origin has no such branch.

Commit: `fix(git-helper): drain on stop, refuse a live socket, push and pull fetch first (SOMET-649)`.

### Task 2: Backend serialisation and error mapping
**Files:**
- `backend/src/api/seedExportRoutes.js`
- `backend/src/services/gitHelperClient.js`
- `backend/src/services/seedSync/jobs.js` (only if needed)
- `backend/tests/seed_export_git_routes_db.test.js`
- the existing data-group route test file

**Behaviour:**
- **Data-group hold.** The synchronous single-group export and seed routes (the `refuseIfBusy()` callers) take `jobs.holdExternal` for their whole duration and release it in `finally`.
  - A git action started meanwhile gets 409 busy.
  - A data-group action started during a git action already gets 409. Keep that.
  - Use the existing hold API. Do not change job semantics.
- **Helper status mapping.** Only 200, 409 and 502 pass through unchanged. Any other status from the helper becomes 502 `{error:'helper_error', message:'The git helper returned an error'}`.
  - Keep the helper's raw detail in the run row and server log, never in the response.
  - For `GET git/status`, a helper 500 gives `{available:false, reason:'helper_error', hint:'The git helper is running but git status failed — check the helper log (backend/run/git-helper.log)'}`.
  - `helper_unavailable` stays for socket, token or connection failures.
- **Test names.** Fix the names that promise more than they test:
  - "socket or token missing" must test both cases: a valid token with the socket missing, and the socket present with the token missing.
  - "a bad body from the helper stays a 400" must either test what it says or be renamed.

**Tests:** route tests with the fake helper, DB tests on the scratch DB:
- a data-group export while a git action is held gets 409, and the reverse;
- the hold is released after a failing export;
- a helper 500 maps to 502 `helper_error` with no raw message in the body;
- a status 500 gives `reason:'helper_error'`;
- the corrected missing-socket and missing-token cases.

Commit: `fix(seed-sync): serialise data-group actions with git, map helper errors (SOMET-649)`.

### Task 3: Frontend edge states
**Files:**
- `frontend/src/games/something2/SeedGitStrip.jsx`
- `seedExportModel.js`
- `useSeedExport.js`
- `SeedExportAdmin.jsx`
- their tests under `__tests__` / `frontend/src/ui/__tests__`

**Behaviour:**
- **While a data-group export or seed request is pending**, all git buttons are disabled with the reason "A seed export or seed is running". This covers `exportGroup.isPending`, the per-group seed mutation, and the existing job-running state.
- **`reason:'helper_error'` (Task 2)** shows "Git helper is running but git failed — check backend/run/git-helper.log". It does not show the `make git-helper` text. Buttons are hidden.
- **Detached HEAD** (`branch` null): the strip shows "detached HEAD". Pull, Commit and Push are disabled with "Not on a branch — switch branch in a terminal".
- **No upstream** (`upstream` null, branch set):
  - the strip shows "no upstream";
  - Push is disabled with "No origin/<branch> yet — push it once from a terminal";
  - Pull is disabled with the same reason;
  - Commit stays enabled.
- **Pull dialog copy:** "Fetch and fast-forward from origin/<branch>", plus "(N new commits known so far)" when behind > 0.
- **Dialog reset:** when status becomes unavailable or helper_error, any open dialog is cleared. It does not reopen when the helper comes back.

**Tests:**
- model tests for every new disabled reason and its precedence (busy > pending > detached > no-upstream > diverged > dirty > behind);
- strip text for detached and no-upstream;
- pull confirm text;
- a render test for helper_error;
- a test that the dialog state resets. Extract a tiny pure helper if needed, because the vitest env has no DOM.

Commit: `fix(seed-sync): git strip edge states and pending guard (SOMET-649)`.

### Task 4: Real-stack verification (no product code)
- This runs after the branch merges, or uses the main checkout only with the user's go-ahead, because the compose backend serves the main checkout.
- `make git-helper` in the main checkout, then GET `/api/seed-export/git/status` through the compose backend. It returns `available:true` with branch `main`.
- `make git-helper-stop` reports stopped, and nothing is left listening.
