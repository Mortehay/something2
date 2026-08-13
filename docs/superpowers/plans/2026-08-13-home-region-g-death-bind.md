# Home Region G — Death returns you to the last village you entered (SOMET-294)

**Goal:** Dying puts you back in the last village you walked into — even when that
village is in a different world.

**Architecture:** The player object already carries a respawn point (`p.spawn`) that
`World.resolveDeaths()` snaps to. This slice adds a second, richer fact next to it —
`p.bind`, the `{ worldId, x, y }` the `player_binds` row actually holds — and lets
`onPlayerDeath` in `server.js` compare `p.bind.worldId` against the world the death
happened in. Same world: nothing changes at all, `p.spawn` already is the bind point.
Different world: `resolveDeaths()` runs byte-for-byte as it does today (heal, clear
interrupt, clear effects, snap to the LOCAL respawn point) and `onPlayerDeath` then
enqueues a `pendingArrivals` entry and sends a `transition` frame — the exact pair the
doorway and portal paths already use.

**Tech Stack:** Node.js (CommonJS), raw `pg`, `node --test`. No migration, no schema
change — `player_binds` has carried `world_id` since `1714440029000` and its primary key
has been `character_id` alone since `1714440092000`, so a character has at most one bind
row and it already names its world. The only reason cross-world respawn does not work
today is that `loadSpawn` filters that row by `world_id`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-12-home-region-design.md` §6 and the third
  Risks bullet. Ticket **SOMET-294**, child of epic SOMET-287. Independent of A–F.
- **The double-fire guarantee is the risk of this slice.** `world.js:555-563` and
  `server.js:599-613` both document it in prose: `onPlayerDeath` fires once per death
  *only* because `resolveDeaths()` heals to full hp in the same synchronous pass it
  reports the death, so the next tick's call sees `hp > 0` and cannot report it again.
  It is not a lock and not a de-dup set. **Therefore `resolveDeaths()` is not touched by
  this slice at all** — not one line inside its body. The relocation is bolted onto
  `onPlayerDeath`, which already runs once per death by that same guarantee, and it runs
  in `onPlayerDeath`'s *synchronous prologue*, before the `applyDeath` promise, so it
  cannot interleave with a later tick.
- **Never mutate the shared dev database destructively.** No DELETE/TRUNCATE/DROP
  outside a test's own named fixtures, no `make reseed-map`, no `make clear-maps`.
- **Both DB env vars.** ~48 test files gate on `TEST_DATABASE_URL` and ~26 on
  `DATABASE_URL`; set only one and large parts of the suite skip silently while
  reporting success. Use the worktree's `run-backend-tests.sh`.
- **Known pre-existing failures**, not to be "fixed": `migration_convert_magic_weapons_db`
  (3), `migration_stone_item_type_down_guard_db` (2), `stones_integration_db` (7),
  `progression_kill_xp` (1), `seed_map_db`'s "every shipped spec applies cleanly" (1,
  SOMET-273). Baseline **2005 tests / 1988 pass / 14 fail / 3 cancelled**. Any other
  failure is a regression caused here.
- **CommonJS**, and match the surrounding comment density — this repo explains *why*.
- Branch `feat/home-region-g-death-bind`, off `main`. Commit subjects
  `type(scope): summary (SOMET-294)` with the
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` trailer.
  No merge, no push.

## What already exists, and what does not

Auto-bind on village entry is **already live** on `main` — `planBind` (`server.js:88`)
plus the tick-loop block at `server.js:1774-1785` writes `player_binds` and moves
`p.spawn` the moment a player's centre tile lands inside a village footprint. It is
already edge-triggered on village identity, so loitering at a gate is one write, not one
per tick. This slice does not re-invent it.

What does **not** exist:

1. `loadSpawn` (`server.js:522-526`) reads
   `SELECT x, y FROM player_binds WHERE character_id = $1 AND world_id = $2`. A bind in
   another world is invisible to that query, so `spawn.respawn` silently falls back to
   the join position and a cross-world death drops the player wherever they joined.
   Nothing anywhere in the process knows the bind is elsewhere.
2. Nothing relocates a player across worlds on death.
3. The throttle is identity-only. The home region puts several villages in one world
   (slice B), and the identity gate alone writes on every crossing, which for a player
   walking a seam between two footprints is a write per tick again.

## The throttle, and why the number

Two gates, answering different questions:

- **Identity** (already there): `planBind` returns `null` for the village you are already
  bound to. This is what makes standing at the gate — or walking a whole village end to
  end — exactly one write.
