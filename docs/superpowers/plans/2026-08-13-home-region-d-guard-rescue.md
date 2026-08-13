# Home Region D — Gate Guards Actually Rescue a Fleeing Player (SOMET-291)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** You run for the gate with something on your heels, and the guards deal with it — instead of watching from their posts while you die four tiles away.

**Architecture:** No new machinery. Guards already refuse to target players (`immuneToPlayerDamage` / `selectGuardTarget`'s `faction !== 'hostile'` skip) and already walk home afterwards (SOMET-154's path search). Two things change: `selectGuardTarget` gains a **priority key** — a hostile that currently holds a player target outranks a nearer one that does not — and the `Guard` behaviour row's `leash_radius` is raised **by migration**, because 300px is smaller than the guard's own 400px aggro radius and smaller than the guard's own village.

**Tech Stack:** Node.js (CommonJS), raw `pg`, `node-pg-migrate`, `node --test`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-12-home-region-design.md` §4. Ticket **SOMET-291**, child of epic SOMET-287. Independent of A/B/C/E/G.
- **Migration timestamp block: `1714440210000`–`1714440219000`.** Sibling worktrees hold 200000 (B), 220000 (E) and 230000 (G). A collision has cost this project real time before.
- **`npm run migrate:up` is broken on the shared dev database** (`1714440171000`/`1714440172000` are recorded out of order and `checkOrder` aborts). Use
  `npx node-pg-migrate up --no-check-order --ignore-pattern '(?!.*\.js$).*'`.
- **The TWO-LOADER inertness trap (SOMET-249).** Behaviour rows reach the sim through `creatures.js`'s `loadCreatureTypes` (the TYPE catalog, which its own comment says nothing ticks from) AND through `server.js`'s `CREATURE_JOINED_SELECT` (the live instance loader). A leash raised in the catalog and proved only through the first is inert in the running game. The DB test in Task 4 must go through `CREATURE_JOINED_SELECT` + `CreatureSim.addCreatures` and then through a real `tick()`.
- **Never mutate the shared dev database destructively.** No DELETE/TRUNCATE/DROP outside a test's own named fixtures, no `make reseed-map`, no `make clear-maps`.
- **Both DB env vars.** ~48 test files gate on `TEST_DATABASE_URL`, ~26 on `DATABASE_URL`. Set only one and large parts of the suite skip silently and report success. Do not `source .env` — exporting `JWT_SECRET` makes `auth_assertJwtSecret.test.js` fail spuriously.
- **Known pre-existing failures, not to be "fixed":** `migration_convert_magic_weapons_db`, `migration_stone_item_type_down_guard_db`, `stones_integration_db` (one schema drift, `column "stat_bonus_stat" ... already exists`), `progression_kill_xp`, `seed_catalogs_db` (full-suite contention; passes alone), and `seed_map_db`'s "every shipped spec applies cleanly" (SOMET-273). Any OTHER failure is a real regression.
- **CommonJS.** Match the surrounding comment density — this repo explains *why*, not *what*.
- Branch `feat/home-region-d-guard-rescue`, off `main`. Commit subjects `type(scope): summary (SOMET-291)`, ending with the `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` trailer. Do not merge, do not push.

## Why 300 is the wrong number, precisely

Three measurements, all taken from the geometry the game actually generates
(`VILLAGE_LIMITS` in `services/villages.js`, `villageGatePosts` in
`services/mapService.js`, `MAP_TILE_SIZE` 100):

1. **The leash is smaller than the aggro radius.** `GUARD_AGGRO_RADIUS` is 400
   and `selectGuardTarget` rejects any candidate outside `leashRadius` *of the
   post*. At 300 a guard refuses to engage a quarter of the area it can see —
   the 400 in the catalog is a lie today.
2. **The leash is smaller than the guard's own village.** The largest legal
   village is `w+h = 10`; for a 7x3 box with an E gate both posts clamp onto the
   same interior tile and the farthest interior tile is **400px** away. A hostile
   that follows a fleeing player through the gate and across the village reaches
   a corner the guard is forbidden to walk to. What the player sees is the guard
   chasing to an invisible line, stopping, dropping the target (the retention
   check is `withinLeash(target, home, leash)`), and walking home while they die.
3. **An interception at the gate needs room outside the wall.** A post is one
   diagonal tile from the gate at worst — **141.42px** — and the guard should be
   able to hold a hostile out to the edge of the aggro radius it had when it
   reached the gate. That is `141.42 + 400 = 541.42px`.

`max(400, 400, 541.42) = 541.42`, rounded up to a whole tile → **600**.

This derivation is **code, not prose**: Task 1 adds `guardRescueLeashRadius()`,
a pure function over `VILLAGE_LIMITS`/`villageGatePosts`/`GUARD_AGGRO_RADIUS`,
and Task 2's DB test asserts the live catalog value still covers it. If anyone
widens `VILLAGE_LIMITS`, the leash test goes red and says why — which is the
only thing that stops 600 becoming another number nobody can defend.

The number is **not** a licence to roam: `selectGuardTarget` still bounds
*acquisition* by `aggroRadius` (400) from the guard's current position, so a
guard standing its post notices exactly what it noticed before. The leash only
governs how far an already-started engagement may travel.

## What does NOT change

- `GUARD_LEASH_RADIUS` (300) in `authority/creatures.js` stays where it is.
  It is the **unprofiled** fallback (`GUARD_DEFAULT_BEHAVIOR`), whose documented
  job is reproducing pre-catalog behaviour for a guard whose `entity_types.
  behavior_id` is NULL. Every live guard is profiled (`Village Guard` →
  `Guard`, migration `1714440081000`), so the fallback is reached only by
  hand-built test fixtures. Raising it would be hardcoding the tuning the ticket
  says belongs in the database, and would silently invalidate the preconditions
  of six displacement tests that measure distances against it.
  The divergence is deliberate and must be **asserted**, not left to be
  discovered (Task 2).
- A guard still never targets a player. `selectGuardTarget`'s
  `o.faction !== 'hostile'` skip and `immuneToPlayerDamage` (SOMET-285) are
  untouched, and Task 3's tests re-prove both under the new priority rule —
  a priority key over the candidate list is exactly the kind of change that
  could smuggle a player back in.
- The walk-home machinery (SOMET-154) is untouched.

## File Structure

| File | Responsibility |
|---|---|
| `backend/src/services/mapService.js` | **modify.** Export `villageGatePoint(v)` — the gate tile's pixel centre, from the same mid-row/mid-col rule `villageGateCell` uses. |
| `backend/src/services/villages.js` | **modify.** `guardRescueLeashRadius()`: the geometry derivation, exported. |
| `backend/migrations/1714440210000_guard_rescue_leash.js` | **new.** Raise `creature_behaviors.Guard.leash_radius` 300 → 600. |
| `backend/seeds/data/creatureBehaviors.js` | **modify.** The same value, so a fresh database gets it. |
| `backend/src/authority/creatures.js` | **modify.** `selectGuardTarget` priority key; the guard branch's upgrade-to-a-rescue rule. |
| `backend/tests/guard_rescue_leash.test.js` | **new.** The derivation, and the seed/constant divergence. |
| `backend/tests/guard_rescue_priority.test.js` | **new.** Priority, in the helper and through a live tick. |
| `backend/tests/guard_rescue_golden.test.js` | **new.** The golden trace. |
| `backend/tests/guard_rescue_leash_db.test.js` | **new.** The live-loader + live-tick proof. |
| `backend/tests/creature_behaviors_invariants.test.js` | **modify.** The Guard row pin and the seed↔migration drift exception. |
| `backend/tests/creature_behaviors_seed_db.test.js` | **modify.** The live-row pin. |

---

### Task 1: The derivation, as code

**Files:**
- Modify: `backend/src/services/mapService.js`
- Modify: `backend/src/services/villages.js`
- Test: `backend/tests/guard_rescue_leash.test.js` (new)

**Interfaces produced:** `villageGatePoint(v) -> {x, y}` and
`guardRescueLeashRadius() -> number`.

- [ ] **Step 1: `villageGatePoint`**

`villageGateCell(gRow, gCol, v)` already knows which tile is the gate but answers
a yes/no question about a tile the caller supplies. Add the constructive form
beside it, built from the same `midCol`/`midRow`/`rMax`/`cMax` expressions, and
export it.

- [ ] **Step 2: `guardRescueLeashRadius`**

In `services/villages.js`, next to `VILLAGE_LIMITS` (which it reads) and
`villageScreenBox` (whose "search it, do not hardcode it" shape it copies):
enumerate every legal `(w, h, gateEdge)`, and for every guard post take
(a) the distance to the farthest interior tile centre and (b) the distance to the
gate tile centre plus `GUARD_AGGRO_RADIUS`. Return the maximum of those and
`GUARD_AGGRO_RADIUS` itself, rounded **up to a whole tile**.

- [ ] **Step 3: The test**

`backend/tests/guard_rescue_leash.test.js`. Assert the *inputs* separately from
the result, so a future reader can see which term moved:

```js
// The three terms, each named and each asserted on its own. A single
// assertEqual(600) would go red on any change and tell nobody which of the
// three geometry facts had moved.
```

Required cases:
- the worst post→interior distance is 400px, and names the box that produces it
  (7x3, E gate) — a fixture check on the geometry, not on the leash;
- the worst post→gate distance is one diagonal tile (141.42px);
- `guardRescueLeashRadius()` is a whole number of tiles, is `>= GUARD_AGGRO_RADIUS`,
  and is `>=` both geometry terms;
- `villageGatePoint` agrees with `villageGateCell` for every legal village —
  i.e. `villageGateCell` is true for exactly the tile `villageGatePoint` names.
  Without this the derivation could be measuring a tile that is not the gate.

- [ ] **Step 4: Commit** — `feat(villages): derive the leash a gate rescue needs from village geometry (SOMET-291)`

---

### Task 2: Raise the leash, in the database

**Files:**
- Create: `backend/migrations/1714440210000_guard_rescue_leash.js`
- Modify: `backend/seeds/data/creatureBehaviors.js`
- Modify: `backend/tests/creature_behaviors_invariants.test.js`
- Modify: `backend/tests/creature_behaviors_seed_db.test.js`
- Modify: `backend/tests/guard_rescue_leash.test.js`

- [ ] **Step 1: The migration**

`UPDATE creature_behaviors SET leash_radius = 600 WHERE name = 'Guard'`, with
`down` restoring 300. The header comment carries the full derivation (the three
terms and the numbers), names `guardRescueLeashRadius()` as the executable form,
and says why `GUARD_LEASH_RADIUS` in `authority/creatures.js` deliberately stays
at 300.

Scoped by `name = 'Guard'` and nothing broader: the incident recorded in
`1714440191000`'s header is a `WHERE` clause that matched 94 rows it should not
have.

- [ ] **Step 2: The seed file**

Same value on the `Guard` row in `seeds/data/creatureBehaviors.js`, or the next
`npm run seed:catalogs` silently reverts the live database — the exact failure
mode `1714440173000` + the `damage_override` invariants test exist for.

- [ ] **Step 3: The two existing pins**

`creature_behaviors_invariants.test.js`:
- "the database Guard row equals today's GUARD_* constants" must now assert the
  **deliberate divergence**: `aggro_radius` still equals `GUARD_AGGRO_RADIUS`,
  and `leash_radius` is `guardRescueLeashRadius()` — strictly greater than
  `GUARD_LEASH_RADIUS`, which is the unprofiled fallback and not the live number.
  Say why in the comment. Do not simply delete the assertion.
- Add `Guard.leash_radius` to `SUPERSEDED_BY_LATER_MIGRATION`
  (`{ migration: 300, seed: 600, by: '1714440210000' }`). The map's own design
  makes the exception auditable and un-widenable; use it rather than loosening
  the field-for-field comparison.

`creature_behaviors_seed_db.test.js`: the live-row `leash_radius` assertion
becomes 600, with the derivation named.

- [ ] **Step 4: Apply and run**

```bash
cd <worktree>/backend
DATABASE_URL=... npx node-pg-migrate up --no-check-order --ignore-pattern '(?!.*\.js$).*'
BACKEND_DIR=<worktree>/backend bash <scratch>/run-backend-tests.sh \
  tests/creature_behaviors_invariants.test.js tests/creature_behaviors_seed_db.test.js \
  tests/guard_rescue_leash.test.js tests/village_guard_seed_durability.test.js
