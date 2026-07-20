# Phase 6 Slice 3b-3c — Elements, status effects, mana depth: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a weapon's element change how a fight plays — by routing creature damage through the one mitigation path and giving each element a status-effect rider.

**Architecture:** Creatures gain `defense`/`resistances` from `entity_types` and a `mit` field, and all three raw `c.hp -=` sites route through `applyDamage`. A new `effects.js` holds a transient per-entity `Map<effectKey, {until, magnitude, sourceId}>`, ticked once per `World.tick` by one shared function for players and creatures alike.

**Tech Stack:** Node + Express + `pg` (CommonJS, `node --test`), node-pg-migrate, `ws` authority, Vite/React frontend (Vitest, env `node`, **no jsdom**).

**Spec:** `docs/superpowers/specs/2026-07-20-phase6-slice3b3c-elements-design.md`

## Global Constraints

- **`applyDamage(target, raw, element, mit)` in `damage.js` is the ONE mitigation path.** Nothing computes damage independently. It floors at 1 and caps resistance at 0.8, so nothing is ever immune or unkillable.
- **Effects are transient and in memory.** No DB writes for effects, ever.
- **Re-application refreshes duration and never stacks** — one entry per `(target, effectKey)`. The single exception is shock's interrupt immunity window, which is stamped once and NOT refreshed.
- **Deaths route through the existing single path.** A creature killed by a burn tick must go through `commitCreatureDeath` (so it still rolls loot) and a player through `resolveDeaths`. Burn must not become a fourth way to die.
- Migrations: `npm run migrate -- up` / `-- down` from `backend/`, prefixed with `DATABASE_URL="postgres://user:password@localhost:15432/game_db"` (the root `.env` is not picked up). Creds: user `user`, db `game_db`. There is NO `migrate:down` script.
- **Tests must not be vacuous.** Eight instances on this project. A mock that ignores its input defends nothing about the input; a mocked pool cannot enforce a DB constraint; a guard that reads a fixture defends the fixture. **Verify every guard by mutation** — break the thing and confirm RED.
- **Test reachability, not just correctness.** Two shipped features here were correct and inert. Every mechanic needs a test that it can actually engage.
- Backend suite must EXIT on its own (a leaked handle once hid a 100% failure for a whole slice). Expect ~337 passing and ~7s before this slice.
- Commit after every task. `cd backend && npm test`; `cd frontend && npm test && npm run build`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `backend/migrations/1714440022000_elements.js` | create | entity_types defense/resistances, creature content, storm staff rebalance |
| `backend/src/authority/effects.js` | create | apply/tick/expire, pure and unit-testable |
| `backend/src/authority/creatures.js` | modify | `mit` at spawn; three damage sites → `applyDamage`; element threading |
| `backend/src/authority/world.js` | modify | tick effects before movement; chill-aware speed; mana drain |
| `backend/src/authority/projectiles.js` | modify | apply the element's effect on hit and on blast |
| `backend/src/authority/server.js` | modify | broadcast active effects for client display |
| `backend/src/services/mapService.js` | modify | load entity_type mitigation at spawn |
| `frontend/.../systems/RenderSystem.js` | modify | effect tint/icon |
| `frontend/.../core/Game.js` | modify | HUD effect indicators |

---

## Task 1: Migration — creature mitigation, content, storm staff rebalance

**Files:** Create `backend/migrations/1714440022000_elements.js`

**Interfaces produced:** `entity_types.defense`, `entity_types.resistances`; rebalanced `storm staff`.

- [ ] **Step 1: Write the migration**

