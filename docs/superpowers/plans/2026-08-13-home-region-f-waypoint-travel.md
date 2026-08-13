# Home Region F — Waypoint travel, and the retirement of world-map click-travel (SOMET-293)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A player standing on a waypoint they have lit can pick another lit waypoint and be there.
Everything else about travel goes away: the World Map stops offering it, and the `fast-travel` leg
that authorized it is deleted.

**Architecture:** Travel is a trip the *server* authorizes and then executes as a transition. The
client sends `{type:'travel', waypointId}` over the socket it already holds; the authority reads the
player's position from its own world object, asks `mayJoin` whether this trip is allowed, and on yes
writes `pendingArrivals` and sends the existing `transition` frame. The client's reconnecting join is
then authorized by the untouched `transition` leg — the same two-step every portal and doorway in
this game already uses, which is what makes it live rather than a second travel path.

**Tech Stack:** Node.js (CommonJS), raw `pg`, `node-pg-migrate`, `node --test`; React + styled-components,
vitest (node environment — components cannot be rendered, so rules live in importable modules).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-12-home-region-design.md` §5 **and its Risks section**.
  Ticket **SOMET-293**, child of epic SOMET-287. Depends on **E** (the mechanism, merged) and **B**
  (the authored region, in review).
- **Migration timestamps `1714440240000`–`1714440249000` only.** Taken elsewhere: 180000 (A),
  190000/191000 (C), 200000/201000 (B), 210000 (D), 220000 (E), 250000 (286), 260000 (C follow-ups).
  `npm run migrate:up` is broken on this database (1714440171000/172000 recorded out of order); use
  `npx node-pg-migrate up --no-check-order --ignore-pattern '(?!.*\.js$).*'`.
- **Never mutate the shared dev database destructively.** No DELETE/TRUNCATE/DROP outside a test's own
  named fixtures. **Do not run `seed-catalogs` or `seed-map`** — `seed-map` converges a whole spec and
  would prune slice B's villages out of the live database from this branch, which does not have them.
  Check `SELECT count(*) FROM worlds WHERE is_entry` is exactly 1 before and after.
- **Both DB env vars.** Set only `TEST_DATABASE_URL` or only `DATABASE_URL` and ~48 test files skip
  silently and report success.
- **Known pre-existing failures on this base** (14, reproducing on untouched `main`, not to be
  chased): `migration_convert_magic_weapons_db` (3), `migration_stone_item_type_down_guard_db` (2),
  `stones_integration_db` (7), `progression_kill_xp` (1), `seed_map_db`'s "every shipped spec applies
  cleanly" (1). `auth_routes` and `seed_catalogs_db` time out at 20s under parallel load.
- **CommonJS on the backend.** Match the surrounding comment density — this repo explains *why*.
- Branch `feat/home-region-f-waypoint-travel`, off `main` at `5d0e5d3`. Commit subjects
  `type(scope): summary (SOMET-293)`, ending with the
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` trailer.

## The scope gap this slice has to close first

Slice E shipped the waypoint *mechanism*. Slice B authored villages, roads and pens. **Neither
authored a waypoint row**, and the live database confirms it:

```
SELECT count(*) FROM waypoints;          -> 0
SELECT count(*) FROM character_waypoints -> 0
```

So F is inert without authoring, and the spec's own risk — *"the waypoint network has to be authored
before F lands, or travel gets worse before it gets better"* — is not a scheduling note here, it is a
task in this plan. Authoring is Task 1.

## The strandedness check, before anything is removed

The `fast-travel` leg is the only thing being taken away, so the question is whether any live
character's *only* route anywhere ran through it. It does not:

| Characters | Route after the retirement |
|---|---|
| 15 with a `world_players` row | `resume` — their last world, unchanged and untouched by this slice |
| 5 with no history at all | `first-join` — the entry world, unchanged |
| `admin` | the `admin` leg — the world picker, unchanged |

No character loses reachability. What they lose is the *shortcut* between two worlds they had both
visited, and that is what the waypoint network replaces. The evidence query is re-run and recorded in
Task 5 rather than trusted from here.

## The three decisions that shape everything else

### 1. Travel is authorized as a trip, executed as a transition

The ticket asks for two things that pull against each other: a `waypoint-travel` leg in `mayJoin`,
*and* arrival through `pendingArrivals` + `transition`. Taken naively they cancel out — if the server
writes `pendingArrivals` before sending `transition`, the follow-up join matches the `transition` leg
and the new leg never runs on any real request. That is precisely the SOMET-286 shape: a leg that is
green in tests and dead in the browser.

