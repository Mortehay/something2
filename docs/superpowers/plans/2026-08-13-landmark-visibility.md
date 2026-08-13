# Landmark Visibility Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make waypoints and portals visible on three surfaces, and author eight portals into the home region.

**Architecture:** A pure `landmarks` read model derives `{kind, x, y, name, activated}` from data the authority already holds (`entry.waypoints`, `entry.portalLinks`). It rides the existing `joined` frame. The client stores it on `Game` and three renderers read it. Portals are authored by two routes because the home region spans two map specs.

**Tech Stack:** Node/Express (CommonJS, raw `pg`, `node-pg-migrate`, `node --test`), React/vite, Canvas 2D, Cytoscape.

**Spec:** `docs/superpowers/specs/2026-08-13-landmark-visibility-design.md`
**Tickets:** SOMET-296 (parent), 297 / 298 / 299.

## Global Constraints

- `MAP_TILE_SIZE = 100` world px per tile. Tile of a point = `Math.floor(coord / 100)`.
- **No second loader.** Landmarks derive from `entry.waypoints` / `entry.portalLinks`, which `loadWorld` already builds. Never add a parallel read of `waypoints` or `map_links` for the sim (SOMET-249).
- **Renderers take the pulse phase as an input.** No `Date.now()` inside a draw function — it cannot be pinned by a test.
- **Fog of war:** anything reaching the World Map must be scoped by `character_visited_worlds` in the query, not the caller.
- **Never mutate the shared dev DB** outside a migration.
- Backend tests need `TEST_DATABASE_URL` / `DATABASE_URL` set or 47 DB files silently skip.
- Migrations: the dev stack auto-applies on boot from the bind mount. This worktree is not the mounted checkout, so editing here is safe; applying is a deliberate step.

## Deviations from the spec, decided during planning

1. **`joined` only, not `joined` + `transition`.** `GameShell.jsx:342` routes `onTransition` to `enterWorld`, which performs a fresh join. Every entry path — first join, resume, transition, waypoint travel — terminates in a `joined` frame. Adding landmarks to `transition` would be dead payload.
2. **The minimap reads landmarks from the Game snapshot, not from the overview payload.** The spec said the overview payload gains the fields. But slice 1 already delivers landmarks to the client, and the minimap only ever shows the current world. Reading the snapshot avoids touching `overviewCache`, avoids a second source of truth, and needs no backend change. `mapService.generateWorldOverview` is left alone.

---

## File Structure

- **Create** `backend/src/services/landmarks.js` — pure; builds the landmark list from a world entry plus an activated-id set. Imports nothing from the authority.
- **Modify** `backend/src/services/mapLinks.js` — `fetchLinks` also selects `w.name AS to_name`, so a portal landmark can be labelled by destination.
- **Modify** `backend/src/authority/server.js` — one activation query at join; `landmarks` on the `joined` frame.
- **Modify** `backend/src/index.js` — `/api/player/world-map` worlds rows gain `waypointCount` / `portalCount`.
- **Modify** `frontend/.../core/Game.js` — store `landmarks`; expose on the minimap snapshot; flip `activated` on `waypointActivated`.
- **Modify** `frontend/.../systems/RenderSystem.js` — draw the in-world marker.
- **Modify** `frontend/.../systems/minimapRenderer.js` — draw minimap markers.
- **Modify** `frontend/.../Minimap.jsx` — pass landmarks and phase through.
- **Modify** `frontend/.../PlayerWorldMap.jsx` — landmark badge on nodes.
- **Create** `backend/migrations/<ts>_home_region_portals.js` — the six cross-spec portal rows.
- **Modify** `backend/seeds/maps/spine-descent.map.json` — the Old Trailhead ↔ Windwatch pair.

---

### Task 1: The landmark read model

**Files:** Create `backend/src/services/landmarks.js`; Test `backend/tests/landmarks.test.js`

**Interfaces produced:**
- `buildLandmarks({ waypoints, portalLinks, activatedIds })` → `Array<{kind, x, y, name, activated}>`
  - `waypoints`: a `Map` of `tileKey -> {id, x, y, name}` (what `loadWorld` builds).
  - `portalLinks`: a `Map` of `tileKey -> {id, fromX, fromY, toName}`.
  - `activatedIds`: a `Set` of waypoint id strings.
  - Sorted by `y` then `x` so output is deterministic for tests and for the wire.

- [ ] **Step 1: Write the failing test** covering: waypoints only; portals only; both; neither (empty array, never a throw); a waypoint whose id is in `activatedIds` reports `activated: true` while the same waypoint with an empty set reports `false`; a portal always reports `activated: false`; missing/`null` inputs yield `[]`.
- [ ] **Step 2: Run it, confirm it fails** (`buildLandmarks is not a function`).
- [ ] **Step 3: Implement** `landmarks.js`. Portal `name` is `To <toName>`, falling back to `Portal` when `toName` is absent. Waypoint `name` is the row's own name.
- [ ] **Step 4: Run, confirm pass.**
- [ ] **Step 5: Commit** — `feat(landmarks): the read model behind every landmark surface (SOMET-297)`

### Task 2: Deliver landmarks on the joined frame