- **Time** (new): a per-player floor of **5000 ms** between `player_binds` writes.

Where 5000 comes from: `PLAYER_SPEED` is 200 world px/s and `MAP_TILE_SIZE` is 100, so a
player covers 2 tiles per second; `VILLAGE_LIMITS.minW/minH` is 3, so the smallest legal
village takes ~1.5 s to cross. Five seconds is therefore longer than any oscillation a
player can produce across a shared seam or a doorway between two adjacent footprints, and
it is short enough that somebody who genuinely relocates has a durable checkpoint long
before their next fight. It is a floor *between* writes, not a delay on the first one: the
first bind of a session writes immediately.

**The in-memory bind is never throttled — only the DB write is.** `p.spawn` and `p.bind`
update on the same tick the player crosses the footprint, so a suppressed write can never
put the death a player is about to have in the wrong place. The row it lags behind matters
only to a *later* session, and a `_bindDirty` flag guarantees the write lands on the next
eligible tick (and on socket close, so a disconnect inside the window cannot lose it).

## File Structure

| File | Responsibility |
|---|---|
| `backend/src/authority/world.js` | **modify.** One new player field, `bind`, set from a new defaulted `addPlayer` argument. `resolveDeaths()` untouched. |
| `backend/src/authority/server.js` | **modify.** `loadSpawn` reads the bind unfiltered by world; the tick-loop village block gains the time gate and writes `p.bind`; `onPlayerDeath` gains the cross-world relocation; the close handler flushes a dirty bind. |
| `backend/tests/village_bind_death.test.js` | **new.** Live-path tests: same-world, cross-world, no-bind, double-fire, throttle. |
| `backend/tests/authority_openchest_integration.test.js`, `overview_chest_cache_invalidation.test.js`, `authority_chests_broadcast_integration.test.js` | **modify (one line each).** Their `player_binds` mock branch matches the old SELECT list verbatim; widen it so the branch stays live rather than rotting into an unreachable arm that happens to agree with the fallthrough. |

---

### Task 1: the bind travels with the player

**Files:** `backend/src/authority/world.js`, `backend/src/authority/server.js` (`loadSpawn`, join).

**Interfaces produced:** `p.bind` — `{ worldId, x, y }` or `null` — on every live player.

- [ ] **Step 1: widen the bind read.**

`loadSpawn` currently asks for the bind *in this world*. Ask for the bind, full stop:

```js
const b = await pool.query(
  'SELECT world_id, x, y FROM player_binds WHERE character_id = $1',
  [characterId],
);
```

`player_binds`'s primary key is `character_id` alone (re-keyed off `user_id` by migration
`1714440092000`), so this returns at most one row — no ORDER BY, no LIMIT, nothing to pick
between.

Then split the answer in two, and comment *why* they are two things:

- `spawn.respawn` — where `resolveDeaths()` snaps the player **inside this world**. The
  same-world bind when there is one, otherwise the join position, exactly as today.
- `spawn.bind` — the row itself, world id included, or `null`.

A cross-world bind deliberately leaves `spawn.respawn` as the local join position: the
death still resolves locally and the player is briefly standing there before the client
completes the reconnect. Leaving them where they died would mean a failed reconnect leaves
them alive in the middle of whatever killed them.

- [ ] **Step 2: carry it on the player.**

`World#addPlayer` gains an eighth defaulted argument, `bind = null`, stored as `p.bind`.
Defaulted so every existing caller — and every test that builds a player — keeps behaving
exactly as before. Pass `spawn.bind` at the one call site (`server.js:1090`).

`resolveDeaths()` is not touched. It reads `p.spawn`, which still means what it always
meant.

- [ ] **Step 3: keep it fresh in the tick loop.**

In the village block, alongside the existing `p.spawn` assignment, set
`p.bind = { worldId: entry.worldId, x: v.spawnX, y: v.spawnY }`. Entering a village in the
world you are in is precisely what turns a cross-world bind back into a same-world one.

- [ ] **Step 4: run the existing bind/death tests.**

```
BACKEND_DIR=<wt>/backend bash <scratch>/run-backend-tests.sh tests/villageBind.test.js tests/progression_death.test.js tests/authority_server.test.js
```

Expected: PASS, unchanged. Nothing observable has moved yet.

- [ ] **Step 5: commit.**

---

### Task 2: the throttle

**Files:** `backend/src/authority/server.js` (village block, close handler).

- [ ] **Step 1: the failing test.**

