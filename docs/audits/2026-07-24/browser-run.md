# Browser verification run — 2026-07-24

Driven live against the running `something2` stack via Chrome DevTools MCP
(headless Chrome on `127.0.0.1:29222`), per the `audit-browser` skill.

Preconditions checked before starting:

- Frontend `http://localhost:15173` → 200
- Backend `http://localhost:13101/api/health` → 200
- `docker ps --filter name=something2` → `something2-backend-1`,
  `something2-frontend-1`, `something2-db-1`, `something2-redis-1`, plus
  `something2-sprite-gen-1` and `something2-game-engine-1` all up.
- Pre-audit dump present: `/tmp/something2-audit/game_db-pre-audit.sql` (7.8 MB).

**Context noted before running:** `JWT_SECRET` was rotated shortly before this
run and the backend now has a boot-time guard rejecting a missing, placeholder,
or under-32-character secret. F-038 (weak JWT secret) and F-032 (sprite-gen
tests writing to the live store) are already `status: fixed` in
`findings.json` and were not re-tested as open findings — F-038's fix is,
however, exercised below as a regression check.

---

## Flow A — auth and authorization

All cases were driven either through the real UI (register/login/logout) or
via `evaluate_script` issuing `fetch`/`WebSocket` calls from the page's own
origin (`http://localhost:15173`), so cookies/headers match a real client and
CORS applies exactly as it would for a player. Test account:
`audit_flowA_user1` (created fresh through the UI register form; role reported
back as `player`).

### Positive path

| Step | Asserted | Observed | Verdict |
|---|---|---|---|
| Register via UI (`Need an account? Register` → fill → Register) | Account created, auto-authenticated, role is `player` even though nothing in the UI can request a role | `POST /api/auth/register` → `201`, decoded JWT payload `{user_id, username, role:"player", tv:1, ...}`; UI moved straight to the Worlds/game shell | Pass |
| `GET /api/auth/me` with the fresh token | `200` with `{id, username, role}` | `200`, `{"id":452,"username":"audit_flowA_user1","role":"player"}` | Pass |
| Sign out via UI button | localStorage token cleared, UI reverts to the Sign-in form | `localStorage.getItem('something2.authToken')` → `null`; snapshot showed the Sign-in form again | Pass |
| Log back in via UI (username + password, `Log in`) | Re-authenticates with the same account, returns to the Worlds shell | Succeeded, worlds list rendered again, no console errors beyond the artifacts of the negative tests run earlier in the same tab (see below) | Pass |
| `POST /api/auth/logout-all` (separately, on the role-injection test account, see below) | `200 {ok:true}`, and the token used to call it is itself invalidated afterward | `200 {"ok":true}`; same token then rejected by both `/api/auth/me` and a live WS upgrade (see negative table) | Pass |

### Negative table (skill's Flow A table)