**Files:** Modify `backend/src/services/mapLinks.js`, `backend/src/authority/server.js`; Test `backend/tests/landmarks_joined_db.test.js`

**Interfaces consumed:** `buildLandmarks` from Task 1.

- [ ] **Step 1: Write the failing test.** A DB test that joins the authority as a character in a world holding a waypoint and asserts the `joined` frame's `landmarks` contains it with `activated: false`; then activates it and asserts a re-join reports `activated: true`. Plus a source-text guard asserting `fetchLinks`' SELECT names `to_name` — the same guard shape SOMET-288 needed after the authority's world SELECT silently dropped two columns.
- [ ] **Step 2: Run, confirm it fails.**
- [ ] **Step 3: Implement.**
  - `fetchLinks`: add `w.name AS to_name` to the SELECT.
  - `loadWorld`'s `portalLinks` Map value gains `toName: l.to_name`.
  - At join, one query: `SELECT waypoint_id FROM character_waypoints WHERE character_id = $1` → `Set`. Once per join, not per tick.
  - `joined` frame gains `landmarks: buildLandmarks({...})`.
- [ ] **Step 4: Run, confirm pass.**
- [ ] **Step 5: Commit** — `feat(landmarks): the joined frame finally says where the landmarks are (SOMET-297)`

### Task 3: In-world tile rendering

**Files:** Modify `frontend/.../core/Game.js`, `frontend/.../systems/RenderSystem.js`; Test `frontend/.../__tests__/landmarkRender.test.js`

- [ ] **Step 1: Write the failing test.** `drawLandmarks(ctx, {landmarks, camera, phase})` draws at the landmark's tile; two different `phase` values produce different `globalAlpha`; an unactivated waypoint strokes (outline) where an activated one fills.
- [ ] **Step 2: Run, confirm it fails.**
- [ ] **Step 3: Implement.** `Game.onJoined` stores `this.landmarks = Array.isArray(msg.landmarks) ? msg.landmarks : []` — the exact shape `merchants` already uses on the line above. `onWaypointActivated` flips the matching landmark's `activated` so the marker changes without a rejoin. `RenderSystem` draws the marker before entities.
- [ ] **Step 4: Run, confirm pass.**
- [ ] **Step 5: Commit** — `feat(landmarks): draw the marker on the ground you walk over (SOMET-297)`

### Task 4: Minimap markers

**Files:** Modify `frontend/.../systems/minimapRenderer.js`, `frontend/.../Minimap.jsx`, `frontend/.../core/Game.js`; Test `frontend/.../__tests__/minimapLandmarks.test.js`

- [ ] **Step 1: Write the failing test.** `drawMinimap` given one landmark draws at the position `worldTileToView` reports for its tile; two phases produce different alpha.
- [ ] **Step 2: Run, confirm it fails.**
- [ ] **Step 3: Implement.** `getMinimapSnapshot` returns `landmarks`; `Minimap.jsx` passes them plus `phase` (derived from the rAF timestamp, in the component, not the renderer); `drawMinimap` draws them after villages/doorways and before creatures.
- [ ] **Step 4: Run, confirm pass.**
- [ ] **Step 5: Commit** — `feat(landmarks): minimap markers, pulsing off a phase the caller owns (SOMET-298)`

### Task 5: World Map counts and badge

**Files:** Modify `backend/src/index.js`, `frontend/.../PlayerWorldMap.jsx`; Test `backend/tests/world_map_landmarks_db.test.js`

- [ ] **Step 1: Write the failing test.** `/api/player/world-map` reports `waypointCount`/`portalCount` for a visited world holding them, and — the load-bearing one — reports **nothing at all** for an unvisited world that holds a portal.
- [ ] **Step 2: Run, confirm it fails.**
- [ ] **Step 3: Implement.** Aggregate scoped to the existing `visited` array. Cytoscape node data gains `landmarks`, styled as a distinct border; a single interval toggles a class for the pulse.
- [ ] **Step 4: Run, confirm pass.**
- [ ] **Step 5: Commit** — `feat(landmarks): the World Map says which worlds have one (SOMET-298)`

### Task 6: Author the home-region portals

**Files:** Modify `backend/seeds/maps/spine-descent.map.json`; Create `backend/migrations/<ts>_home_region_portals.js`; Test `backend/tests/home_region_portals_db.test.js`

Coordinates: pads sit immediately south of each village box (all three gate `S`), on walkable ground outside the wall.

- [ ] **Step 1: Write the failing test** asserting all eight live rows exist with the right endpoints, that none is flagged `is_waypoint` while guarded, and that navigability holds.
- [ ] **Step 2: Run, confirm it fails.**
- [ ] **Step 3: Implement.** Spec pair in `spine-descent.map.json`; the six cross-spec rows in a migration using **literals**, worlds matched by name. `down` removes exactly what `up` added.
- [ ] **Step 4: Apply and run, confirm pass.**
- [ ] **Step 5: Commit** — `feat(home-region): eight portals, and a pad outside every village gate (SOMET-299)`

### Task 7: Browser verification

- [ ] Merge to the main checkout, confirm via Chrome DevTools: a pulsing marker one tile east of the Old Trailhead spawn; the same marker on the minimap; the World Map badging the world; a portal pad outside the gate that transits.
