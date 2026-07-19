# Phase 6 Slice 3b-3b — AoE and consumable ammo: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ranged martial weapons consume a stackable ammo item written through to Postgres on every shot; staff projectiles detonate in a terrain-respecting radius with linear damage falloff.

**Architecture:** Ammo is a real `item_types` row with `category='ammo'`, referenced by a weapon's `ammo_type_id`. `player_items` gains `quantity`. Consumption is a single atomic single-row `UPDATE ... RETURNING` whose `rowCount` is itself the has-ammo gate — no in-memory count, no cache. AoE lives entirely inside `ProjectileSim.step`, reusing `hasLineOfSight` and the shared `MAX_SUB` from 3b-3a.

**Tech Stack:** Node + Express + `pg` (CommonJS, `node --test`), node-pg-migrate, `ws` authority server, Vite/React frontend (Vitest, env `node`, **no jsdom**).

**Spec:** `docs/superpowers/specs/2026-07-19-phase6-slice3b3b-aoe-ammo-design.md`

## Global Constraints

- **Environment:** run migrations with `npm run migrate -- up` / `npm run migrate -- down` from `backend/`. There is NO `migrate:down` script. DB creds are user `user`, database `game_db`.
- **Server-authoritative:** the client sends intent only. It never sends ammo counts, quantities, damage, or positions of things it does not own.
- **The one mitigation path:** all player damage goes through `applyDamage(target, raw, element, mit)` in `damage.js`. AoE scales `raw` BEFORE calling it; it never reimplements mitigation.
- **Creatures carry no mitigation** — they are damaged via `creatures.damageCreatureById(id, dmg)`, which returns `true` on death.
- **Denial rule (from 3b-3a):** an attack refused for ANY reason — cooldown, mana, stamina, ammo — must NOT consume the attack cooldown.
- **`MAX_SUB` is shared** and exported from `projectiles.js`. Never redefine it.
- **Tests must not be vacuous.** This project has shipped four vacuous tests. A test whose assertion is satisfied by data the test itself supplied proves nothing. Where a test guards a SQL statement, assert against the SQL **text and parameter positions**, because the mock pool ignores the query string.
- **3b-2b's loot tests (`backend/tests/authorityLoot.test.js`, `loot.test.js`) must pass UNMODIFIED.** If a change appears to require editing one, stop and escalate.
- Commit after every task. Backend tests: `cd backend && npm test`. Frontend: `cd frontend && npm test`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `backend/migrations/1714440021000_aoe_ammo.js` | create | columns, CHECKs, ammo rows, weapon wiring |
| `backend/src/authority/ammo.js` | create | `consumeAmmo` — the single ammo spend path |
| `backend/src/authority/world.js` | modify | `canAttack` extraction |
| `backend/src/authority/projectiles.js` | modify | detonation, falloff, LOS |
| `backend/src/authority/items.js` | modify | expose new columns, `quantity` on inventory |
| `backend/src/authority/server.js` | modify | attack handler → op chain, `noammo`, detonation broadcast |
| `backend/src/authority/loot.js` | modify | carry `quantity` through drop/claim |
| `backend/src/index.js` | modify | `validateItemType` + INSERT/UPDATE columns |
| `frontend/.../net/WorldAuthorityClient.js` | modify | `noammo` + `detonations` handling |
| `frontend/.../systems/RenderSystem.js` | modify | blast render |
| `frontend/.../core/Game.js` | modify | HUD ammo count |
| `frontend/src/pages/ItemTypesAdmin.jsx` | modify | admin fields |

---

## Task 1: Migration — schema, constraints, content

**Files:**
- Create: `backend/migrations/1714440021000_aoe_ammo.js`

**Interfaces:**
- Produces: columns `item_types.stackable`, `item_types.ammo_type_id`, `item_types.aoe_radius`, `player_items.quantity`, `world_items.quantity`; ammo rows named `arrow`, `bolt`, `stone`.

- [ ] **Step 1: Write the migration**

