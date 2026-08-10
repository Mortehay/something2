# Plan B — Map-based fast travel

Turns the read-only player World Map into a travel surface: click a world you
have visited and enter it, gated so the existing portal-guard mechanic keeps
working.

**Depends on Plan A** (`2026-08-10-login-resume-and-visited-backfill.md`).
Without the backfill, every pre-existing character's map is empty and there is
nothing to click.

**Goal:** a player navigates the world from the map instead of from a raw
86-item list.

**Users:** players. Whether admins get it is an open question (below).

---

## Why a flag, and not "anywhere you have been"

The obvious design — click any visited world — conflicts with mechanics that
already exist:

- **7 creatures carry `blocks_portal_id`**, placed specifically to gate dungeon
  entrances. Fast travel past them makes them decorative.
- **Level bands run 1-1 to 47-50** across 86 worlds. A character that once
  stepped into a high-band world could return to its interior at any level.

So travel targets are opt-in per world via a new column, default false.
Dungeons are simply never targets, which preserves gating **by construction**
rather than by a rule someone must remember to check.

---

## Slice 1 — the flag exists and is seedable

The whole slice is copied from how `is_entry` already works; there is no new
pattern to invent.

**Files**
- Create: `backend/migrations/1714440163000_world_fast_travel.js`
- Modify: `backend/seeds/mapSpec.js` (validation)
- Modify: `backend/scripts/seed-map.js` (apply)
- Test: `backend/tests/map_spec_validate.test.js`, `backend/tests/world_fast_travel_db.test.js`

**Migration**

```js
exports.up = (pgm) => {
  pgm.addColumns('worlds', {
    allows_fast_travel: { type: 'boolean', notNull: true, default: false },
  });
};
exports.down = (pgm) => pgm.dropColumns('worlds', ['allows_fast_travel']);
```

`default: false` is the safety property: a world added later is not a travel
target until someone says so. **Do not add a data migration flagging existing
worlds** — that is Slice 2's job and needs judgement.

**Spec + seeder.** Accept an optional `allows_fast_travel` boolean per world in
the spec, default false, and apply it in `seed-map.js` beside the existing
`is_entry` handling. Unlike `is_entry`, it is **not** mutually exclusive — many
worlds may carry it, so no "clear the others" step.

**Verification:** re-seeding a spec sets the flag to the spec's value, and a
world whose spec omits the key ends up false rather than null.

---

## Slice 2 — classify the worlds

Content work, not code. This is what the user asked to do before the flag is
set anywhere.

There are only **4 spec files** covering all 86 worlds, so this is per-cluster
labelling, not 86 individual calls. The split is very uneven, which decides
where the effort actually goes:

| spec | worlds |
|---|---|
| `hub-vale` | 5 |
| `loop-catacombs` | 7 |
| `spine-descent` | 8 |
| **`p5-descent`** | **66** |

Three specs are 20 worlds between them and can be labelled in one sitting.
`p5-descent` is 77% of the work on its own and is where a rule — rather than
per-world judgement — will be needed.

**Starting evidence** — the compass-connected component from Old Trailhead is
20 worlds and, usefully, contradicts the obvious guesses:

- it **includes** Catacomb Threshold, Sealed Mausoleum, Farrow Hall, Deepvault
  Row, Drowned Southwing, Frozen Ossuary Heart, Sunken Eastwing — these read
  like dungeon interiors but are compass-walkable surface locations
- it **excludes** the entire "Reach"/"Frontier" tier, which reads like
  overworld but sits in separate clusters

so neither naming nor level band is a safe proxy. The query that produced it:

```sql
WITH RECURSIVE overworld AS (
  SELECT id, name FROM worlds WHERE name = 'Old Trailhead'
  UNION
  SELECT w.id, w.name FROM overworld o
    JOIN map_links l ON l.from_world_id = o.id AND l.edge <> 'PORTAL'
    JOIN worlds w ON w.id = l.to_world_id)
SELECT * FROM overworld;
```

**Deliverable:** each spec's worlds labelled travel-target or not, written into
the spec files (reviewable in a diff, survives a re-seed) — **not** applied by
hand to live rows. Hand-editing shared world rows is how `is_entry` was lost.

**Judgement rule to confirm with the owner before labelling:** a travel target
should be somewhere a player can safely arrive alone. Start narrow; widening
later is safe, narrowing takes travel away from players who already had it.

---

## Slice 3 — travel from the map

