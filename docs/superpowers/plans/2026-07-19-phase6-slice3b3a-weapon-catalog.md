# Phase 6 Slice 3b-3a — Weapon Catalog, Stamina, Melee LOS — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seed 18 new weapons across four families, give martial combat a stamina resource, and stop melee attacks passing through walls.

**Architecture:** Almost entirely data — the engine already resolves reach/arc melee and simulated projectiles, so the catalog is seed rows. Two mechanics are added: stamina (a deliberate copy of the existing mana pool) and a shared terrain ray-walk that makes melee obey the same line-of-sight rule projectiles already obey.

**Tech Stack:** Node/Express + `pg` (CommonJS, `node --test`, `__setPool` mock seam), `ws`, node-pg-migrate, Vite/React ESM frontend (Vitest, env `node`, no jsdom).

**Spec:** `docs/superpowers/specs/2026-07-19-phase6-slice3b3a-weapon-catalog-design.md`

## Global Constraints

- **The client sends intent only.** It never asserts positions, stats, damage, or resource values. The server owns every mutation.
- **All damage to players routes through `damage.js applyDamage`.** This slice adds no damage source. (Note: `applyMeleeArc` damages *creatures* with a direct `c.hp -= damage` — creatures carry no mitigation. That is existing, intentional, and out of scope. Do not "fix" it.)
- **Resource denial must not consume the attack cooldown.** Mana already behaves this way; stamina must match exactly.
- **Every inbound wire field is validated** (`finiteOr`; ids type-checked). This slice adds no new inbound message.
- **Every async ws handler is try/catch-wrapped and serialised through `ws._opChain`.**
- Backend is **CommonJS**, frontend is **ESM**. Never mixed.
- **Adding a column to `item_types` means touching five places together** — the migration, `validateItemType` in `backend/src/index.js`, the INSERT and UPDATE column lists in the same file, `loadItemTypes` in `items.js`, and `ItemTypesAdmin.jsx`. A validator that lags the schema produced a live 500 in slice 3b-2a.
- Existing suites must stay green: backend **248**, frontend **113**. Do not weaken an existing assertion to accommodate new fields without saying so in your report.

---

### Task 1: Migration — `stamina_cost` + seed 18 weapons

**Files:**
- Create: `backend/migrations/1714440019000_weapon_catalog.js`

**Interfaces:**
- Produces: `item_types.stamina_cost integer NOT NULL DEFAULT 0`, plus 18 new weapon rows.

- [ ] **Step 1: Write the migration**

```js
exports.up = (pgm) => {
  pgm.addColumn('item_types', {
    stamina_cost: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.addConstraint('item_types', 'item_types_stamina_cost_check', 'CHECK (stamina_cost >= 0)');

  // Backfill the four already-seeded weapons with their catalog stamina costs.
  pgm.sql(`UPDATE item_types SET stamina_cost = 0 WHERE name = 'dagger'`);
  pgm.sql(`UPDATE item_types SET stamina_cost = 8 WHERE name = 'halberd'`);
  pgm.sql(`UPDATE item_types SET stamina_cost = 3 WHERE name = 'bow'`);
  pgm.sql(`UPDATE item_types SET stamina_cost = 0 WHERE name = 'magic-bolt'`);

  // 18 new weapons. ON CONFLICT DO NOTHING so a re-run (or a name an admin
  // already authored) cannot fail the migration.
  pgm.sql(`
    INSERT INTO item_types
      (name, category, slot, two_handed, kind, damage, cooldown, reach, arc_width,
       range, projectile_speed, projectile_radius, pierce, mana_cost, stamina_cost, element)
    VALUES
      ('knife',            'weapon','main_hand',false,'melee',       6,0.25, 70,0.5, NULL,NULL,NULL,NULL, 0,0, NULL),
      ('stick',            'weapon','main_hand',false,'melee',       7,0.35, 90,0.7, NULL,NULL,NULL,NULL, 0,0, NULL),
      ('club',             'weapon','main_hand',false,'melee',      10,0.45, 85,0.8, NULL,NULL,NULL,NULL, 0,2, NULL),
      ('short sword',      'weapon','main_hand',false,'melee',      11,0.45,100,0.9, NULL,NULL,NULL,NULL, 0,2, NULL),
      ('mid club',         'weapon','main_hand',false,'melee',      14,0.60,115,1.0, NULL,NULL,NULL,NULL, 0,4, NULL),
      ('long sword',       'weapon','main_hand',false,'melee',      15,0.65,140,1.2, NULL,NULL,NULL,NULL, 0,4, NULL),
      ('morning star',     'weapon','main_hand',false,'melee',      17,0.75,130,1.6, NULL,NULL,NULL,NULL, 0,6, NULL),
      ('two-handed sword', 'weapon','main_hand',true, 'melee',      22,1.00,170,1.4, NULL,NULL,NULL,NULL, 0,9, NULL),
      ('scythe',           'weapon','main_hand',true, 'melee',      20,0.95,175,2.0, NULL,NULL,NULL,NULL, 0,8, NULL),
      ('pike',             'weapon','main_hand',true, 'melee',      19,0.85,200,0.5, NULL,NULL,NULL,NULL, 0,7, NULL),
      ('darts',            'weapon','main_hand',false,'projectile',  7,0.35,NULL,NULL, 350, 800, 6,1, 0,1, NULL),
      ('sling',            'weapon','main_hand',false,'projectile',  8,0.50,NULL,NULL, 450, 700, 8,1, 0,1, NULL),
      ('arbalest',         'weapon','main_hand',true, 'projectile', 20,1.20,NULL,NULL, 850,1100, 8,2, 0,5, NULL),
      ('apprentice staff', 'weapon','main_hand',false,'projectile', 10,0.55,NULL,NULL, 500, 650,10,1, 8,0, 'arcane'),
      ('frost staff',      'weapon','main_hand',false,'projectile', 13,0.70,NULL,NULL, 620, 650,12,1,16,0, 'ice'),
      ('flame staff',      'weapon','main_hand',false,'projectile', 16,0.80,NULL,NULL, 550, 600,14,1,18,0, 'fire'),
      ('storm staff',      'weapon','main_hand',true, 'projectile', 19,0.95,NULL,NULL, 700,1000,10,1,24,0, 'lightning'),
      ('archmage staff',   'weapon','main_hand',true, 'projectile', 24,1.10,NULL,NULL, 800, 850,14,1,32,0, 'arcane')
    ON CONFLICT (name) DO NOTHING
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM item_types WHERE name IN (
      'knife','stick','club','short sword','mid club','long sword','morning star',
      'two-handed sword','scythe','pike','darts','sling','arbalest',
      'apprentice staff','frost staff','flame staff','storm staff','archmage staff'
    )
  `);
  pgm.dropConstraint('item_types', 'item_types_stamina_cost_check');
  pgm.dropColumn('item_types', 'stamina_cost');
};
```