```js
exports.up = (pgm) => {
  pgm.addColumns('entity_types', {
    defense: { type: 'real', notNull: true, default: 0 },
    // Same shape and semantics as item_types.resistances: {element: 0..1}.
    resistances: { type: 'jsonb', notNull: true, default: '{}' },
  });

  // THE DATABASE CONTAINS EXACTLY ONE CREATURE (`Wolf`); everything else is
  // scenery. With one creature, resistances create no matchup — they are just
  // a flat nerf to one element. So this slice adds three more.
  //
  // This is cheap: spawnChunkCreatures picks uniformly from the creature list
  // by hash, so a new row spawns automatically with no spawn-table wiring, and
  // creatures render from `color`, so no sprites are needed. A creature type
  // is any entity_types row with is_creature = true.
  //
  // Profiles are chosen so no single element beats everything: each element is
  // resisted by someone, and each creature has an element it cannot resist.
  // Nothing resists arcane — arcane carries no status rider, so reliable
  // unresisted damage is the generalist's compensation.
  pgm.sql(`
    INSERT INTO entity_types (name, color, walkable, spawn_tiles, chance, is_creature,
                              hp, max_hp, strength, constitution, defense, resistances)
    VALUES
      ('Slime',    '#27ae60', true, '[]'::jsonb, 0.1, true, 18, 18, 4, 6, 0,
       '{"fire":0.6,"physical":0.3}'::jsonb),
      ('Skeleton', '#ecf0f1', true, '[]'::jsonb, 0.1, true, 14, 14, 6, 4, 2,
       '{"ice":0.6,"physical":0.2}'::jsonb),
      ('Bat',      '#8e44ad', true, '[]'::jsonb, 0.1, true,  8,  8, 3, 2, 0,
       '{"lightning":0.5}'::jsonb)
    ON CONFLICT (name) DO NOTHING;
  `);

  // Wolf stays the neutral baseline: no resistances, so every element works on
  // it. Set max_hp to match hp — the existing row has max_hp = 0, which is
  // wrong data that creatures.js happens to paper over by using hp for both.
  pgm.sql(`UPDATE entity_types SET max_hp = hp WHERE name = 'Wolf' AND max_hp = 0;`);

  // Storm staff pays for carrying all three lightning riders: it becomes the
  // worst staff in the game by damage-per-mana. An invariant test enforces
  // this, because a future rebalance could otherwise quietly restore
  // dominance with every other test still green.
  pgm.sql(`UPDATE item_types SET damage = 14, cooldown = 1.10, mana_cost = 34
           WHERE name = 'storm staff';`);
};

exports.down = (pgm) => {
  pgm.sql(`UPDATE item_types SET damage = 19, cooldown = 0.95, mana_cost = 24
           WHERE name = 'storm staff';`);
  // World rows referencing these creatures must go first, or the delete
  // fails (or orphans live creatures pointing at a vanished type).
  pgm.sql(`DELETE FROM world_creatures WHERE type IN ('Slime','Skeleton','Bat');`);
  pgm.sql(`DELETE FROM entity_types WHERE name IN ('Slime','Skeleton','Bat');`);
  pgm.dropColumns('entity_types', ['defense', 'resistances']);
};
```

- [ ] **Step 2: Verify the roster landed and is genuinely a matchup**

```bash
docker exec something2-db-1 psql -U user -d game_db -c \
  "SELECT name, hp, max_hp, defense, resistances FROM entity_types WHERE is_creature = true ORDER BY name;"
```
Expected 4 rows: Bat, Skeleton, Slime, Wolf. Wolf must have `resistances = {}` (the neutral baseline) and `max_hp = 12`.

Confirm by inspection that **no single element beats everything**: fire is resisted by Slime, ice by Skeleton, lightning by Bat, physical by Slime and Skeleton, and arcane by nobody. If that property does not hold, the resistances are flat nerfs rather than a matchup and the content is wrong.

**Also confirm `is_creature` is the right column name** by checking `\d entity_types` — `server.js:70` filters on it, and inserting rows without it means they never spawn.

- [ ] **Step 3: Run up, verify, round-trip**

```bash
cd backend && DATABASE_URL="postgres://user:password@localhost:15432/game_db" npm run migrate -- up
docker exec something2-db-1 psql -U user -d game_db -c \
  "SELECT name, defense, resistances FROM entity_types WHERE resistances <> '{}'::jsonb ORDER BY name;"
```
Expected: one row per creature you wired, each with a non-empty resistances object.

