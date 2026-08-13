# Home Region E — Waypoint data model, activation on contact, guarded-portal exclusion (SOMET-292)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The data a waypoint network is made of, the physical act that lights one up, the rule that
stops a waypoint from being a way around a guarded door, and a read API shaped so slice F can build
the travel popup on top of it without changing anything here.

**Architecture:** One registry table, `waypoints`, holding every waypoint tile. `map_links.is_waypoint`
is the *authored opt-in* that says "this staircase also serves as a waypoint"; the `waypoints` row it
produces (carrying `map_link_id`) is the *derived registry entry* the runtime reads. Deliberately one
runtime reader: the authority loads `waypoints` for the world it is running and the tick loop matches
the player's tile against it. `character_waypoints` records activation per character, exactly as
`character_visited_worlds` does and for the same reason.

**Tech Stack:** Node.js (CommonJS), raw `pg`, `node-pg-migrate`, `node --test`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-12-home-region-design.md` §5. Ticket **SOMET-292**, child
  of epic SOMET-287. **SOMET-293 (slice F) depends on this** — it consumes the read API and adds the
  `waypoint-travel` leg to `mayJoin`.
- **Travel is NOT in this slice.** No new `mayJoin` leg, no removal of the `fast-travel` leg, no
  popup UI, no world-map changes. This slice ends at "the server knows which waypoints this character
  has lit, and will tell an authorized caller".
- **Migration timestamps `1714440220000`–`1714440229000` only.** Sibling worktrees hold 200000 (B),
  210000 (D) and 230000 (G). `npm run migrate:up` is broken on this database (1714440171000/172000 are
  recorded out of order); use
  `npx node-pg-migrate up --no-check-order --ignore-pattern '(?!.*\.js$).*'`.
- **Never mutate the shared dev database destructively.** No DELETE/TRUNCATE/DROP outside a test's own
  named fixtures, no `make reseed-map`, no `make clear-maps`.
- **Both DB env vars.** Set only `TEST_DATABASE_URL` or only `DATABASE_URL` and ~48 test files skip
  silently and report success.
- **Known pre-existing failures**, all reproducing on untouched `main` and not to be chased:
  `migration_convert_magic_weapons_db`, `migration_stone_item_type_down_guard_db`,
  `stones_integration_db`, `progression_kill_xp`, `seed_catalogs_db` (full-suite contention),
  `seed_map_db`'s "every shipped spec applies cleanly" (SOMET-273).
- **CommonJS.** Match the surrounding comment density — this repo explains *why*, not *what*.
- Branch `feat/home-region-e-waypoints`, off `main`. Commit subjects `type(scope): summary (SOMET-292)`,
  ending with the `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` trailer.

## The two decisions that shape everything else

### 1. One registry, not two kinds of waypoint

The spec names two sources: a standalone `waypoints` row, and a `map_links` row opted in with
`is_waypoint`. It also names `character_waypoints (character_id, waypoint_id, activated_at)` — a
single FK. Those cannot both be true unless a flagged portal *also* has a `waypoints` row.

So: **`waypoints` is the registry, and a portal-backed waypoint is a `waypoints` row with
`map_link_id` set.** `is_waypoint` remains the authored flag (it is what the validator gates and what
a map author writes), and the seeder derives the registry row from it.

The alternative — two nullable FKs on `character_waypoints` with an exactly-one-of CHECK — gives the
tick loop two tables to scan, the read API two queries to union, and slice F two shapes to render.
Every one of those is a place for the two halves to drift, and this repo's recorded failure mode
(SOMET-249) is exactly a feature wired into one of two paths.

### 2. Activation is a tick-loop fact, throttled by a per-player latch

`character_waypoints` is written from the authority tick loop when a player's tile matches a waypoint
tile. There is no client message that can activate a waypoint — the frame travels server→client only.

The write is throttled the way `player_binds` is: `planBind` returns null when the player is already
bound to the village covering their tile, so a player loitering by the gate costs one write, not one
per tick. The waypoint equivalent is a per-player `Set` of waypoint ids this session has already
written, **set before the query is issued** so a slow round trip cannot let the next tick fire a
duplicate INSERT. The INSERT is `ON CONFLICT DO NOTHING` on top of that, so the latch is an
optimisation and the primary key is the correctness guarantee.

The latch is *not* primed from the database on join, matching `_boundVillageId`, which is also not.
Cost: one no-op INSERT per session per waypoint re-walked. That is cheaper than the extra query
priming would need, and `ON CONFLICT DO NOTHING` makes it harmless.

## The gating rule

> A portal referenced by any creature's `blocks_portal_id` may never be flagged `is_waypoint`.

Enforced in three places, each catching a different class of mistake:

1. **The map-spec validator** — a spec that declares `guard` and `is_waypoint` on the same portal link
   never reaches the database.
2. **A DB test over the LIVE rows** — catches a waypoint added by hand, by an admin route, or by a
   migration that bypassed the validator.
3. **The same rule extended to the portal's MIRROR.** `setPortalLink` writes two rows: the declared
   `(from, from_x, from_y) -> (to, to_x, to_y)` and its mirror `(to, to_x, to_y) -> (from, from_x, from_y)`.
   Guards are inserted on the *departure* side only. Flagging the mirror as a waypoint would drop a
   traveller on the far side of the staircase — the guard never met, the level band never checked.
   The narrow reading of the spec's sentence misses this; the intent plainly does not.

A **standalone** waypoint declared on a guarded portal's tile is the same bypass with a different
spelling, and is rejected identically.

## File Structure

| File | Responsibility |
|---|---|
| `backend/migrations/1714440220000_waypoints.js` | **new.** `waypoints`, `character_waypoints`, `map_links.is_waypoint`. |
| `backend/src/services/waypoints.js` | **new.** The only reader/writer pair: `fetchWaypoints`, `upsertWaypoint`, `activateWaypoint`, `listWaypointsForCharacter`. |
| `backend/seeds/mapSpec.js` | **modify.** Authoring + the exclusion rule. |
| `backend/scripts/seed-map.js` | **modify.** Apply authored waypoints. |
| `backend/src/authority/server.js` | **modify.** Load per world; activate on contact in the tick loop. |
| `backend/src/index.js` | **modify.** `GET /api/player/waypoints`. |
| `backend/tests/map_spec_waypoints.test.js` | **new.** Validator rejection cases. |
| `backend/tests/waypoints_db.test.js` | **new.** Schema, live-rows invariant, service round trip. |
| `backend/tests/waypoint_activation_live.test.js` | **new.** Activation through the running authority. |

---

### Task 1: The schema

**Files:** create `backend/migrations/1714440220000_waypoints.js`; test
`backend/tests/waypoints_db.test.js` (schema half).

**Interfaces produced:** the three schema objects below.

```
waypoints
  id           uuid        PK  default gen_random_uuid()
  world_id     uuid        NOT NULL  REFERENCES worlds      ON DELETE CASCADE
  x            real        NOT NULL      -- pixels, same units as map_links.from_x
  y            real        NOT NULL
  name         text        NOT NULL  UNIQUE
  map_link_id  uuid        NULL      REFERENCES map_links   ON DELETE SET NULL, UNIQUE where not null
  created_at   timestamptz NOT NULL  default now()
  UNIQUE INDEX waypoints_world_tile_unique (world_id, floor(y/100), floor(x/100))
  INDEX on world_id