```

- [ ] **Step 5: Commit** — `feat(creatures): a gate guard's leash reaches past its own gate (SOMET-291)`

---

### Task 3: A rescue outranks a wandering slime

**Files:**
- Modify: `backend/src/authority/creatures.js`
- Test: `backend/tests/guard_rescue_priority.test.js` (new)

**Read before editing:** `selectGuardTarget` (~line 473) and its call site in the
guard branch (~line 826). The tick already builds `byId` (userId → player) at the
top of `tick()`.

**What to build:**

1. `huntsAPlayer(creature, playersById)` — true when the candidate's `_target`
   is a live player id. Guarded twice: `playersById` may be absent (every
   existing caller and test), and a candidate whose `_targetKind === 'creature'`
   holds a *creature* id, which could collide numerically with a userId.
   Absent `playersById` ⇒ nobody hunts ⇒ byte-identical to today's selection.
2. `selectGuardTarget` takes an optional `playersById` and compares
   **lexicographically: hunting first, distance second.** Keep the existing
   `<=` distance tie-break (last equal candidate wins) so the frozen behaviour
   for a field with no rescues is unchanged, and keep the aggro cap as a
   separate constant rather than folding it into the running best.
3. **The upgrade rule, in the tick.** A held target is kept, as today — except
   when it is not a rescue and a rescue is available, in which case the guard
   switches. Without this the feature is half-inert: a guard already busy with a
   slime never re-selects (`if (!displaced && !tgt)`), which is precisely the
   case the ticket describes. The rule is monotone — only ever
   not-a-rescue → rescue — so it cannot oscillate.

