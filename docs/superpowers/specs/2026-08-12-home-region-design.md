# Home Region — villages, safe roads, waypoints, and death

Date: 2026-08-12
Status: approved for slicing into Plane work items

## The premise

Every character begins in a village, and the whole starting region reads as
settled territory: several villages joined by roads that hostiles never spawn
on, with pockets of low-level, non-aggressive wildlife off the road for a new
player to practise on. A gate with guards is where you run when something
chases you. Getting from place to place is a Diablo/PoE waypoint network — you
walk to a waypoint once, it lights up, and from then on you can travel between
the ones you have lit. Dying puts you back in the last village you entered.

Five things have to exist for that to be true, and only one of them exists
today.

## What is already here

| Piece | State |
|---|---|
| Villages | Walled boxes, `w+h ≤ 10` tiles (SOMET-282 screen budget), one gate, 2 leashed guards, a merchant. `services/villages.js`. |
| Guards | `chase_style: 'guard'`, aggro 400 / leash 300 from a fixed post, target `faction='hostile'` only, never players. `authority/creatures.js`. |
| Roads | `mapService.js` already carves a deterministic, chunk-seam-safe path lattice (`collectPathCells`, `pathAnchor`). Purely cosmetic today. |
| Multi-village worlds | The stamper already loops `cfg.villages` **plural**; only the map spec (`w.village`, singular) and its validator are single. |
| Portals | `map_links` rows with `edge='PORTAL'` and tile coordinates. Walk-through only. 7 creatures carry `blocks_portal_id` to guard entrances. |
| Fast travel | World granularity: `worlds.allows_fast_travel` + `character_visited_worlds`, driven from the player World Map, authorized in `services/joinPolicy.js` (SOMET-266). |
| Death | `World.resolveDeaths()` snaps the player to `player_binds` or their join spawn, **same world only**. |
| Non-aggressive creatures | Do not exist. Every `chase_style` in the catalog acquires a target. |

## Design

### 1. The safe region

A new pure module, `services/safeRegion.js`, answers one question: **is this
tile safe?**

```
safe(tile) = inside a village footprint
           OR within safe_road_radius tiles of a carved path cell
           OR inside an authored safe rectangle
```

It calls `collectPathCells` rather than re-deriving roads, so the safe corridor
is exactly the road the player sees drawn — the two cannot drift apart, which
is the same one-source-of-truth reason `VILLAGE_LIMITS` is shared between
`index.js` and `seeds/mapSpec.js`.

**It is consumed at spawn time only.** `populateWorld` and the map-spec creature
placer skip safe tiles; the creature re-roll route inherits this because it goes
through the same placer. Nothing on the movement or tick path consults it.

That boundary is the design, not an economy: a hostile that is already chasing
a player **can** follow them onto the road and through the gate. That is the
moment the guards exist for. A hard barrier at the region edge would make the
rescue a non-event — the hostile would turn around and the gate would read as
an invisible wall.

Non-goal: safe regions do not suppress damage, PvP, or projectiles. A player
who drags a fight into a village gets a fight in a village, plus two guards.

### 2. The starting region

The entry world (Old Trailhead) and its two direct compass neighbours become
the home region. Everything beyond is untouched — hostile, banded, exactly as
today.

- **3–4 villages** across the three worlds, each obeying the existing box rules.
- **Roads** — the carved lattice, with `safe_road_radius` authored per world.

  **Correction, from SOMET-288's implementation:** an earlier draft of this
  section said the roads "connect the villages and the two doorways". Nothing
  can author *where* a road goes. `collectPathCells` derives the lattice purely
  from `seed` / `pathCell` / `pathJitter` on a coarse anchor grid, and
  `safe_road_radius` only widens whatever it already drew. SOMET-289 must pick
  one of three: place villages onto lattice cells found by inspection, add
  authored road polylines to the map spec and union them into
  `collectPathCells`, or accept that roads pass near villages by luck.
  `safeRegion` takes `pathCells` as an input, so none of the three is blocked.

  **Pick a radius of 1–3.** Measured against the real generator, the road leg
  alone marks a 64×64 world 26% safe at r=1, 40% at r=2, 52% at r=3 and 92% at
  r=8 — Chebyshev dilation saturates fast. The DB's `CHECK (0..8)` is a
  backstop against an absurd value, not a range to explore. When the safe
  region does eat the map, placement under-delivers; `populateWorld` warns when
  scatter places fewer creatures than requested.
