# Home Region C — Skittish Creature Behaviour (SOMET-290)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A creature that ignores you until you hurt it — it backs away when you get close, fights back when damaged or cornered, and cannot be herded across the map.

**Architecture:** A new `chase_style: 'skittish'` in the `creature_behaviors` catalog, routed in `CreatureSim.step`'s existing chase branch alongside `kite` and `skirmish`. Provocation is stamped at `damage.js`'s single `applyDamage` funnel, so every damage source — melee arc, projectile, AoE detonation, burn tick — provokes without any of them naming the rule. The flee clamp reuses the existing `withinLeash` helper, which treats a null home as unconstrained: a skittish creature with a home anchor cannot be pushed away from it, and one without behaves exactly as it would with no clamp at all.

**Tech Stack:** Node.js (CommonJS), raw `pg`, `node-pg-migrate`, `node --test`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-12-home-region-design.md` §3. Ticket: **SOMET-290**, child of epic SOMET-287. **SOMET-289 (slice B) is blocked on this** — it populates its pens with these creatures.
- **The allowed chase styles are listed in TWO places, deliberately.** `CHASE_STYLES` in `backend/src/services/creatureBehaviors.js` and the `creature_behaviors_chase_style_check` CHECK constraint. That file's own comment explains why: "a value rejected only in JS is a value that reaches the database, and a value rejected only in SQL is a value that reaches the sim from a row written before the constraint existed." Both must accept `skittish`.
- **The TWO-LOADER inertness trap (SOMET-249).** A behaviour authored in the catalog but read through only one of two loaders is silently inert in the live tick. Behaviours reach the sim through `creatures.js`'s `LEFT JOIN creature_behaviors` AND through `server.js`'s per-chunk spawn loader. A test must prove the new style is live on the path the running authority actually uses, not just the seed loader.
- **Never mutate the shared dev database destructively.** No DELETE/TRUNCATE/DROP outside a test's own named fixtures, no `make reseed-map`, no `make clear-maps`.
- **Both DB env vars.** 48 test files gate on `TEST_DATABASE_URL`, 26 on `DATABASE_URL`. Export both or large parts of the suite skip silently and report success.
- **One known pre-existing failure set** on this repo, unrelated to this work and not to be "fixed": `migration_convert_magic_weapons_db`, `migration_stone_item_type_down_guard_db`, `stones_integration_db` (all one schema drift, `column "stat_bonus_stat" ... already exists`), `progression_kill_xp`, and `seed_map_db`'s "every shipped spec applies cleanly" (SOMET-273). Any OTHER failure is a real regression.
- **CommonJS.** Match the surrounding comment density — this repo explains *why*, not *what*.
- Branch `feat/home-region-skittish`, off `main`. Commit subjects `type(scope): summary (SOMET-290)`, ending with the `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` trailer.

## The behaviour, precisely

A skittish creature resolves a nearest player within `aggroRadius` into `_target` exactly like any other creature — it needs to know who to back away from. What changes is what it does with that target:

| state | movement | attack |
|---|---|---|
| unprovoked, player closer than `preferredRange` | retreat along the reversed target vector | none |
| unprovoked, player between `preferredRange` and `aggroRadius` | stand still | none |
| provoked | identical to `charge` | normal |

- **`preferredRange` is the flee radius.** No new column: the field exists, and for `charge`-family styles it is unused.
- **Provoked** is set when the creature takes damage (any source), and when a retreat step is refused by collision — that is the cornered rule. It persists for the engagement and is cleared when the creature loses its target.
- **The flee clamp** uses the existing helper, whose signature is
  `withinLeash(x, y, home, radius)` — position first, the home anchor third, and
  it returns `true` when `home` is falsy. A creature with `home_x/home_y` cannot
  be pushed further than its leash from home; a creature with a null home is
  unconstrained, which is today's behaviour for every wild spawn.

That clamp is why SOMET-289 should give its penned creatures a home anchor: it keeps them in their pen, **and** `home_x IS NOT NULL` is the marker that spares a row from `populateWorld`'s opening DELETE — the trap that already bit portal guards (SOMET-246) and vault chests (SOMET-244).

## File Structure

| File | Responsibility |
|---|---|
| `backend/src/services/creatureBehaviors.js` | **modify.** Accept `skittish` in `CHASE_STYLES`. |
| `backend/migrations/1714440190000_skittish_chase_style.js` | **new.** Widen the CHECK; insert the `Skittish` catalog row. |
| `backend/seeds/data/creatureBehaviors.js` | **modify.** The `Skittish` profile, so a fresh database gets it too. |
| `backend/src/authority/damage.js` | **modify.** Stamp provocation at the single damage funnel. |
| `backend/src/authority/creatures.js` | **modify.** The flee band, the attack gate, the cornered rule, the clamp. |
| `backend/tests/creature_skittish.test.js` | **new.** Golden traces and edge cases. |
| `backend/tests/creature_skittish_db.test.js` | **new.** The live-loader proof. |

---

### Task 1: The catalog entry

**Files:**
- Modify: `backend/src/services/creatureBehaviors.js`
- Create: `backend/migrations/1714440190000_skittish_chase_style.js`
- Modify: `backend/seeds/data/creatureBehaviors.js`
- Test: `backend/tests/creature_behaviors_invariants.test.js` (append)

**Interfaces produced:** a `creature_behaviors` row named `Skittish`, and `resolveBehavior` returning `chaseStyle: 'skittish'` for it instead of falling back to Line.

- [ ] **Step 1: Create the branch**

```bash
cd /home/markunn/worker/coding/jsgame/something2
git checkout main && git pull --ff-only
git checkout -b feat/home-region-skittish
```

Note: slice A (SOMET-288) is in an open PR and NOT on `main`. This slice is independent of it — nothing here touches `safeRegion`, the placement chokepoint, or the map spec. Branch off `main` regardless of whether that PR has landed.

- [ ] **Step 2: Confirm the migration timestamp is free**

```bash
cd backend && ls migrations | sort | tail -3
```

`1714440190000` should be free (the highest is `1714440180000` if slice A has landed, `1714440176000` if not). If anything at or above it exists, use `<highest>+1000` and say so in your report — a duplicate timestamp across branches has stalled `migrate:up` in this repo before.

- [ ] **Step 3: Write the failing test**

Append to `backend/tests/creature_behaviors_invariants.test.js`, matching the helpers already at the top of that file:

```js
test('the Skittish profile is in the catalog and resolves to its own style', () => {
  const skittish = SEED_BEHAVIORS.find((b) => b.name === 'Skittish');
  assert.ok(skittish, 'no Skittish row in the seed catalog');
  assert.equal(skittish.chase_style, 'skittish');
  // The flee radius. Asserted as a real number rather than "is defined":
  // preferred_range IS the flee radius for this style, so a 0 here would mean
  // a creature that never backs away and the behaviour would be inert.
  assert.ok(skittish.preferred_range > 0,
    'preferred_range is the flee radius — a zero makes the behaviour inert');
  assert.ok(skittish.aggro_radius > skittish.preferred_range,
    'a skittish creature must notice you before you are close enough to scare it');
});