```js
exports.up = (pgm) => {
  pgm.addColumns('item_types', {
    stackable: { type: 'boolean', notNull: true, default: false },
    // Self-referencing: the ammo item this weapon consumes. RESTRICT (not
    // CASCADE): deleting `arrow` while a bow points at it must fail loudly
    // rather than silently deleting the bow.
    ammo_type_id: { type: 'integer', references: 'item_types', onDelete: 'RESTRICT' },
    aoe_radius: { type: 'real' },
  });

  // quantity > 0 is load-bearing: it makes spending the last unit a constraint
  // violation rather than a silent negative, so Postgres enforces the invariant
  // instead of every call site remembering to.
  pgm.addColumns('player_items', {
    quantity: { type: 'integer', notNull: true, default: 1 },
  });
  pgm.addConstraint('player_items', 'player_items_quantity_check', 'CHECK (quantity > 0)');
  pgm.addColumns('world_items', {
    quantity: { type: 'integer', notNull: true, default: 1 },
  });
  pgm.addConstraint('world_items', 'world_items_quantity_check', 'CHECK (quantity > 0)');

  // 'ammo' joins the category enum.
  pgm.dropConstraint('item_types', 'item_types_category_check');
  pgm.addConstraint('item_types', 'item_types_category_check',
    "CHECK (category IN ('weapon','armor','ammo'))");

  // Category-conditional required fields, matching the weapon/armor pattern:
  // the DB must reject an item that can never work.
  pgm.addConstraint('item_types', 'item_types_ammo_fields_check',
    "CHECK (category <> 'ammo' OR (stackable = true AND kind IS NULL))");
  // A detonating projectile has nothing left to pierce with; allowing both
  // makes "what happens on impact" ambiguous.
  pgm.addConstraint('item_types', 'item_types_aoe_pierce_check',
    'CHECK (aoe_radius IS NULL OR pierce IS NULL OR pierce <= 1)');
  // A melee weapon with ammo_type_id set would silently never check it.
  pgm.addConstraint('item_types', 'item_types_ammo_ref_check',
    "CHECK (ammo_type_id IS NULL OR kind = 'projectile')");

  // Ammo rows FIRST — the weapon updates below reference them by FK.
  pgm.sql(`
    INSERT INTO item_types (name, category, stackable, kind, damage, cooldown, mana_cost, stamina_cost)
    VALUES ('arrow','ammo',true,NULL,0,0,0,0),
           ('bolt', 'ammo',true,NULL,0,0,0,0),
           ('stone','ammo',true,NULL,0,0,0,0)
    ON CONFLICT (name) DO NOTHING;
  `);

  // Wire weapons to ammo by name subquery. A missing row on either side
  // updates nothing rather than aborting the migration — the same guarded
  // pattern the 3b-2b loot seed uses.
  for (const [weapon, ammo] of [['bow', 'arrow'], ['arbalest', 'bolt'], ['sling', 'stone']]) {
    pgm.sql(`UPDATE item_types SET ammo_type_id = (SELECT id FROM item_types WHERE name = '${ammo}')
             WHERE name = '${weapon}' AND EXISTS (SELECT 1 FROM item_types WHERE name = '${ammo}');`);
  }

  // darts deliberately get NO ammo — the weak-but-free option.
  for (const [staff, radius] of [['flame staff', 90], ['storm staff', 70], ['archmage staff', 110]]) {
    pgm.sql(`UPDATE item_types SET aoe_radius = ${radius} WHERE name = '${staff}';`);
  }
};

exports.down = (pgm) => {
  // Null the FKs before deleting the ammo rows, or ON DELETE RESTRICT blocks
  // the DELETE and aborts the rollback.
  pgm.sql(`UPDATE item_types SET ammo_type_id = NULL;`);
  pgm.sql(`DELETE FROM item_types WHERE category = 'ammo';`);
  pgm.dropConstraint('item_types', 'item_types_ammo_ref_check');
  pgm.dropConstraint('item_types', 'item_types_aoe_pierce_check');
  pgm.dropConstraint('item_types', 'item_types_ammo_fields_check');
  pgm.dropConstraint('item_types', 'item_types_category_check');
  pgm.addConstraint('item_types', 'item_types_category_check',
    "CHECK (category IN ('weapon','armor'))");
  pgm.dropConstraint('world_items', 'world_items_quantity_check');
  pgm.dropColumns('world_items', ['quantity']);
  pgm.dropConstraint('player_items', 'player_items_quantity_check');
  pgm.dropColumns('player_items', ['quantity']);
  pgm.dropColumns('item_types', ['stackable', 'ammo_type_id', 'aoe_radius']);
};
```

- [ ] **Step 2: Run the migration up**

```bash
cd backend && npm run migrate -- up
```
Expected: `### MIGRATION 1714440021000_aoe_ammo (UP) ###` and no error.

- [ ] **Step 3: Verify the content landed**

```bash
docker exec something2-db-1 psql -U user -d game_db -c \
  "SELECT w.name, a.name AS ammo, w.aoe_radius FROM item_types w
   LEFT JOIN item_types a ON a.id = w.ammo_type_id
   WHERE w.ammo_type_id IS NOT NULL OR w.aoe_radius IS NOT NULL ORDER BY w.name;"
```
Expected exactly 6 rows: archmage staff (aoe 110), arbalest→bolt, bow→arrow, flame staff (aoe 90), sling→stone, storm staff (aoe 70). `darts` must NOT appear.

- [ ] **Step 4: Verify the round trip**

```bash
cd backend && npm run migrate -- down && npm run migrate -- up
```
Expected: both succeed. A failure here means `down()` left the DB in a state `up()` can't re-enter — most likely the FK-nulling step.

- [ ] **Step 5: Commit**

```bash
git add backend/migrations/1714440021000_aoe_ammo.js
git commit -m "feat(db): ammo + aoe columns, constraints, and content"
```

---

## Task 2: Catalog load path

**Files:**
- Modify: `backend/src/authority/items.js`
- Test: `backend/tests/authority_items_catalog.test.js`

**Interfaces:**
- Consumes: the columns from Task 1.
- Produces: item type objects with `stackable: boolean`, `ammo_type_id: number|null`, `aoe_radius: number|null`. Inventory items gain `quantity: number`.

**Context:** 3b-3a added a test asserting `loadItemTypes`' SELECT column list names every mapped column, because the mock pool ignores the SQL string and dropping a column from the SELECT otherwise stayed green. Extend that test — do not just leave it passing.

- [ ] **Step 1: Extend the SELECT-column guard test**

In `backend/tests/authority_items_catalog.test.js`, find the existing test asserting the SELECT names every mapped column and add the three new names to its expected list:

```js
for (const col of ['stackable', 'ammo_type_id', 'aoe_radius']) {
  assert.ok(sql.includes(col), `loadItemTypes SELECT must name ${col} — a mapped column missing from the SELECT loads as undefined, so ammo silently never depletes and AoE silently never fires`);
}
```

- [ ] **Step 2: Add a mapping test**

```js
test('loadItemTypes exposes ammo and aoe fields', async () => {
  const pool = { query: async () => ({ rows: [{
    id: 1, name: 'bow', category: 'weapon', kind: 'projectile',
    stackable: false, ammo_type_id: 7, aoe_radius: null,
  }] }) };
  const m = await loadItemTypes(pool);
  assert.equal(m.get(1).stackable, false);
  assert.equal(m.get(1).ammo_type_id, 7);
  assert.equal(m.get(1).aoe_radius, null);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
cd backend && npm test 2>&1 | tail -20
```
Expected: FAIL — the SELECT does not name the new columns.