- **Pens**: authored rectangles off-road holding skittish level 1–2 creatures.
  Deliberately **no walls and no gates on a pen**. The gate that matters is the
  village gate you flee toward; pen walls would be geometry with no mechanic
  behind it.

  **Trap, from SOMET-288's implementation:** the placement chokepoint refuses a
  safe tile for *any* creature type, not just hostiles — so a pen authored
  inside the road corridor comes out **silently empty**. SOMET-289 must either
  give pens their own placement pass that bypasses `isSafeTile`, or teach
  `creatureTileCandidates` the faction distinction. Separately,
  `populateWorld`'s opening DELETE spares only rows with `type = 'Village
  Guard'`, a `blocks_portal_id`, or a non-null `home_x`; a penned creature
  carrying none of those is deleted on the next populate — the bug that already
  bit portal guards (SOMET-246) and vault chests (SOMET-244).

Map spec changes: `villages: [...]` (plural, with `village` kept as a one-element
alias so existing specs still validate), `safe_road_radius`, `pens: [...]`. Live
rows are moved by migration in the same style as `1714440175000`.

Every authored change re-runs the offline navigability check `seed-map.js`
already performs at apply time: villages and pens must not sever a doorway from
the rest of the map.

### 3. Skittish creatures

New `chase_style: 'skittish'`:

- Never acquires a player on its own — aggro radius is not consulted for target
  selection while undisturbed.
- Retreats when a player closes inside a flee radius, moving directly away,
  clamped by its leash so it cannot be herded across the map.
- Switches to normal retaliation permanently (for that engagement) once it takes
  damage **or** once it is cornered — a retreat step that collision refuses.
- Loses the player and returns home at leash, like any other profile.

Two or three level 1–2 catalog rows adopt it. This is the only slice with
genuinely new movement code.

### 4. Guard rescue

Guards already refuse to target players and already engage `faction='hostile'`
only, so this is a targeting-priority and tuning problem, not new machinery:

- `selectGuardTarget` prefers a hostile that currently holds a **player** target
  over a nearer hostile that does not. A rescue must beat a wandering slime.
- The `Guard` behaviour row's leash rises far enough that an interception at the
  gate actually completes instead of stalling mid-chase at 300px.

Verified by a golden trace: player flees → crosses the gate → guard disengages
its post → hostile dies → guard walks home and re-anchors.

### 5. Waypoints

**Data.** A new `waypoints` table (`id`, `world_id`, `x`, `y`, `name`), plus an
opt-in `map_links.is_waypoint` boolean so a hand-picked safe staircase can also
serve as one. `character_waypoints (character_id, waypoint_id, activated_at)`
records activation, per character — the same reason `character_visited_worlds`
is per character.

**The gating rule, and it is load-bearing:** a portal referenced by any
creature's `blocks_portal_id` may **never** be flagged `is_waypoint`. Enforced
in the map-spec validator *and* pinned by a DB test over live rows. Without it,
a guarded dungeon entrance is bypassable on the second visit and the level-band
gating that `joinPolicy` was written to protect stops holding.

**Activation** is physical: walking onto a waypoint tile writes the row and
tells the client. There is no other way to light one.

**Travel** is only available while standing on an activated waypoint. The popup
lists every waypoint in a world the character has visited: activated ones as
travel targets, known-but-unactivated ones rendered distinctly and not
selectable.

**Authorization** is server-side, as with every join: a new `waypoint-travel`
leg in `mayJoin` accepts the destination only if `character_waypoints` holds it.
The client's claim is never the input. Arrival reuses `pendingArrivals` plus the
existing `transition` frame, so the player lands on the destination tile exactly
rather than at a world spawn.

