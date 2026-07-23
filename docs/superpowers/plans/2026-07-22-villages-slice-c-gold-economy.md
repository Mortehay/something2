# Villages Slice C — Gold Economy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hostile creatures drop a gold ground-item scaled by toughness; picking it up credits an account-wide `users.gold` wallet (not the inventory), and the client HUD shows the balance.

**Architecture:** Gold is a seeded `item_types` row, so it flows through the existing world_items → drop → pickup machinery. `spawnDrops` additionally spawns one gold ground-item per creature death when the creature's `gold_max > 0`. Pickup routes gold to a NEW dedicated atomic claim path (`claimGold`, which credits `users.gold` instead of `player_items`) — the well-tested `claimItem` path is left untouched. The wallet is loaded at join, mirrored on the player as `p.gold`, sent to the owner in the `joined` frame, and updated via a private `wallet` message on credit.

**Tech Stack:** Node/Express, `node-pg-migrate`, `node:test` (backend), Postgres; React + canvas HUD (frontend). WS authority in `backend/src/authority`.

## Global Constraints

- Reserved gold item type: an `item_types` row named EXACTLY `gold`, `category = 'currency'`, `stackable = true`, `damage = 0` (damage is NOT NULL with no default). Seeded idempotently (`ON CONFLICT (name) DO NOTHING`). Resolved to its id at world load by name.
- `users.gold`: `integer NOT NULL DEFAULT 0`. Account-wide, like `player_items`. Never negative.
- `entity_types.gold_min` / `gold_max`: `integer NOT NULL DEFAULT 0`. `gold_max = 0` ⇒ that creature drops no gold. Guards (`faction = 'guard'`) stay 0.
- Gold is scaled by toughness via DATA (the columns), not a hardcoded hp formula. The migration seeds a starting range on existing hostile creatures derived from hp; the values are then designer-tunable.
- Gold drops as ONE ground-item carrying the whole amount in `world_items.quantity` (a coin pile), NOT N one-gold items.
- Determinism: gold quantity is rolled with the SAME rng instance already threaded through `spawnDrops` (no `Math.random` in the drop path). Roll gold AFTER the normal drop rolls so adding gold does not shift the item drops' rng draws… actually it MUST NOT change existing item drops — see Task 3's ordering note.
- Wallet is PRIVATE: sent only to the owning socket (in `joined` and in `wallet` messages). Do NOT add gold to the broadcast players snapshot in `world.js`.
- `users.gold` is the source of truth; every credit is write-through (`UPDATE users SET gold = gold + $ RETURNING gold`) and the returned balance is mirrored to `p.gold`. Death does not touch gold (`resolveDeaths` unchanged).
- Migration filename: next monotonic timestamp after `1714440030000` → **`1714440031000_gold_economy.js`**.
- Do NOT add merchant tables/columns (Slice D).

---

### Task 1: Migration — wallet, per-creature gold range, and the gold item type

**Files:**
- Create: `backend/migrations/1714440031000_gold_economy.js`

**Interfaces:**
- Produces: `users.gold` (int NOT NULL DEFAULT 0); `entity_types.gold_min`/`gold_max` (int NOT NULL DEFAULT 0); an `item_types` row named `gold`; a starting gold range on existing hostile creature types.

- [ ] **Step 1: Write the migration**