map_links.is_waypoint  boolean NOT NULL DEFAULT false

character_waypoints
  character_id  integer     NOT NULL  REFERENCES characters ON DELETE CASCADE
  waypoint_id   uuid        NOT NULL  REFERENCES waypoints  ON DELETE CASCADE
  activated_at  timestamptz NOT NULL  default now()
  PRIMARY KEY (character_id, waypoint_id)
  INDEX on waypoint_id
```

Why each of the non-obvious ones:

- **`UNIQUE(name)` globally, not per world.** Slice F's popup lists waypoints across worlds; two
  "Old Well" entries in that list are indistinguishable to the player choosing one. Same reasoning
  as `worlds_name_unique`.
- **The tile-derived unique index, not `UNIQUE(world_id, x, y)`.** The tick loop keys waypoints by
  `floor(y/100),floor(x/100)`, so two rows in the same tile at different pixel offsets are not two
  waypoints — one of them is simply unreachable. Pin the invariant the runtime actually has.
- **`map_link_id` ON DELETE SET NULL, not CASCADE.** `blocks_portal_id` set the precedent
  (1714440061000): re-linking a dungeon must not delete the guard. Here CASCADE would delete the
  waypoint and, through it, every character's activation of it. A relinked staircase leaves a
  standalone waypoint on the tile; nobody's progress is destroyed.
- **`character_waypoints` PK, not a surrogate id.** The PK *is* the idempotency guarantee for
  activation. A surrogate id would let the same character activate the same waypoint twice.

- [ ] **Step 1: Write the failing schema assertions** in `backend/tests/waypoints_db.test.js` —
      column types/nullability from `information_schema`, the FK delete rules from `pg_constraint`,
      and the PK of `character_waypoints`. Gate on `TEST_DATABASE_URL || DATABASE_URL` like every
      other `*_db.test.js`.
- [ ] **Step 2: Confirm the timestamp block is free** — `ls backend/migrations | sort | tail -3`.
      `1714440220000` must not exist. It is reserved for this slice; do not use another number.
- [ ] **Step 3: Write the migration**, with a working `down()` that drops in FK order
      (`character_waypoints`, then `waypoints`, then the `map_links` column).
- [ ] **Step 4: Apply and re-run** —
      `npx node-pg-migrate up --no-check-order --ignore-pattern '(?!.*\.js$).*'`.
- [ ] **Step 5: Commit.**

---

### Task 2: The service — one reader, one writer, one activator

**Files:** create `backend/src/services/waypoints.js`; test `backend/tests/waypoints_db.test.js`
(service half).

**Interfaces produced:**

```js
fetchWaypoints(pool, worldId)
  -> [{ id, worldId, x, y, name, mapLinkId }]        // what the authority loads per world