```bash
DATABASE_URL="..." npm run migrate -- down && DATABASE_URL="..." npm run migrate -- up
```
Both must succeed.

- [ ] **Step 4: Commit**

```bash
git add backend/migrations/1714440022000_elements.js
git commit -m "feat(db): creature mitigation, elemental resistances, storm staff rebalance"
```

---

## Task 2: The effects module

**Files:** Create `backend/src/authority/effects.js`, `backend/tests/authority_effects.test.js`

**Interfaces produced:**
- `applyEffect(target, key, { durationMs, magnitude, sourceId, now })` — refreshes, never stacks
- `tickEffects(target, dtMs, now, ctx)` — advances and expires; returns what fired
- `hasEffect(target, key, now)` / `effectMagnitude(target, key, now)`
- Exported constants: `BURN`, `CHILL`, `SHOCK`, and their durations/magnitudes

- [ ] **Step 1: Write the failing tests**

```js
test('applying an effect twice refreshes rather than stacking', () => {
  const t = { effects: new Map() };
  applyEffect(t, BURN, { durationMs: 1000, magnitude: 3, now: 0 });
  applyEffect(t, BURN, { durationMs: 1000, magnitude: 3, now: 400 });
  assert.equal(t.effects.size, 1, 'a second application must not add an entry');
  assert.equal(t.effects.get(BURN).until, 1400, 'the later application must extend expiry');
});

test('an expired effect is removed and stops acting', () => {
  const t = { effects: new Map() };
  applyEffect(t, CHILL, { durationMs: 500, magnitude: 0.6, now: 0 });
  assert.equal(hasEffect(t, CHILL, 400), true);
  assert.equal(hasEffect(t, CHILL, 600), false);
  tickEffects(t, 100, 600, {});
  assert.equal(t.effects.size, 0, 'tick must evict expired entries, not just report them false');
});

test('effect entries are bounded by effect KIND, not by rate of application', () => {
  const t = { effects: new Map() };
  for (let i = 0; i < 500; i++) applyEffect(t, BURN, { durationMs: 100, magnitude: 1, now: i });
  assert.equal(t.effects.size, 1);
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd backend && node --test tests/authority_effects.test.js
```
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `effects.js`**

Keep it pure — no `Date.now()` inside, no I/O. `now` is always passed in, so tests are deterministic and the module cannot drift from the tick clock. Model it on how `loot.js` takes `now` as a parameter.

Burn ticks must not fire faster than a fixed interval regardless of `dt`; accumulate elapsed time per effect entry rather than damaging once per server tick, or burn damage silently scales with tick rate.

- [ ] **Step 4: Verify green, then mutate**

Remove the eviction in `tickEffects` and confirm the expiry test goes RED. Restore. Report the result.

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/effects.js backend/tests/authority_effects.test.js
git commit -m "feat(authority): transient status-effect module with refresh semantics"
```

---

## Task 3: Route creature damage through the one mitigation path

**Files:** Modify `backend/src/authority/creatures.js`, `backend/src/services/mapService.js`; test `backend/tests/authority_creatures_combat.test.js`

**Context:** This is the highest-value change in the slice. Creatures currently take damage via a direct `c.hp -= damage` at **three** sites (`creatures.js` lines ~125, ~141, ~153) while *dealing* damage through `applyDamage` (~line 96). That asymmetry is why elements are inert in PvE.

**Interfaces consumed:** `entity_types.defense`/`resistances` (Task 1).
**Interfaces produced:** creatures carry `mit`; `applyMeleeArc` and `damageCreatureById` take an `element`.

**The loader trap — do not repeat 3b-3b's.** `backend/src/authority/server.js:70` reads
`SELECT id, name, color, hp FROM entity_types WHERE is_creature = true` and maps only
`{ name, hp, color }`. Adding columns without extending BOTH the SELECT and the mapping
loads them as `undefined`, and every resistance is silently inert — the identical failure
`loadItemTypes` needed a guard test for in 3b-3b. Extend both, and **add the same guard**:
a test asserting the SELECT text names every column the mapping consumes. Verify it by
mutation (drop `resistances` from the SELECT, confirm RED).

- [ ] **Step 1: Write the failing tests**

```js
test('a fire-resistant creature takes less from a fire weapon than from an equal physical one', () => {
  const resistant = mkCreature({ mit: { defense: 0, resistances: { fire: 0.5 } } });
  const plain     = mkCreature({ mit: { defense: 0, resistances: {} } });
  sim.damageCreatureById(resistant.id, 20, 'fire');
  sim.damageCreatureById(plain.id,     20, 'fire');
  assert.ok(resistant.maxHp - resistant.hp < plain.maxHp - plain.hp,
    'creature resistances are not being applied — damage is bypassing applyDamage');
});