```js
// backend/migrations/1714440031000_gold_economy.js
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('users', {
    gold: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.addColumns('entity_types', {
    gold_min: { type: 'integer', notNull: true, default: 0 },
    gold_max: { type: 'integer', notNull: true, default: 0 },
  });
  // Gold is a new item CATEGORY. item_types.category has a CHECK limiting it to
  // weapon/armor/ammo, so widen it to admit 'currency' before seeding the row.
  // (The per-category field checks — weapon_fields/armor_fields/ammo_fields —
  // are all `category <> 'X' OR ...`, so a currency row trips none of them.)
  pgm.dropConstraint('item_types', 'item_types_category_check');
  pgm.addConstraint('item_types', 'item_types_category_check', {
    check: "category IN ('weapon','armor','ammo','currency')",
  });
  // The reserved currency item type. name/damage/category/cooldown are NOT NULL
  // with no usable default, so they're set explicitly. Rendered by name client-side.
  pgm.sql(
    `INSERT INTO item_types (name, category, damage, cooldown, stackable)
     VALUES ('gold', 'currency', 0, 0, true)
     ON CONFLICT (name) DO NOTHING`
  );
  // Starting, toughness-scaled gold range for existing HOSTILE creatures; then
  // designer-tunable. Guards (faction='guard') and non-creatures stay 0.
  pgm.sql(
    `UPDATE entity_types
        SET gold_min = GREATEST(1, floor(hp / 10.0))::int,
            gold_max = GREATEST(GREATEST(1, floor(hp / 10.0))::int, floor(hp / 4.0)::int)
      WHERE is_creature = true AND faction = 'hostile'`
  );
};

exports.down = (pgm) => {
  // Delete the gold row BEFORE narrowing the constraint back, or the restored
  // check would fail on the still-present 'currency' row.
  pgm.sql("DELETE FROM item_types WHERE name = 'gold'");
  pgm.dropConstraint('item_types', 'item_types_category_check');
  pgm.addConstraint('item_types', 'item_types_category_check', {
    check: "category IN ('weapon','armor','ammo')",
  });
  pgm.dropColumns('entity_types', ['gold_min', 'gold_max']);
  pgm.dropColumns('users', ['gold']);
};
```

- [ ] **Step 2: Run the migration up**

Run: `cd backend && DATABASE_URL="postgres://user:password@localhost:15432/game_db" npm run migrate:up`
Expected: `1714440031000_gold_economy` applied, no error.

- [ ] **Step 3: Verify schema + seed via psql**

Run:
```bash
docker exec something2-db-1 psql -U user -d game_db \
  -c "SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='gold';" \
  -c "SELECT name, category, stackable, damage FROM item_types WHERE name='gold';" \
  -c "SELECT name, faction, hp, gold_min, gold_max FROM entity_types WHERE is_creature=true ORDER BY faction, name;"
```
Expected: `users.gold` exists; one `gold | currency | t | 0` item; every hostile creature has `gold_min >= 1` and `gold_max >= gold_min`; the `Village Guard` (guard) row has `gold_min = 0, gold_max = 0`.

- [ ] **Step 4: Verify down reverses, then re-apply up**

Run: `cd backend && DATABASE_URL="postgres://user:password@localhost:15432/game_db" npm run migrate down && DATABASE_URL="postgres://user:password@localhost:15432/game_db" npm run migrate:up`
Expected: clean down (drops columns + gold item) then up. (`package.json` has no `migrate:down` script — use `npm run migrate down`.)

- [ ] **Step 5: Run the full backend suite to catch any invariant that reacts to the new item/columns**

Run: `cd backend && node --test "tests/**/*.test.js"`
Expected: all pass. In particular, the item-catalog invariant test (`item_types_db.test.js` or similar — find it with `ls tests | grep -i item`) may assert the catalog matches a `SEED_ROWS` fixture; a new `gold` row could break it. If so, that is a REAL signal, not noise: update the fixture to include `gold` (the same way Slice B scoped the drops invariant), and note it. Do NOT skip or weaken the test.

- [ ] **Step 6: Commit**

```bash
git add backend/migrations/1714440031000_gold_economy.js backend/tests/
git commit -m "feat(db): users.gold wallet, entity gold range, gold item type"
```

---

### Task 2: Load the gold catalog id + per-creature gold range + the wallet at join

**Files:**
- Modify: `backend/src/authority/items.js` (`resolveGoldItemTypeId`)
- Modify: `backend/src/authority/creatures.js` (`loadCreatureTypes` returns a `creatureGold` map)
- Modify: `backend/src/authority/world.js` (`addPlayer` accepts + stores `gold`)
- Modify: `backend/src/authority/server.js` (`loadWorld` resolves `entry.goldItemTypeId` + `entry.creatureGold`; join loads `users.gold`, passes it to `addPlayer`, sends it in `joined`)
- Test: `backend/tests/goldLoad.test.js`