- [ ] **Step 1: Write the failing tests**

`backend/tests/guard_rescue_priority.test.js`. Required cases:

```js
// 1. HELPER, PRIORITY. A nearer idle hostile and a further one holding a
//    player target: the further one is chosen.
// 2. HELPER, DISTANCE STILL DECIDES among equals. Two hostiles both hunting
//    players: the nearer wins. (Proves the priority key did not replace the
//    distance ordering, only outrank it.)
// 3. HELPER, NO PLAYERS MAP. Omit playersById entirely: the nearest wins,
//    exactly as before. This is what keeps every existing caller honest.
// 4. HELPER, STILL NEVER A PLAYER. A player-faction... there is no such
//    creature; the real case is a guard-faction creature and a player object
//    in the candidate list. Both must be refused.
// 5. HELPER, A GUARD-STYLED CANDIDATE'S CREATURE TARGET IS NOT A RESCUE.
//    _targetKind 'creature' with an id that also exists as a userId.
// 6. LIVE TICK, PRIORITY. Two hostiles inside the post's leash, only the
//    further one within aggro of a player. Assert the guard's _target after
//    the sim has settled, not after tick 1 — on the first tick the hostile
//    has not resolved its own target yet, and asserting there would pin
//    Map insertion order rather than the rule.
// 7. LIVE TICK, UPGRADE. The guard starts locked onto the idle hostile; a
//    player then walks into the other hostile's aggro. The guard must switch.
// 8. LIVE TICK, NO DOWNGRADE. Once on a rescue, a nearer idle hostile must
//    NOT steal the guard back — the anti-oscillation half of the rule.
// 9. LIVE TICK, THE PLAYER IS STILL NEVER A TARGET, and still takes no
//    damage from the guard, with a player standing between the two hostiles.
```