test('every creature-damage path threads its element', () => {
  // The three sites are applyMeleeArc, the projectile hit, and
  // damageCreatureById. A site that drops `element` silently reverts to
  // element-blind damage, which is the exact defect this task removes.
  const c = mkCreature({ mit: { defense: 0, resistances: { fire: 0.8 } } });
  const before = c.hp;
  sim.applyMeleeArc(c.x, c.y, 1, 0, 200, 3.14, 20, 'fire');
  assert.ok(before - c.hp <= 20 * 0.2 + 1,
    'applyMeleeArc did not pass the element through to applyDamage');
});

test('creature mitigation is loaded from its entity type at spawn', () => {
  // Guards the wiring, not just the maths: a creature spawned without `mit`
  // silently falls back to NO_MITIGATION and every resistance is inert.
  const c = spawnFromType({ name: 'Slime', defense: 1, resistances: { fire: 0.6 } });
  assert.deepEqual(c.mit, { defense: 1, resistances: { fire: 0.6 } });
});
```

- [ ] **Step 2: Run to verify failure, implement, run to verify pass**

Replace all three `c.hp -= damage` with `applyDamage(c, damage, element, c.mit || NO_MITIGATION)`. Add the `element` parameter to `applyMeleeArc` and `damageCreatureById`, and update EVERY caller — search the whole `backend/src` tree, not just the files you have open. A missed caller passes `undefined`, which `applyDamage` silently coerces to `'physical'`.

- [ ] **Step 3: Mutation check**

Revert ONE of the three sites to `c.hp -= damage` and confirm a test goes RED. If the suite stays green, your tests only cover one path and you must add coverage for the others. Report which test caught it.

- [ ] **Step 4: Commit**

```bash
git add backend/src/authority/creatures.js backend/src/services/mapService.js backend/tests/authority_creatures_combat.test.js
git commit -m "fix(authority): route creature damage through the single mitigation path"
```

---

## Task 4: Tick effects in the world

**Files:** Modify `backend/src/authority/world.js`; test `backend/tests/authority_world.test.js`

**Context:** Effects tick once per `World.tick`, for players and creatures, through ONE shared call. Two implementations would drift the way melee and ranged line-of-sight drifted before 3b-3a unified `MAX_SUB`.

- [ ] **Step 1: Write the failing tests**

```js
test('effects are applied before movement so a chill affects the same tick', () => {
  const w = mkWorld(); w.addPlayer('u1', { x: 0, y: 0 });
  const p = w.getPlayer('u1');
  applyEffect(p, CHILL, { durationMs: 5000, magnitude: 0.6, now: 0 });
  w.setInput('u1', 1, 1, 0);
  w.tick(1);
  assert.ok(p.x < PLAYER_SPEED, 'the chill did not apply until the following tick');
});