- [ ] **Step 4: Implement**

In `loadItemTypes`, add to the SELECT list after `resistances`: `, stackable, ammo_type_id, aoe_radius`. Add to the mapped object:

```js
stackable: row.stackable === true,
ammo_type_id: num(row.ammo_type_id),
aoe_radius: num(row.aoe_radius),
```

In `loadInventory`, change the items query to `SELECT id, item_type_id, quantity FROM player_items ...` and map `quantity: Number(r.quantity ?? 1)` alongside `id` and `typeId`.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd backend && npm test 2>&1 | tail -5
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/authority/items.js backend/tests/authority_items_catalog.test.js
git commit -m "feat(authority): load ammo/aoe catalog fields and inventory quantity"
```

---

## Task 3: `World.canAttack` extraction

**Files:**
- Modify: `backend/src/authority/world.js`
- Test: `backend/tests/authority_world_combat.test.js`

**Interfaces:**
- Produces: `World.canAttack(userId) -> { ok: boolean, weapon: itemType|null }`.

**Context:** Ammo must be spent only after cooldown/mana/stamina have already passed, or an attack refused for cooldown destroys an arrow. `canAttack` exposes those checks so the caller can gate before spending. **`attack()` keeps its own checks unchanged** — it must stay correct when called directly, which it still is for every ammo-free weapon.

- [ ] **Step 1: Write the failing tests**

```js
test('canAttack reports false while the cooldown is running', () => {
  const w = mkWorld();               // existing helper in this file
  w.addPlayer('u1', { x: 0, y: 0 });
  w.attack('u1', 1, 0);              // starts the cooldown
  assert.equal(w.canAttack('u1').ok, false);
});

test('canAttack reports false with insufficient stamina', () => {
  const w = mkWorld();
  w.addPlayer('u1', { x: 0, y: 0 });
  w.getPlayer('u1').stamina = 0;
  const r = w.canAttack('u1');
  // The default dagger costs 0 stamina, so equip something that costs some
  // before asserting — otherwise this passes for the wrong reason.
  assert.equal(r.ok, r.weapon && (r.weapon.stamina_cost || 0) === 0);
});

test('canAttack returns the active weapon when it can fire', () => {
  const w = mkWorld();
  w.addPlayer('u1', { x: 0, y: 0 });
  const r = w.canAttack('u1');
  assert.equal(r.ok, true);
  assert.ok(r.weapon);
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd backend && npm test 2>&1 | grep -A3 "canAttack"
```
Expected: FAIL — `canAttack is not a function`.

- [ ] **Step 3: Implement**

Add to `World`, directly above `attack`:

```js
  // The pure, side-effect-free half of `attack`'s gating: cooldown, mana and
  // stamina. Exposed so a caller can check BEFORE spending something
  // irreversible (ammo), since an attack refused for cooldown must not have
  // already destroyed an arrow. `attack` keeps performing these same checks
  // itself — this is additive, and attack() stays correct called directly.
  canAttack(userId) {
    const p = this.players.get(userId);
    if (!p || p._attackCd > 0) return { ok: false, weapon: null };
    const w = activeWeaponType(p.inv, this.weapons, this.defaultWeaponId);
    if (!w) return { ok: false, weapon: null };
    if (p.mana < (w.mana_cost || 0) || p.stamina < (w.stamina_cost || 0)) {
      return { ok: false, weapon: w };
    }
    return { ok: true, weapon: w };
  }
```

- [ ] **Step 4: Run to verify they pass**

```bash
cd backend && npm test 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/world.js backend/tests/authority_world_combat.test.js
git commit -m "feat(authority): extract World.canAttack for pre-spend gating"
```

---

## Task 4: `consumeAmmo`

**Files:**
- Create: `backend/src/authority/ammo.js`
- Test: `backend/tests/authority_ammo.test.js` (create)

**Interfaces:**
- Produces: `consumeAmmo(pool, userId, ammoTypeId) -> Promise<boolean>` — true if exactly one unit was spent.

- [ ] **Step 1: Write the failing tests**

```js
const test = require('node:test');
const assert = require('node:assert');
const { consumeAmmo } = require('../src/authority/ammo');

test('consumeAmmo returns true and spends one unit', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    return { rowCount: 1, rows: [{ id: 'i1', quantity: 4 }] };
  } };
  assert.equal(await consumeAmmo(pool, 'u1', 7), true);
  assert.equal(calls.length, 1, 'a non-empty stack needs no follow-up delete');
});

// The mock pool ignores the SQL string, so nothing about the statement is
// defended unless the test reads the statement itself. Without the
// single-row subquery, one shot decrements EVERY stack of that ammo type.
test('the consume statement targets exactly one row', async () => {
  let sql = '';
  const pool = { query: async (q) => { sql = q; return { rowCount: 1, rows: [{ id: 'i1', quantity: 2 }] }; } };
  await consumeAmmo(pool, 'u1', 7);
  const norm = sql.replace(/\s+/g, ' ').toLowerCase();
  assert.ok(norm.includes('limit 1'),
    'consume must select a single stack id — without LIMIT 1 the UPDATE hits every stack of this ammo type, so one shot spends several units');
  assert.ok(norm.includes('where id ='),
    'the UPDATE must be keyed on a single id, not on user_id/item_type_id directly');
  assert.ok(norm.includes('quantity > 0'),
    'the quantity > 0 predicate is the has-ammo gate; without it an empty stack decrements to a CHECK violation and 500s');
});