`item_types.name` is `unique: true` (verified in `1714440016000_create_weapon_types.js:4`), so `ON CONFLICT (name)` is valid — the same migration already uses it.

- [ ] **Step 2: Apply and verify the round trip**

There is **no `migrate:down` npm script** — use `npm run migrate -- down`. DB credentials are `user` / `game_db`.

Run from `backend/`:
```bash
npm run migrate:up
docker exec something2-db-1 psql -U user -d game_db -c "SELECT count(*) FROM item_types WHERE category='weapon';"
docker exec something2-db-1 psql -U user -d game_db -c "SELECT name, damage, cooldown, reach, arc_width, stamina_cost FROM item_types WHERE kind='melee' ORDER BY reach;"
npm run migrate -- down
npm run migrate:up
```
Expected: 22 weapons after the first `up`; `down` succeeds; the second `up` re-seeds to 22 again. **A player may own instances of these item types (`player_items` FKs `item_types` ON DELETE CASCADE)** — the `down` deleting a seeded type will cascade away owned instances. That is acceptable for a dev rollback, but note it in your report.

- [ ] **Step 3: Commit**

```bash
git add backend/migrations/1714440019000_weapon_catalog.js
git commit -m "feat(db): stamina_cost column + 18-weapon catalog"
```

---

### Task 2: Shared `MAX_SUB` + `hasLineOfSight`

**Files:**
- Modify: `backend/src/authority/projectiles.js` (export `MAX_SUB`)
- Modify: `backend/src/authority/weapons.js` (add `hasLineOfSight`)
- Test: `backend/tests/authority_weapons.test.js` (append)

**Interfaces:**
- Produces: `MAX_SUB` exported from `projectiles.js`; `hasLineOfSight(map, x0, y0, x1, y1) -> boolean` exported from `weapons.js`.
- `map` must expose `isWalkable(worldX, worldY)` (world PIXEL coordinates — confirmed in `collision.js:76`).

**Context:** `MAX_SUB = 16` is currently a function-local const inside `ProjectileSim.step`. Lift it to a module constant, export it, and have the LOS walk import it. Two independent copies of a sampling resolution is how melee and ranged drift apart again.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/authority_weapons.test.js`:
```js
const { hasLineOfSight } = require('../src/authority/weapons');
const { MAX_SUB } = require('../src/authority/projectiles');

// Map stub: everything walkable except an x-range forming a vertical wall.
function wallMap(wallXMin, wallXMax) {
  return {
    chunkSize: 8,
    isWalkable: (x) => !(x >= wallXMin && x <= wallXMax),
    speedAt: () => 1,
    getChunk: () => [],
  };
}