test('chill expiry restores the EXACT original speed', () => {
  const w = mkWorld(); w.addPlayer('u1', { x: 0, y: 0 });
  const p = w.getPlayer('u1');
  for (let i = 0; i < 50; i++) {           // repeated apply/expire cycles
    applyEffect(p, CHILL, { durationMs: 10, magnitude: 0.6, now: i * 100 });
    w.tick(0.2);
  }
  assert.equal(p.speed, PLAYER_SPEED,
    'speed drifted — chill must recompute from a stored base, not multiply/divide in place');
});
```

- [ ] **Step 2: Implement**

Store the base speed and RECOMPUTE effective speed each tick from `base × (chill ? magnitude : 1)`. Never mutate `p.speed` by multiplying on apply and dividing on expire — that accumulates float drift and leaves a player permanently a fraction slower.

Burn damage goes through `applyDamage`, and a creature killed by a burn tick must be reported to the caller so it routes through `commitCreatureDeath` — burn must not become a fourth way to die that skips loot.

- [ ] **Step 3: Verify, commit**

```bash
cd backend && npm test
git add backend/src/authority/world.js backend/tests/authority_world.test.js
git commit -m "feat(authority): tick status effects before movement resolution"
```

---

## Task 5: Apply elements on hit

**Files:** Modify `backend/src/authority/world.js` (melee), `backend/src/authority/projectiles.js` (projectile + blast); test both

- [ ] **Step 1: Write the failing tests**

```js
test('each element applies its own effect and no other', () => {
  for (const [element, key] of [['fire', BURN], ['ice', CHILL], ['lightning', SHOCK]]) {
    const t = mkPlayer('t', 0, 0);
    applyElementEffect(t, element, 0);
    assert.equal(t.effects.has(key), true, `${element} did not apply ${key}`);
    assert.equal(t.effects.size, 1, `${element} applied more than its own effect`);
  }
});

test('arcane applies no effect at all', () => {
  const t = mkPlayer('t', 0, 0);
  applyElementEffect(t, 'arcane', 0);
  assert.equal(t.effects.size, 0, 'arcane is the pure-damage generalist and must carry no rider');
});

test('an AoE blast applies the element to every target it damages', () => {
  // The blast is a separate damage path from the direct hit; a rider wired
  // only into the direct path would leave AoE staves riderless.
});
```

- [ ] **Step 2: Implement, verify, commit**

Apply the rider everywhere the element already deals damage: melee arc (players AND creatures), projectile direct hit, and AoE detonation. Falloff scales damage but NOT effect duration — a target clipped by the blast edge still burns for the full time.

```bash
git commit -m "feat(authority): apply elemental status effects on every damage path"
```

---

## Task 6: Chill, shock vulnerability, and mana drain

**Files:** Modify `backend/src/authority/world.js`, `backend/src/authority/damage.js`; tests

- [ ] **Step 1: Write the failing tests**

```js
test('shock increases damage taken by 25%', () => {
  const shocked = mkPlayer('a', 0, 0), plain = mkPlayer('b', 0, 0);
  applyEffect(shocked, SHOCK, { durationMs: 5000, magnitude: 0.25, now: 0 });
  const d1 = applyDamageWithEffects(shocked, 20, 'physical', NO_MITIGATION, 0);
  const d2 = applyDamageWithEffects(plain,   20, 'physical', NO_MITIGATION, 0);
  assert.ok(d1 > d2 * 1.2);
});

test('mana drain clamps at zero and no-ops on a target with no mana pool', () => {
  const creature = { hp: 10 };                    // creatures have no mana
  assert.doesNotThrow(() => drainMana(creature, 10));
  const p = mkPlayer('p', 0, 0); p.mana = 3;
  drainMana(p, 10);
  assert.equal(p.mana, 0, 'mana must clamp at 0, never go negative');
});
```

- [ ] **Step 2: Implement**

Vulnerability multiplies the RAW damage before mitigation, so resistances still apply on top — keep `applyDamage` itself the single reduction path and layer vulnerability in front of it rather than inside it.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(authority): chill slow, shock vulnerability, and mana drain"
```

---

## Task 7: Shock's interrupt and its immunity window

**Files:** Modify `backend/src/authority/effects.js`, `backend/src/authority/world.js`; tests