- [ ] **Step 2: Run them and confirm they fail** (1, 6, 7 fail; 2/3/4/5/8/9 must
      pass before the change too — say so, a case that only passes afterwards is
      testing something else).

- [ ] **Step 3: Implement.** Change nothing outside `selectGuardTarget`, the new
      predicate, and the guard branch's target-resolution block.

- [ ] **Step 4: Prove the guard suite did not move**

```bash
BACKEND_DIR=<worktree>/backend bash <scratch>/run-backend-tests.sh \
  tests/guardTick.test.js tests/guardHelpers.test.js tests/guardWallReturn.test.js \
  tests/authority_guard_knockback.test.js tests/guard_player_immunity.test.js \
  tests/creature_behavior_golden.test.js
```

`creature_behavior_golden.test.js` is the frozen trace — **if it fails, stop and
report BLOCKED.** Do not update a golden to make it pass.

- [ ] **Step 5: Commit** — `feat(creatures): a guard rescues before it swats (SOMET-291)`

---

### Task 4: The golden trace, and the live-loader proof

**Files:**
- Test: `backend/tests/guard_rescue_golden.test.js` (new)
- Test: `backend/tests/guard_rescue_leash_db.test.js` (new)

- [ ] **Step 1: The golden trace**

Drive `CreatureSim.tick` — the real one — over a real wall ring. Reuse
`guardWallReturn.test.js`'s map shape (a tile-grid `isWalkable` where only the
gate tile breaks the ring); do **not** re-implement any movement maths in the
test.