So the new leg authorizes **the travel request**, not the follow-up join:

```
client: {type:'travel', waypointId}
  authority: origin  = entry.waypoints.get(tile of THIS player, from the world object)
             facts   = joinPolicyFacts(dest world) + waypointTravelFacts(origin, dest)
             verdict = mayJoin({... travel: {...}})        <-- the waypoint-travel leg
  on allow:  pendingArrivals.set(characterId, {worldId, x, y})
             send {type:'transition', toWorldId, arriveX, arriveY}
client: reconnects, joins
  authority: mayJoin -> 'transition'                        <-- untouched leg
```

Every input to the verdict is a fact the server owns: the player's position comes from the live
`World` object, the origin waypoint from `entry.waypoints` (the Map `loadWorld` built with slice E's
`fetchWaypoints` — the same one the activation block reads), and both activations from
`character_waypoints`. The frame carries a waypoint id and nothing else; there is no field a forged
frame could set to change the answer.

### 2. `travel` is a distinct question, so exactly one leg may answer it

`mayJoin` gains an optional `travel` argument. **Its presence changes the question** from "may this
character be in that world" to "may this character travel there, now" — and when it is present,
exactly one leg answers:

```js
if (travel) {
  if (travel.standingOnActivatedWaypoint && travel.destinationActivated) {
    return { allowed: true, reason: 'waypoint-travel' };
  }
  return { allowed: false, reason: 'not-reachable' };
}
```

This is not decoration. Letting the ordinary cascade decide a travel would hand `resume` the answer,
and `resume` matches the world the character is *currently in* (its `world_players` row is the newest
one). A player could then select an **unactivated** waypoint in their own world and be teleported to
it — which is the exact thing acceptance criterion 4 says must be impossible. One leg, one question.

`isAdmin` still short-circuits above this, matching every other call: an admin already has an
unrestricted world picker, so denying them a waypoint hop would protect nothing. They still need a
real waypoint id, because that is where the arrival coordinates come from.

### 3. The retirement is a deletion, not a flag

`fast-travel` is removed from `mayJoin` outright, and the World Map's click handler, its `travelable`
node data and its green "you can travel here" legend go with it. `worlds.allows_fast_travel` stays in
the schema and in the specs — map authors read it to decide where waypoints belong — but nothing
consults it for authorization any more. The one place it survives in `mayJoin` is the `first-join`
leg, which is explicitly out of scope.

## Where the waypoints go, and why

Read from the live `villages` rows, not guessed. All three home-region villages are 6×4 boxes with a
south gate, so their interiors are structurally identical: two interior rows, four interior columns,
with the spawn tile, the merchant post and the two gate-guard posts already spoken for.

| World | Village box | Waypoint tile | Pixels | Name |
|---|---|---|---|---|
| Old Trailhead | rows 31–34, cols 30–35 | (32, 32) | 3250, 3250 | `Old Trailhead Commons` |
| Windwatch Pass | rows 24–27, cols 38–43 | (25, 40) | 4050, 2550 | `Windwatch Waystone` |
| Thornbriar Reach | rows 25–28, cols 28–33 | (26, 30) | 3050, 2650 | `Thornbriar Green` |

Each is **the interior tile immediately east of the village spawn, between the spawn and the
merchant** — one rule, applied three times, rather than three hand-picked coordinates. That tile is:

- inside the village footprint, so it is walkable by construction (`stampVillage` paints the interior
  as floor) and inside slice A's safe region, so nothing hostile spawns on it;
- not the spawn tile, not the merchant post, and not either gate-guard post — verified against the
  live `villages` and `world_creatures` rows, not derived from the geometry helpers alone;
- on the path a player already walks: you arrive at the spawn and step east to reach the merchant, so
  the waypoint lights itself the first time you trade.