**Context:** Refresh-stacking means a refreshed effect is a PERMANENT effect under sustained fire. That is fine for burn and chill. It is not fine for an interrupt — a 1.10s-cooldown storm staff would chain-lock a player indefinitely. The immunity window is the exception: **stamped once when the interrupt lands, and NOT refreshed by later hits.**

- [ ] **Step 1: Write the failing tests**

```js
test('shock cannot chain-lock: the target acts within a bounded window under sustained fire', () => {
  const t = mkPlayer('t', 0, 0);
  let actedTicks = 0;
  for (let ms = 0; ms < 10000; ms += 100) {
    applyShock(t, ms);                        // fire as fast as the weapon allows
    if (canAct(t, ms)) actedTicks += 1;
  }
  assert.ok(actedTicks > 50,
    'the target was interrupted for most of 10s — the immunity window is not limiting anything');
});

test('the immunity window exceeds the fastest lightning weapon cooldown', () => {
  // Reachability, not correctness. If IMMUNITY_MS <= cooldown, the exception
  // is decorative: every shot re-interrupts and the chain-lock returns.
  assert.ok(SHOCK_IMMUNITY_MS > FASTEST_LIGHTNING_COOLDOWN_MS,
    `immunity ${SHOCK_IMMUNITY_MS}ms must exceed the fastest lightning cooldown ` +
    `${FASTEST_LIGHTNING_COOLDOWN_MS}ms, or a caster re-interrupts on every shot and the ` +
    `target never acts again`);
});
```

- [ ] **Step 2: Implement, mutate, commit**

Mutation check: make the immunity window refresh on each hit and confirm the chain-lock test goes RED. Report it.

```bash
git commit -m "feat(authority): shock interrupt with a non-refreshing immunity window"
```

---

## Task 8: Reachability and balance invariants

**Files:** `backend/tests/authority_elements_invariants.test.js` (create)

**Context:** This project has shipped two features that were correct and inert. These tests are the defence.

- [ ] **Step 1: Write them**

```js
test('creature resistances are populated AND form a real matchup', async () => {
  // Real DB, skip-if-unreachable but FAIL under CI — a mocked pool cannot
  // prove content exists. Follow authority_ammo_db.test.js.
  const r = await pool.query(
    `SELECT name, resistances FROM entity_types WHERE is_creature = true`);
  const creatures = r.rows;
  assert.ok(creatures.length >= 4,
    'the slice needs several creatures or resistances are a flat nerf, not a choice');

  // Populated at all.
  const withRes = creatures.filter((c) => Object.keys(c.resistances || {}).length > 0);
  assert.ok(withRes.length >= 3,
    'fewer than 3 creature types carry any resistance — element choice cannot change an outcome, which is the inert state this slice exists to remove');

  // ...and no single element is the right answer to everything. THIS is the
  // half that fails if a future edit makes every creature fire-resistant,
  // turning the matchup back into a flat nerf while the count above still passes.
  for (const c of creatures) {
    const unresisted = ELEMENTS.filter((e) => !((c.resistances || {})[e] > 0));
    assert.ok(unresisted.length > 0,
      `${c.name} resists every element — no weapon choice can beat it cleanly`);
  }
  for (const el of ['fire', 'ice', 'lightning']) {
    const resisters = creatures.filter((c) => ((c.resistances || {})[el] > 0));
    assert.ok(resisters.length > 0,
      `nothing resists ${el}, so it is strictly safe to always bring it — that is not a matchup`);
  }
});

test('burn is a meaningful fraction of a hit, not decoration', () => {
  const total = BURN_TICK_DAMAGE * (BURN_DURATION_MS / BURN_TICK_MS);
  assert.ok(total >= FLAME_STAFF_DAMAGE * 0.3,
    `a full burn deals ${total} vs the flame staff's ${FLAME_STAFF_DAMAGE} hit — under 30% it is decoration`);
});