| Attack | Expected | Observed | Verdict |
|---|---|---|---|
| Player token against an admin-only route (`POST /api/tile-types` with the player's own bearer token) | `403` | `403 {"error":"admin role required"}`, no row created | Pass — not exploitable |
| `{"role":"admin"}` in the register body (`POST /api/auth/register` with `role:"admin"` in the JSON body) | Account created as `player` | `201`, response `user.role === "player"`; server-side role literal is hardcoded to `'player'` in the INSERT, body value is ignored | Pass — not exploitable |
| JWT with the signature byte-flipped (took a real valid token, flipped one base64 char in the signature segment) | `401` | `401 {"error":"invalid token"}` | Pass — not exploitable |
| JWT with `exp` in the past (signed inside the backend container with the live `JWT_SECRET`, `exp` set to now − 1h) | `401` | `401 {"error":"invalid token"}` | Pass — not exploitable |
| Token reused after `logout-all` | `401` | First call bumps `token_version`; the pre-bump token then gets `401 {"error":"token revoked"}` from `/api/auth/me` | Pass — not exploitable |
| Login with a wrong password | `401`, no token issued | `401 {"error":"invalid credentials"}`, response body has no `token` field | Pass — not exploitable |
| Login attempted 20 times in a row (fresh username, 20 sequential `POST /api/auth/login`) | Rate limited, not 20×401 | Attempts 1–10 → `401`; attempts 11–20 → `429` | Pass — not exploitable |

No case in the negative table succeeded. Flow A found **zero new
auth-bypass vulnerabilities** — the auth surface held up against every
attack the skill specifies.

### F-038 regression check (old placeholder JWT secret)

Per the task brief, this is now a regression test rather than a fresh finding:
F-038's fix is the `JWT_SECRET` rotation plus the boot-time guard in
`backend/src/auth/assertJwtSecret.js`. The placeholder value it guards against
(`replace-me-with-a-long-random-string-min-32-chars`, taken from that guard's
own `KNOWN_PLACEHOLDERS` set — no `.env.example` file exists at the repo root
today, so the guard source is the authoritative record of the placeholder
text) was used to sign a fresh admin-claiming token (`user_id:1, role:"admin"`)
locally, without touching the live secret.

| Surface | Expected after rotation | Observed |
|---|---|---|
| `GET /api/auth/me` with the old-secret token | `401` | `401 {"error":"invalid token"}` |
| `POST /api/tile-types` (admin route) with the old-secret token | `401` (rejected before the admin-role check even runs) | `401 {"error":"invalid token"}`, no row created |
| WS upgrade to `ws://localhost:13101/authority?token=<old-secret token>` | Connection refused | `onerror` fired, no `onopen`, no handshake completed |

**Result: no regression.** The rotated secret is enforced on both the HTTP
auth path and the co-hosted WS authority upgrade path (`backend/src/index.js`
starts `attachAuthority` on the same listening socket, `/authority`). This was
the most important check in this phase and it passed cleanly.

---

## Static findings arbitrated in Flow A

Findings were considered in scope for Flow A if their `verification` field
named an auth/authorization check reachable through login, tokens, or route
guards (as opposed to crash-safety, resource limits, or game-economy checks,
which belong to Flows B–D and the general arbitration sweep). Only one
qualified:

### F-021 — token-revocation check duplicated between HTTP middleware and WS upgrade (P3, dry)

The finding's own text already anticipated the outcome: *"They agree today
and nothing is currently broken, which is why this is recorded at P3 rather
than higher."* Its `verification` field specifies the exact browser check:
bump a user's `token_version` and assert both an HTTP request and a live WS
upgrade reject the stale token.

Ran it: registered a second account, captured its token, called
`POST /api/auth/logout-all` with that token (bumping `token_version`), then
reused the pre-bump token against both `GET /api/auth/me` (→ `401 token
revoked`) and a live WS upgrade to `/authority?token=...` (→ rejected before
handshake). The two independent checks currently agree — no divergence
observed.

**Verdict: confirmed in browser.** Severity stays at P3 (this was never a
live vulnerability — the finding is about missing regression-test coverage
for a duplicated check, and the browser run corroborates that duplication has
not yet caused drift). `verification` field updated via `store.merge` to
record the browser confirmation; no status change.

No other static finding's `verification` names a browser-checkable
auth/authorization case — F-001, F-012, F-015 name valid-token setup but test
crash/resource-limit behavior (Flow B/C territory); F-002 and F-009 test
missing input/size limits, not an authn/z control; F-019 is a WS
game-economy authorization gap that belongs to Flow D; F-023/F-024/F-025/F-028
are frontend UI-state findings for Flow B/C; F-041 is a static-only
repo/config check. These are left for their respective flows or the general
arbitration sweep.

---

## New findings emitted by Flow A

None. Every case in the skill's Flow A table, plus the F-038 regression
check, held. No `source: 'browser'` findings were filed for this flow.

---

*(Flows C, D and the remainder of the arbitration sweep are run by later
agents, which append their sections below.)*

---

## Flow B — admin CRUD

Driven live against the running stack via Chrome DevTools MCP, continuing in
the same authenticated admin session Flow A left behind (re-logged-in as
`admin` after Flow A's negative-auth testing, since the rotated `JWT_SECRET`
invalidated the prior session). Preconditions re-checked: frontend/backend
health both `200`, all six `something2-*` containers up, and the pre-audit
dump still present at `/tmp/something2-audit/game_db-pre-audit.sql` (7.8 MB,
unchanged).

**Method note:** per the skill, most checks were driven through the real UI
(fill/click) so React state and toasts render exactly as an admin would see
them; the empty-field and oversized-name edges of check 3/4, and a handful of
raw status/body assertions, were driven with `evaluate_script` issuing `fetch`
from the page origin, matching Flow A's approach. All seven admin panels'
worth of `list_console_messages` output was checked after every mutating
step; no uncaught exception was observed at any point in this flow.

**Fixtures:** all destructive/edge-case testing used freshly created rows
prefixed `AuditFixture*` / `AuditFlowB*`, all deleted again before this flow
ended. `grass` (tile type) and `Tree` (entity type) were never edited,
deleted, or sent to sprite/tile generation — confirmed both still carry their
original `image`/`render_mode` at the end of the run. Generation was
triggered exactly twice (one tile texture, one entity image), both against
the `auditfixturetile` / `AuditFixtureCritter` fixtures, each ~66s on the CPU
backend as expected — read as normal, not a hang.

### Per-panel results (checks 1–7 from the skill)

| Check | Maps (worlds) | Tile Types | Entity Types | Item Types |
|---|---|---|---|---|
| 1. Create valid → appears without reload | Pass | Pass | Pass | Pass |
| 2. Duplicate name → visible error | **Fail** — silently accepted, HTTP 201, no unique constraint (new finding F-044) | Pass — toast shown, though backend returns a raw 500 rather than 409 | Pass — same 500-but-toasted pattern | Pass — toast shown (backend 500 too) |
| 3. Empty required fields → blocked client-side AND API-side | Pass (client blocks; direct `POST /api/worlds` with `name:""` → 400) | Pass (400 `"Name and color are required"`) | Pass (400 `"Name and color are required"`) | Pass (400 `"Name is required"`) |
| 4. 10,000-char name → rejected, not truncated/500 | **Fail** — accepted verbatim, HTTP 201 (text column, no cap) | **Fail** — HTTP 500, raw Postgres varchar(255) overflow | **Fail** — same 500 pattern (varchar(255)) | **Fail** — accepted verbatim, HTTP 201 (text column, no cap) |
| 5. Edit → visible + survives reload | Pass | Pass | Pass (see note below on a self-inflicted false start) | Pass |
| 6. Delete → gone + dependent view degrades | Pass — Maps panel's creature-type checkbox grid drops a deleted entity type with no crash | Pass — no crash; only known dependent (an entity's `spawn_tiles`) degrades exactly as F-027 describes | Pass — no crash | Pass — no crash |
| 7. Asset upload / generation trigger | N/A — no asset/generation UI in this panel (terrain "Regenerate"/"Re-roll" are procedural, not AI asset jobs, and were exercised incidentally under F-005/F-008 below) | Pass — job accepted, UI showed `Generating… (0/0)` → preview → `Approve texture`, approve persisted `render_mode:"image"` | Pass — identical lifecycle, approve persisted `render_mode:"static"` | N/A — no asset/generation UI in this panel |