**Three waypoints, no separate junction row.** The spec asks for "one per village plus any key
junction"; in this region the junction *is* a village. Windwatch Pass is the only world of the three
with four compass doorways (Old Trailhead, Hollow Cache, Ashfang Den, Shrikewind Gorge), so its
village waypoint already sits on the hub of the network. Every other link between the three worlds is
a compass doorway, which `validateMapSpec` rejects as a waypoint outright ("a doorway you can walk
through is not a shortcut worth a waypoint").

**The specs and the live rows are moved separately, on purpose.** Thornbriar Reach lives in
`hub-vale.map.json`; Old Trailhead and Windwatch Pass live in `spine-descent.map.json`. Both specs get
a `waypoints` block so a future `seed-map` run reproduces these rows instead of pruning them — but
`seed-map` is *not* run from this branch, because it converges a whole spec and this branch does not
carry slice B's villages. The live rows are inserted by migration, in the style of `1714440175000`,
and Task 5's DB test is what stops the two from drifting.

## File Structure

| File | Responsibility |
|---|---|
| `backend/seeds/maps/spine-descent.map.json` | **modify.** `waypoints` on `entry` and `pass`. |
| `backend/seeds/maps/hub-vale.map.json` | **modify.** `waypoints` on `forest`. |
| `backend/migrations/1714440240000_home_region_waypoints.js` | **new.** The three live rows, via `upsertWaypoint`. |
| `backend/src/services/joinPolicy.js` | **modify.** `+waypoint-travel`, `-fast-travel`, `waypointTravelFacts`. |
| `backend/src/authority/server.js` | **modify.** The `travel` message handler. |
| `frontend/src/games/something2/waypointTravel.js` | **new.** The pure popup rules (selectability, grouping, "where am I"). |
| `frontend/src/games/something2/WaypointTravel.jsx` | **new.** The popup, mounted beside `Minimap`. |
| `frontend/src/games/something2/src/js/net/WorldAuthorityClient.js` | **modify.** `sendTravel`, `onWaypointActivated`. |
| `frontend/src/games/something2/src/js/core/Game.js` | **modify.** `travelToWaypoint`, `setOnWaypointActivated`, waypoint snapshot. |
| `frontend/src/games/something2/GameView.jsx` | **modify.** Mount the popup. |
| `frontend/src/games/something2/PlayerWorldMap.jsx` | **modify.** Remove click-to-travel. |
| `frontend/src/games/something2/playerWorldMap.js` | **modify.** Remove `travelable`. |
| `backend/tests/join_policy.test.js` | **modify.** The exhaustive table, both legs. |
| `backend/tests/waypoint_travel_live.test.js` | **new.** Travel through the running authority. |
| `backend/tests/home_region_waypoints_db.test.js` | **new.** Live rows match the checked-in specs. |
| `frontend/src/games/something2/__tests__/waypointTravel.test.js` | **new.** Unactivated is distinct and not selectable. |
| `frontend/src/games/something2/__tests__/playerWorldMap.test.js` | **modify.** Travel is gone. |

---

### Task 1: Author the waypoints — specs and live rows

**Files:** modify `backend/seeds/maps/spine-descent.map.json`, `backend/seeds/maps/hub-vale.map.json`;
create `backend/migrations/1714440240000_home_region_waypoints.js`; test
`backend/tests/home_region_waypoints_db.test.js`.

Spec shape, added as a new key on the world object and nothing else moved (slice B is editing the
same files and a conflict should be three added blocks, not a restructure):

```jsonc
{ "key": "entry", "name": "Old Trailhead", ...,
  "waypoints": [ { "x": 3250, "y": 3250, "name": "Old Trailhead Commons" } ] }
```

The migration resolves each world **by name**, then calls `upsertWaypoint` from
`src/services/waypoints.js` — the same writer `seed-map` uses, so the migration cannot produce a row
shape the seeder would not. `1714440175000` set the precedent for a migration calling application
code when the alternative is a second copy of a write rule. `down()` deletes the three rows by name;
that cascades `character_waypoints`, which is correct (the places stop existing) and is stated in the
migration's own comment.

- [ ] **Step 1: Confirm the timestamp block is free** — `ls backend/migrations | sort | tail -5`.
- [ ] **Step 2: Write the failing DB test** in `backend/tests/home_region_waypoints_db.test.js`: read
      both spec files with `require`, resolve `world.name -> worlds.id`, and assert the `waypoints`
      rows for those worlds are **exactly** the authored set — name, world, and the *tile*
      (`floor(x/100)`, `floor(y/100)`), which is the unit the runtime actually keys on. Assert in both
      directions: every authored waypoint exists, and no unauthored waypoint exists in those worlds.
      A one-directional assertion passes with a stale extra row sitting in the table.
- [ ] **Step 3: Add a second assertion in the same file** — each waypoint tile is inside its world's
      `villages` box interior and is not the spawn, the merchant post or a `Village Guard` home post,
      **computed from the live rows**. This is what makes the placement rule checkable rather than a
      claim in a comment, and it fails if slice B later moves a village without moving the waypoint.
- [ ] **Step 4: Edit the two specs. Step 5: Write the migration. Step 6: Apply it** with
      `npx node-pg-migrate up --no-check-order --ignore-pattern '(?!.*\.js$).*'`.
- [ ] **Step 7: Run `map_spec_fixtures.test.js`** — every shipped spec must still validate, and
      `validateMapSpec` has waypoint rules that the new blocks have to satisfy.
- [ ] **Step 8: Re-check `SELECT count(*) FROM worlds WHERE is_entry` is 1. Commit.**

---

### Task 2: The join policy — one leg in, one leg out

**Files:** modify `backend/src/services/joinPolicy.js`; test `backend/tests/join_policy.test.js`.

**Interfaces produced:**

```js
mayJoin({ isAdmin, pendingWorldId, worldId, facts, travel })
  // travel absent  -> admin | unknown-world | transition | resume | first-join | not-reachable
  // travel present -> admin | unknown-world | waypoint-travel | not-reachable
  // 'fast-travel' is GONE as a reason token.

waypointTravelFacts(pool, characterId, originWaypointId, destinationWaypointId)
  -> { destination: { id, worldId, x, y, name } | null,
       standingOnActivatedWaypoint: boolean,
       destinationActivated: boolean }
  // one round trip; both activation answers come from character_waypoints.
```

`originWaypointId` is supplied by the caller from the live world object, never from the frame. Passing
`null` (the player is on no waypoint at all) makes `standingOnActivatedWaypoint` false, so "not
standing on one" and "standing on an unlit one" refuse through the same branch.

- [ ] **Step 1: Rewrite the table in `join_policy.test.js` exhaustively.** Every case asserted in both
      directions. Required cases, each named for what it protects:
      - **the removal:** visited + `allowsFastTravel` + `hasHistory`, no travel → `not-reachable`.
        This is the criterion; it was `fast-travel` before this slice.
      - `resume` still works for an unflagged, unvisited world (the dungeon a character logged out
        in) — the strandedness promise, asserted as its own named test.
      - `transition`, `first-join`, `admin`, `unknown-world`, the null-pending/null-world pair: all
        unchanged, all re-asserted, because "untouched" is a claim that needs a test.
      - **travel, allowed:** standing on an activated waypoint + destination activated →
        `waypoint-travel`.
      - **travel, refused, three ways:** not standing on any waypoint; standing on an *unactivated*
        waypoint; destination not activated. Each must be `not-reachable`, and each must be refused
        **even when `facts` would have allowed a plain join** (set `lastWorldId === worldId` and
        `visited`/`allowsFastTravel` true in those cases) — that is the assertion that proves the
        travel branch is not falling through to the cascade.
      - `no reason token 'fast-travel' is reachable`: sweep the whole fact space
        (`isEntry` × `allowsFastTravel` × `visited` × `hasHistory` × `lastWorldId` × pending × travel)
        and assert no verdict ever carries it. A deleted `if` is easy to re-add by accident during a
        merge with slice B.
- [ ] **Step 2: Implement** — delete leg 4, add the `travel` branch above the cascade, add
      `waypointTravelFacts`. Rewrite the file header comment: it currently explains the rule in terms
      of click-to-travel, which stops existing in Task 4.
- [ ] **Step 3: Run `join_policy.test.js` and `join_policy_db.test.js`. Commit.**

---

### Task 3: The travel handler, proved on the live tick path

**Files:** modify `backend/src/authority/server.js`; test `backend/tests/waypoint_travel_live.test.js`.

The handler is a new entry in the existing `messageHandlers` dispatch table, next to `join`:

```js
async travel(ws, msg) {
  const entry = worlds.get(ws.worldId);
  if (!entry || ws.characterId == null) return;
  const p = entry.world.getPlayer(ws.userId);
  if (!p) return;
  // The origin comes from the SERVER's copy of where this player is, matched
  // against the same entry.waypoints Map the activation block reads.
  const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
  const origin = entry.waypoints && entry.waypoints.get(waypointTileKey(cx, cy));
  ...
  const verdict = mayJoin({ isAdmin, pendingWorldId: null, worldId: dest.worldId, facts, travel });
  ...
  pendingArrivals.set(ws.characterId, { worldId: dest.worldId, x: dest.x, y: dest.y });
  send(ws, { type: 'transition', toWorldId: dest.worldId, arriveX: dest.x, arriveY: dest.y });
}
```

`pendingWorldId: null` is deliberate and gets its own comment: a stale pending arrival must not be
able to stand in for a waypoint the character has not lit.

**Same-world travel is allowed** (two lit waypoints in one world is ordinary Diablo behaviour) and
goes through the identical path — `transition` to the world you are already in, which `enterWorld`
handles as a rejoin.

- [ ] **Step 1: Write the failing test** with the `waypoint_activation_live.test.js` harness — real
      `attachAuthority`, a stateful fake pool, a real WebSocket client. This is not optional: a unit
      test of the handler proves nothing about whether the running authority routes `travel` to it,
      which is the SOMET-249 failure this repo keeps re-shipping. Cases:
      - standing on a lit waypoint, destination lit → exactly one `transition` frame, carrying the
        **destination waypoint's own** `toWorldId`/`arriveX`/`arriveY` (assert the values, not just
        the frame type);
      - the follow-up join to that world is **allowed** — reconnect and join in the test, and assert
        `joined` arrives. This is what proves `pendingArrivals` was written and that the two halves
        actually meet;
      - standing on a lit waypoint but destination **unlit** → no `transition`, and the player is
        still in the origin world;
      - standing on **no** waypoint → no `transition`;
      - standing on a waypoint the character has **not lit** → no `transition`;
      - an unknown/garbage `waypointId` → no `transition`, no crash, socket still alive.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Re-run the neighbouring live tests** —
      `waypoint_activation_live`, `portal_blocking_live`, and the transition tests — the tick loop and
      the dispatch table are shared surface.