**Retirement.** World-map click-to-travel (SOMET-266) is removed as a travel
mechanism and the `fast-travel` leg of `mayJoin` goes with it; the World Map
stays as the fog-of-war view. `worlds.allows_fast_travel` remains as data —
map authors use it to decide where waypoints belong — but it no longer
authorizes a join on its own. The `transition`, `resume` and `first-join` legs
are untouched.

### 6. Death returns you to your last village

Entering a village footprint silently writes `player_binds` for that character
(throttled, so a player loitering by the gate is not a write per tick). This is
the D2 checkpoint rule: death always returns you to the last village you
entered, wherever it is.

- Bind in the **current world** → today's behaviour exactly: `resolveDeaths()`
  snaps position and restores hp/mana/stamina.
- Bind in **another world** → `resolveDeaths()` still resolves the death
  synchronously (heal, clear interrupt, clear effects), and `onPlayerDeath` in
  `server.js` then enqueues a `pendingArrivals` entry for the bound village
  spawn and sends `transition`. Nothing tries to change worlds on the
  synchronous tick path.
- **No bind yet** — a character that has never entered a village → today's
  behaviour, unchanged.

The XP death penalty is unaffected; it already runs off the `died` list.

## Slices

Tracked under epic **SOMET-287**.

| Slice | Ticket | Scope | Depends on |
|---|---|---|---|
| **A** | SOMET-288 | `safeRegion.js`, spec support for plural villages / `safe_road_radius` / pens, spawn exclusion in `populateWorld` and the map-spec placer | — |
| **B** | SOMET-289 | Author the three home-region worlds: villages, roads, pens; migration moving live rows; navigability verified | A, C |
| **C** | SOMET-290 | `chase_style: 'skittish'` in the authority + catalog rows | — |
| **D** | SOMET-291 | Guard rescue: player-chasing target preference, leash tuning, golden trace | — |
| **E** | SOMET-292 | Waypoint data model, activation on contact, guarded-portal exclusion rule, read API | — |
| **F** | SOMET-293 | Waypoint travel: popup UI, activated vs unactivated display, `waypoint-travel` join leg, retire world-map click-travel | B, E (see Risks — retiring travel before waypoints are authored makes travel worse) |
| **G** | SOMET-294 | Auto-bind on village entry, cross-world respawn transition | — |

## Testing

- **A**: unit tests over `safeRegion` (village interior, road corridor edges,
  authored rectangle, a tile that is none of them); a placement test asserting
  no hostile lands on a safe tile for a seeded world.
- **B**: map-spec fixture tests (the existing `map_spec_fixtures.test.js`
  pattern) plus the navigability assertion; a DB test that the live rows match
  the checked-in spec.
- **C**: golden-trace test of a skittish creature — approach, retreat, damage,
  retaliate, leash home; plus a corner case where retreat is blocked.
- **D**: golden trace of the gate rescue; a test that a guard prefers the
  player-chasing hostile over a nearer idle one.
- **E**: validator test rejecting `is_waypoint` on a guarded portal; a DB test
  over live rows asserting the same; an activation test.
- **F**: exhaustive `mayJoin` table including the new leg and the removed one;
  a UI test that an unactivated waypoint is not selectable.
- **G**: same-world and cross-world respawn tests; a no-bind test asserting the
  old behaviour survives.

Browser verification is required for **B**, **D**, **F** and **G** — the four
with a surface a player can see. The repo's history is explicit that a green
suite has repeatedly shipped inert features.

## Risks

- **F retires shipped behaviour.** Removing the `fast-travel` leg from `mayJoin`
  strands any character whose only route home was a world-map click. The
  `resume` leg still covers where they logged out, and the waypoint network has
  to be authored (slice B/E) *before* F lands, or travel gets worse before it
  gets better. F must merge after B and E, not merely after E.
- **C is new movement code.** Retreat pathing on a map with walls is where
  skittish behaviour will misbehave; the cornered rule is the safety valve and
  needs the blocked-retreat test, not just the happy path.
- **G touches the death path**, which already carries a double-fire guarantee
  resting on `resolveDeaths()` healing in the same pass. The cross-world leg
  must not weaken that: the heal stays synchronous, only the relocation defers.