**Files**
- Modify: `backend/src/index.js` (the player world-map endpoint)
- Modify: `frontend/src/games/something2/playerWorldMap.js`
- Modify: `frontend/src/games/something2/PlayerWorldMap.jsx`
- Test: `backend/tests/player_world_map_routes.test.js`, `frontend/src/games/something2/__tests__/playerWorldMap.test.js`

**Endpoint.** Add `allows_fast_travel` to the visited-worlds SELECT and emit it
per world. **Do not emit it for unvisited stubs** — a stub already withholds
name, level band and coordinates, and "this unseen place is a travel hub" is
information the player has not earned.

**Transform.** Carry it into node data as a string (`'true'`/`'false'`, the
cytoscape selector convention this file already uses for `unvisited` and
`current`) so the stylesheet can render non-targets differently.

**Component.** A click handler on nodes where `travelable === 'true'` and the
node is not already current. Everything else is inert — and the existing
read-only guards (no edgehandles, no mutation hook, no drag persist,
`autoungrabify`) must remain, so `playerWorldMap.test.js`'s absence assertions
stay as they are. Travel is a *navigation* affordance, not an editing one.

**Entering.** Reuse `enterWorld` from the Outlet context rather than opening a
socket here; `GameShell` owns the game lifecycle, and a second entry path is
exactly the two-loader shape that has bitten this project before.

**The server must re-check.** The client only decides what to *offer*. The
authority's join handler must reject a fast-travel arrival into a world that is
not flagged, or not visited by that character — a client-side gate is not a
gate. This is the security-relevant assertion of the slice and needs its own
test with a hand-crafted join frame.

---

## Slice 4 — rules beyond the flag

Deferred until Slices 1-3 are usable, because the right answers are easier to
judge once travel can be felt. Candidates, all currently **unresolved**:

- level gating in addition to the flag
- blocked while creatures are aggro / in combat
- a cost or cooldown
- whether arrival uses the character's saved position in the destination or a
  fixed safe point

---

## Included scope

`allows_fast_travel` end to end: column, spec field, seeder, classification,
endpoint field, map click-to-travel, and the server-side re-check.

## Excluded scope

- Plan A's two defect fixes
- SOMET-265 (`is_entry` regression)
- Any change to how *walking* between worlds works — doorways and portals are
  untouched
- Admin World Map **Editor** changes; the spec files stay the only writer of
  the flag in this plan
- The Slice 4 rules

## Assumptions

- **Visited implies allowed to return** (subject to the flag). If revisiting
  should ever require re-clearing a guard, this whole model needs revisiting.
- ~~The 4 spec files genuinely cover all 86 worlds.~~ **Verified**: the specs
  declare 5 + 7 + 66 + 8 = 86 worlds, matching the database exactly. Every
  world has a spec home, so Slice 2 can be done entirely in the spec files with
  nothing left over.
- `enterWorld` is safe to call for a world the player is not adjacent to. It is
  the same call the admin world picker already makes for arbitrary worlds, so
  this is likely but should be confirmed in Slice 3.

## Verification strategy

Both suites, then browser. Specifically for this feature: travel to a flagged
world and confirm arrival; confirm an unflagged visited world is visibly not a
target and does nothing on click; and **forge a join frame for an unflagged
world to confirm the server refuses it** — the client-side gate must not be the
only one.

## User-visible acceptance criteria

- Clicking a visited, flagged world on the map enters it.
- A visited but unflagged world is visibly distinct and inert on click.
- An unvisited stub stays anonymous and reveals no travel information.
- Fast travel cannot place a character inside a portal-guarded dungeon it has
  not walked into.
- The map remains read-only in the editing sense: no world creation, deletion,
  link editing or position persistence.

## Known risks & unresolved questions

- **Misclassifying one world silently defeats the guard mechanic.** This is the
  headline risk and the reason for default-false plus narrow initial labelling.
- **`seed-map.js` clears `is_entry` on every other world** before setting its
  own, and 4 specs each assert an entry world — so the last seed wins. Do not
  copy that pattern for the new flag; it is a bug waiting to happen for
  `is_entry` and must not be replicated.
- **Open:** does the flag mean "safe for anyone" or is it combined with level?
- **Open:** do admins get map travel, or is it player-only?
- **Open:** is the `first_seen_at` approximation from Plan A ever surfaced? If
  travel ordering or "discovered on" is shown, backfilled dates are wrong.