- [ ] **Step 4: Commit.**

---

### Task 4: Retire world-map click-travel

**Files:** modify `frontend/src/games/something2/PlayerWorldMap.jsx`, `playerWorldMap.js`,
`__tests__/playerWorldMap.test.js`, `__tests__/PlayerWorldMap.smoke.test.js`.

Remove the `travelable` node datum, the `node[travelable]` stylesheet rule, the `cy.on('tap', ...)`
handler, `travelRef`/`inFlight`, the `enterWorld`/`navigate` imports if they fall unused, and the
green legend line. The fog-of-war view — visited worlds, dashed `?` stubs, the "you are here"
highlight — is untouched.

- [ ] **Step 1: Update `playerWorldMap.test.js` first.** It currently asserts `travelable` is set
      correctly; those cases invert to "no node carries a `travelable` datum". Keep every fog-of-war
      assertion exactly as it is — this task must not weaken SOMET-263.
- [ ] **Step 2: The existing source-token guard.** `playerWorldMap.test.js` reads this component's
      source to assert the absence of the edge-drawing plugin. Extend it to assert the absence of the
      tap handler, spelled the way that file already spells its forbidden tokens. A source grep is a
      weak test on its own — it is acceptable here only because it is asserting an **absence**, which
      is the one thing a behavioural test cannot do in a node-environment vitest that cannot mount
      cytoscape.