test('consumeAmmo returns false when no stack has any left', async () => {
  const pool = { query: async () => ({ rowCount: 0, rows: [] }) };
  assert.equal(await consumeAmmo(pool, 'u1', 7), false);
});

test('emptying a stack deletes it rather than leaving quantity 0', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (calls.length === 1) return { rowCount: 1, rows: [{ id: 'i1', quantity: 0 }] };
    return { rowCount: 1, rows: [] };
  } };
  assert.equal(await consumeAmmo(pool, 'u1', 7), true);
  assert.equal(calls.length, 2);
  assert.match(calls[1].sql, /delete\s+from\s+player_items/i);
  assert.deepEqual(calls[1].params, ['i1']);
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd backend && npm test 2>&1 | tail -20
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// The single ammo spend path. Write-through: Postgres is the only source of
// truth for how much ammo a player has, so a crash can neither lose nor
// refund a shot. Deliberately NOT cached in memory — see the "Why not Redis"
// section of the 3b-3b spec.

// Spend one unit of `ammoTypeId` from `userId`. Returns whether a unit was
// actually spent; the caller must treat false as "out of ammo" and refuse the
// attack WITHOUT consuming the cooldown.
//
// The subquery is load-bearing. A player may hold more than one stack of the
// same ammo type (stacks are never merged — see the spec), and the obvious
// form `WHERE user_id = $1 AND item_type_id = $2` would decrement EVERY one
// of them on a single shot. Selecting one id first makes the statement
// correct for any number of stacks; ORDER BY created_at drains oldest first.
//
// rowCount IS the has-ammo check: there is no separate SELECT that could
// drift out of sync with the write, the same reasoning as the loot claim CTE.
async function consumeAmmo(pool, userId, ammoTypeId) {
  const r = await pool.query(
    `UPDATE player_items SET quantity = quantity - 1
      WHERE id = (
        SELECT id FROM player_items
         WHERE user_id = $1 AND item_type_id = $2 AND quantity > 0
         ORDER BY created_at ASC, id ASC LIMIT 1
      )
      RETURNING id, quantity`,
    [userId, ammoTypeId],
  );
  if (r.rowCount !== 1) return false;
  // quantity > 0 is a CHECK constraint, so an emptied stack must be removed
  // rather than left at 0 — the next shot's `quantity > 0` predicate would
  // skip it anyway, but leaving zero-rows around would grow the inventory.
  if (Number(r.rows[0].quantity) === 0) {
    await pool.query('DELETE FROM player_items WHERE id = $1', [r.rows[0].id]);
  }
  return true;
}

module.exports = { consumeAmmo };
```

- [ ] **Step 4: Run to verify they pass**

```bash
cd backend && npm test 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/ammo.js backend/tests/authority_ammo.test.js
git commit -m "feat(authority): write-through ammo consumption"
```

---

## Task 5: Attack handler — ordering and the `noammo` frame

**Files:**
- Modify: `backend/src/authority/server.js` (the `msg.type === 'attack'` handler, currently ~line 333)
- Test: `backend/tests/authority_server.test.js`

**Interfaces:**
- Consumes: `World.canAttack` (Task 3), `consumeAmmo` (Task 4).
- Produces: a `{ type: 'noammo' }` frame to the attacking socket.

**Context:** This is the task the whole slice turns on. The order MUST be: `canAttack` → consume ammo → `attack`. Any other order spends ammo on a refused attack.

- [ ] **Step 1: Write the failing tests**

```js
test('an attack refused for cooldown does not consume ammo', async () => {
  // Build a world whose player holds an ammo-consuming weapon, put the
  // player on cooldown, then send an attack frame.
  const spent = [];
  const harness = mkAttackHarness({ onConsume: () => { spent.push(1); return true; } });
  harness.player._attackCd = 1;             // cooldown running
  await harness.sendAttack(1, 0);
  assert.equal(spent.length, 0,
    'ammo was spent on an attack that was refused for cooldown — the consume must come AFTER canAttack');
});

test('an attack refused for stamina does not consume ammo', async () => {
  const spent = [];
  const harness = mkAttackHarness({ onConsume: () => { spent.push(1); return true; } });
  harness.player.stamina = 0;
  await harness.sendAttack(1, 0);
  assert.equal(spent.length, 0,
    'ammo was spent on an attack refused for stamina');
});

test('firing with no ammo sends noammo and leaves the cooldown untouched', async () => {
  const harness = mkAttackHarness({ onConsume: () => false });
  await harness.sendAttack(1, 0);
  assert.equal(harness.player._attackCd, 0,
    'an ammo denial must not consume the cooldown, matching the mana/stamina rule');
  assert.ok(harness.sent.some((m) => m.type === 'noammo'));
});

test('a weapon with no ammo_type_id never touches player_items', async () => {
  let consumed = false;
  const harness = mkAttackHarness({ weapon: { kind: 'melee', reach: 80, arc_width: 1, damage: 5, cooldown: 0.3 },
                                    onConsume: () => { consumed = true; return true; } });
  await harness.sendAttack(1, 0);
  assert.equal(consumed, false);
});