**Interfaces:**
- Consumes: Task 1's columns + gold item type.
- Produces:
  - `resolveGoldItemTypeId(itemTypes)` (items.js, exported) → the numeric id of the `gold` item type, or `null`. (`itemTypes` is the Map from `loadItemTypes`.)
  - `loadCreatureTypes(pool)` additionally returns `creatureGold` = `Map<name, { min, max }>` (SELECT gains `gold_min, gold_max`).
  - `addPlayer(userId, spawn, inv, respawn, gold = 0)` — sim player carries `gold` (a number). Every existing field unchanged.
  - `entry.goldItemTypeId` (number|null) and `entry.creatureGold` (Map) set in `loadWorld`.
  - `joined` frame carries `gold: <number>`.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/goldLoad.test.js
const test = require('node:test');
const assert = require('node:assert');
const { loadCreatureTypes } = require('../src/authority/creatures');
const { resolveGoldItemTypeId } = require('../src/authority/items');

test('resolveGoldItemTypeId finds the gold item type by name', () => {
  const itemTypes = new Map([
    [1, { id: 1, name: 'dagger' }],
    [7, { id: 7, name: 'gold' }],
  ]);
  assert.equal(resolveGoldItemTypeId(itemTypes), 7);
  assert.equal(resolveGoldItemTypeId(new Map([[1, { id: 1, name: 'dagger' }]])), null);
});