test('resolveBehavior accepts skittish rather than falling back to Line', () => {
  const bh = resolveBehavior({
    name: 'Skittish', chase_style: 'skittish', aggro_radius: 300,
    leash_radius: 500, preferred_range: 150, move_speed_mult: 1.1,
  });
  assert.equal(bh.chaseStyle, 'skittish');
  assert.equal(bh.name, 'Skittish');
  // The fallback is what this guards against: an unrecognised chase_style
  // resolves to DEFAULT_BEHAVIOR (Line, chaseStyle 'charge'), which would make
  // every skittish creature a normal aggressive one with nothing failing.
  assert.notEqual(bh.chaseStyle, 'charge');
});
```

- [ ] **Step 4: Run it and confirm it fails**

```bash
cd backend && npm test -- tests/creature_behaviors_invariants.test.js
```

Expected: FAIL — no `Skittish` row, and `resolveBehavior` returns `chaseStyle: 'charge'` because `skittish` is not in `CHASE_STYLES`.

- [ ] **Step 5: Add the style to the normalizer**

In `backend/src/services/creatureBehaviors.js`, extend the list:

```js
const CHASE_STYLES = ['charge', 'kite', 'skirmish', 'hold', 'ambush', 'guard', 'skittish'];
```

- [ ] **Step 6: Add the seed row**

In `backend/seeds/data/creatureBehaviors.js`, add alongside the existing profiles, matching the surrounding column order and formatting exactly:

```js
  { name: 'Skittish',   attack_kind: 'melee',  attack_range: 60,  attack_cooldown: 1.2, projectile_speed: 0,   projectile_radius: 0,  aggro_radius: 300, leash_radius: 500,  chase_style: 'skittish', preferred_range: 150, move_speed_mult: 1.15, gold_min: 0,  gold_max: 2 },