The village is the **worst legal box, 7x3 with an E gate**, because that is the
box the leash number was derived from: both posts clamp onto one interior tile
and the far interior corner is exactly 400px away.

The guard runs the **shipped `Guard` profile read from the seed catalog**, not
`GUARD_DEFAULT_BEHAVIOR` — the fallback still carries 300 and a trace built on it
would prove nothing about the tuning that ships.

The trace, recorded per tick and asserted as an **ordered sequence of phases**:

```
1. ARMED     guard at post, mode 'guard', no target; hostile chasing the player
             outside the village and beyond the guard's aggro.
2. CROSSING  the player's centre passes the gate tile into the village box.
3. PURSUED   the hostile follows through the gate (it is NOT stopped at the
             wall — that boundary is the design, see spec §1).
4. ENGAGED   the guard's mode becomes 'chase' and its target is the hostile,
             and it leaves its post.
5. KILLED    the hostile's id appears in tick().killed.
6. HOME      the guard's mode returns to 'guard' within GUARD_HOME_EPSILON of
             its post, having WALKED (no single tick displaces it more than
             one step) — the SOMET-154 snap would satisfy "re-anchors" without
             the guard ever moving.
```

Plus, in the same file and the same fixture:

- **The player is never targeted and never damaged by the guard** through the
  whole trace. This is acceptance 3 and it must be asserted on the live path,
  not only through `immuneToPlayerDamage`.
- **The counterfactual.** Re-run the identical scenario with the guard's
  `leashRadius` set to the old 300 and assert the hostile **survives** and the
  guard **never engages it in the far corner**. Without this arm the trace
  passes at any leash and the migration is unfalsifiable.

- [ ] **Step 2: The live-loader proof**

`backend/tests/guard_rescue_leash_db.test.js`, modelled on
`creature_skittish_db.test.js`. A real `world_creatures` row of type
`Village Guard` in a `zzGuardLeash*` fixture world, read back through the exact
`CREATURE_JOINED_SELECT` text `server.js` exports, fed through
`CreatureSim.addCreatures`, and then:

1. `instance.behavior.leashRadius` is the derived number, and is **strictly
   greater than `GUARD_LEASH_RADIUS`** — so the assertion cannot be satisfied by
   the unprofiled fallback, which is the way this test would go vacuous;
2. a real `tick()` with a hostile placed **beyond the old leash and inside the
   new one** acquires that hostile. The field being copied is not the claim; the
   claim is that the tick's leash gate uses it.

Fixture rows deleted BY NAME, unconditionally, in a `finally` — never by an id
captured mid-test.

- [ ] **Step 3: Full suite, once**

```bash
BACKEND_DIR=<worktree>/backend bash <scratch>/run-backend-tests.sh
```

Expected: the known pre-existing failure set from Global Constraints and nothing
else. Any other failure is a regression — stop and report BLOCKED.

- [ ] **Step 4: Commit** — `test(creatures): golden trace of a gate rescue, end to end (SOMET-291)`

---

## Definition of done

- Backend suite green apart from the known pre-existing failure set.
- **Browser verification is required for this slice** (spec Testing section) and
  is run separately in the main checkout. What to look at:
  a level-1 character in a village world, a hostile aggroed outside the gate,
  the player running through it — the guard must leave its post, meet the
  hostile, kill it, and walk back. The two failure modes to watch for are the
  guard stopping at an invisible line mid-chase (leash still 300 in the live
  database — check `creature_behaviors.Guard.leash_radius`), and the guard
  ignoring the chaser for a nearer idle creature.
- SOMET-291 moves to **To Review** with a comment naming the commits, the leash
  number and its derivation, and the test evidence.