upsertWaypoint(client, { worldId, x, y, name, mapLinkId })
  -> { id }                                          // what seed-map applies

activateWaypoint(pool, characterId, waypointId)
  -> { firstTime: boolean }                          // idempotent; firstTime is the INSERT's rowCount

listWaypointsForCharacter(pool, characterId)
  -> [{ id, worldId, worldName, x, y, name, mapLinkId, activated, activatedAt }]
```

`listWaypointsForCharacter` is the read API's whole payload and is scoped by fog of war: a waypoint is
listed when the character has **visited its world** (`character_visited_worlds`) **or has activated
it**. The second half of that OR is not redundant — it is what keeps a waypoint listed if the visit
row is ever lost, and losing one is a recorded failure in this repo (SOMET-265 wiped rows the
`joinPolicy` `transition` leg then had to work around). Unvisited worlds' waypoints are withheld
*in the query*, not in the component, for the same reason `/api/player/world-map` withholds an
unvisited neighbour's name in SQL: a component-side filter still ships the data to the browser.

- [ ] **Step 1: Write the failing service tests.** Real database, fixture rows named `zzWp*`, deleted
      **by name, unconditionally, in a `finally`** — never by an id captured mid-test.
      - `activateWaypoint` twice in a row: no error, exactly one row, `firstTime` true then false.
      - `listWaypointsForCharacter` returns an activated waypoint with `activated: true` and a
        visited-but-unactivated one with `activated: false` — both, in one call. Slice F renders
        those two states differently, so a list that only ever contains activated rows makes half
        the feature unbuildable.
      - a waypoint in a world the character has neither visited nor activated is **absent**.
      - `upsertWaypoint` twice with the same tile and a changed name updates rather than duplicating.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run, then commit.**

---

### Task 3: Map-spec authoring and the exclusion rule

**Files:** modify `backend/seeds/mapSpec.js`; test `backend/tests/map_spec_waypoints.test.js`.

**Authoring shape** (coordinates in **pixels**, matching the portal-link coordinates immediately
beside them in a spec):

```jsonc
// a standalone waypoint on a world
{ "key": "trailhead", "waypoints": [ { "x": 1250, "y": 850, "name": "Trailhead Well" } ] }