- [ ] **Step 3: Implement. Step 4: Run `npx vitest run`. Step 5: Commit.**

---

### Task 5: The travel popup

**Files:** create `frontend/src/games/something2/waypointTravel.js` and `WaypointTravel.jsx`; modify
`WorldAuthorityClient.js`, `Game.js`, `GameView.jsx`; test
`__tests__/waypointTravel.test.js`.

vitest runs in a node environment here, so **every rule worth asserting lives in `waypointTravel.js`**
and the `.jsx` is a thin renderer over it — the same split `playerWorldMap.js` uses and for the same
reason.

```js
// waypointTravel.js
buildTravelList({ waypoints, currentWorldId, playerX, playerY })
  -> { here: waypoint|null,          // the waypoint this player is standing on, or null
       standingOnActivated: boolean, // here && here.activated
       groups: [ { worldId, worldName, entries: [
         { id, name, activated, selectable, reason } ] } ] }
```

`selectable` is `standingOnActivated && entry.activated && entry.id !== here.id`. `reason` is the
token the UI renders next to a non-selectable entry (`'not-discovered'`, `'you-are-here'`,
`'not-on-a-waypoint'`) — a disabled row with no explanation reads as a broken popup, which is the
lesson the World Map's own legend comment already records.

The tile match uses `Math.floor(v / MAP_TILE_SIZE)` on the player's **centre**, the same arithmetic
`waypointTileKey` uses server-side. The client's answer is an *offer*; the server recomputes it from
its own copy of the position in Task 3.