test('loadCreatureTypes returns a name->gold-range map from gold_min/gold_max', async () => {
  let sql = '';
  const pool = { query: async (q) => { sql = q; return { rows: [
    { id: 1, name: 'Slime', color: '#0f0', hp: 10, defense: 0, resistances: {}, faction: 'hostile', gold_min: 1, gold_max: 3 },
    { id: 2, name: 'Village Guard', color: '#3f6fb5', hp: 300, defense: 10, resistances: {}, faction: 'guard', gold_min: 0, gold_max: 0 },
  ] }; } };
  const { creatureGold } = await loadCreatureTypes(pool);
  assert.match(sql, /gold_min/, 'SELECT must include gold_min/gold_max — omitting them loads undefined and drops no gold');
  assert.deepEqual(creatureGold.get('Slime'), { min: 1, max: 3 });
  assert.deepEqual(creatureGold.get('Village Guard'), { min: 0, max: 0 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/goldLoad.test.js`
Expected: FAIL — `resolveGoldItemTypeId` / `creatureGold` not present.

- [ ] **Step 3: Add `resolveGoldItemTypeId` to `items.js`**

Near `resolveDefaultWeaponId`:

```js
// The reserved currency item type's id, resolved by name from the loaded
// catalog. null if the migration that seeds it hasn't run.
function resolveGoldItemTypeId(itemTypes) {
  for (const t of itemTypes.values()) if (t.name === 'gold') return t.id;
  return null;
}
```

Add `resolveGoldItemTypeId` to `module.exports`.

- [ ] **Step 4: Add the gold range to `loadCreatureTypes`**

Extend the SELECT and build the map:

```js
async function loadCreatureTypes(pool) {
  const r = await pool.query(
    `SELECT id, name, color, hp, defense, resistances, faction, gold_min, gold_max
     FROM entity_types WHERE is_creature = true ORDER BY id ASC`,
  );
  const creatureTypes = r.rows.map((row) => ({
    name: row.name,
    hp: row.hp,
    color: row.color,
    faction: row.faction || 'hostile',
    ...creatureMitigation(row),
  }));
  const hostileCreatureTypes = creatureTypes.filter((t) => (t.faction || 'hostile') !== 'guard');
  const creatureTypeIds = new Map(r.rows.map((row) => [row.name, row.id]));
  const creatureGold = new Map(r.rows.map((row) => [row.name, {
    min: Number(row.gold_min) || 0,
    max: Number(row.gold_max) || 0,
  }]));
  return { creatureTypes, hostileCreatureTypes, creatureTypeIds, creatureGold };
}
```

(Keep whatever the current return shape is — this adds `creatureGold` alongside the existing `hostileCreatureTypes` from Slice B. Confirm all destructuring call sites still work.)

- [ ] **Step 5: Add `gold` to `addPlayer`**

In `world.js`, extend the signature and add the field (leave every other field byte-identical):

```js
  addPlayer(userId, spawn, inv = { items: [], equipment: {} }, respawn = spawn, gold = 0) {
    this.players.set(userId, {
      // ... unchanged fields ...
      spawn: { x: respawn.x, y: respawn.y },
      gold: Number(gold) || 0,
      // ... rest unchanged ...
    });
  }
```

- [ ] **Step 6: Wire the load + join in `server.js`**

In `loadWorld`, after `const itemTypes = await loadItemTypes(pool);` and the creature-types load:

```js
      const goldItemTypeId = resolveGoldItemTypeId(itemTypes);
      const { creatureTypes, creatureTypeIds, hostileCreatureTypes, creatureGold } = await loadCreatureTypes(pool);
```

Add `goldItemTypeId` and `creatureGold` to the `entry` object. Import `resolveGoldItemTypeId` from `./items` (add to the existing destructure).

In the join handler, load the wallet and thread it through. After the inventory is finalized (the `let inv = await loadInventory(...)` block) and before/at `addPlayer`:

```js
          const gr = await pool.query('SELECT gold FROM users WHERE id = $1', [ws.userId]);
          const gold = gr.rows.length ? Number(gr.rows[0].gold) || 0 : 0;
```

Pass it to `addPlayer`:

```js
          entry.world.addPlayer(ws.userId, spawn, inv, spawn.respawn, gold);
```

Add `gold` to the `joined` frame object:

```js
          send(ws, {
            type: 'joined', user_id: ws.userId, spawn, tickRate: 1000 / tickMs,
            itemTypes: [...entry.world.weapons.values()],
            items: inv.items,
            equipment: inv.equipment,
            autoLoot: entry.world.getPlayer(ws.userId).autoLoot,
            gold,
          });
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd backend && node --test tests/goldLoad.test.js`
Expected: PASS (2 tests).

- [ ] **Step 8: Load-check + full suite**

Run: `cd backend && node -e "require('./src/index.js'); require('./src/authority/server.js')" && node --test "tests/**/*.test.js"`
Expected: clean require; all tests pass (destructuring of `loadCreatureTypes` in server.js still valid).

- [ ] **Step 9: Commit**

```bash
git add backend/src/authority/items.js backend/src/authority/creatures.js backend/src/authority/world.js backend/src/authority/server.js backend/tests/goldLoad.test.js
git commit -m "feat(authority): load gold item id, per-creature gold range, wallet at join"
```

---

### Task 3: Drop gold on creature death

**Files:**
- Modify: `backend/src/authority/loot.js` (`spawnDrops`; add `rollGold`)
- Test: `backend/tests/goldDrop.test.js`

**Interfaces:**
- Consumes: `entry.goldItemTypeId`, `entry.creatureGold` (Task 2).
- Produces:
  - `rollGold(range, rng)` (loot.js, exported) → integer in `[min, max]` when `max > 0`, else `0`. `range` is `{min, max}` (or undefined ⇒ 0).
  - `spawnDrops` additionally inserts ONE gold `world_items` row (`item_type_id = entry.goldItemTypeId`, `quantity = rolled amount`) at the corpse centre when the dead creature's gold range yields `> 0` and `entry.goldItemTypeId != null`.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/goldDrop.test.js
const test = require('node:test');
const assert = require('node:assert');
const { rollGold, spawnDrops } = require('../src/authority/loot');

test('rollGold returns 0 when max is 0 or range missing', () => {
  assert.equal(rollGold({ min: 0, max: 0 }, () => 0.9), 0);
  assert.equal(rollGold(undefined, () => 0.9), 0);
});

test('rollGold returns an integer in [min,max], monotonic in rng', () => {
  assert.equal(rollGold({ min: 2, max: 6 }, () => 0), 2);
  assert.equal(rollGold({ min: 2, max: 6 }, () => 0.999), 6);
  const v = rollGold({ min: 2, max: 6 }, () => 0.5);
  assert.ok(Number.isInteger(v) && v >= 2 && v <= 6);
});

test('spawnDrops inserts one gold world_item when the creature has a gold range', async () => {
  const inserts = [];
  const pool = { query: async (sql, params) => {
    if (/SELECT item_type_id, chance/.test(sql)) return { rows: [] }; // no item drops
    if (/INSERT INTO world_items/.test(sql)) { inserts.push(params); return { rows: [{ id: 'g1', item_type_id: params[1], x: params[2], y: params[3], quantity: params[5] }] }; }
    throw new Error('unexpected ' + sql);
  } };
  const entry = {
    worldId: 'w1',
    goldItemTypeId: 42,
    creatureTypeIds: new Map([['Slime', 1]]),
    creatureGold: new Map([['Slime', { min: 5, max: 5 }]]),
    world: { groundItems: { add: () => {} } },
  };
  await spawnDrops(pool, entry, { type: 'Slime', x: 100, y: 100 }, { rng: () => 0.5 });
  const goldIns = inserts.filter((p) => p[1] === 42);
  assert.equal(goldIns.length, 1, 'exactly one gold world_item');
  assert.equal(goldIns[0][5], 5, 'quantity equals the rolled gold amount');
});

test('spawnDrops inserts NO gold when gold_max is 0', async () => {
  const inserts = [];
  const pool = { query: async (sql, params) => {
    if (/SELECT item_type_id, chance/.test(sql)) return { rows: [] };
    if (/INSERT INTO world_items/.test(sql)) { inserts.push(params); return { rows: [{ id: 'x' }] }; }
    throw new Error('unexpected ' + sql);
  } };
  const entry = {
    worldId: 'w1', goldItemTypeId: 42,
    creatureTypeIds: new Map([['Bat', 2]]),
    creatureGold: new Map([['Bat', { min: 0, max: 0 }]]),
    world: { groundItems: { add: () => {} } },
  };
  await spawnDrops(pool, entry, { type: 'Bat', x: 0, y: 0 }, { rng: () => 0.9 });
  assert.equal(inserts.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/goldDrop.test.js`
Expected: FAIL — `rollGold` not exported; no gold insert.

- [ ] **Step 3: Add `rollGold` and the gold spawn to `loot.js`**

Add near `rollDrops`:

```js
// Gold amount for a creature death. `range` is {min,max} from entry.creatureGold.
// Returns 0 when the creature drops no gold (max 0 / missing range). Monotonic
// in rng so a higher roll never yields less, matching rollDrops' contract.
function rollGold(range, rng = Math.random) {
  const max = Math.max(0, Math.floor((range && range.max) || 0));
  if (max <= 0) return 0;
  const min = Math.max(0, Math.min(max, Math.floor((range && range.min) || 0)));
  return min + Math.floor(rng() * (max - min + 1));
}
```

In `spawnDrops`, AFTER the existing item-drop loop (so it does not change the rng draws that determine the item drops), append the gold spawn. Reuse the same `dropX`/`dropY`:

```js
  // Gold: one coin-pile ground item carrying the whole amount, when this
  // creature type has a gold range and the currency type exists.
  const goldAmt = rollGold(entry.creatureGold && entry.creatureGold.get(dead.type), rng);
  if (goldAmt > 0 && entry.goldItemTypeId != null) {
    const gi = await pool.query(
      `INSERT INTO world_items (world_id, item_type_id, x, y, expires_at, quantity)
       VALUES ($1, $2, $3, $4, now() + ($5::int * interval '1 millisecond'), $6)
       RETURNING id, item_type_id, x, y, expires_at, quantity`,
      [entry.worldId, entry.goldItemTypeId, dropX, dropY, ttlMs, goldAmt],
    );
    entry.world.groundItems.add(gi.rows);
  }
```

Add `rollGold` to `module.exports`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/goldDrop.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the loot regression suite**

Run: `cd backend && node --test tests/loot.test.js` (and any other file matching `ls tests | grep -iE "loot|drop"` — run them all)
Expected: PASS — the existing item-drop behavior is unchanged (gold is appended after, so item-drop rng draws are identical).

- [ ] **Step 6: Commit**

```bash
git add backend/src/authority/loot.js backend/tests/goldDrop.test.js
git commit -m "feat(authority): drop a gold ground-item scaled by the creature's gold range"
```

---

### Task 4: Credit the wallet on gold pickup

**Files:**
- Modify: `backend/src/authority/loot.js` (`claimGold`)
- Modify: `backend/src/authority/server.js` (route gold pickups in the `pickup` handler + the auto-loot tick; send a `wallet` message)
- Test: `backend/tests/claimGold.test.js`

**Interfaces:**
- Consumes: `entry.goldItemTypeId` (Task 2).
- Produces:
  - `claimGold(pool, entry, userId, groundItemId)` (loot.js, exported) → `{ gold }` (the new balance) on success, or `null` if the row was already gone (lost race). Atomic: deletes the `world_items` row and `UPDATE users SET gold = gold + quantity` in one statement. Removes the ground item from the sim and updates `p.gold`. Uses the same `entry.claiming` guard as `claimItem`.
  - The `pickup` handler and the auto-loot tick route a ground item whose `item_type_id === entry.goldItemTypeId` to `claimGold` (sending `{ type: 'wallet', gold }` to the owner) instead of `claimItem`.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/claimGold.test.js
const test = require('node:test');
const assert = require('node:assert');
const { claimGold } = require('../src/authority/loot');

function entryWith(player) {
  const removed = [];
  return {
    claiming: new Set(),
    world: {
      groundItems: { remove: (id) => removed.push(id) },
      getPlayer: () => player,
    },
    _removed: removed,
  };
}

test('claimGold credits users.gold atomically and updates p.gold', async () => {
  const player = { gold: 10 };
  const entry = entryWith(player);
  const pool = { query: async (sql, params) => {
    assert.match(sql, /DELETE FROM world_items/, 'must delete the ground row');
    assert.match(sql, /UPDATE users SET gold = gold \+/, 'must credit the wallet');
    assert.deepEqual(params, ['g1', 'u1']);
    return { rowCount: 1, rows: [{ gold: 15 }] };
  } };
  const got = await claimGold(pool, entry, 'u1', 'g1');
  assert.deepEqual(got, { gold: 15 });
  assert.equal(player.gold, 15, 'in-memory wallet mirrors the DB');
  assert.deepEqual(entry._removed, ['g1'], 'ground item evicted from the sim');
});

test('claimGold returns null on a lost race (row already gone) and evicts the stale sim row', async () => {
  const entry = entryWith({ gold: 0 });
  const pool = { query: async () => ({ rowCount: 0, rows: [] }) };
  const got = await claimGold(pool, entry, 'u1', 'g1');
  assert.equal(got, null);
  assert.deepEqual(entry._removed, ['g1']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/claimGold.test.js`
Expected: FAIL — `claimGold` not exported.

- [ ] **Step 3: Add `claimGold` to `loot.js`**

Model it on `claimItem` — same `claiming` guard, one atomic statement, sim eviction:

```js
// Gold pickup: the currency path parallel to claimItem. One statement DELETEs
// the world_items row and credits users.gold, so there is no window where the
// row is gone but the wallet hasn't moved. rowCount === 1 means THIS call both
// removed the row and credited it; 0 means it lost the race (already claimed or
// swept) and nothing was credited. Returns the NEW balance so the caller can
// push a wallet update to the owner.
async function claimGold(pool, entry, userId, groundItemId) {
  if (entry.claiming.has(groundItemId)) return null;
  entry.claiming.add(groundItemId);
  try {
    const r = await pool.query(
      `WITH d AS (DELETE FROM world_items WHERE id = $1 RETURNING quantity)
       UPDATE users SET gold = gold + (SELECT quantity FROM d)
       WHERE id = $2 AND EXISTS (SELECT 1 FROM d)
       RETURNING gold`,
      [groundItemId, userId],
    );
    entry.world.groundItems.remove(groundItemId);
    if (r.rowCount !== 1) return null;
    const gold = Number(r.rows[0].gold) || 0;
    const p = entry.world.getPlayer(userId);
    if (p) p.gold = gold;
    return { gold };
  } finally {
    entry.claiming.delete(groundItemId);
  }
}
```

Add `claimGold` to `module.exports`.

- [ ] **Step 4: Route gold in the `pickup` handler**

In `server.js`, import `claimGold` (add to the existing `require('./loot')` destructure). In the `pickup` handler, where it currently does `const target = entry.world.groundItems.nearest(...)` then `claimItem`, branch on the type:

```js
            const target = entry.world.groundItems.nearest(cx, cy, PICKUP_RADIUS);
            if (!target) { /* keep existing no-target behavior */ }
            else if (target.item_type_id === entry.goldItemTypeId) {
              const got = await claimGold(pool, entry, ws.userId, target.id);
              if (got) send(ws, { type: 'wallet', gold: got.gold });
            } else {
              const got = await claimItem(pool, entry, ws.userId, target.id);
              if (got) send(ws, { type: 'picked', item: got });
            }
```

(Match the ACTUAL existing structure of the handler — read it first. The point is: gold → `claimGold` + `wallet` message; everything else → `claimItem` + `picked`, exactly as today.)

- [ ] **Step 5: Route gold in the auto-loot tick**

In the auto-loot scan (~line 651-676), where it currently pushes `claimItem(...)` promises and sends `picked`, route gold items to `claimGold` and send `wallet`. Keep the `dropGraceActive` check for both. A minimal, correct shape:

```js
        for (const it of entry.world.groundItems.within(pcx, pcy, PICKUP_RADIUS)) {
          if (dropGraceActive(p, it.id, autoLootNow)) continue;
          if (it.item_type_id === entry.goldItemTypeId) {
            claims.push(claimGold(pool, entry, p.userId, it.id).then((g) => g && { wallet: g.gold }));
          } else {
            claims.push(claimItem(pool, entry, p.userId, it.id).then((item) => item && { item }));
          }
        }
```

and where the results are sent, distinguish the two:

```js
            if (r.status === 'fulfilled' && r.value) {
              if (r.value.wallet != null) send(sock, { type: 'wallet', gold: r.value.wallet });
              else send(sock, { type: 'picked', item: r.value.item });
            }
```

(Adapt to the real code — read the auto-loot block first and preserve its existing settle/`Promise.allSettled` structure and the per-player socket lookup. The ONLY change is routing gold to `claimGold` + a `wallet` message.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && node --test tests/claimGold.test.js`
Expected: PASS (2 tests).

- [ ] **Step 7: Full suite + load check**

Run: `cd backend && node -e "require('./src/authority/server.js')" && node --test "tests/**/*.test.js"`
Expected: clean require; all pass. The existing pickup/auto-loot tests must still pass (non-gold path unchanged).

- [ ] **Step 8: Commit**

```bash
git add backend/src/authority/loot.js backend/src/authority/server.js backend/tests/claimGold.test.js
git commit -m "feat(authority): credit users.gold on gold pickup (keypress + auto-loot)"
```

---

### Task 5: Client wallet + HUD

**Files:**
- Modify: `frontend/src/games/something2/src/js/net/WorldAuthorityClient.js` (`onWallet` + `case 'wallet'`)
- Modify: `frontend/src/games/something2/src/js/core/Game.js` (track `this.gold`; set from `joined`; update from `wallet`; thread into render)
- Modify: `frontend/src/games/something2/src/js/systems/RenderSystem.js` (HUD gold line)
- Test: `frontend/src/games/something2/src/js/net/__tests__/` (a WorldAuthorityClient wallet-dispatch test if the harness supports it; otherwise build + existing suite)

**Interfaces:**
- Consumes: the backend `joined.gold` and `{type:'wallet', gold}` messages.
- Produces: the HUD shows `Gold: <n>`; `this.gold` updates live on pickup.

- [ ] **Step 1: Add `onWallet` to the client**

In `WorldAuthorityClient.js`, add `onWallet` to the constructor destructure + default (mirror `onPicked`), and a case:

```js
      case 'wallet': this.onWallet(msg); break;
```

with `this.onWallet = onWallet || (() => {});` in the constructor.

- [ ] **Step 2: Write a failing dispatch test (if the net test harness exists)**

Look for existing `WorldAuthorityClient` tests (`ls frontend/src/games/something2/src/js/net/__tests__/`). If there is one, add:

```js
test('a wallet message invokes onWallet with the new balance', () => {
  let seen = null;
  const c = new WorldAuthorityClient({ url: 'ws://x', token: 't', onWallet: (m) => { seen = m.gold; } });
  c._handleMessage({ type: 'wallet', gold: 42 });
  assert.equal(seen, 42);
});
```

Run it, confirm RED (no `onWallet` dispatch), then it passes after Step 1. If NO net test harness exists, skip this step and rely on build + the existing suite (document that).

- [ ] **Step 3: Track gold in `Game.js`**

Add `this.gold = 0;` where the other per-join state is initialized (near `this.autoLoot = false;` — both the constructor init and the re-join reset). In `onJoined`:

```js
                onJoined: (msg) => {
                    applyJoined(this.inventory, msg);
                    this.autoLoot = msg.autoLoot === true;
                    this.gold = Number(msg.gold) || 0;
                    // ... rest unchanged ...
                },
```

Add the wallet handler alongside `onPicked`:

```js
                onWallet: (msg) => { this.gold = Number(msg.gold) || 0; },
```

- [ ] **Step 4: Thread `gold` into the render call**

Find where `Game` calls `renderSystem.render({...})` (it already passes `mana`, `stamina`, etc.). Add `gold: this.gold` to that options object.

- [ ] **Step 5: Draw the gold line in the HUD**

In `RenderSystem.render`'s destructure (~line 98-99) add `gold = null,` and pass it to `renderHud`. In `renderHud`'s signature add `gold = null`, and after the MP/SP lines are pushed:

```js
    if (gold != null) lines.push(`Gold: ${gold}`);
```

- [ ] **Step 6: Build + test**

Run: `cd frontend && npm run build && npm test`
Expected: build succeeds; existing suite passes (plus the new net test if added).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/games/something2/src/js/net/WorldAuthorityClient.js frontend/src/games/something2/src/js/core/Game.js frontend/src/games/something2/src/js/systems/RenderSystem.js frontend/src/games/something2/src/js/net/__tests__/
git commit -m "feat(client): gold wallet HUD + wallet message handling"
```

---

## Final runtime verification (whole-slice, after all tasks)

Bring up the stack and restart the backend node (NOT `docker restart`):
```bash
docker start something2-db-1 something2-backend-1
docker exec something2-backend-1 sh -c 'pkill -f "node src/index.js"; sleep 2'
docker exec -d something2-backend-1 sh -c 'cd /app && node src/index.js > /tmp/backend.log 2>&1'
```

With an admin token + a WS client:
1. Note the admin user's `users.gold` before.
2. Join a bounded world with hostile creatures; kill a hostile (or plant one at low hp and let it die), and confirm a gold `world_items` row spawns at the corpse with `quantity` in the creature's `[gold_min, gold_max]` range.
3. Walk over the gold (or auto-loot) → confirm the server sends `{type:'wallet', gold}`, the ground row is gone, `users.gold` increased by exactly the pile's quantity, and **inventory (`player_items`) is unchanged** (gold did NOT become an item).
4. Confirm the `joined` frame on a fresh join carries the updated `gold`.
5. Confirm a NORMAL item drop still goes to inventory (regression) and a normal pickup still sends `picked`.

---

## Self-Review

**Spec coverage** (Slice C section of `2026-07-22-villages-economy-design.md`):
- `users.gold` wallet, loaded at join, on the player, sent in `joined`, persisted write-through → Tasks 1, 2, 4. ✅
- Gold drops as a ground-item scaled by `gold_min/gold_max` columns (toughness via data) → Tasks 1, 3. ✅
- Pickup of a gold item credits the wallet instead of inventory → Task 4. ✅
- HUD shows the balance → Task 5. ✅
- Determinism (same rng, no `Math.random` in the drop path) → Task 3. ✅
- Private wallet (owner only, not the broadcast snapshot) → Tasks 2, 4. ✅

**Placeholder scan:** none — every code step carries complete code.

**Type consistency:** `resolveGoldItemTypeId` (Task 2) → `entry.goldItemTypeId` consumed in Tasks 3/4. `creatureGold` Map<name,{min,max}> (Task 2) → `rollGold` (Task 3). `claimGold` returns `{gold}` (Task 4) → `wallet` message → client `onWallet` (Task 5). `addPlayer`'s 5th param `gold` (Task 2) consistent with the join call site. The `wallet` message shape `{type:'wallet', gold}` is identical across Task 4 (send) and Task 5 (receive).

**Known deliberate scope:** no gold-loss-on-death penalty; gold stacks as one pile per kill (not per-coin); no merchant (Slice D). Documented, not gaps.