In `backend/tests/village_bind_death.test.js`, drive the real tick loop with two villages
and a fake pool that counts `INSERT INTO player_binds`. Move the player between the two
footprints every tick for several throttle windows. Assert the write count is bounded by
the windows elapsed, **and** that the last write names the village the player finished in
— a throttle that merely drops writes would pass the first assertion and fail the second.

The window is injectable (`opts.bindWriteMinMs`, defaulting to the module constant) in the
same style as `tickMs`/`flushMs`/`heartbeatMs`, so the test drives the production code
path rather than a re-implementation of it.

- [ ] **Step 2: implement.** Identity gate (unchanged) sets `p.bind`/`p.spawn`/
  `p._boundVillageId` and raises `p._bindDirty`. A separate, unconditional pass writes when
  dirty and the floor has elapsed. Flush a dirty bind in the socket close handler next to
  the existing `persist`.

- [ ] **Step 3: run it.** Expected PASS, plus `villageBind.test.js` unchanged.

- [ ] **Step 4: commit.**

---

### Task 3: cross-world respawn

**Files:** `backend/src/authority/server.js` (`onPlayerDeath`).

- [ ] **Step 1: the failing tests** (all in `village_bind_death.test.js`, all through the
  real `attachAuthority` + a fake pool, following `progression_death.test.js`'s harness —
  `handle.worlds` is exposed, so a death is triggered by dropping the live player's hp,
  the same shortcut that file already uses):

```js
// 1. SAME-WORLD RESPAWN. Bind row in the world the player is in. Death snaps
//    them to the bind point, heals to full, and sends NO transition frame.
//    This is today's behaviour and the assertion that the widened SELECT did
//    not break it.
// 2. CROSS-WORLD RESPAWN. Bind row names another world. The player receives a
//    `transition` naming that world and the bind's coordinates, AND is healed
//    to full in the world they died in. Both halves asserted: a transition
//    without the heal is exactly the regression the Risks bullet warns about.
// 3. THE ARRIVAL IS AUTHORIZED. Rejoining the bind world after that transition
//    succeeds and lands on the bind coordinates -- with joinPolicyFacts rigged
//    so every OTHER leg of mayJoin refuses (not entry, not visited, not the
//    last world). The join can therefore only have been allowed by the
//    pendingArrivals entry this slice enqueues, which is the thing under test.
// 4. NO BIND. No row at all: today's behaviour, position snaps to the join
//    spawn, no transition.
// 5. DOUBLE FIRE. One cross-world death, ~20 ticks of observation: exactly ONE
//    transition frame and exactly ONE `UPDATE player_progression`. If the
//    relocation ever escaped onPlayerDeath's once-per-death guarantee it would
//    re-send every tick, and the player would be pinned in a reconnect loop.
// 6. DOUBLE FIRE, ADVERSARIAL. Two separate deaths must produce two
//    transitions -- otherwise test 5 would also pass on code that fires zero
//    times, which is the inert failure this repo keeps shipping.
```

- [ ] **Step 2: implement.** In `onPlayerDeath`, before the `applyDeath` promise:

```js
if (p.bind && p.bind.worldId !== entry.worldId) { pendingArrivals.set(...); send(ws, { type: 'transition', ... }); }
```

Synchronous, in the same block `resolveDeaths()` just returned into — nothing awaits
between the heal and the enqueue, so there is no window in which a second tick could see
the player still dead. No `recordVisit`: a character can only hold a bind in a world it has
physically walked a village in, so the visit row is already there; the doorway path's
defensive call exists because a doorway can lead somewhere genuinely new.

- [ ] **Step 3: run the new file plus every death/join-adjacent test.**

- [ ] **Step 4: full suite once, compare to the 14-failure baseline.**

- [ ] **Step 5: commit.**

---

## Known gaps, stated rather than hidden

- If the socket is already gone when a cross-world death resolves, the `pendingArrivals`
  entry is enqueued with no `transition` to deliver. It lingers until that character next
  joins that world, exactly as a doorway transition's does today. It is not a new
  authorization hole — it names a world the character has already stood in a village in.
- The relocation is a `transition` frame, so it depends on the client's existing
  `setOnTransition` → `enterWorld` path (`GameShell.jsx:334`). No client change is made or
  needed; that is also why this slice needs browser verification.

## Definition of done

- Backend suite green apart from the known 14.
- Browser verification (spec: G is one of the four slices that needs it).
- SOMET-294 to **To Review** with commits, test evidence, and the browser steps.