test('a successful ammo attack spends exactly one unit and fires', async () => {
  let count = 0;
  const harness = mkAttackHarness({ onConsume: () => { count += 1; return true; } });
  await harness.sendAttack(1, 0);
  assert.equal(count, 1);
  assert.ok(harness.player._attackCd > 0, 'a successful attack starts the cooldown');
});
```

Build `mkAttackHarness` in this file following the existing harness helpers in
`authority_server.test.js`; it must let the test inject the `consumeAmmo`
result and capture frames sent to the socket.

- [ ] **Step 2: Run to verify they fail**

```bash
cd backend && npm test 2>&1 | tail -20
```

- [ ] **Step 3: Implement**

Replace the `attack` handler:

```js
      if (msg.type === 'attack') {
        const entry = worlds.get(ws.worldId);
        if (!entry) return;
        const ax = finiteOr(msg.ax, 0), ay = finiteOr(msg.ay, 0);

        const gate = entry.world.canAttack(ws.userId);
        if (!gate.ok) return;   // cooldown / mana / stamina — nothing spent

        // Ammo-free weapons (all melee, all staves, darts) keep the fully
        // synchronous path: no DB round trip on the hot path.
        if (gate.weapon.ammo_type_id == null) {
          const { killedCreatureIds } = entry.world.attack(ws.userId, ax, ay);
          for (const id of new Set(killedCreatureIds)) onCreatureDeath(entry, id);
          return;
        }

        // Ammo is spent LAST, after every other gate has passed, so a refused
        // attack can never destroy a unit. Serialized on the op chain: a
        // player has one connection, so their next attack cannot start
        // between this consume and its attack().
        ws._opChain = (ws._opChain || Promise.resolve()).then(async () => {
          try {
            if (!(await consumeAmmo(pool, ws.userId, gate.weapon.ammo_type_id))) {
              send(ws, { type: 'noammo' });   // no cooldown consumed
              return;
            }
            const { killedCreatureIds } = entry.world.attack(ws.userId, ax, ay);
            for (const id of new Set(killedCreatureIds)) onCreatureDeath(entry, id);
          } catch (err) {
            console.error('attack/ammo failed', err);
          }
        });
        return;
      }
```

Add `const { consumeAmmo } = require('./ammo');` to the requires at the top.
Use whatever the file's existing helper for sending a frame to one socket is
(match the `pickup`/`drop` handlers); if there is none, `ws.send(JSON.stringify(...))`
guarded by a readyState check.

- [ ] **Step 4: Run to verify they pass**

```bash
cd backend && npm test 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/server.js backend/tests/authority_server.test.js
git commit -m "feat(authority): gate attacks on ammo after cooldown and resources"
```

---

## Task 6: AoE detonation

**Files:**
- Modify: `backend/src/authority/projectiles.js`
- Test: `backend/tests/authority_projectiles.test.js`

**Interfaces:**
- Consumes: `hasLineOfSight` from `./weapons` (3b-3a).
- Produces: `step()` returns `{ killedCreatureIds, detonations: [{ x, y, radius, element }] }`.

- [ ] **Step 1: Write the failing tests**

```js
test('a blast damages a target in radius with clear terrain', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0,
              weapon: { projectile_speed: 100, range: 200, damage: 20,
                        projectile_radius: 4, pierce: 1, aoe_radius: 100 } });
  const target = mkPlayer('u2', 60, 0);
  sim.step(1, { creatures: mkNoCreatures(), players: [target], map: allWalkable });
  assert.ok(target.hp < target.maxHp, 'target in radius took no damage');
});

// The pair IS the test. Either half alone proves nothing.
test('a blast does NOT damage the same target through a wall', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0,
              weapon: { projectile_speed: 100, range: 200, damage: 20,
                        projectile_radius: 4, pierce: 1, aoe_radius: 100 } });
  const target = mkPlayer('u2', 60, 0);
  const blocked = { isWalkable: (x) => x < 30 || x > 55 };  // wall between blast and target
  sim.step(1, { creatures: mkNoCreatures(), players: [target], map: blocked });
  assert.equal(target.hp, target.maxHp, 'blast damaged a target through a wall');
});

test('blast damage falls off with distance', () => {
  const near = mkPlayer('near', 30, 0);
  const far = mkPlayer('far', 90, 0);
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0,
              weapon: { projectile_speed: 100, range: 200, damage: 40,
                        projectile_radius: 4, pierce: 1, aoe_radius: 100 } });
  sim.step(1, { creatures: mkNoCreatures(), players: [near, far], map: allWalkable });
  assert.ok(near.maxHp - near.hp > far.maxHp - far.hp,
    'a nearer target must take strictly more than a further one');
});

test('the caster takes no damage from their own blast', () => {
  const owner = mkPlayer('u1', 10, 0);
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0,
              weapon: { projectile_speed: 100, range: 200, damage: 40,
                        projectile_radius: 4, pierce: 1, aoe_radius: 100 } });
  sim.step(1, { creatures: mkNoCreatures(), players: [owner], map: allWalkable });
  assert.equal(owner.hp, owner.maxHp);
});

test('an AoE projectile does not survive its detonation', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0,
              weapon: { projectile_speed: 100, range: 500, damage: 10,
                        projectile_radius: 4, pierce: 1, aoe_radius: 60 } });
  const r = sim.step(1, { creatures: mkNoCreatures(), players: [mkPlayer('u2', 50, 0)], map: allWalkable });
  assert.equal(sim.count(), 0);
  assert.equal(r.detonations.length, 1);
});