// a staircase that also serves as one
{ "kind": "portal", "from": "trailhead", "to": "barrow", "from_x": 3050, "from_y": 1250,
  "to_x": 550, "to_y": 550, "is_waypoint": true, "waypoint_name": "Barrow Stair" }
```

Rules, each with its own test:

1. `w.waypoints`, if present, must be an array of objects.
2. `x`/`y` must be integers, `>= 0`, and inside the world (`< width*100` / `< height*100`). A
   waypoint outside the map is a tile no player can stand on, so it is a dead row rather than a
   feature.
3. `name` must be a non-empty string, and **every waypoint name in the spec must be unique** —
   standalone and portal-backed alike, because they share one `UNIQUE(name)` column.
4. Two waypoints in one world must not resolve to the same **tile** (the same rule the DB index
   holds).
5. `l.is_waypoint`, if present, must be a real boolean. Rejected, not coerced — for exactly the
   reason `allows_fast_travel` is: `"true"` and `1` are how a hand-edited spec gets this wrong, and
   coercing either would flag a portal as a waypoint on the strength of a typo.
6. `is_waypoint: true` requires a non-empty `waypoint_name`.
7. `is_waypoint` on a non-portal link is an error (a compass doorway has no tile to stand on).
8. **The gating rule.** Build the set of guarded portal *slots* — for every link carrying `guard`,
   both `from:from_x,from_y` and `to:to_x,to_y`, because `setPortalLink` writes both rows and the
   guard defends the staircase, not one row of it. Then reject:
   - any portal link with `is_waypoint: true` claiming either of those slots (covers the declared
     link *and* a redundantly-declared mirror), and
   - any standalone waypoint whose tile falls on one of those slots.

- [ ] **Step 1: Write the failing tests**, one per rule above, plus the two that matter most stated
      as their own named cases: "a guarded portal cannot be a waypoint" and "the mirror of a guarded
      portal cannot be a waypoint either". Assert on the **specific** error string, not just
      `errors.length > 0` — a test that only counts errors passes when the validator rejects the
      spec for an unrelated reason.
- [ ] **Step 2: Implement** in `validateMapSpec`. The guarded-slot pre-pass goes next to the existing
      `portalConnectedKeys` scan, which already runs before the world loop for the same reason: the
      world loop needs to consult it.
- [ ] **Step 3: Run `map_spec_fixtures.test.js` too.** Every shipped spec must still validate — this
      slice adds rules, and a rule that rejects existing content is a regression, not a finding.
- [ ] **Step 4: Commit.**

---

### Task 4: Seeding

**Files:** modify `backend/scripts/seed-map.js`; test `backend/tests/waypoints_db.test.js` (source
guard + round trip).

After the portal-guard pass (so a guarded link is already known) and before `populateWorld`:

- for each portal link with `is_waypoint: true` — set the flag on the forward row and
  `upsertWaypoint` with its `map_link_id`;
- for each `w.waypoints` entry — `upsertWaypoint` with `map_link_id: null`;
- re-assert `is_waypoint = false` on portal links the spec does not flag, so removing the key from a
  spec takes the flag back off (same convergence rule `allows_fast_travel` is written under).

**Waypoint rows converge to the spec, and identity is the NAME** (revised after review — the first
shape of this pass never deleted a row, and that was a security hole rather than a tidiness gap).

- `upsertWaypoint` conflicts on `name`, not on the tile. Moving a waypoint is then an UPDATE of the
  row players already activated, so `character_waypoints` survives the move. Conflicting on the tile
  made the same edit an INSERT that collided on `waypoints_name_unique` and rolled the whole
  transaction back with a raw 23505.
- `pruneWaypoints` drops every waypoint in the spec's own worlds whose name the spec no longer
  authors. This *does* cascade `character_waypoints`. The migration's `ON DELETE SET NULL` exists so
  an *incidental* event (relinking a staircase) cannot take activations down with it; de-authoring is
  not incidental — the author removed the place, so an activation of it is a dangling reference. The
  precedent is `populateWorld`, which already deletes and re-places a seeded world's creatures.
- `guardedWaypointViolations` then asks the **database** whether any waypoint sits on a guarded
  staircase, and aborts the transaction if one does. The validator only ever sees the spec text, and
  two ordinary edits defeat it: adding `guard:` to a portal that was flagged in the previous spec
  (the flag goes off, the registry row does not), and dropping `guard:` while adding the flag (the
  guard creatures stay — `worldPopulation` spares `blocks_portal_id IS NOT NULL`). The runtime reads
  the registry, so the registry is where the rule has to hold.

- [ ] **Step 1: Write the failing tests.** A behavioural case in `seed_map_db.test.js` that applies a
      spec authoring both a standalone and a portal-backed waypoint and reads the rows back
      (positions, `map_link_id`, the converged flag), plus the two guarded-staircase edits above, plus
      a round trip: `upsertWaypoint` into a fixture world, then `fetchWaypoints` — the same reader
      `loadWorld` calls — returns it. **A source grep for `upsertWaypoint` is not one of these**: the
      first version of this task shipped exactly that, and the surviving `require` line satisfied it
      while both call sites were no-ops.
- [ ] **Step 2: Implement. Step 3: Run. Step 4: Commit.**

---

### Task 5: Activation on contact, through the live tick path

**Files:** modify `backend/src/authority/server.js`; test
`backend/tests/waypoint_activation_live.test.js`.

Two edits, both small:

1. `loadWorld` gains `const waypoints = await fetchWaypoints(pool, canonicalId)`, folded into
   `entry.waypoints` — a `Map` keyed `${gRow},${gCol}` exactly like `entry.portalLinks`, so the tick
   loop's lookup is O(1) against the same tile arithmetic every other tile rule in that loop uses.
2. A block in the tick loop, immediately after the village-bind block it is modelled on:

```js
if (entry.waypoints && entry.waypoints.size) {
  for (const p of entry.world.players.values()) {
    const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
    const wp = entry.waypoints.get(`${Math.floor(cy / MAP_TILE_SIZE)},${Math.floor(cx / MAP_TILE_SIZE)}`);
    if (!wp) continue;
    if (!p._litWaypoints) p._litWaypoints = new Set();
    if (p._litWaypoints.has(wp.id)) continue;
    p._litWaypoints.add(wp.id);     // BEFORE the await -- see the plan's throttling note
    activateWaypoint(pool, p.characterId, wp.id).then(...).catch(...);
  }
}
```

The frame is `{ type: 'waypointActivated', waypoint: { id, worldId, x, y, name, mapLinkId }, firstTime }`.
`firstTime` is the INSERT's `rowCount`, i.e. server-side fact, so slice F can show "waypoint
discovered" once and merely refresh its list on a re-walk.

**Explicitly not built:** no `activateWaypoint` message type on the socket. Activation is physical or
it does not happen — a client-claimed activation would be a free travel target, which is the same
shape of hole `joinPolicy` exists to close.

- [ ] **Step 1: Write the failing test.** Use the `portal_blocking_live.test.js` harness (real
      `attachAuthority`, a fake pool with a stateful `route(sql, params)`, a real WebSocket client) —
      it is the established way to exercise the tick loop in this repo, and it forces the waypoint to
      arrive through `loadWorld`'s own query rather than through a test-only injection. Cases:
      - a player standing on a waypoint tile produces exactly ONE
        `INSERT INTO character_waypoints`, with **this** character's id and **this** waypoint's id
        (assert the params, not just that a matching statement was issued);
      - the client receives `waypointActivated` naming that waypoint;
      - **many ticks on the same tile still produce one INSERT** — the throttle, which is the whole
        reason this is safe on a hot path;
      - a player standing on a NON-waypoint tile produces none;
      - `firstTime` is false when the fake pool reports `rowCount: 0`, i.e. the flag tracks the
        database rather than the server's own memory.
- [ ] **Step 2: Implement. Step 3: Run.**
- [ ] **Step 4: Prove the rest of the tick loop did not move:**
      `npm test -- tests/portal_blocking_live.test.js tests/authority_transition.test.js tests/visited_worlds_db.test.js`
      (adjust to the transition tests that actually exist).
- [ ] **Step 5: Commit.**

---

### Task 6: The read API, and the live-rows invariant

**Files:** modify `backend/src/index.js`; test `backend/tests/waypoints_db.test.js` (invariant half).

```
GET /api/player/waypoints?character_id=<id>     playerGuard + ownedCharacter
->  { waypoints: [ { id, worldId, worldName, x, y, name, mapLinkId,
                     activated, activatedAt } ] }