Check 4's failure is one coherent defect, not four independent ones: it comes
down to which Postgres column type each table's `name` happens to use
(`varchar(255)` for tile_types/entity_types → raw 500; unbounded `text` for
item_types/worlds → silent unlimited acceptance). Filed as **F-043** (new,
P2). Check 2's Maps-panel gap is a second, smaller defect — `worlds.name` has
no unique constraint at all, unlike the other three catalogs — filed as
**F-044** (new, P3, since world identity is by UUID everywhere it's actually
used, confirmed by reading `MapsAdmin.jsx`'s link-dropdown `option value`).

**Check 5 false start (not a finding):** the first two attempts to edit
`AuditFixtureCritter`'s Spawn Chance to `0.33` silently failed to submit — no
network request fired at all. Root cause: the `<input type="number"
step="0.05">` field's native HTML5 constraint validation blocked the browser
from submitting the form (`0.33` isn't a multiple of the step; DevTools
showed `invalid="true"` and a native "nearest valid values are 0.3 and 0.35"
tooltip). Retrying with a step-aligned value (`0.35`) submitted normally, and
persisted across a reload. This was my test data being invalid input, not a
product defect — recorded here only so it isn't a mystery in the working
notes.

### Static findings arbitrated in Flow B

Every `source: 'static'` finding whose `verification` field named a check
reachable through one of the four admin panels was run. All eight were
**confirmed in browser** — none demoted. `verification` was updated on each
via `store.merge` to record exactly what was run; severities are unchanged.

- **F-003** (item value never written, P1) — `POST /api/item-types` with
  `{"value":25}` returned the row with `value:0`; confirmed the admin form
  also has no field for it at all.
- **F-004** (bounded-world spawn OOB, P1) — settled decisively. Set
  `entry_spawn:{x:99999,y:99999}` on a 24×24 world (`PUT` accepted it with no
  validation, 200), joined that world over a live WebSocket as a fresh player,
  and sent 41 movement-input frames over ~2 seconds. The player spawned at
  `(99999,99999)` and **did not move by even one pixel** across 50 state
  frames. This was not an assumption — the player is provably, completely
  stuck, with no in-game recovery. Backend stayed healthy throughout (no
  crash, no restart).
- **F-005** (entity-type rename orphans world references, P1) — built a
  disposable bounded world with one allowed creature type; re-roll placed 5/5
  as a baseline. Renamed the entity type via `PUT` (accepted, no reference
  check). Re-rolling again on the same world returned `HTTP 200
  {"placed":0}` — the exact silent-failure shape the finding describes.
- **F-009** (50MB global body limit, P2) — settled the mechanism without the
  full stress test the finding's own `verification` specifies (20 concurrent
  50MB requests), per the audit brief's explicit instruction not to risk
  exhausting the host. Instead: one unauthenticated ~44MB JSON POST to
  `/api/health` (a route that accepts no body and needs no auth) was fully
  buffered and parsed *before* the 404 was produced, and `something2-backend-1`
  RSS jumped from ~37MiB to ~181MiB for that single request and had not
  settled several seconds later. This proves the claim's core mechanism (the
  global limit runs pre-auth, pre-routing, on every path) with a real
  measurement; I did not attempt the 20-concurrent variant. Container stayed
  up (`RestartCount: 0`) throughout.
