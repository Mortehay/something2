# Seed/Export Plan 5: Git Strip and Buttons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The Seed / Export tab shows the repo's git state at the top. It offers **Pull**, **Commit seeds** and **Push** buttons, so moving data between PCs needs no terminal.

**Architecture:**
- The backend container has no `.git` and no SSH key, and that stays true.
- A small host-side helper runs as plain Node with no dependencies (`tools/git-helper/`). It listens on a unix socket at `backend/run/git-helper.sock`. The container already sees that path as `/app/run/git-helper.sock` through the existing `./backend:/app` bind mount, so no compose change and no container recreate are needed.
- The helper runs only a fixed allow-list of git operations in the repo it lives in, using `execFile` with argument arrays. Every call carries a token from a 0600 file next to the socket.
- The backend proxies admin-only routes to it and records runs in `seed_export_runs`. That table's `action` CHECK already allows `git_pull`, `git_commit` and `git_push`.
- The frontend renders the strip, the buttons, confirm dialogs that show exactly what will happen, and hints in the status popups.

**Spec:** `docs/superpowers/specs/2026-10-18-seed-export-tab-design.md`, section "Git strip and buttons". Option 1 (host helper) is the spec's recommendation.

## Global Constraints
- **Allow-list only.** There is no endpoint that runs arbitrary git commands or shell. Only these operations exist: `status`, `fetch`, `pull`, `commit`, `push`. Arguments are fixed. The only caller-supplied value is the commit message, and it is passed as a separate `-m` argv element, never interpolated.
- **Pull:** `git pull --ff-only`. Refuse when the working tree is dirty, anywhere.
- **Commit seeds:** stage only `backend/seeds/` (`git add -- backend/seeds`), then commit with the editable message. The default message is `seed export: <groups> from <pc>`. Refuse when nothing under `backend/seeds/` is staged after the add. Never stage anything else.
- **Push:** `git push origin <current branch>`. Never `--force`. Refuse when behind upstream ("pull first").
- **The push key never enters the web server.** The helper uses the host user's own git and SSH setup.
- **Transport:**
  - The default is a unix socket at `<repo>/backend/run/git-helper.sock`.
  - Docker Desktop cannot share unix sockets across bind mounts, so the fallback is TCP on `127.0.0.1:<GIT_HELPER_PORT>`, which the backend reaches as `host.docker.internal:<port>`.
  - Both transports require the token from `backend/run/git-helper.token` (0600, regenerated at each helper start).
  - `backend/run/` is gitignored and dockerignored.
- **One operation at a time.** The helper serialises calls, and a second concurrent call gets 409 `busy`.
- **Missing helper is a normal state.** If the helper is not running, the tab shows "Git buttons need the git helper: run `make git-helper`", and everything else keeps working.
- **Never run git against the shared checkout from tests.** Tests create temp repos: a bare origin plus a clone.
- **Workflow:** a worktree on branch `feat/seed-export-plan5`. Commits are `type(scope): summary (SOMET-642)` with the Co-Authored-By trailer. Never push. DB tests use the scratch DB with both env vars set.

## Review Focus
1. **Message injection:** a commit message with quotes, newlines, `$(...)`, a leading `-` or `--amend` is committed literally and never interpreted. → Task 1 test.
2. **Commit while dirty outside seeds:** "Commit seeds" commits only seeds. Other dirty files stay unstaged and untouched, and the strip keeps warning about them. → Task 1 test.
3. **Pull while dirty:** refused, and nothing changes. → Task 1 test.
4. **Push while behind:** refused with "pull first". A diverged branch is refused with a clear message, never force-pushed. → Task 1 test.
5. **Helper down mid-click:** a clear 503 `helper_unavailable`, a toast in the UI, and no crash. → Task 2 and Task 3 tests.

---

### Task 1: The host-side git helper
**Files:**
- `tools/git-helper/server.js` (stdlib only)
- `tools/git-helper/gitOps.js`: the pure allow-list operations, testable without the server
- `tools/git-helper/README.md`
- Makefile targets:
  - `git-helper`: starts it in the background with a pid file and log in `backend/run/`, and prints where it listens.
  - `git-helper-stop`: kills it by pid, then verifies with `ss`.
  - `git-helper-status`.
- `.gitignore` and `.dockerignore`: add `backend/run/`.

**Interfaces:**
- The repo root is `path.resolve(__dirname, '../..')`. Refuse to start if that is not a git work tree.
- HTTP over the socket:
  - `GET /status` returns `{ branch, upstream, ahead, behind, seedsDirty: [paths], otherDirty: [paths], headSubject, lastFetchAt }`. `lastFetchAt` is the mtime of `.git/FETCH_HEAD`.
  - `POST /fetch`
  - `POST /pull`
  - `POST /commit` with body `{ message }`
  - `POST /push`