Wiring: `Game.travelToWaypoint(id)` → `WorldAuthorityClient.sendTravel(id)` → `{type:'travel'}`.
`waypointActivated` gets a `case` in the client's switch and a `setOnWaypointActivated` hook on
`Game`, so the popup can invalidate its query when a new waypoint lights up — without it a player
lights a waypoint and the list keeps saying "not discovered" until reload. The `transition` frame
needs **no** new handling: `GameShell` already routes it to `enterWorld`.

- [ ] **Step 1: Write the failing tests for `buildTravelList`**, all against a payload shaped like the
      real `/api/player/waypoints` response:
      - an **unactivated** waypoint is present in the list, carries `activated: false`, is
        `selectable: false` and `reason: 'not-discovered'` — acceptance criterion 4, and the reason
        it is asserted here rather than on the DOM is that a node-environment vitest cannot mount the
        component at all;
      - an activated waypoint in another world is `selectable: true` **only when** the player is
        standing on an activated one;
      - standing on an *unactivated* waypoint makes every entry non-selectable with
        `reason: 'not-on-a-waypoint'` — the client mirroring the server's rule, not a looser version
        of it;
      - the waypoint the player is standing on is `'you-are-here'`, not a travel target;
      - grouping preserves the endpoint's `worldName` and never invents one.
- [ ] **Step 2: Build the fixture from the live service, not by hand.** Add one case to
      `backend/tests/waypoints_db.test.js` that snapshots the exact key set
      `listWaypointsForCharacter` returns, and assert in `waypointTravel.test.js` that the fixture
      uses that same key set. SOMET-286 shipped green-and-inert because a fixture encoded a shape the
      live loader never produces; this is the cheapest available guard against repeating it.
- [ ] **Step 3: Implement `waypointTravel.js`, then the component**, mounted in `GameView.jsx` as
      `{isPlaying && <WaypointTravel gameRef={gameRef} characterId={activeCharacter?.id} />}` beside
      `Minimap` and `CharacterSheet`. Toggle on **T**, Esc to close in the capture phase (copy
      `Minimap.jsx`'s handler — Esc otherwise pauses the game).
- [ ] **Step 4: Add the "Travel" row to `GameShell`'s `HELP_SECTIONS`** and remove the World Map's
      travel line from it if one is there. The help panel is one place describing the controls and it
      is not allowed to drift.
- [ ] **Step 5: Run `npx vitest run`. Commit.**

---

### Task 6: Verification

- [ ] **Step 1: Re-run the strandedness evidence** and record the actual output in the ticket comment:
      characters with a `world_players` row, characters with visits, characters with neither.
- [ ] **Step 2: Backend suite once**, both env vars exported, whole-suite. Expected: the 14 known
      failures and nothing else. Any other failure is a regression — stop and report BLOCKED.
- [ ] **Step 3: `cd frontend && npx vitest run`.** Expected 0 failures.
- [ ] **Step 4: `SELECT count(*) FROM worlds WHERE is_entry` is 1.**
- [ ] **Step 5: Write the browser script** for the human verifier: activate two waypoints, travel,
      confirm the arrival tile, confirm the World Map no longer offers travel, and what failure looks
      like at each step.

## Definition of done

- Three waypoints authored in both specs and live, agreeing by test.
- `waypoint-travel` in, `fast-travel` out, with an exhaustive table over both.
- Travel proved through a running authority, including that the follow-up join lands.
- The World Map is a map and nothing else.
- Backend suite at the known-failure baseline; `npx vitest run` clean.
- SOMET-293 to **To Review** with commits, evidence and the browser script. **Done is not this
  session's to set** — the browser leg belongs to the human verifier.

## Known gaps, stated rather than discovered later

- **`seed-map` is not run from this branch**, so the specs and the live rows are only proved equal by
  Task 1's DB test, not by having been applied through the seeder. Whoever merges slice B should run
  `seed-map` on `spine-descent` and `hub-vale` once both are on `main` and confirm
  `waypointsRemoved: 0`.
- **Travel has no cost, no cooldown and no cast time.** The spec asks for none. A player being chased
  can travel away from a fight instantly; the design's own answer to being chased is the village gate
  and its guards, so this is left as-is rather than invented here.
- **The popup's "where am I" is a client-side offer.** It reads the player position from the Game
  snapshot, which lags the server by up to a tick. The consequence is a briefly stale enabled/disabled
  state at the edge of a waypoint tile; the server refuses anyway, and the refusal is silent rather
  than a toast, which is a deliberate choice not to hand a probe a signal.
- **`allows_fast_travel` is now write-only data.** Nothing reads it for authorization except
  `first-join`. If it stays unread for another slice or two it should be reconsidered rather than
  quietly kept.