```

The numbers, and why: `aggro_radius` 300 (it notices you before you are close), `preferred_range` 150 — the flee radius, comfortably inside aggro so there is a band where it stands and watches; `leash_radius` 500, shorter than a hostile's 800 because a creature that runs should not run far; `move_speed_mult` 1.15, faster than a player's baseline walk so fleeing reads as fleeing, but not so fast it cannot be caught; `attack_cooldown` 1.2 and `gold` 0–2 because a provoked critter is a weak fight, not a reward.

- [ ] **Step 7: Write the migration**

Create `backend/migrations/1714440190000_skittish_chase_style.js`:

```js
exports.shorthands = undefined;

// The first non-aggressive creature behaviour in the game (SOMET-290).
//
// Every chase style before this one acquires a player and closes. `skittish`
// backs away instead, and only fights once it has been damaged or cornered --
// which is what makes a starting-zone pen a place to practise rather than a
// place to die.
//
// The CHECK is widened rather than replaced piecewise because a CHECK is one
// value: services/creatureBehaviors.js carries the same list in JS, and that
// duplication is deliberate and documented there -- a value rejected only in
// JS reaches the database, and a value rejected only in SQL reaches the sim
// from a row written before the constraint existed.
exports.up = (pgm) => {
  pgm.dropConstraint('creature_behaviors', 'creature_behaviors_chase_style_check');
  pgm.addConstraint('creature_behaviors', 'creature_behaviors_chase_style_check',
    "CHECK (chase_style IN ('charge','kite','skirmish','hold','ambush','guard','skittish'))");

  // Byte-for-byte the row in seeds/data/creatureBehaviors.js. The seed file
  // makes a fresh database work; this makes the live one work without a
  // re-seed. Same arrangement tile_types uses.
  //
  // preferred_range IS the flee radius for this style -- 0 would be a
  // creature that never backs away, i.e. the behaviour silently inert.
  pgm.sql(`
    INSERT INTO creature_behaviors
      (name, attack_kind, attack_range, attack_cooldown, projectile_speed,
       projectile_radius, aggro_radius, leash_radius, chase_style,
       preferred_range, move_speed_mult, gold_min, gold_max)
    VALUES
      ('Skittish', 'melee', 60, 1.2, 0, 0, 300, 500, 'skittish', 150, 1.15, 0, 2)
    ON CONFLICT (name) DO NOTHING
  `);
};

exports.down = (pgm) => {
  // The row goes first: the narrowed CHECK below would reject it.
  pgm.sql("DELETE FROM creature_behaviors WHERE name = 'Skittish'");
  pgm.dropConstraint('creature_behaviors', 'creature_behaviors_chase_style_check');
  pgm.addConstraint('creature_behaviors', 'creature_behaviors_chase_style_check',
    "CHECK (chase_style IN ('charge','kite','skirmish','hold','ambush','guard'))");
};
```

`ON CONFLICT (name)` is safe here: `creature_behaviors.name` is declared `unique: true` in migration `1714440080000_creature_behaviors.js:32`. (Verified while writing this plan — no need to re-check.)

- [ ] **Step 8: Run the migration and the test**

```bash
cd backend && npm run migrate:up   # needs DATABASE_URL exported from the repo-root .env
npm test -- tests/creature_behaviors_invariants.test.js
```

Expected: migration applies; tests PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/src/services/creatureBehaviors.js backend/seeds/data/creatureBehaviors.js \
        backend/migrations/1714440190000_skittish_chase_style.js \
        backend/tests/creature_behaviors_invariants.test.js
git commit -m "$(cat <<'EOF'
feat(creatures): add the Skittish behaviour profile (SOMET-290)

The first non-aggressive chase style in the catalog. Widened in both places
that list the legal styles -- the JS array and the CHECK constraint -- because
this repo documents why that duplication exists: a value rejected only in JS
reaches the database, and a value rejected only in SQL reaches the sim.

preferred_range is the flee radius for this style, so the invariants test
asserts it is non-zero: a 0 there would be a creature that never backs away,
which is the behaviour silently inert.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Provocation at the damage funnel

**Files:**
- Modify: `backend/src/authority/damage.js`
- Test: `backend/tests/authority_damage.test.js` (append)

**Interfaces produced:** any target that takes a hit of more than zero damage carries `_provoked === true`.

**Why here:** `applyDamage` is the one place `target.hp -= final` happens. The melee arc (`world.js`), direct projectile hits and AoE detonations (`projectiles.js`), and the burn tick (`world.js`) all route through it. Stamping the marker at any of those call sites instead would be the same one-of-several-write-paths trap that shipped SOMET-153.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/authority_damage.test.js`, reusing that file's existing target-building helpers:

```js
test('any landed hit marks the target provoked', () => {
  const t = { hp: 100, maxHp: 100 };
  applyDamage(t, 10, 'physical', NO_MITIGATION);
  assert.equal(t._provoked, true);
});

test('a hit fully absorbed by mitigation still provokes', () => {
  // MIN_DAMAGE floors every hit at 1, so a landed swing always deals damage.
  // If that floor is ever removed, being hit for zero must STILL provoke — a
  // creature that ignores an attack it survived unharmed reads as broken.
  const t = { hp: 100, maxHp: 100 };
  applyDamage(t, 1, 'physical', { defense: 9999, resistances: {} });
  assert.equal(t._provoked, true);
});

test('a target nobody has hit is not provoked', () => {
  const t = { hp: 100, maxHp: 100 };
  assert.notEqual(t._provoked, true);
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd backend && npm test -- tests/authority_damage.test.js
```

Expected: FAIL — `_provoked` is `undefined`.

- [ ] **Step 3: Stamp the marker**

In `backend/src/authority/damage.js`, immediately after `target.hp -= final`:

```js
  // SOMET-290. Being hit is what turns a skittish creature from prey into a
  // fighter, and this is the ONE place a hit lands: the melee arc (world.js),
  // a direct projectile, an AoE detonation (projectiles.js) and the burn tick
  // all funnel through here. Stamping it at those call sites instead would be
  // the same rule-on-one-of-several-write-paths failure that shipped SOMET-153.
  //
  // Set unconditionally rather than only when `final > 0`: a hit absorbed to
  // nothing is still an attack, and a creature that shrugs off being struck
  // reads as broken. Harmless on players and on every other chase style —
  // nothing but the skittish branch reads it.
  target._provoked = true;
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
cd backend && npm test -- tests/authority_damage.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/damage.js backend/tests/authority_damage.test.js
git commit -m "$(cat <<'EOF'
feat(creatures): mark a damaged target provoked at the damage funnel (SOMET-290)

applyDamage is the one place target.hp -= final happens, so the melee arc,
direct projectile hits, AoE detonations and the burn tick all provoke without
any of them naming the rule. Stamping it per call site would be the
one-of-several-write-paths trap that shipped SOMET-153.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The tick behaviour

**Files:**
- Modify: `backend/src/authority/creatures.js` (`CreatureSim.step`'s chase branch only)
- Test: `backend/tests/creature_skittish.test.js`

**Interfaces consumed:** `chaseStyle: 'skittish'` (Task 1), `_provoked` (Task 2).

**Read before editing:** the chase branch begins at the comment `// Target resolution: keep current target unless it left leash` and runs to the `continue` that ends it, followed by the roam block. The style bands (`hold` / `kite` / `skirmish`) are an `if/else if` chain; `charge` and `ambush` fall through with the straight-at-target vector. `withinLeash(c, x, y, radius)` already exists in this file and treats a null home as unconstrained.

**What to build:**

1. Before the style bands, derive the state once:
   `const fleeing = bh.chaseStyle === 'skittish' && !c._provoked;`