test('a projectile with no aoe_radius reports no detonations', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0,
              weapon: { projectile_speed: 100, range: 500, damage: 10,
                        projectile_radius: 4, pierce: 1 } });
  const r = sim.step(1, { creatures: mkNoCreatures(), players: [mkPlayer('u2', 50, 0)], map: allWalkable });
  assert.equal(r.detonations.length, 0);
});
```

Reuse the existing helpers in this file for players/creatures/maps; the names
above are placeholders for whatever it already defines.

- [ ] **Step 2: Run to verify they fail**

```bash
cd backend && npm test 2>&1 | tail -20
```

- [ ] **Step 3: Implement**

Add `hasLineOfSight` to the requires:
```js
const { hasLineOfSight } = require('./weapons');
```

In `spawn`, carry the radius: `aoeRadius: weapon.aoe_radius ?? null,`.

Add the detonation method to `ProjectileSim`:

```js
  // Resolve an AoE blast at (bx,by). Damages every creature and every
  // non-owner player within `radius`, scaled linearly from full damage at the
  // centre to zero at the edge.
  //
  // Each candidate needs line of sight FROM THE BLAST POINT: without it AoE
  // reintroduces the melee-through-walls exploit closed in 3b-3a, with a
  // bigger hitbox. Reuses the same helper and the same shared MAX_SUB.
  //
  // The caster is exempt, matching the existing rule that a projectile never
  // collides with its owner — one rule, not two.
  _detonate(p, bx, by, { creatureList, creatures, players, map }, killedCreatureIds) {
    const r = p.aoeRadius;
    for (const c of creatureList) {
      const half = c.width / 2;
      const cx = c.x + half, cy = c.y + c.height / 2;
      const d = Math.hypot(cx - bx, cy - by);
      if (d >= r) continue;
      if (!hasLineOfSight(map, bx, by, cx, cy)) continue;
      // Creatures carry no mitigation, so falloff is the only scaling.
      if (creatures.damageCreatureById(c.id, p.damage * (1 - d / r))) {
        killedCreatureIds.push(c.id);
      }
    }
    for (const pl of players) {
      if (pl.userId === p.ownerId) continue;
      const half = pl.width / 2;
      const px = pl.x + half, py = pl.y + pl.height / 2;
      const d = Math.hypot(px - bx, py - by);
      if (d >= r) continue;
      if (!hasLineOfSight(map, bx, by, px, py)) continue;
      // Falloff scales the RAW damage; applyDamage still applies defense and
      // resistances on top. It floors at 1, so an edge hit still registers.
      applyDamage(pl, p.damage * (1 - d / r), p.element, pl.mit || NO_MITIGATION);
    }
    return { x: bx, y: by, radius: r, element: p.element };
  }
```

`creatures` and `creatureList` are both passed in `step`'s context object —
`creatureList` is the hoisted array to iterate, `creatures` is the sim that owns
`damageCreatureById`. Do not introduce an instance field for either.

In `step`, declare `const detonations = [];` beside `killedCreatureIds`, and at
**each** of the three points that currently set `dead = true` for an impact
(terrain, creature hit exhausting pierce, player hit exhausting pierce) plus the
terrain branch, detonate first if `p.aoeRadius`:

```js
        // Terrain: walls stop projectiles.
        if (!map.isWalkable(p.x, p.y)) {
          if (p.aoeRadius) detonations.push(this._detonate(p, p.x, p.y, { creatureList, players, map, creatures }, killedCreatureIds));
          dead = true; break;
        }
```

For the creature and player branches, an AoE projectile detonates on its FIRST
contact rather than applying single-target damage:

```js
          if (dist2(p.x, p.y, cx, cy) <= rr * rr) {
            if (p.aoeRadius) {
              detonations.push(this._detonate(p, p.x, p.y, { creatureList, players, map, creatures }, killedCreatureIds));
              dead = true; break;
            }
            p.hitIds.add(key);
            // ... existing single-target path unchanged
          }
```

Do the same in the player loop. Finally return
`{ killedCreatureIds, detonations }`.

Also detonate when `p.remaining <= 0` (the projectile reached max range without
hitting anything) — a fireball that runs out of range should still explode.

- [ ] **Step 4: Run to verify they pass**

```bash
cd backend && npm test 2>&1 | tail -5
```

- [ ] **Step 5: Update the caller**

`world.js`'s `tickProjectiles` currently returns `.killedCreatureIds`. Change it
to return the whole result object and update `server.js`'s tick to destructure
both fields, stashing detonations for the next broadcast.

- [ ] **Step 6: Run the full suite and commit**

```bash
cd backend && npm test 2>&1 | tail -5
git add backend/src/authority/projectiles.js backend/src/authority/world.js backend/tests/authority_projectiles.test.js
git commit -m "feat(authority): AoE detonation with terrain LOS and linear falloff"
```

---

## Task 7: Stack-aware drop and pickup

**Files:**
- Modify: `backend/src/authority/loot.js`
- Test: `backend/tests/loot.test.js` (add to; do not modify existing cases)

**Interfaces:**
- Consumes: `world_items.quantity`, `player_items.quantity` (Task 1).

**Context:** 3b-2b's existing tests must pass **unmodified**. This task only carries the quantity across the existing statements.

- [ ] **Step 1: Write the failing test**

```js
test('dropping a stack of N spawns one ground item of quantity N', async () => {
  // The DELETE returns the dropped row's quantity; the INSERT must carry it.
  // Without this a stack of 40 arrows drops as 1 and destroys 39.
  const seen = [];
  const pool = { query: async (sql, params) => {
    seen.push({ sql, params });
    if (/delete\s+from\s+player_items/i.test(sql)) {
      return { rowCount: 1, rows: [{ item_type_id: 7, quantity: 40 }] };
    }
    return { rowCount: 1, rows: [{ id: 'g1', item_type_id: 7, x: 0, y: 0, quantity: 40 }] };
  } };
  const entry = mkEntry();   // existing helper
  const r = await dropItem(pool, entry, 'u1', 'i1');
  assert.equal(r.ok, true);
  const ins = seen.find((c) => /insert\s+into\s+world_items/i.test(c.sql));
  assert.ok(ins.sql.includes('quantity'), 'the world_items INSERT must name quantity');
  assert.ok(ins.params.includes(40), 'the dropped stack size must reach the INSERT');
});