- Every request needs the header `X-Git-Helper-Token` (constant-time compare). A missing or wrong token gets 401.
- Results: each operation returns `{ ok, op, output, status }` with stdout and stderr trimmed and capped at 4 KB. Refusals are 409 `{ error: '<code>', message }`, with these codes: `dirty`, `nothing_to_commit`, `behind`, `diverged`, `no_upstream`, `busy`.
- Git runs with `GIT_TERMINAL_PROMPT=0`. Each call has a 60s timeout. If credentials are needed and unavailable, the call fails with a clear message instead of hanging.
- Startup:
  - Create `backend/run/` with mode 0700, write the token file with mode 0600, and remove a stale socket file.
  - On SIGTERM, close the server and remove the socket.
  - Listen on the unix socket by default, or on TCP 127.0.0.1 when `GIT_HELPER_PORT` is set.

**Tests:** `tools/git-helper/gitOps.test.js` (node --test), using temp repos: a bare origin plus two clones, so "the other PC" can push.
- status counts and paths
- commit stages only `backend/seeds`
- injection-safe message (Review Focus 1)
- pull refused when dirty
- `--ff-only`
- push refused when behind or diverged
- `nothing_to_commit`
- concurrent call gets busy
- token required (server-level test over a temp socket)

Commit: `feat(git-helper): allow-listed host helper for seed git actions (SOMET-642)`.

### Task 2: Backend proxy routes
**Files:**
- `backend/src/services/gitHelperClient.js`:
  - uses the socket path `/app/run/git-helper.sock`, or `GIT_HELPER_URL` for the TCP fallback, and the token from `/app/run/git-helper.token`;
  - read the token at call time, because it changes when the helper restarts.
- Routes in `backend/src/api/seedExportRoutes.js`, all admin-only:
  - `GET git/status`
  - `POST git/fetch`
  - `POST git/pull`
  - `POST git/commit` with `{ message }`
  - `POST git/push`

**Interfaces:**
- Status degrades to `{ available: false, reason: 'helper_unavailable', hint: 'Run make git-helper on this PC' }` when the socket or token is missing or the connection is refused.
- Actions return 503 `helper_unavailable` in the same case, and pass refusals through as 409 with the helper's code.
- Each action records a `seed_export_runs` row:
  - `action`: `git_pull`, `git_commit` or `git_push`
  - `group_id`: `'git'`. The column is plain `text NOT NULL` with no CHECK, so no migration is needed.
  - The summary holds the short output, for example the new HEAD.
- The default commit message comes from a backend helper: `seed export: <groups changed under seeds/sync> from <SEED_PC_LABEL>`. Group names are derived from the changed `backend/seeds/sync/<group>.json` paths in status. Expose it in status as `suggestedMessage`.
- A git action is refused (409 `busy`) while a seed-sync job runs, and the reverse also holds. Reuse the jobs single-flight `isBusy`.

**Tests:** route tests with a fake helper. The fake is a test server on a temp unix socket.
- status available and unavailable
- each action's pass-through
- 409 codes
- 503 when down
- admin-only
- the run row is written
- the suggested message
- busy interplay with jobs

Commit: `feat(seed-sync): git routes via the host helper (SOMET-642)`.

### Task 3: Frontend git strip, buttons and hints
**Files:**
- `frontend/src/games/something2/SeedGitStrip.jsx` (new)
- `useSeedExport.js`: `useGitStatus` polls every 15s while the tab is visible and refetches after every action; `useGitAction`
- `seedExportModel.js`: `gitHints(status, groups)`
- `SeedExportAdmin.jsx` and `SeedStatusPopup.jsx`

**UI:**
- **Strip:** `<branch> · ↑ahead ↓behind · N seed changes` and, when other files are dirty, a warn chip "M changes outside seeds/ — won't be committed". Show the last fetch time and a Fetch button.
- **Buttons:** Pull, Commit seeds and Push. Each opens a confirm dialog listing exactly what will happen:
  - Pull: "fast-forward N commits from origin/<branch>"
  - Commit: the file list under seeds/ plus an editable message prefilled from `suggestedMessage`
  - Push: "N commits to origin/<branch>"
- **Disabled states, each with its reason as a tooltip:**
  - Pull when dirty
  - Commit when there are no seed changes
  - Push when behind or ahead is 0
  - all of them while any job runs
- **Helper unavailable:** the strip shows the hint, and the buttons are hidden.
- **Hints in the status popups** (`gitHints`):
  - "git is newer, but you're N commits behind — pull first" when a group reads git-newer and behind > 0
  - "exported, not committed yet" when the group's sync file is in `seedsDirty`
  - "committed, not pushed (N ahead)"

**Tests:**
- model tests for `gitHints` and the disabled-reason logic
- render tests for the strip states: available, unavailable, dirty-outside and behind

Commit: `feat(seed-sync): git strip, buttons and hints in the tab (SOMET-642)`.

### Task 4: Verification (no product code unless a defect)
- Start the real helper on this PC (`make git-helper`). In the browser, open the tab with fixture auth (see the dev-run-browser-verify memory) and check that the strip shows the real repo state. Do NOT click Pull, Commit or Push on the shared checkout.
- Run the end-to-end action check against a temp clone instead: start a second helper instance with its root overridden by `GIT_HELPER_ROOT=<temp clone>`, which only tests may set, and drive commit, push and pull through the backend client.
- Stop the helpers by pid, and leave no socket behind.
- Post a Plane comment with the evidence.

## Out of scope
- Git credential setup on PCs.
- Branch switching and conflict resolution. Refusals tell the user to resolve them in a terminal.