```

Shaped so slice F needs no change here: every field the popup renders is present, `activated`
separates the selectable entries from the ones drawn distinctly, and `worldName`/`worldId` let it
group by world. A missing or blank `character_id` is a **400** (this endpoint is meaningless without
one, matching `/api/player/world-map`); a character that exists but is not this account's is a
**403**, never a 404 — a 404 would make the route an existence oracle for character ids.

- [ ] **Step 1: Write the failing invariant test** — the one the spec calls load-bearing, over the
      rows currently in the database:

```js
// No portal that a creature guards may be a waypoint, by EITHER spelling, and
// the mirror row counts. A waypoint here is a guarded dungeon entrance that is
// bypassable on the second visit, which takes the level-band gating joinPolicy
// was written to protect with it.
//   (a) map_links.is_waypoint on a link any world_creatures row blocks
//   (b) a waypoints row whose map_link_id is such a link
//   (c) either of the above on that link's MIRROR
```

      This test asserts over live data and is expected to pass on day one (nothing is flagged yet).
      That is the point: it fails the day someone flags one, which is the only day it matters.
- [ ] **Step 2: Add the route. Step 3: Run. Step 4: Commit.**

---

### Task 7: Full suite

- [ ] Run the whole backend suite once, with both DB env vars exported and without sourcing the whole
      `.env` (exporting `JWT_SECRET` makes `auth_assertJwtSecret.test.js` fail spuriously).
- [ ] Expected: the known pre-existing failure set and nothing else. Any other failure is a
      regression — stop and report BLOCKED rather than adjusting the test.

## Definition of done

- Backend suite green apart from the known pre-existing failure set.
- **No browser verification for this slice.** Nothing here has a surface a player can see: no
  waypoint is authored yet (slice B), and nothing renders the activation frame yet (slice F). The
  spec's own Testing section lists B, D, F and G as the browser-verified slices and deliberately not
  E. The live-tick activation test is what stands in for it, and it exercises the real authority
  rather than a seed path.
- SOMET-292 moves to **To Review** with a comment naming the commits, the schema, the read-API shape
  and the test evidence.
- Slice F (SOMET-293) is told the read-API shape and that the `waypointActivated` frame exists.

## Known gaps, stated rather than discovered later

- **Un-authoring a waypoint removes it, and un-lights it for every character** (Task 4, revised after
  review). The alternative left an orphan row on a staircase a later spec guarded, which is the
  bypass this slice exists to prevent. A *rename* is un-authoring plus authoring, so it does cost the
  activations; a move does not.
- **The session latch is not primed from the database** (Task 5), so re-walking a lit waypoint after a
  relog costs one no-op INSERT. Deliberate; the alternative is a query on every join.
- **The exclusion rule covers portals, not proximity.** A waypoint placed one tile *past* a guarded
  staircase, inside the dungeon, is the same bypass and neither the validator nor the DB test sees
  it. Guarding against that needs a reachability check the map-spec validator does not have today;
  it belongs with slice B's navigability work, and it is called out here so slice B can decide.
