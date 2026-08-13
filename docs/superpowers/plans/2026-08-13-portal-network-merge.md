# Portal Network Merge — Implementation Plan (SOMET-300)

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One travel landmark per map, called a Portal, that opens a travel popup when you step on it — replacing the two competing mechanics with the one that already works.

**Architecture:** No new travel system. The waypoint implementation (`waypoints`, `character_waypoints`, `joinPolicy`'s `waypoint-travel` leg, `WaypointTravel.jsx`) *is* the network; this plan deletes the rival, constrains it to one per world, changes how the popup opens, and renames it user-facing. Walk-through dungeon doors (`map_links` `edge='PORTAL'`) stay a separate thing and never enter the travel list.

**Tech Stack:** Node/Express (CommonJS, raw `pg`, `node-pg-migrate`, `node --test`), React/vite + vitest.

**Ticket:** SOMET-300. Reverses part of SOMET-299; keeps SOMET-297/298.

## Global Constraints

- `MAP_TILE_SIZE = 100`; a tile is `Math.floor(coord / 100)`.
- **A guarded portal may never become travel-selectable.** 7 of the 14 dungeon portals carry `blocks_portal_id`; making one selectable drops a traveller past the guard and defeats the level-band gating `joinPolicy` protects. `guardedWaypointViolations` already pins this and must keep passing.
- **Spec and migration move together or they drift.** Deleting rows in a migration while leaving the declaration in `spine-descent.map.json` means the next `seed-map` run puts them straight back (`setPortalLink` upserts; `seed-map` holds no DELETE). Both edits are in the same task, deliberately.
- Server re-derives every travel rule; the client's copy is an offer, never a gate (`waypointTravel.js` header).
- Backend tests need `TEST_DATABASE_URL` set or 47 DB files silently skip.
- Never mutate the shared dev DB outside a migration.
- The dev backend auto-runs migrations on boot from the bind-mounted checkout — edit migrations in a worktree, not in the served checkout.

## What already exists (verified, do not rebuild)

| Requirement | State |
|---|---|
| Must be standing on one to travel | `waypointTravel.js` `REASON.NOT_ON_A_WAYPOINT`, re-derived server-side |
| Undiscovered ones not selectable | `REASON.NOT_DISCOVERED`, `disabled` + `aria-disabled` on the row |
| Empty list when nothing reachable | `groups.length === 0` → `<Empty>` copy. **Only the wording changes.** |
| Server-side authorization | `joinPolicy` `waypoint-travel` leg, against its own read of `character_waypoints` |
| Authored per map spec | `mapSpec.js:513` validates a world's `waypoints` array |
| One per *tile* per world | `waypoints_world_tile_unique` |
| One per *world* | **Missing — this plan adds it.** |

---

## Scope

**Included:** deleting the 8 SOMET-299 portal rows and their spec entry; a one-portal-per-world constraint in the DB and the spec validator; auto-open on arrival with a latch; user-facing rename to "Portal".

**Excluded:** placing portals in additional safe maps (a content pass that follows the mechanism); renaming the `waypoints`/`character_waypoints` tables or their code identifiers; changing dungeon walk-through portals; changing `allows_fast_travel`; the SOMET-297/298 marker rendering.

**Assumptions** — stated because they were open at the end of grilling and I am proceeding on the recommended answers. Any of them can be reversed cheaply inside its own task:

1. The rename is **user-facing only**. Tables, services and test names keep saying `waypoint`. A DB rename is churn with no behaviour change and would touch every file in the feature.
2. Walk-through dungeon doors **keep their pink marker** (SOMET-297). They are still landmarks worth seeing; they are simply not travel nodes.
3. Empty-list copy becomes *"You have not found any portals yet. Walk onto one to light it."* — same structure, new noun.

---

### Task 1: Delete the rival mechanic

**Files:** Create `backend/migrations/<ts>_remove_home_region_portals.js`; Modify `backend/seeds/maps/spine-descent.map.json`; Modify `backend/tests/home_region_portals_db.test.js`

This is the whole user-visible complaint — "you have added multiple" — so it lands first and alone.

- [ ] **Step 1: Rewrite the failing test.** `home_region_portals_db.test.js` currently asserts all 8 rows EXIST. Invert it: assert **zero** `PORTAL` rows touch Old Trailhead, Thornbriar Reach or Windwatch Pass, and that each of those three worlds has **exactly one** `waypoints` row. Keep the guarded-portal/`is_waypoint` test unchanged — it still binds.
- [ ] **Step 2: Run it, confirm it fails** (8 rows still present).
- [ ] **Step 3: Remove the spec declaration.** Delete the `kind: "portal"` entry from `spine-descent.map.json`'s `links`. **Without this the next `seed-map` run re-creates the pair** — `setPortalLink` upserts and `seed-map` never deletes.
- [ ] **Step 4: Write the migration.** `up` calls `clearPortalLink` for each of the four source tiles in `1714440250000_home_region_portals.js` (it deletes the mirror too, so four calls remove all eight rows). `down` re-applies the identical `setPortalLink` calls, so the pair is genuinely reversible.
- [ ] **Step 5: Apply and run.** `npx node-pg-migrate up --no-check-order --ignore-pattern '(?!.*\.js$).*'`, then the test file.
- [ ] **Step 6: Commit** — `fix(portals): one travel landmark per map, not four (SOMET-300)`

**Acceptance:** standing outside the Old Trailhead gate shows no portal pad; the village's single Portal is the only travel landmark in the world.

### Task 2: Make one-per-map impossible to violate

**Files:** Create `backend/migrations/<ts>_one_waypoint_per_world.js`; Modify `backend/seeds/mapSpec.js`; Test `backend/tests/one_portal_per_world.test.js`

Two enforcement points on purpose: the validator catches an authoring mistake with a readable message, the index catches everything else including a hand-written `INSERT`.

- [ ] **Step 1: Write the failing tests.** (a) `validateMapSpec` rejects a world declaring two `waypoints` entries, naming the world key. (b) A DB test that a second `waypoints` row for the same world is refused by the database. (c) A test that the three live home worlds each have exactly one — so the constraint is proven satisfiable by shipped data, not just by an empty table.
- [ ] **Step 2: Run, confirm all three fail.**
- [ ] **Step 3: Implement.** In `mapSpec.js` beside the existing `w.waypoints` array validation (~line 513), reject `length > 1`. Migration adds `CREATE UNIQUE INDEX waypoints_world_unique ON waypoints (world_id)`.
- [ ] **Step 4: Apply and run.**
- [ ] **Step 5: Commit** — `feat(portals): at most one portal per world, in the spec and in the schema (SOMET-300)`

**Acceptance:** authoring a second portal in a map spec fails at seed time with a message naming the world; a direct `INSERT` of a second row is refused.

**Note for the implementer:** the index will reject any future world that wants two. That is the point, but it also means the *content* pass adding portals to more safe maps must pick exactly one tile per map — flag it rather than dropping the index.

### Task 3: The popup opens when you stand on it

**Files:** Modify `frontend/src/games/something2/WaypointTravel.jsx`; Test `frontend/src/games/something2/__tests__/waypointAutoOpen.test.js`

`T` stays. The new path is arrival.

- [ ] **Step 1: Write the failing test** over a pure `shouldAutoOpen({ prevTile, tile, portalTile, isOpen })` helper — extracted for the reason `waypointTravel.js` and `playerWorldMap.js` both are: vitest runs in a node environment here, so a component cannot be rendered and anything worth asserting must be importable. Cases: stepping onto the tile opens; staying on it does **not** re-open (this is the latch, and the whole point); stepping off then back on opens again; already-open stays open; a world with no portal never opens.
- [ ] **Step 2: Run, confirm it fails.**
- [ ] **Step 3: Implement.** A low-frequency poll of `getWaypointSnapshot()` while the popup is CLOSED (the existing poll only runs while open), feeding `shouldAutoOpen`. Latch on the previous tile, not on a timer.
- [ ] **Step 4: Run, confirm it passes.**
- [ ] **Step 5: Commit** — `feat(portals): stepping onto a portal opens the travel list (SOMET-300)`

**Acceptance:** walking onto the village Portal opens the popup once; walking in circles on the same tile does not reopen it; `T` still works anywhere.

### Task 4: Rename to "Portal", user-facing only

**Files:** Modify `WaypointTravel.jsx`, `waypointTravel.js` (the `WHY_TEXT` strings), `PlayerWorldMap.jsx` legend

- [ ] **Step 1: Write the failing test** asserting the popup's copy says "portal" and not "waypoint" — including the empty-state line and the `stand on a waypoint` reason string.
- [ ] **Step 2: Run, confirm it fails.**
- [ ] **Step 3: Implement.** Strings only. `REASON.NOT_ON_A_WAYPOINT` and every table, service and identifier keep their names (Assumption 1).
- [ ] **Step 4: Run, confirm it passes.**
- [ ] **Step 5: Commit** — `feat(portals): call it a Portal everywhere the player can read (SOMET-300)`

---

## Verification strategy

- **Per task:** the task's own tests, then the touched app's suite (`npx node --test tests/<files>` / `npx vitest run src/games/something2`).
- **Once, before merge:** the full backend suite. Expect the 14 known pre-existing failures (stones/migration `42701`, `progression_kill_xp`, `seed_catalogs_db` contention, the sealed-spec check) and nothing else. `villageScreenBudget_db` may fail under full-suite contention and passes in isolation — check before treating it as a regression.
- **Browser, required.** Tasks 1 and 3 are both user-visible and this repo has repeatedly shipped inert features past a green suite. Concretely: join Old Trailhead, confirm exactly one marker (no pad outside the gate), walk onto it and confirm the popup opens by itself, close it and confirm it stays closed while standing there, step off and back on and confirm it reopens.
- Re-run `seed-map` for `spine-descent` after Task 1 — or at minimum re-read the rows — to prove the spec edit really removed the declaration rather than only the data.

## User-visible acceptance criteria

1. Every map has at most one Portal; the home region's three have exactly one each.
2. Standing on a Portal opens the travel list without pressing anything.
3. The list offers only Portals this character has lit, in worlds it has visited.
4. A Portal the character has not visited is shown but not selectable, with a reason.
5. With nothing reachable yet, the popup opens and says so rather than showing a blank card.
6. No guarded dungeon portal ever appears in the list.

## Risks and unresolved questions

- **Task 1 deletes shipped rows.** `down()` restores them, but the rows only exist on unpushed local `main` (84 commits ahead of `origin`). Anyone syncing mid-change gets the migration without its predecessor. Land both together.
- **The auto-open poll runs while the popup is closed** — i.e. every frame budget in the game now carries it. Keep it slow (~4/sec is ample for a tile transition) and read from the existing snapshot rather than adding a second source.
- **A modal that opens on arrival can interrupt combat.** The village Portal is inside the walls where that is unlikely, but a future Portal placed on open ground could pop mid-fight. If that shows up, the fix is a suppression while the player has an active target — not removing the latch.
- **Unresolved, deferred deliberately:** which additional safe maps get a Portal and where. `allows_fast_travel` cannot answer it — 30 worlds carry it including the whole loop-catacombs chain, and the flagged `Blackfen Sinks` ships sealed (SOMET-273, 0.1% reachable). That pass needs a content decision per map.