test('MAX_SUB is shared, not duplicated', () => {
  assert.strictEqual(typeof MAX_SUB, 'number');
  assert.ok(MAX_SUB > 0 && MAX_SUB <= 16, 'must stay small enough to not skip a wall');
});

test('clear terrain has line of sight', () => {
  const map = wallMap(10000, 10001); // wall far away, irrelevant
  assert.strictEqual(hasLineOfSight(map, 0, 0, 200, 0), true);
});

test('a wall between the two points blocks line of sight', () => {
  const map = wallMap(90, 110);
  assert.strictEqual(hasLineOfSight(map, 0, 0, 200, 0), false);
});

test('a wall BEYOND the target does not block', () => {
  const map = wallMap(300, 320);
  assert.strictEqual(hasLineOfSight(map, 0, 0, 200, 0), true);
});

test('point-blank is always visible', () => {
  const map = wallMap(-1000, 1000); // standing inside a blocked tile
  assert.strictEqual(hasLineOfSight(map, 50, 50, 50, 50), true);
});

test('line of sight is symmetric', () => {
  const map = wallMap(90, 110);
  assert.strictEqual(hasLineOfSight(map, 0, 0, 200, 0), hasLineOfSight(map, 200, 0, 0, 0));
});

test('a diagonal wall crossing is blocked', () => {
  const map = wallMap(90, 110);
  assert.strictEqual(hasLineOfSight(map, 0, 0, 200, 200), false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run from `backend/`: `node --test tests/authority_weapons.test.js`
Expected: FAIL — `hasLineOfSight is not a function`.

- [ ] **Step 3: Export `MAX_SUB` from `projectiles.js`**

Lift the local const to module scope:
```js
// Sub-step resolution for terrain sampling, shared with the melee
// line-of-sight walk in weapons.js. Must stay smaller than the thinnest
// wall and than the smallest projectile capture radius, or a fast mover
// (or a long swing) can sample straight past an obstacle.
const MAX_SUB = 16;
```
Remove the `const MAX_SUB = 16;` line from inside `step`, keep its explanatory comment near the module constant, and add `MAX_SUB` to the file's `module.exports`.

- [ ] **Step 4: Implement `hasLineOfSight`**

In `backend/src/authority/weapons.js`:
```js
const { MAX_SUB } = require('./projectiles');

// True when nothing blocks the straight line between two world points.
// Walks in <=MAX_SUB px steps, the same resolution projectiles use for
// terrain, so melee and ranged obey ONE rule. The endpoints are not tested:
// an attacker standing in a doorway, or a target clipping a wall corner,
// must not be self-blocking.
function hasLineOfSight(map, x0, y0, x1, y1) {
  if (!map || typeof map.isWalkable !== 'function') return true;
  const dx = x1 - x0, dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  if (!Number.isFinite(dist) || dist <= MAX_SUB) return true; // point-blank
  const steps = Math.ceil(dist / MAX_SUB);
  const sx = dx / steps, sy = dy / steps;
  // Start at 1 and stop before `steps` so both endpoints are excluded.
  for (let i = 1; i < steps; i++) {
    if (!map.isWalkable(x0 + sx * i, y0 + sy * i)) return false;
  }
  return true;
}
```
Add `hasLineOfSight` to `module.exports`.

No require cycle results: `projectiles.js` requires only `./damage` (verified), so `weapons.js` requiring `./projectiles` is safe.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test` (whole backend suite)
Expected: PASS — the new tests plus all 248 existing.

- [ ] **Step 6: Commit**

```bash
git add backend/src/authority/weapons.js backend/src/authority/projectiles.js backend/tests/authority_weapons.test.js
git commit -m "feat(authority): shared MAX_SUB + hasLineOfSight terrain ray-walk"
```

---

### Task 3: Apply line-of-sight to melee

**Files:**
- Modify: `backend/src/authority/creatures.js` (`applyMeleeArc`)
- Modify: `backend/src/authority/world.js` (`attack`, player-vs-player branch)
- Test: `backend/tests/authority_world_combat.test.js` (append)

**Interfaces:**
- Consumes: `hasLineOfSight` (Task 2).
- `CreatureSim` already stores `this.map` (constructor at `creatures.js:34`), and `World` already stores `this.map` — no signature changes needed.

- [ ] **Step 1: Write the failing test**

The RED/GREEN pair is the test — a blocked-target assertion alone proves nothing, because a bug that makes melee never hit would also pass it. Append to `backend/tests/authority_world_combat.test.js`:

```js
// Map stub with a vertical wall between x=90 and x=110.
function walledMap() {
  return {
    chunkSize: 8,
    isWalkable: (x) => !(x >= 90 && x <= 110),
    speedAt: () => 1,
    getChunk: () => [],
  };
}
function openMap() {
  return { chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] };
}

test('melee does NOT hit a player through a wall', () => {
  const w = new World(walledMap(), TYPES, DEFAULT_ID);
  w.addPlayer('u1', { x: 0, y: 0 }, longReachInv());
  w.addPlayer('u2', { x: 150, y: 0 }, emptyInv());
  const before = w.getPlayer('u2').hp;
  w.attack('u1', 1, 0);
  assert.strictEqual(w.getPlayer('u2').hp, before, 'wall must block the swing');
});

test('the SAME swing DOES hit with clear terrain', () => {
  const w = new World(openMap(), TYPES, DEFAULT_ID);
  w.addPlayer('u1', { x: 0, y: 0 }, longReachInv());
  w.addPlayer('u2', { x: 150, y: 0 }, emptyInv());
  const before = w.getPlayer('u2').hp;
  w.attack('u1', 1, 0);
  assert.ok(w.getPlayer('u2').hp < before, 'clear line must land — otherwise the block test is vacuous');
});

test('melee does NOT hit a creature through a wall', () => {
  const w = new World(walledMap(), TYPES, DEFAULT_ID);
  w.addPlayer('u1', { x: 0, y: 0 }, longReachInv());
  w.creatures.addCreatures([{ id: 'c1', type: 'Wolf', x: 150, y: 0, hp: 50, facing: 's' }]);
  w.attack('u1', 1, 0);
  assert.strictEqual(w.creatures.creatures.get('c1').hp, 50, 'wall must block the swing');
});

test('the SAME swing DOES hit a creature with clear terrain', () => {
  const w = new World(openMap(), TYPES, DEFAULT_ID);
  w.addPlayer('u1', { x: 0, y: 0 }, longReachInv());
  w.creatures.addCreatures([{ id: 'c1', type: 'Wolf', x: 150, y: 0, hp: 50, facing: 's' }]);
  w.attack('u1', 1, 0);
  assert.ok(w.creatures.creatures.get('c1').hp < 50, 'clear line must land');
});
```

Use the existing test file's helpers for `TYPES`/`DEFAULT_ID`/`emptyInv` rather than inventing new ones. `longReachInv()` must equip a weapon whose `reach` exceeds 150 and whose `arc_width` is wide enough to include a target directly east — add such a type to that file's `TYPES` map if none exists, and say so in your report.

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tests/authority_world_combat.test.js`
Expected: the two "does NOT hit through a wall" tests FAIL (melee currently ignores terrain); the two "DOES hit with clear terrain" tests PASS.

- [ ] **Step 3: Apply LOS in `creatures.js`**

Add the import and the check in `applyMeleeArc`:
```js
const { inArc, hasLineOfSight } = require('./weapons');
```
```js
  applyMeleeArc(ox, oy, nx, ny, reach, arcWidth, damage) {
    const killed = [];
    for (const [id, c] of this.creatures) {
      const cc = center(c);
      if (!inArc(ox, oy, nx, ny, cc.x, cc.y, reach, arcWidth)) continue;
      // Terrain blocks the swing, exactly as it blocks a projectile.
      if (!hasLineOfSight(this.map, ox, oy, cc.x, cc.y)) continue;
      c.hp -= damage;
      c.dirty = true;
      if (c.hp <= 0) { this.creatures.delete(id); killed.push(id); }
    }
    return killed;
  }
```
Check `creatures.js`'s existing import line for `inArc` and extend it rather than adding a second require.

- [ ] **Step 4: Apply LOS in `world.js`**

In `attack`'s melee branch, in the player loop:
```js
        if (inArc(cx, cy, nx, ny, ocx, ocy, w.reach, w.arc_width)
            && hasLineOfSight(this.map, cx, cy, ocx, ocy)) {
          applyDamage(other, w.damage, w.element, other.mit || NO_MITIGATION);
        }
```
Extend the existing `require('./weapons')` destructure to include `hasLineOfSight`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test`
Expected: PASS, all four new tests plus the full existing suite.

- [ ] **Step 6: Commit**

```bash
git add backend/src/authority/creatures.js backend/src/authority/world.js backend/tests/authority_world_combat.test.js
git commit -m "fix(authority): melee respects terrain line-of-sight (no more hitting through walls)"
```

---

### Task 4: Stamina

**Files:**
- Modify: `backend/src/authority/world.js`
- Test: `backend/tests/authority_world_combat.test.js` (append)

**Interfaces:**
- Produces: `PLAYER_MAX_STAMINA = 100`, `PLAYER_STAMINA_REGEN = 12` exported from `world.js`; `stamina`/`maxStamina` on the player state and on each `snapshot()` player entry.

**Context:** This is a deliberate copy of the mana implementation already in this file. Find how `mana`/`maxMana`/`PLAYER_MANA_REGEN` are declared, regenerated in `tick`, gated in `attack`, and emitted in `snapshot`, and mirror each one.

- [ ] **Step 1: Write the failing test**

```js
test('stamina regenerates and clamps to max', () => {
  const w = new World(openMap(), TYPES, DEFAULT_ID);
  w.addPlayer('u1', { x: 0, y: 0 }, emptyInv());
  const p = w.getPlayer('u1');
  assert.strictEqual(p.stamina, p.maxStamina);
  p.stamina = 50;
  w.tick(1);
  assert.strictEqual(p.stamina, 62, '12 per second');
  p.stamina = p.maxStamina - 1;
  w.tick(1);
  assert.strictEqual(p.stamina, p.maxStamina, 'clamps, never exceeds max');
});

test('a stamina-costed attack deducts it', () => {
  const w = new World(openMap(), TYPES, DEFAULT_ID);
  w.addPlayer('u1', { x: 0, y: 0 }, heavyInv()); // weapon with stamina_cost > 0
  const p = w.getPlayer('u1');
  const before = p.stamina;
  w.attack('u1', 1, 0);
  assert.strictEqual(p.stamina, before - heavyWeapon.stamina_cost);
});

test('insufficient stamina refuses the attack AND leaves the cooldown untouched', () => {
  const w = new World(openMap(), TYPES, DEFAULT_ID);
  w.addPlayer('u1', { x: 0, y: 0 }, heavyInv());
  w.addPlayer('u2', { x: 60, y: 0 }, emptyInv());
  const p = w.getPlayer('u1');
  p.stamina = 0;
  const targetHp = w.getPlayer('u2').hp;
  w.attack('u1', 1, 0);
  assert.strictEqual(w.getPlayer('u2').hp, targetHp, 'no damage dealt');
  assert.strictEqual(p._attackCd, 0, 'a denied attack must NOT start the cooldown');
  // and once stamina is restored the very next attack works
  p.stamina = p.maxStamina;
  w.attack('u1', 1, 0);
  assert.ok(w.getPlayer('u2').hp < targetHp, 'attack lands once affordable');
});

test('a zero-cost weapon is unaffected by an empty stamina pool', () => {
  const w = new World(openMap(), TYPES, DEFAULT_ID);
  w.addPlayer('u1', { x: 0, y: 0 }, emptyInv()); // default weapon, stamina_cost 0
  w.addPlayer('u2', { x: 60, y: 0 }, emptyInv());
  w.getPlayer('u1').stamina = 0;
  const targetHp = w.getPlayer('u2').hp;
  w.attack('u1', 1, 0);
  assert.ok(w.getPlayer('u2').hp < targetHp, 'free weapons always swing');
});

test('snapshot exposes stamina', () => {
  const w = new World(openMap(), TYPES, DEFAULT_ID);
  w.addPlayer('u1', { x: 0, y: 0 }, emptyInv());
  const pl = w.snapshot().players[0];
  assert.strictEqual(pl.stamina, 100);
  assert.strictEqual(pl.maxStamina, 100);
});
```

Add a stamina-costed weapon type to the file's `TYPES` map and a matching `heavyInv()` helper alongside the existing inventory helpers.

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tests/authority_world_combat.test.js`
Expected: FAIL — `p.stamina` is undefined.

- [ ] **Step 3: Implement**

Add the constants beside the mana ones:
```js
const PLAYER_MAX_STAMINA = 100;
const PLAYER_STAMINA_REGEN = 12; // per second
```

In `addPlayer`, beside `mana`/`maxMana`:
```js
      stamina: PLAYER_MAX_STAMINA,
      maxStamina: PLAYER_MAX_STAMINA,
```

In `tick`, beside the mana regen line:
```js
      if (p.stamina < p.maxStamina) p.stamina = Math.min(p.maxStamina, p.stamina + PLAYER_STAMINA_REGEN * dt);
```

In `attack`, gate BOTH resources before deducting EITHER, so a weapon that costs both can never deduct one and then fail on the other. Place this after the weapon is resolved and before any mutation:
```js
    const manaCost = w.mana_cost || 0;
    const staminaCost = w.stamina_cost || 0;
    // Denied attacks do NOT consume the cooldown — matching mana's existing rule.
    if (p.mana < manaCost || p.stamina < staminaCost) return { killedCreatureIds: [] };
```
Then deduct both where mana is currently deducted, for melee AND projectile branches:
```js
    if (manaCost) p.mana -= manaCost;
    if (staminaCost) p.stamina -= staminaCost;
```
**Note the existing code only gates mana on the projectile branch.** Melee weapons now carry a cost too, so the gate must move to cover both branches. Make sure the existing projectile mana behaviour is preserved exactly — its test must still pass unchanged.

In `snapshot()`, add `stamina: p.stamina, maxStamina: p.maxStamina,` to the player mapping.

Export both new constants.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test`
Expected: PASS. If a pre-existing snapshot key-list assertion fails, widen it for the additive fields and SAY SO in your report — that has been necessary before in this codebase.

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/world.js backend/tests/authority_world_combat.test.js
git commit -m "feat(authority): stamina pool, regen and attack gate"
```

---

### Task 5: Load `stamina_cost` + whole-catalog integrity test

**Files:**
- Modify: `backend/src/authority/items.js`
- Test: `backend/tests/authority_items_catalog.test.js` (append)

**Interfaces:**
- Produces: `stamina_cost` on every item type returned by `loadItemTypes`.

**Context:** if the column is not SELECTed, every weapon loads with `stamina_cost` undefined, `w.stamina_cost || 0` silently yields 0, and the entire gate from Task 4 never fires. Nothing else would fail.

- [ ] **Step 1: Write the failing test**

```js
test('loadItemTypes exposes stamina_cost', async () => {
  const pool = { query: async () => ({ rows: [{
    id: 1, name: 'club', category: 'weapon', kind: 'melee',
    damage: 10, cooldown: 0.45, reach: 85, arc_width: 0.8,
    mana_cost: 0, stamina_cost: 2, resistances: {},
  }] }) };
  const types = await loadItemTypes(pool);
  assert.strictEqual(types.get(1).stamina_cost, 2);
});

test('a missing stamina_cost defaults to 0, never undefined', async () => {
  const pool = { query: async () => ({ rows: [{
    id: 1, name: 'x', category: 'weapon', kind: 'melee', damage: 1, cooldown: 1,
    reach: 10, arc_width: 1, mana_cost: 0, resistances: {},
  }] }) };
  const types = await loadItemTypes(pool);
  assert.strictEqual(types.get(1).stamina_cost, 0);
});
```

Also add the whole-catalog integrity check. It must iterate the ENTIRE catalog, not spot-check — a typo in one of 18 seeded rows is exactly what this catches. A melee row with NULL `reach`/`arc_width` loads as an equippable weapon that can never hit; a projectile row with NULL `range`/`projectile_speed`/`projectile_radius` is equally broken. This is the "unhittable weapon" class the category CHECKs were added for in 3b-2a.

Write it as a pure function over whatever `loadItemTypes` returns, so it runs against a mock pool here and could be pointed at live rows later:

```js
// Returns an array of human-readable problems; empty means the catalog is sound.
function catalogProblems(typesById) {
  const problems = [];
  for (const t of typesById.values()) {
    if (t.category !== 'weapon') continue;
    if (t.kind === 'melee') {
      if (t.reach == null || t.arc_width == null) problems.push(`${t.name}: melee needs reach+arc_width`);
      if (!(t.reach > 0)) problems.push(`${t.name}: reach must be > 0`);
      if (!(t.arc_width > 0)) problems.push(`${t.name}: arc_width must be > 0`);
    } else if (t.kind === 'projectile') {
      if (t.range == null || t.projectile_speed == null || t.projectile_radius == null) {
        problems.push(`${t.name}: projectile needs range+speed+radius`);
      }
      if (!(t.projectile_speed > 0)) problems.push(`${t.name}: projectile_speed must be > 0`);
    } else {
      problems.push(`${t.name}: weapon has no valid kind`);
    }
    if (!(t.cooldown > 0)) problems.push(`${t.name}: cooldown must be > 0`);
    if (!(t.damage > 0)) problems.push(`${t.name}: damage must be > 0`);
    if (t.stamina_cost < 0 || t.mana_cost < 0) problems.push(`${t.name}: negative resource cost`);
  }
  return problems;
}

test('the seeded catalog has no structurally broken weapon', async () => {
  // SEED_ROWS mirrors the migration's VALUES list exactly — every one of the
  // 22 weapons, in DB row shape. Keep it in sync with the migration.
  const pool = { query: async () => ({ rows: SEED_ROWS }) };
  const types = await loadItemTypes(pool);
  assert.deepStrictEqual(catalogProblems(types), []);
});

test('the integrity check actually catches a broken row', () => {
  const broken = new Map([[1, {
    id: 1, name: 'bad-axe', category: 'weapon', kind: 'melee',
    damage: 5, cooldown: 0.5, reach: null, arc_width: null,
    mana_cost: 0, stamina_cost: 0,
  }]]);
  const problems = catalogProblems(broken);
  assert.ok(problems.length > 0, 'a melee weapon with no reach must be reported');
  assert.match(problems[0], /bad-axe/);
});
```

Build `SEED_ROWS` as a const in the test file, transcribing the migration's 22 rows. The second test is what stops the first from being vacuous — without it, a `catalogProblems` that always returns `[]` would pass.

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tests/authority_items_catalog.test.js`
Expected: FAIL — `stamina_cost` is undefined.

- [ ] **Step 3: Implement**

In `loadItemTypes`, add `stamina_cost` to the SELECT column list and to the mapped object:
```js
      stamina_cost: Number(row.stamina_cost ?? 0),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/items.js backend/tests/authority_items_catalog.test.js
git commit -m "feat(authority): load stamina_cost; whole-catalog integrity test"
```

---

### Task 6: API — validate and persist `stamina_cost`

**Files:**
- Modify: `backend/src/index.js`
- Test: `backend/tests/item_types_api.test.js` (append)

**Interfaces:**
- Produces: `validateItemType` accepts/validates `stamina_cost`; the INSERT and UPDATE column lists carry it.

- [ ] **Step 1: Write the failing test**

```js
test('rejects a negative stamina_cost', () => {
  const err = validateItemType({ name: 'x', category: 'weapon', kind: 'melee', reach: 10, arc_width: 1, stamina_cost: -1 });
  assert.match(err, /stamina_cost/i);
});

test('rejects a non-numeric stamina_cost', () => {
  const err = validateItemType({ name: 'x', category: 'weapon', kind: 'melee', reach: 10, arc_width: 1, stamina_cost: 'lots' });
  assert.match(err, /stamina_cost/i);
});

test('accepts a valid stamina_cost', () => {
  assert.strictEqual(
    validateItemType({ name: 'x', category: 'weapon', kind: 'melee', reach: 10, arc_width: 1, stamina_cost: 5 }),
    null,
  );
});

test('accepts an absent stamina_cost (defaults server-side)', () => {
  assert.strictEqual(
    validateItemType({ name: 'x', category: 'weapon', kind: 'melee', reach: 10, arc_width: 1 }),
    null,
  );
});
```

Follow however this test file already reaches `validateItemType` (it may be exported for test, or exercised through the route).

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tests/item_types_api.test.js`
Expected: FAIL — a negative cost is currently accepted.

- [ ] **Step 3: Implement**

In `validateItemType`, alongside the other numeric checks:
```js
  if (b.stamina_cost != null) {
    if (typeof b.stamina_cost !== 'number' || !Number.isFinite(b.stamina_cost) || b.stamina_cost < 0) {
      return 'stamina_cost must be a non-negative finite number';
    }
  }
```
This must mirror the DB CHECK from Task 1 (`stamina_cost >= 0`) — if the API accepts what the DB rejects, the route 500s instead of returning a clean 400. That exact mismatch happened in slice 3b-2a.

Add `stamina_cost` to the INSERT column list, its `VALUES` placeholder, and the parameter array as `b.stamina_cost ?? 0`; do the same for the UPDATE statement. **Renumber the `$n` placeholders carefully** — both statements already run to `$18`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/index.js backend/tests/item_types_api.test.js
git commit -m "feat(api): validate and persist stamina_cost"
```

---

### Task 7: Admin editor field

**Files:**
- Modify: `frontend/src/games/something2/ItemTypesAdmin.jsx`

- [ ] **Step 1: Add the field**

Add a numeric `stamina_cost` input beside the existing `mana_cost` input, following that field's exact markup, state wiring and default (`0`). It should appear for weapons only, matching how `mana_cost` is already gated by category.

- [ ] **Step 2: Verify**

Run from `frontend/`: `npm test && npm run build`
Expected: both PASS (113 tests; this task adds none — it is admin UI, covered by the browser pass).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/games/something2/ItemTypesAdmin.jsx
git commit -m "feat(admin): stamina_cost field in the item editor"
```

---

### Task 8: `renderHud` options object

**Files:**
- Modify: `frontend/src/games/something2/src/js/systems/RenderSystem.js`

**Context:** `renderHud` takes 7 positional parameters and stamina makes 8, with two adjacent same-typed pairs (`mana, maxMana, stamina, maxStamina`) that would silently compile if transposed. This is the same debt paid down for `renderChunked` in slice 3b-2b. Do it as its own commit, BEFORE the stamina fields are added, so the refactor is reviewable in isolation.

**Interfaces:**
- Produces: `renderHud({player, remotePlayers, localUserId, mana = null, maxMana = null, weaponName = null})`.

- [ ] **Step 1: Change the signature**

```js
  renderHud({ player, remotePlayers, localUserId, mana = null, maxMana = null, weaponName = null }) {
```
Every parameter keeps its exact name, so the body needs no other change.

- [ ] **Step 2: Update the call site**

Inside `renderChunked`:
```js
    this.renderHud({ player, remotePlayers, localUserId, mana, maxMana, weaponName });
```

- [ ] **Step 3: Confirm every call site is updated**

Run from `frontend/`: `grep -rn "renderHud" src/`
Expected: the definition plus its call sites. Update all of them, including any in tests.

- [ ] **Step 4: Verify**

Run: `npm test && npm run build`
Expected: both PASS. This is a pure refactor — any behaviour change is a bug.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/systems/RenderSystem.js
git commit -m "refactor(client): renderHud takes an options object"
```

---

### Task 9: Client stamina display

**Files:**
- Modify: `frontend/src/games/something2/src/js/core/Game.js`
- Modify: `frontend/src/games/something2/src/js/systems/RenderSystem.js`

**Interfaces:**
- Consumes: `stamina`/`maxStamina` on the local player's `state` entry (Task 4), `renderHud` options object (Task 8).

- [ ] **Step 1: Read the values off the wire**

In `Game.js`, find where `localMana`/`localMaxMana` are set from the local player's state entry in `_onWorldState` and mirror them:
```js
            this.localStamina = mine.stamina;
            this.localMaxStamina = mine.maxStamina;
```
Initialise both alongside the existing mana fields in the constructor and in `initChunked`, following exactly how mana is initialised there.

- [ ] **Step 2: Pass them through**

Add `stamina: this.localStamina, maxStamina: this.localMaxStamina,` to the `renderChunked` options object in `render()`, add `stamina = null, maxStamina = null` to `renderChunked`'s destructured options, and forward them in the `renderHud({...})` call.

- [ ] **Step 3: Display**

In `renderHud`, beside the MP line:
```js
    if (stamina != null && maxStamina != null) {
      lines.push(`SP: ${Math.round(stamina)} / ${Math.round(maxStamina)}`);
    }
```
Add `stamina = null, maxStamina = null` to `renderHud`'s destructured options.

- [ ] **Step 4: Verify**

Run: `npm test && npm run build`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/core/Game.js frontend/src/games/something2/src/js/systems/RenderSystem.js
git commit -m "feat(client): show stamina in the HUD"
```

---

### Task 10: Live browser verification

**Files:** none (verification only)

**Context:** The frontend test env is `node` with no jsdom, so the render layer and the full round trip are verified only here. In slice 3b-2b this step is where a design defect (drop being a silent no-op with auto-loot on) was found. **If a check cannot be performed, report it as UNVERIFIED. Do not report a pass you did not observe.**

Environment (already running; do NOT use `docker compose`, there is no `.env` and it fails on a missing `JWT_SECRET`):
- Frontend `http://localhost:15173`, backend `http://localhost:13101`
- DB: `docker exec something2-db-1 psql -U user -d game_db -c "SQL"`
- The backend runs inside a sleep container. Restart it with:
  `docker exec -d something2-backend-1 sh -c 'cd /app && npm start > /tmp/backend.log 2>&1'`
  and read `docker exec something2-backend-1 tail -50 /tmp/backend.log`.
- Apply migrations with `docker exec something2-backend-1 npm run migrate:up`.

- [ ] **Step 1: Confirm the catalog is live**

Query the DB for all 22 weapons and confirm the admin item list shows them. Grant yourself several via the admin API so you can equip them.

- [ ] **Step 2: Verify weapons feel different**

Equip a knife, then a two-handed sword, then a pike. Confirm the reach difference is real (a pike hits a creature the knife cannot reach) and that swing rates differ visibly.

- [ ] **Step 3: Verify the LOS fix — the headline check**

Stand on one side of a wall (a non-walkable tile) with a creature or a second player directly opposite, within your weapon's reach. Swing. Expected: **no damage**. Step around so the line is clear at the same distance and swing again. Expected: **damage lands**. Both halves are required — the first alone would pass even if melee were broken entirely.

- [ ] **Step 4: Verify stamina**

Equip a two-handed sword (cost 9) and swing repeatedly. Expected: the SP bar drains, and once it is below the cost the swing is refused — and, critically, you can swing again the instant stamina regenerates rather than waiting out an extra cooldown. Then equip a knife (cost 0) with SP at 0 and confirm it still swings.

- [ ] **Step 5: Verify magic still costs mana, not stamina**

Equip a flame staff. Expected: MP drains, SP does not.

- [ ] **Step 6: Check the console and the wire**

Expected: no browser console errors; `state` frames carry `stamina`/`maxStamina`; the HUD shows both SP and MP.

- [ ] **Step 7: Watch the flagged balance risk**

Note how `pike` (reach 200, arc 0.5) plays in a corridor. Report your observation; do not change stats.

- [ ] **Step 8: Report**

Write up each step with what you actually observed. Any step you could not complete is reported as UNVERIFIED with the reason.

---

## Notes for the executing controller

- Task 2 must land before Task 3 (LOS helper before its callers).
- Task 4 changes `attack`'s resource gate; Task 3 changes `attack`'s melee branch. Run them in order and do not parallelise them — they touch the same function.
- Task 8 must land before Task 9 (signature before new fields).
- Tasks 1, 5 and 6 all concern the same column in different layers. If any one of them is skipped the gate silently never fires, which no other test would catch.