test('chill is a decisive PvP differential', () => {
  // NOT a creature-pursuit test: PLAYER_SPEED 200 vs CREATURE_SPEED 40 means a
  // chilled player still moves 3x creature speed, so a pursuit assertion can
  // never fail and would be vacuous. Chill is a PvP/dodging mechanic.
  assert.ok(PLAYER_SPEED * CHILL_MAGNITUDE <= PLAYER_SPEED * 0.7,
    'chill must create at least a 30% speed gap to decide a player-vs-player chase');
});

test('storm staff is not strictly dominant: worst damage-per-mana of any staff', () => {
  const staves = SEED_ROWS.filter((r) => r.mana_cost > 0);
  const storm = staves.find((s) => s.name === 'storm staff');
  const dpm = (s) => s.damage / s.mana_cost;
  for (const s of staves) {
    if (s.name === 'storm staff') continue;
    assert.ok(dpm(storm) < dpm(s),
      `storm staff carries all three lightning riders, so it must pay for them: ${dpm(storm).toFixed(3)} dmg/mana vs ${s.name}'s ${dpm(s).toFixed(3)}`);
  }
});
```

- [ ] **Step 2: Commit**

```bash
git commit -m "test(authority): elemental reachability and balance invariants"
```

---

## Task 9: Client — effect indicators

**Files:** Modify `frontend/.../systems/RenderSystem.js`, `frontend/.../core/Game.js`, `backend/src/authority/server.js`

**Context:** Vitest here runs env `node` with NO jsdom — the render layer is verified by `npm run build` plus the browser pass. Put anything worth testing in pure exported functions.

- [ ] **Step 1: Broadcast active effects**

Include each player's and creature's active effect keys on the existing snapshot. Keys only, not full effect objects — the client needs to know *what* is active, not the server's timing internals.

- [ ] **Step 2: Render**

Tint an affected entity by element (burn orange, chill blue, shock yellow) and show the player's own active effects near the HUD bars. Reuse the existing projectile element colours rather than inventing a second palette.

**Coordinate traps already paid for twice:** `worldToScreen` returns the tile diamond's CENTRE, not its top corner; depth sorting uses TOP-LEFT. Copy an existing call site rather than deriving a new one.

- [ ] **Step 3: Verify build + tests, commit**

```bash
cd frontend && npm test && npm run build
git commit -m "feat(client): status effect indicators"
```

---

## Task 10: Browser verification

**Files:** none — live verification.

**Context:** This step found the defining defect in each of the last two slices. Environment traps that manufacture a false clean result — check ALL of them first:
- `docker restart something2-frontend-1` kills Vite and **nothing restarts it** (entrypoint is `tail -f /dev/null`). Start it manually and confirm the page is current.
- An **old backend process** may still answer on 3101 while a fresh `npm start` dies with EADDRINUSE, serving pre-slice code. `pkill -f "node src/index.js"` first.
- `GET /api/item-types` is a `SELECT *` passthrough — it shows new columns even on OLD code and is NOT evidence you are current.
- **SOMET-97**: a reload mints a new anonymous user. Pin a `user_id` rather than reloading mid-scenario.

- [ ] **Step 2: Verify each**

- [ ] A flame staff hit leaves a creature visibly burning, and it keeps losing HP after the hit.
- [ ] A burn tick that kills a creature still drops loot (proves it went through the single death commit).
- [ ] A chilled player is visibly slower, and returns to exactly normal speed afterwards.
- [ ] Shock's interrupt feels brief, NOT oppressive — fire a storm staff continuously at a target and confirm they can still act and fight back.
- [ ] Mana visibly drains on a player under lightning fire.
- [ ] A resistant creature takes visibly longer to kill with the wrong element than with the right one. **This is the check that proves the slice's whole premise.**
- [ ] Storm staff feels appropriately costly after the rebalance.

- [ ] **Step 3: Record findings in `.superpowers/sdd/progress.md`.** Anything that fails here is a finding, not a note.

---

## Final review

Dispatch the whole-branch review on the most capable model, then use superpowers:finishing-a-development-branch.