2. Add a `skittish` band to the chain: when `fleeing`, reverse the vector if `dist < bh.preferredRange`, otherwise set `move = false` (it stands and watches). A **provoked** skittish creature must fall through with the straight-at-target vector exactly as `charge` does — do not give it its own provoked band.
3. **Clamp the flee step to the leash from home.** Before committing a flee step, test the candidate position with the existing helper — `withinLeash(candidateX, candidateY, c.home, bh.leashRadius)`, which returns `true` whenever `c.home` is falsy. A creature with a null home (every wild spawn today) is therefore unconstrained, so this is inert for everything except the penned creatures SOMET-289 will anchor. Refusing the step this way also feeds rule 4: a creature pinned against its leash is cornered.
4. **Cornered:** when `fleeing` and the move was refused (the existing `r.x !== c.x || r.y !== c.y` check is already there), set `c._provoked = true`. A creature with nowhere to run fights.
5. **No attack while fleeing.** The attack block sits after the movement inside the same branch — gate it so an unprovoked skittish creature never selects an ability. Do not stamp a cooldown for the attack it did not take, matching how `canAct` refusal is already handled here.
6. **Clear provocation when the target is lost.** In the target-resolution block, where a target is dropped for leaving leash, clear `c._provoked` too — otherwise a creature stays angry forever after one hit, which makes the whole behaviour a one-way switch.

Keep the roam block untouched: a skittish creature with no target should wander like any other, which is what falling through to it already does.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/creature_skittish.test.js`. Build the sim the way the existing behaviour tests in this repo do — read `backend/tests/authority_creature_styles.test.js` first and reuse its fixture helpers rather than inventing a second harness.

Required cases, each of which must be able to fail:

```js
// 1. WALK PAST UNHARMED. A player stands inside aggroRadius for many ticks;
//    the creature never attacks and the player's hp never changes. This is the
//    headline promise of the whole behaviour.
// 2. RETREAT. With the player inside preferredRange, the creature's distance
//    from the player INCREASES over successive ticks. Assert on the distance
//    trend, not on an exact coordinate — an exact coordinate would pin the
//    movement constant rather than the behaviour.
// 3. STAND AND WATCH. With the player between preferredRange and aggroRadius,
//    the creature does not move toward or away.
// 4. PROVOKED BY DAMAGE. After applyDamage, the same creature closes on the
//    player and attacks. Assert both: a creature that turns to face you but
//    never swings is the inert half of this bug.
// 5. CORNERED. A creature with a wall directly behind it and the player in
//    front becomes provoked (assert `_provoked === true`) and attacks, rather
//    than jittering in place. Build the wall with the map fixture the styles
//    test already uses.
// 6. NOT HERDED. A creature WITH a home anchor cannot be pushed further than
//    leashRadius from that home, however long the player pursues.
// 7. UNANCHORED IS UNCONSTRAINED. The same creature with a null home is NOT
//    clamped — this is what proves the clamp cannot change any wild spawn's
//    behaviour today.
// 8. CALMS DOWN. Once the target is lost at leash, `_provoked` is cleared, so
//    the next encounter starts skittish again.
```

Write each as a real test with real assertions — this repo has a recorded history of tests that pass while proving nothing, including assertions derived from the same constants as the code under test.

- [ ] **Step 2: Run them and confirm they fail**

```bash
cd backend && npm test -- tests/creature_skittish.test.js
```

Expected: FAIL. Before the tick change, a skittish creature resolves through the chase branch as a `charge` fall-through — it closes and attacks, so cases 1–3 and 5–8 fail. Record which fail and why; a case that passes at this point is testing nothing.

- [ ] **Step 3: Implement the behaviour**

Per the six points above. Change nothing outside the chase branch and the target-resolution block.

- [ ] **Step 4: Run them and confirm they pass**

```bash
cd backend && npm test -- tests/creature_skittish.test.js
```

- [ ] **Step 5: Prove the other styles did not move**

```bash
cd backend && npm test -- tests/authority_creature_styles.test.js tests/creature_behavior_golden.test.js tests/authority_creatures.test.js tests/authority_creatures_combat.test.js tests/authority_guard_knockback.test.js
```

Expected: PASS, unchanged. `creature_behavior_golden.test.js` is the frozen trace that proves the behaviour system stayed neutral for existing creatures — **if it fails, stop and report BLOCKED.** Do not update a golden to make it pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/authority/creatures.js backend/tests/creature_skittish.test.js
git commit -m "$(cat <<'EOF'
feat(creatures): skittish creatures flee, and fight only when hurt or cornered (SOMET-290)

Routed in the existing chase branch alongside kite and skirmish. An unprovoked
skittish creature backs away inside its flee radius, stands and watches outside
it, and never selects an ability; once damaged or cornered it falls through as
a charger.

The flee step is clamped with withinLeash, which treats a null home as
unconstrained -- inert for every wild spawn today, and the thing that will keep
SOMET-289's penned creatures in their pen.

Provocation clears when the target is lost, so a creature that was hit once
does not stay angry forever.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Creature types, and the live-loader proof

**Files:**
- Modify: `backend/seeds/data/entityTypes.js`
- Create: `backend/migrations/1714440191000_skittish_creature_types.js`
- Create: `backend/tests/creature_skittish_db.test.js`

**What:** two or three level 1–2 creature types adopt the `Skittish` profile via `entity_types.behavior_id`. Pick from creature types that ALREADY exist in the catalog — read `backend/seeds/data/entityTypes.js` and choose ones that read as harmless wildlife. **Do not invent new creature types**: a new type needs sprites, and this repo's coding agents cannot generate images, so an invented creature ships as a placeholder colour box.

Name your choices in your report.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/creature_skittish_db.test.js`. It must prove the behaviour is live **through the loader the running authority actually uses**, not through the seed file:

```js
// The SOMET-249 trap: a behaviour authored in the catalog but read through
// only one of two loaders is silently inert in the live tick. The assertion
// that matters is not "the catalog has a Skittish row" (Task 1 covers that) —
// it is that a real world_creatures row of a skittish TYPE arrives at the sim
// carrying chaseStyle 'skittish'.
//
// Load it the way the authority does: through creatures.js's own loader with
// its LEFT JOIN creature_behaviors, against a fixture creature of a skittish
// type. Fixture rows are named zzSkit* and deleted BY NAME, unconditionally,
// in a finally — never by an id captured mid-test.
```

Also assert that the types you picked are the ones actually flagged, so a future edit that drops the flag fails here.

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd backend && npm test -- tests/creature_skittish_db.test.js
```

Expected: FAIL — the types have no `behavior_id` pointing at `Skittish`, so the loader resolves them to the Line fallback (`chaseStyle: 'charge'`).

- [ ] **Step 3: Flag the types**

Update `backend/seeds/data/entityTypes.js` for a fresh database, and write `backend/migrations/1714440191000_skittish_creature_types.js` to move the live rows — setting `behavior_id` from a subselect on `creature_behaviors.name = 'Skittish'` rather than a hardcoded id, which would be wrong in any database but this one. The `down` must restore each type's previous `behavior_id`; capture those values in the migration's own comment so the reversal is auditable.

- [ ] **Step 4: Run the migration and the tests**

```bash
cd backend && npm run migrate:up
npm test -- tests/creature_skittish_db.test.js tests/creature_behaviors_invariants.test.js
```

- [ ] **Step 5: Full suite, once**

```bash
cd backend && npm test
```

Export BOTH `TEST_DATABASE_URL` and `DATABASE_URL` first, and **do not source the whole `.env`** — exporting `JWT_SECRET` into the test subprocess makes `auth_assertJwtSecret.test.js` fail spuriously, because that file's whole point is asserting behaviour when the secret is absent.

Expected: the known pre-existing failure set from Global Constraints and nothing else. Any other failure is a regression — stop and report BLOCKED.

- [ ] **Step 6: Commit**

```bash
git add backend/seeds/data/entityTypes.js \
        backend/migrations/1714440191000_skittish_creature_types.js \
        backend/tests/creature_skittish_db.test.js
git commit -m "$(cat <<'EOF'
feat(creatures): the first skittish creature types (SOMET-290)

Existing low-level types adopt the Skittish profile, flagged in the seed file
for a fresh database and moved on the live rows by migration.

The DB test proves the behaviour through creatures.js's own loader rather than
the seed file: SOMET-249's recorded trap is a behaviour that is present in the
catalog and inert in the running tick because only one of the two loaders sees
it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Definition of done

- Backend suite green apart from the known pre-existing failure set.
- No browser verification for this slice: the creatures exist but nothing places them where a player will meet them until SOMET-289 authors the pens. That ticket carries the browser step, and it is where "does fleeing actually read as fleeing on screen?" gets answered.
- SOMET-290 moves to **To Review** with a comment naming the commits, the test evidence, and the creature types chosen.
- SOMET-289 is unblocked by this and should be told so.