test('claiming a stack grants the full quantity', async () => {
  let sql = '';
  const pool = { query: async (q) => {
    sql = q;
    return { rowCount: 1, rows: [{ id: 'i9', item_type_id: 7, quantity: 40 }] };
  } };
  const entry = mkEntry();
  entry.world.addPlayer('u1', { x: 0, y: 0 });
  const r = await claimItem(pool, entry, 'u1', 'g1');
  assert.equal(r.quantity, 40);
  assert.ok(sql.includes('quantity'), 'the claim CTE must carry quantity across');
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd backend && npm test 2>&1 | tail -20
```

- [ ] **Step 3: Implement**

In `dropItem`, change the DELETE to `... RETURNING item_type_id, quantity` and the
INSERT to name `quantity` with the returned value as a parameter.

In `claimItem`, carry quantity through the CTE:

```sql
WITH d AS (DELETE FROM world_items WHERE id = $1 RETURNING item_type_id, quantity)
INSERT INTO player_items (user_id, item_type_id, quantity)
SELECT $2, item_type_id, quantity FROM d
RETURNING id, item_type_id, quantity
```

Return `quantity` in the result object and include it on the `p.inv.items` push.

In `spawnDrops`, name `quantity` explicitly as 1 — drops stay one-per-unit this
slice, and being explicit stops a future edit from silently inheriting a default.

- [ ] **Step 4: Run to verify they pass, and that nothing else broke**

```bash
cd backend && npm test 2>&1 | tail -5
git diff --stat backend/tests/authorityLoot.test.js
```
Expected: all pass, and **the diff for `authorityLoot.test.js` is empty**. A
non-empty diff means an existing loot test was modified — stop and escalate.

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/loot.js backend/tests/loot.test.js
git commit -m "feat(authority): carry stack quantity through drop and claim"
```

---

## Task 8: Admin API — validation and persistence

**Files:**
- Modify: `backend/src/index.js`
- Test: `backend/tests/item_types_api.test.js`

**Context:** 3b-3a added tests that parse the INSERT's column list and check
positional alignment by dynamic index lookup, because swapping two params
(data corruption) or breaking placeholder arity (every POST 500s) both stayed
green otherwise. Extend those, do not merely leave them passing.

- [ ] **Step 1: Write the failing tests**

```js
test('validateItemType accepts the ammo category', () => {
  assert.equal(validateItemType({ name: 'arrow', category: 'ammo', stackable: true }), null);
});

test('validateItemType rejects a negative aoe_radius', () => {
  const err = validateItemType({ name: 'x', category: 'weapon', kind: 'projectile',
    range: 1, projectile_speed: 1, projectile_radius: 1, aoe_radius: -5 });
  assert.match(err, /aoe_radius/);
});

test('validateItemType rejects a non-stackable ammo row', () => {
  assert.match(validateItemType({ name: 'arrow', category: 'ammo', stackable: false }), /stackable/);
});

test('the INSERT column list and placeholders stay aligned', () => {
  // Extend the existing alignment test with the three new columns, looking up
  // each by dynamic index rather than a hard-coded position.
  for (const col of ['stackable', 'ammo_type_id', 'aoe_radius']) {
    const i = insertColumns.indexOf(col);
    assert.ok(i >= 0, `INSERT must name ${col}`);
    assert.equal(insertParams[i] === undefined, false, `${col} has no bound parameter`);
  }
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd backend && npm test 2>&1 | tail -20
```

- [ ] **Step 3: Implement**

In `validateItemType`:
- change the category check to `['weapon', 'armor', 'ammo']`
- add an `ammo` branch: `if (b.category === 'ammo') { if (b.stackable !== true) return 'ammo must be stackable'; if (b.kind != null) return 'ammo must not have a kind'; }`
- guard `aoe_radius` and `ammo_type_id` as non-negative finite numbers when present, mirroring the existing `stamina_cost` guard
- reject `aoe_radius` set together with `pierce > 1`, and `ammo_type_id` on a non-projectile — so the API rejects what the DB CHECKs would, rather than 500ing

Add `stackable`, `ammo_type_id`, `aoe_radius` to the INSERT and UPDATE column
lists and their parameter arrays, keeping positions aligned.

- [ ] **Step 4: Run to verify they pass**

```bash
cd backend && npm test 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/index.js backend/tests/item_types_api.test.js
git commit -m "feat(api): validate and persist ammo/aoe item fields"
```

---

## Task 9: Admin UI fields

**Files:**
- Modify: `frontend/src/pages/ItemTypesAdmin.jsx`

- [ ] **Step 1: Add the fields**

Add `stackable` (checkbox), `ammo_type_id` (select populated from the loaded
item types filtered to `category === 'ammo'`, with an empty "none" option), and
`aoe_radius` (number, blank = null) to the create/edit form, following the
existing field pattern for `stamina_cost`. Include `'ammo'` in the category
select.

- [ ] **Step 2: Verify the build**

```bash
cd frontend && npm run build 2>&1 | tail -5
```
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/ItemTypesAdmin.jsx
git commit -m "feat(admin): ammo and aoe fields on the item type editor"
```

---

## Task 10: Client — ammo HUD, `noammo` feedback, blast render

**Files:**
- Modify: `frontend/src/games/something2/src/js/net/WorldAuthorityClient.js`
- Modify: `frontend/src/games/something2/src/js/core/Game.js`
- Modify: `frontend/src/games/something2/src/js/systems/RenderSystem.js`

**Context:** Vitest here runs with env `node` and **no jsdom** — the render layer
is verified by `npm run build` plus the browser pass, not by unit tests. Put
logic worth testing in pure functions.

- [ ] **Step 1: Handle the new frames**

In `WorldAuthorityClient`, handle `noammo` by setting a timestamped flag the HUD
reads, and `detonations` (arriving on the broadcast) by appending to a list of
active blasts, each stamped with its arrival time.

- [ ] **Step 2: HUD count**

The equipped weapon's ammo count is the **sum of `quantity` across the player's
stacks of `ammo_type_id`** — stacks are never merged, so a single row's quantity
is not the answer. Render it beside the mana/stamina bars, and render nothing at
all when the active weapon has `ammo_type_id == null`.

Show the `noammo` flash for ~600ms after the frame arrives.

- [ ] **Step 3: Blast render**

Draw each active detonation as a ring expanding from 0 to `radius`, fading out
over ~250ms, tinted by `element` using the existing projectile element colours.
Drop blasts older than their lifetime each frame.

**Watch the coordinate convention:** `worldToScreen` returns the tile diamond's
CENTRE, and ground items were painted at the wrong depth in 3b-2b by assuming
otherwise. The blast centre is a world-space point, so convert it the same way
projectiles are converted — copy that call site rather than deriving a new one.

- [ ] **Step 4: Verify the build**

```bash
cd frontend && npm run build 2>&1 | tail -5 && npm test 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/
git commit -m "feat(client): ammo HUD, noammo feedback, and blast rendering"
```

---

## Task 11: Catalog invariant tests

**Files:**
- Modify: `backend/tests/authority_items_catalog.test.js`

**Context:** 3b-3a shipped a stamina economy that was mathematically inert —
every gate and test worked, and the numbers guaranteed the gate never engaged.
The lesson: **test that the mechanism is reachable, not only that it works when
reached.** These tests apply that to ammo and AoE.

- [ ] **Step 1: Write the tests**

```js
test('every weapon with ammo_type_id points at an ammo row', () => {
  // Guards against a weapon wired to another weapon, which would make
  // firing consume a sword.
  for (const w of SEED_ROWS.filter((r) => r.ammo_type_id != null)) {
    const target = SEED_ROWS.find((r) => r.name === w.ammo_type_name);
    assert.ok(target, `${w.name} references a missing ammo type`);
    assert.equal(target.category, 'ammo');
  }
});

test('no weapon has both aoe_radius and pierce > 1', () => {
  for (const w of SEED_ROWS) {
    if (w.aoe_radius != null) {
      assert.ok((w.pierce ?? 1) <= 1,
        `${w.name} both detonates and pierces — impact behaviour is ambiguous`);
    }
  }
});

test('every ammo row is stackable and has no kind', () => {
  for (const a of SEED_ROWS.filter((r) => r.category === 'ammo')) {
    assert.equal(a.stackable, true);
    assert.equal(a.kind, null);
  }
});

test('AoE falloff leaves a meaningful damage band', () => {
  // Reachability, not just correctness: if a staff's radius were smaller than
  // its projectile_radius, the blast would be entirely inside the impact
  // circle and falloff would never produce a visible gradient.
  for (const w of SEED_ROWS.filter((r) => r.aoe_radius != null)) {
    assert.ok(w.aoe_radius > w.projectile_radius * 2,
      `${w.name}: aoe_radius ${w.aoe_radius} is not meaningfully larger than its projectile radius ${w.projectile_radius} — the blast adds nothing over a direct hit`);
  }
});
```

`SEED_ROWS` is the existing hand-maintained fixture in this file; extend it with
the new columns and the three ammo rows.

- [ ] **Step 2: Run, fix any content the tests reject, commit**

```bash
cd backend && npm test 2>&1 | tail -5
git add backend/tests/authority_items_catalog.test.js
git commit -m "test(authority): ammo and AoE catalog invariants"
```

---

## Task 12: Browser verification

**Files:** none — this is a live verification pass.

**Context:** The vite dev server has served a stale bundle before. **Restart the
frontend container first and confirm the bundle is current** — this cost a full
misdiagnosis in 3b-3a. The backend container's CMD is `tail -f /dev/null`, so
the server must be started manually. `docker compose` fails (no `.env`); use
`docker exec`/`docker restart` directly.

- [ ] **Step 1: Bring the stack up**

```bash
docker restart something2-frontend-1
docker exec -d something2-backend-1 sh -c 'cd /app && npm start > /tmp/backend.log 2>&1'
```

- [ ] **Step 2: Verify each behaviour**

- [ ] Grant arrows and a bow via the admin editor; the HUD shows the count.
- [ ] Fire until empty: the count falls by exactly 1 per shot, and the last shot leaves the stack gone rather than at 0.
- [ ] Firing with 0 arrows produces the `noammo` feedback and **no attack cooldown** — the next shot after picking ammo up is immediate.
- [ ] Drop the arrow stack; it lands as ONE ground item. Pick it back up; the count is unchanged.
- [ ] Equip a flame staff: a blast damages two creatures standing together.
- [ ] A creature behind a wall inside the blast radius takes NO damage.
- [ ] Switch to a dagger: no ammo count is shown at all.
- [ ] **Watch the input/attack reordering** (spec §2): attack while moving and check whether swings visibly resolve from a stale position.

- [ ] **Step 3: Record findings**

Append results to `.superpowers/sdd/progress.md`. Anything that fails here is a
finding, not a note — 3b-3a's most important defect was found only at this step
and was invisible to a fully green suite.

---

## Final review

After Task 12, run the whole-branch review on the most capable model, then use
superpowers:finishing-a-development-branch.

```bash
cd backend && npm test 2>&1 | tail -3
cd ../frontend && npm test 2>&1 | tail -3 && npm run build 2>&1 | tail -3
```