- **F-023** (MapsAdmin swallows `worldsError`, P1) — patched `fetch` via
  `navigate_page`'s `initScript` to reject only `/api/worlds` while leaving
  every other endpoint (including auth) working, then opened the Maps tab.
  After the query settled it rendered "No bounded maps yet. Generate one
  above." — no toast, no error banner, nothing in the console.
  Indistinguishable from a genuinely empty catalog, exactly as claimed.
- **F-024** (generic vs. specific mutation errors, P2) — opened Edit on a
  fresh entity type, deleted that same row via a background request
  (simulating a second admin's tab), then clicked Save Changes in the
  still-open first tab. Backend correctly returned `404 {"error":"Entity type
  not found"}`; the toast shown read the generic hardcoded `"Update failed:
  Failed to update entity type"` — the specific, actionable reason was
  discarded exactly as claimed.
- **F-025** (no stat validation, P2) — edited the real `Wolf` entity type's
  Max HP to `-50`. No client-side error, `PUT` returned 200, and a follow-up
  `GET` confirmed `max_hp:-50` persisted with no error surfaced anywhere.
  Reverted `Wolf` to `max_hp:12` immediately after so later flows aren't
  handed a broken shared fixture.
- **F-027** (orphaned `spawn_tiles`, P2) — created an entity type with
  `spawn_tiles:["auditfixturetile"]`, deleted that tile type, reloaded, and
  reopened the entity's edit modal: the `auditfixturetile` checkbox was
  simply gone with no warning, while `GET /api/entity-types` confirmed the
  row's `spawn_tiles` array still held the dangling string.

**On F-027 vs. F-005 (task asked whether these are one defect):** they are
the same root defect *class* — a name-keyed reference into an admin catalog
with zero integrity checking on rename/delete — but they are not the same
finding and I did not merge them. They differ in trigger (F-005: renaming an
*entity type* breaks `worlds.allowed_creature_types` / `world_creatures.type`;
F-027: deleting a *tile type* breaks `entity_types.spawn_tiles`), in the
table/column pair involved, and in consequence (F-005 silently zeroes
creature placement and can wipe village guards; F-027 silently drops object
spawn density on that tile with no gameplay-visible signal at all, since
nothing else reads the stale name after the checkbox disappears). A correct
fix for one would not by itself fix the other — they'd share a fix *pattern*
(referential check or cascade on catalog rename/delete), not a fix
*location*. Recommend keeping them as two separate Plane tasks tagged with a
shared root-cause note, rather than merging.

### New findings emitted by Flow B

Two, both `source: 'browser'`, both backend-api:

- **F-043** (P2, user-logic) — none of the four admin-catalog create routes
  validates name length; a 10,000-character name either 500s (tile-types,
  entity-types — `varchar(255)` columns, raw Postgres overflow error
  uncaught) or is silently accepted without limit (item-types, worlds —
  unbounded `text` columns). Neither matches the "rejected cleanly" behavior
  the checklist (and any reasonable admin) would expect.
- **F-044** (P3, kiss) — `worlds.name` has no unique constraint, so creating
  a world with a name that duplicates an existing one succeeds silently
  (201, no error), unlike the other three catalogs. Confirmed the live dev
  DB already had duplicate-named worlds from prior seed data before this
  session touched anything. Not a data-integrity risk since every actual
  reference (links, joins) resolves by world UUID, not name — purely an
  admin-usability gap, hence P3.

That's a real, non-trivial yield from this phase: two static P0/P1 findings
that were filed on inference (F-004, F-005) are now proven with a live
reproduction instead of a plausible story, one P2 (F-009) got a real
measurement instead of an inferred consequence, and two defects (F-043,
F-044) existed only because static review doesn't drive four separate admin
forms with the same edge-case input and compare what actually comes back.

No finding was demoted in this flow — everything arbitrated held up exactly
as claimed. No assertion needed a flake retry.

---

## Flow C — game loop

Driven against the live stack via Chrome DevTools MCP, mostly as the admin
account (which gets the world picker instead of auto-join, needed to select
specific worlds by name) plus two fresh player accounts
(`audit_flowC_user1`, `audit_flowC_user2`) for the reconnect and two-client
checks. Movement was driven by dispatching real `keydown`/`keyup`
`KeyboardEvent`s at `window` (the same listener the game itself attaches
to), not synthetic position writes.

### 1. Canvas render, no accumulating console errors — Pass

Fresh login → auto-join into `Overworld` rendered the canvas correctly
(HUD, terrain, HP/gold) with only benign `[debug]`/`[info]` console lines
and one pre-existing a11y warning (missing `id`/`name` on form fields, not a
Flow C concern). No uncaught exceptions in any clean session.

While chasing this check I found and **reproduced twice, deterministically**
a real defect: signing out and back in (or, per the app's own code comments,
having a token silently revoked mid-session and re-authenticating) without a
full page reload leaves the canvas element permanently blank. Filed as
**F-045** (P1, `frontend-game`, browser) — see below.

### 2. Movement in four directions, camera follow, position persistence — Pass

Held `w`/`a`/`s`/`d` individually in a creature-free bounded world
(`MerchantVerify`). Each clean, uninterrupted single-key hold produced
movement on exactly that axis (e.g. `d` for 1.5s: x +200, y unchanged) with
the camera keeping the player centered while terrain scrolled underneath —
correct camera-follow. Diagonal-looking deltas observed elsewhere turned out
to be combat knockback/death-respawn from nearby wildlife in "Overworld"
(unbounded, ambient creatures despite `creature_count:0` in the worlds
table — chunk-based spawning, not the bounded-world roll), not a movement
bug; a clean re-run in a creature-free world confirmed single-axis fidelity.

Position persistence confirmed two ways: (a) reloading the page and
re-entering `MerchantVerify` restored the exact last position
(`60, 1518`); (b) killing and rejoining the authority socket (§6) also
restored the same exact position server-side.

### 3. Wall collision, no tunnelling — Pass

Held `a` toward `MerchantVerify`'s west boundary in three consecutive 5s
pushes. Speed decayed as the player approached the wall (152 px/s → 35 px/s
→ 12 px/s) and then fully stopped at `x=60`; a further push produced zero
further movement. No tunnelling through the boundary at any point.

### 4. Doorway transition + return trip — Pass

`BoundedArena` (24×24) has doorway links on all four edges to `test2`
(2560×2560). Walked from `BoundedArena` through its `S` doorway into
`test2`: console logged `chunked game loop started (world test2-id)`, tiles
rendered with correct textures immediately (no fallback-color flash), no
console errors. Located the exact return doorway columns via the chunk API
(`GET /api/worlds/:id/chunk?cx=19&cy=0` /
`cx=20&cy=0`, row 0 = `map_wall` everywhere except columns 1279–1281 =
`map_doorway`, matching `arrivalPoint()`'s `midCol`/`DOORWAY_TILES=3`
geometry in `backend/src/services/mapService.js`), navigated into that
column range, and walked back north: console logged
`chunked game loop started (world BoundedArena-id)` again, tiles rendered
correctly, no errors. Both directions clean.

### 5. Chunk seam continuity — Pass (observed, not a dedicated repro)

The doorway-hunting traversal in `test2` (chunk_size 64, i.e. 6400 world-px
per chunk) crossed at least two chunk boundaries end-to-end (~10,000 world-px
of travel). No screenshot across that traversal showed a visual seam, gap,
or duplicate entity; terrain and creature rendering stayed continuous
throughout. Did not additionally instrument `chunkTileCells` cell counts —
that's F-029's territory (perf), separately arbitrated below.

### 6. Kill the socket, assert reconnect — Confirms F-045A / **F-028**

Injected a `WebSocket` constructor wrapper via `navigate_page`'s
`initScript` to get a live handle on the authority socket, joined
`MerchantVerify`, then called `.close()` on it directly (`readyState`
1→2→3). Over 10+ seconds afterward: zero new WebSocket connections (no
reconnect attempt), zero console output referencing the disconnect, no
toast. Pressing `d` afterward still visibly moved the sprite (local
prediction against the already-loaded map continued), so there is *no
on-screen indication whatsoever* that the session died — exactly F-028's
claimed defect. See arbitration below.

### 7. Two clients, one map, see each other move — Pass

Admin (`user_id=1`) and `audit_flowC_user2` (`user_id=456`) both joined
`Overworld`; both HUDs read `Players online: 2` throughout. After closing
the gap between their positions, admin's own screen rendered the `#456`
name tag next to user2's character. Confirmed bidirectionally reachable
(both accounts show each other in `Players online` and in rendered state).

Tab-backgrounding caveat for future runs: switching CDP focus away from a
tab and back caused that tab's local, unacked movement prediction to get
discarded and hard-snapped to the last *server-acknowledged* position on
resume (consistent with `reconcile()` in `net/reconcile.js` trusting
`ackSeq`, not a bug — likely `requestAnimationFrame` throttling in the
backgrounded tab pausing outbound input frames). Not filed; this is
expected authoritative-server behavior, not a defect, and only appeared as
an artifact of switching between two CDP-driven tabs in the same window.

---

## Static findings arbitrated in Flow C

Three static findings named a browser check reachable through the game
loop:

- **F-012** (P0, `backend-authority`, "`null` frame kills the process") —
  **confirmed in browser.** Sent the literal 4-byte frame `null` (not
  `JSON.stringify(null)`) over a live, joined authority WebSocket. The
  socket closed immediately with code 1006 (abnormal closure — not a clean
  protocol close). `docker ps` still reported `something2-backend-1` as
  "Up" (its container `CMD` is `tail -f /dev/null`, fully decoupled from the
  app process, which is `docker exec`'d in separately via
  `npm run dev`/nodemon), but `docker exec ... ps aux` inside the container
  showed only that `tail` process — the `node`/`nodemon` process that had
  been serving every prior request in this session was gone, and nothing
  was listening on the app port (`ss -tlnp` empty, `GET /api/health` failed
  to connect). This is exactly the failure signature the finding predicts:
  one 4-byte frame from any authenticated player kills the shared HTTP+WS
  process and drops every connection. Run **last**, as instructed, after
  every other Flow C check was complete. **Left the stack down** for the
  minimum time needed to confirm the process was actually gone, then
  restarted it with `docker compose exec -d backend npm run dev`; backend
  health, frontend, and both existing browser sessions were verified
  recovered (`/api/health` → 200) before finishing this report. Severity
  left at P0; `verification` updated with the browser repro.

- **F-028** (P1, `frontend-game`, "no reconnect after socket close") —
  **confirmed in browser**, per check 6 above. `verification` updated.

- **F-014** (P1, `backend-authority`, "case-sensitive world_id splits the
  world") — **confirmed in browser.** Opened two raw authority WebSockets
  (admin `user_id=1`, `audit_flowC_user2` `user_id=456`) joining the same
  `MerchantVerify` UUID, one lower-cased, one upper-cased. Both got `joined`
  frames, but each connection's `state` frames only ever listed its own
  player id — neither ever saw the other, despite being nominally in the
  same world. Control run with both connections using the *identical*
  lower-case id showed each `state` frame correctly listing both players,
  isolating the case difference as the cause (not e.g. an unrelated
  per-account isolation bug). `verification` updated.

No static finding was demoted in this flow.

### New findings emitted by Flow C

Two, both `source: 'browser'`, both `frontend-game`:

- **F-045** (P1, user-logic) — the mount effect that binds the live `Game`
  instance to the DOM `<canvas>` only re-runs on an `activeTab` change; it
  never re-runs when `authed` flips false→true. Signing out and back in (or
  the app's own designed recovery path for a token revoked mid-session,
  which routes through the same `authed`-gated remount) leaves the visible
  canvas at its browser-default 300×150 size, permanently blank, while the
  authority WebSocket and game loop keep running underneath — confirmed by
  observing HP drop from 100 to 95 with zero player input during the
  "blank" period. Reproduced twice, deterministically. Only a full page
  reload recovers.

- **F-046** (P2, security) — the Worlds picker's delete-world control (a
  trash icon per list row) and the world-creation form beneath it are not
  gated behind `isAdmin`, unlike the admin-only tabs in the same component.
  A completely unprivileged fresh player account sees a working-looking
  destructive icon next to every world. Clicking it does fire a real
  `DELETE /api/worlds/:id` request — correctly rejected server-side (403 via
  `adminGuard`) with an eventual "Failed to delete world" toast — so there
  is no actual security bypass, only a misleading admin-only affordance
  shown to the wrong role.

### Flake policy

One assertion was retried and dropped per policy: on one admin session,
clicking "Enter World" did nothing at all (no console output, no network
request beyond the world preview, no error) — traced to the same
`gameRef.current` mount-effect race as F-045's cousin (the instance simply
hadn't been constructed yet when the click fired). Switching tabs away and
back forced the effect to re-run and fixed it for that session. A
fresh-reload retry did **not** reproduce the failure (worked on the first
click). Per the flake policy this is marked `unverified` and was **not**
filed — noted here only as a "watch for this" observation, not a tracked
finding, since a second independent attempt did not reproduce it.

### Report

Every one of the skill's seven Flow C checks passed. Two static P0/P1
findings (F-012, F-028) that were previously reproduced only against
isolated/local harnesses are now proven against the actual running stack —
F-012 in particular is the single most consequential result of this whole
phase: a one-frame remote DoS against the shared HTTP+WS process, confirmed
live and then recovered. F-014's case-sensitivity world-splitting bug is
now demonstrated with two real accounts rather than inferred from code
reading. Two new client-side defects (F-045, F-046) surfaced only because
this flow drove real auth-state transitions and role combinations through
the actual game shell, which static review has no way to do.
