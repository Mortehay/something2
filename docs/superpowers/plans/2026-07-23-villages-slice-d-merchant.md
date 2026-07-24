# Villages Slice D — Merchant & Buyback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each village has a merchant NPC that sells a base catalog for gold and buys player equipment; sold items are held as buyback stock for 3 days at the sold price and can be repurchased.

**Architecture:** The merchant is a *position* (`villages.merchant_x/merchant_y`), not a sim entity — sent once in the `joined` frame and drawn as one extra depth-sorted drawable. Stock lives in a new `merchant_stock` table: base-catalog rows (`seller_user_id IS NULL`, never consumed, never expire) and buyback rows (`seller_user_id` set, consumed on purchase, expire after 3 days). Three new WS messages (`interact`/`buy`/`sell`) follow the existing `drop` handler shape exactly: wire-validate → `ws._opChain` serialize → try/catch → reply or `error`. Gold moves through atomic guarded UPDATEs so there is no overdraft and no read-modify-write race.

**Tech Stack:** Node/Express, `node-pg-migrate`, `node:test` (+ the real-ws/fake-pool integration harness), Postgres; React + canvas client.

## Global Constraints

- **Item value:** new column `item_types.value` (`integer NOT NULL DEFAULT 0`). It is the item's base gold worth. Buy price (base catalog) = `value`. Sell price = `floor(value / 2)`. Buyback price = the sell price it was sold at (stored on the row). Items with `value <= 0` are NOT sellable and never enter the base catalog.
- **`SELL_FRACTION = 0.5`, `BUYBACK_DAYS = 3`, `INTERACT_RADIUS = 120`** (px) — export them as named constants, never inline.
- **Base-catalog rows are NOT consumed on purchase** (a shop always stocks a dagger); **buyback rows ARE deleted on purchase** (unique instances). This is the one rule the spec left ambiguous ("delete/decrement") — resolved here.
- Expired buyback rows are filtered on read (`expires_at IS NULL OR expires_at > now()`) and swept lazily (`DELETE ... WHERE expires_at < now()`) when a shop is opened. No cron.
- Every new WS handler MUST mirror `drop` (`server.js:563-578`): world lookup + bail, wire-type validation before any mutation, `ws._opChain = (ws._opChain || Promise.resolve()).then(async () => {...})` serialization, a try/catch inside (an unhandled rejection out of an async ws handler **crashes the Node process**), and `send(ws, {...})` / `send(ws, {type:'error', message})`.
- **Gold moves atomically.** Debit: `UPDATE users SET gold = gold - $2 WHERE id = $1 AND gold >= $2 RETURNING gold` (0 rows ⇒ insufficient funds, no overdraft). Credit: `UPDATE users SET gold = gold + $2 WHERE id = $1 RETURNING gold`. Never `SET gold = <in-memory value>`. After any change, mirror to `p.gold` and `send(ws, {type:'wallet', gold})`.
- **In-memory inventory must be kept in sync**: buying pushes to `p.inv.items`, selling filters it out — the same discipline `claimItem`/`dropItem` already follow, or a later equip validates against stale state.
- **Ownership is enforced by the SQL predicate**: `DELETE FROM player_items WHERE id = $1 AND user_id = $2` — a forged itemId deletes nothing.
- An **equipped** item must not be sellable (mirror `dropItem`'s guard: reject if the id appears in `p.inv.equipment`).
- Migration filename: next monotonic timestamp after `1714440031000` → **`1714440032000_merchant_stock.js`**.
- `package.json` has NO `migrate:down` script — reverse with `npm run migrate down`.
- Test-harness trap (from the existing integration tests): the fake pool matches SQL by regex, and `claimGold`'s CTE also contains `UPDATE users SET gold` — **order specific regexes before generic ones**.

---

### Task 1: Migration — item value, merchant position, merchant_stock

**Files:**
- Create: `backend/migrations/1714440032000_merchant_stock.js`

**Interfaces:**
- Produces: `item_types.value` (int NOT NULL DEFAULT 0, seeded); `villages.merchant_x`/`merchant_y` (real NULL); table `merchant_stock`.

- [ ] **Step 1: Write the migration**

```js
// backend/migrations/1714440032000_merchant_stock.js
exports.shorthands = undefined;

exports.up = (pgm) => {
  // An item's base gold worth. Buy = value, sell = floor(value/2).
  pgm.addColumns('item_types', {
    value: { type: 'integer', notNull: true, default: 0 },
  });
  // Starting, tunable values derived from what an item actually does.
  // Currency (gold) stays 0 so it can never be sold to a merchant.
  pgm.sql(`UPDATE item_types SET value = 10 + (damage * 2)::int WHERE category = 'weapon'`);
  pgm.sql(`UPDATE item_types SET value = 10 + (COALESCE(defense,0) * 3)::int WHERE category = 'armor'`);
  pgm.sql(`UPDATE item_types SET value = 2 WHERE category = 'ammo'`);
  pgm.sql(`UPDATE item_types SET value = 0 WHERE category = 'currency'`);

  pgm.addColumns('villages', {
    merchant_x: { type: 'real' },
    merchant_y: { type: 'real' },
  });

  pgm.createTable('merchant_stock', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    world_id: { type: 'uuid', notNull: true, references: 'worlds', onDelete: 'CASCADE' },
    village_id: { type: 'uuid', notNull: true, references: 'villages', onDelete: 'CASCADE' },
    item_type_id: { type: 'integer', notNull: true, references: 'item_types', onDelete: 'CASCADE' },
    price: { type: 'integer', notNull: true },
    // NULL = base catalog (infinite, never expires). Set = a player buyback row.
    seller_user_id: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    expires_at: { type: 'timestamptz' },
    quantity: { type: 'integer', notNull: true, default: 1 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('merchant_stock', 'village_id');
};

exports.down = (pgm) => {
  pgm.dropTable('merchant_stock');
  pgm.dropColumns('villages', ['merchant_x', 'merchant_y']);
  pgm.dropColumns('item_types', ['value']);
};
```

- [ ] **Step 2: Run the migration up**

Run: `cd backend && DATABASE_URL="postgres://user:password@localhost:15432/game_db" npm run migrate:up`
Expected: applied, no error.

- [ ] **Step 3: Verify schema + seeded values**

Run:
```bash
docker exec something2-db-1 psql -U user -d game_db \
  -c "\d merchant_stock" \
  -c "SELECT column_name FROM information_schema.columns WHERE table_name='villages' AND column_name LIKE 'merchant%';" \
  -c "SELECT name, category, damage, defense, value FROM item_types ORDER BY category, name LIMIT 15;" \
  -c "SELECT category, min(value), max(value) FROM item_types GROUP BY category;"
```
Expected: `merchant_stock` exists with the columns above; `villages.merchant_x/merchant_y` present; weapons/armor have `value > 0`; `gold` (currency) has `value = 0`.

- [ ] **Step 4: Verify down reverses, then re-apply up**

Run: `cd backend && DATABASE_URL="postgres://user:password@localhost:15432/game_db" npm run migrate down && DATABASE_URL="postgres://user:password@localhost:15432/game_db" npm run migrate:up`
Expected: clean down then up.

- [ ] **Step 5: Run the FULL backend suite**

Run: `cd backend && node --test "tests/**/*.test.js"`
Expected: all pass (currently 592). A catalog invariant test may pin `item_types` columns or a `SEED_ROWS` fixture — if the new `value` column breaks it, that is a REAL signal: update the fixture (do NOT weaken/skip it) and explain in your report.

- [ ] **Step 6: Commit**

```bash
git add backend/migrations/1714440032000_merchant_stock.js backend/tests/
git commit -m "feat(db): item value, village merchant position, merchant_stock table"
```

---

### Task 2: Merchant position helper + village wiring

**Files:**
- Modify: `backend/src/services/mapService.js` (add `villageMerchantPost`)
- Modify: `backend/src/services/villages.js` (`fetchVillages` returns `merchantX`/`merchantY`)
- Modify: `backend/src/index.js` (village-create sets the merchant position; seeds the base catalog — see Task 3 for the seeding helper)
- Test: `backend/tests/villageMerchantPost.test.js`

**Interfaces:**
- Consumes: the village shape `{minRow,minCol,width,height,gateEdge}`; `villageGatePosts` (Slice B) for reference.
- Produces:
  - `villageMerchantPost(v)` (mapService, exported) → `{x, y}` — the pixel centre of an interior tile near the gate, one tile deeper than the guard posts, on the gate's centre line, clamped into the interior.
  - `fetchVillages` rows gain `merchantX`, `merchantY` (numbers or null).

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/villageMerchantPost.test.js
const test = require('node:test');
const assert = require('node:assert');
const { villageMerchantPost } = require('../src/services/mapService');

const V = (over = {}) => ({ minRow: 5, minCol: 5, width: 8, height: 6, gateEdge: 'S', ...over });

test('S gate: merchant stands on the gate centre column, one tile deeper than the guard posts', () => {
  // box rows 5..10, cols 5..12; gate row 10 col 9; guard posts row 9; merchant row 8
  assert.deepEqual(villageMerchantPost(V()), { x: 9 * 100 + 50, y: 8 * 100 + 50 });
});

test('N gate mirrors: one tile deeper from the N wall', () => {
  // gate row 5 col 9; guard posts row 6; merchant row 7
  assert.deepEqual(villageMerchantPost(V({ gateEdge: 'N' })), { x: 9 * 100 + 50, y: 7 * 100 + 50 });
});

test('W gate: merchant on the gate centre row, one col deeper', () => {
  // gate col 5 row 8; guard posts col 6; merchant col 7
  assert.deepEqual(villageMerchantPost(V({ gateEdge: 'W' })), { x: 7 * 100 + 50, y: 8 * 100 + 50 });
});

test('E gate: one col deeper from the E wall', () => {
  // gate col 12 row 8; guard posts col 11; merchant col 10
  assert.deepEqual(villageMerchantPost(V({ gateEdge: 'E' })), { x: 10 * 100 + 50, y: 8 * 100 + 50 });
});

test('a minimum 3x3 village clamps the merchant to its single interior tile', () => {
  const p = villageMerchantPost(V({ width: 3, height: 3, gateEdge: 'S' }));
  assert.deepEqual(p, { x: 6 * 100 + 50, y: 6 * 100 + 50 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/villageMerchantPost.test.js`
Expected: FAIL — `villageMerchantPost` not exported.

- [ ] **Step 3: Add `villageMerchantPost` to `mapService.js`**

Place it next to `villageGatePosts`:

```js
// Where the village merchant stands: on the gate's centre line, one tile deeper
// into the village than the guard posts, clamped into the interior so a
// minimum-size village still yields a legal interior tile.
function villageMerchantPost(v) {
  const rMax = v.minRow + v.height - 1;
  const cMax = v.minCol + v.width - 1;
  const midCol = v.minCol + Math.floor(v.width / 2);
  const midRow = v.minRow + Math.floor(v.height / 2);
  const loR = v.minRow + 1, hiR = rMax - 1;
  const loC = v.minCol + 1, hiC = cMax - 1;
  const clampR = (r) => Math.min(hiR, Math.max(loR, r));
  const clampC = (c) => Math.min(hiC, Math.max(loC, c));
  let row, col;
  if (v.gateEdge === 'S')      { row = clampR(rMax - 2); col = clampC(midCol); }
  else if (v.gateEdge === 'N') { row = clampR(v.minRow + 2); col = clampC(midCol); }
  else if (v.gateEdge === 'W') { row = clampR(midRow); col = clampC(v.minCol + 2); }
  else                         { row = clampR(midRow); col = clampC(cMax - 2); }
  return { x: col * 100 + 50, y: row * 100 + 50 };
}
```

Add `villageMerchantPost` to `module.exports`.

- [ ] **Step 4: Return the merchant position from `fetchVillages`**

In `backend/src/services/villages.js`, add the columns to the SELECT and the mapping:

```js
    `SELECT id, min_row, min_col, width, height, gate_edge, spawn_x, spawn_y, merchant_x, merchant_y
       FROM villages WHERE world_id = $1 ORDER BY created_at ASC`,
```
```js
    merchantX: v.merchant_x == null ? null : Number(v.merchant_x),
    merchantY: v.merchant_y == null ? null : Number(v.merchant_y),
```

- [ ] **Step 5: Set the merchant position when a village is created**

In `backend/src/index.js`'s `POST /api/worlds/:id/villages`, the INSERT currently omits merchant columns. Compute the post from the validated body and store it. Import `villageMerchantPost` (add to the existing `./services/mapService` destructure). Before the INSERT:

```js
    const mpost = villageMerchantPost({
      minRow: min_row, minCol: min_col, width, height, gateEdge: gate_edge,
    });
```

and add the two columns to the INSERT column list/values (`merchant_x, merchant_y` ← `mpost.x, mpost.y`), keeping `RETURNING *`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && node --test tests/villageMerchantPost.test.js tests/villageRoutes.test.js`
Expected: PASS. (The village-create route test asserts on the INSERT — if its mock or assertions need the new columns, update them; do not weaken assertions.)

- [ ] **Step 7: Full suite + commit**

Run: `cd backend && node --test "tests/**/*.test.js"` → all pass.

```bash
git add backend/src/services/mapService.js backend/src/services/villages.js backend/src/index.js backend/tests/
git commit -m "feat(villages): merchant post helper + persist merchant position"
```

---

### Task 3: `merchantStock` service — shop reads, base catalog seeding, buyback writes

**Files:**
- Create: `backend/src/services/merchantStock.js`
- Modify: `backend/src/index.js` (seed the base catalog on village create)
- Test: `backend/tests/merchantStock.test.js`

**Interfaces:**
- Produces (all exported from `merchantStock.js`):
  - `SELL_FRACTION = 0.5`, `BUYBACK_DAYS = 3`
  - `sellPriceFor(value)` → `Math.floor(Number(value || 0) * SELL_FRACTION)`
  - `seedBaseCatalog(pool, worldId, villageId)` — inserts one base-catalog row per sellable item type (`category IN ('weapon','armor') AND value > 0`), `price = value`, `seller_user_id = NULL`, `expires_at = NULL`.
  - `fetchShop(pool, villageId)` → `{ catalog, buyback }`; sweeps expired rows first; `catalog` = `seller_user_id IS NULL`; `buyback` = non-expired `seller_user_id IS NOT NULL`. Rows shaped `{ id, itemTypeId, price, quantity, sellerUserId }`.
  - `insertBuyback(pool, worldId, villageId, itemTypeId, price, sellerUserId, days)` → the inserted row.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/merchantStock.test.js
const test = require('node:test');
const assert = require('node:assert');
const { sellPriceFor, fetchShop, seedBaseCatalog, insertBuyback, SELL_FRACTION, BUYBACK_DAYS } =
  require('../src/services/merchantStock');

test('sellPriceFor is half the value, floored, and never negative', () => {
  assert.equal(SELL_FRACTION, 0.5);
  assert.equal(sellPriceFor(10), 5);
  assert.equal(sellPriceFor(11), 5);
  assert.equal(sellPriceFor(0), 0);
  assert.equal(sellPriceFor(undefined), 0);
});

test('fetchShop sweeps expired rows, then splits catalog vs buyback', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push(sql);
    if (/DELETE FROM merchant_stock/i.test(sql)) return { rowCount: 2 };
    if (/SELECT .* FROM merchant_stock/i.test(sql)) {
      assert.match(sql, /expires_at IS NULL OR expires_at > now\(\)/i,
        'the read must exclude expired rows');
      return { rows: [
        { id: 'c1', item_type_id: 1, price: 20, quantity: 1, seller_user_id: null },
        { id: 'b1', item_type_id: 2, price: 5, quantity: 1, seller_user_id: 7 },
      ] };
    }
    throw new Error('unexpected ' + sql);
  } };
  const shop = await fetchShop(pool, 'v1');
  assert.ok(calls.some((s) => /DELETE FROM merchant_stock/i.test(s)), 'expired sweep ran');
  assert.deepEqual(shop.catalog, [{ id: 'c1', itemTypeId: 1, price: 20, quantity: 1, sellerUserId: null }]);
  assert.deepEqual(shop.buyback, [{ id: 'b1', itemTypeId: 2, price: 5, quantity: 1, sellerUserId: 7 }]);
});

test('seedBaseCatalog inserts only sellable weapon/armor types at price = value', async () => {
  let insertSql = '', insertParams = null;
  const pool = { query: async (sql, params) => {
    if (/INSERT INTO merchant_stock/i.test(sql)) { insertSql = sql; insertParams = params; return { rows: [] }; }
    throw new Error('unexpected ' + sql);
  } };
  await seedBaseCatalog(pool, 'w1', 'v1');
  assert.match(insertSql, /SELECT/i, 'seeds via INSERT ... SELECT from item_types');
  assert.match(insertSql, /category IN \('weapon','armor'\)/i);
  assert.match(insertSql, /value > 0/i);
  assert.deepEqual(insertParams, ['w1', 'v1']);
});

test('insertBuyback stores the sold price, the seller, and an expiry', async () => {
  let params = null, sql = '';
  const pool = { query: async (s, p) => { sql = s; params = p; return { rows: [{ id: 'b9' }] }; } };
  const row = await insertBuyback(pool, 'w1', 'v1', 3, 5, 7, BUYBACK_DAYS);
  assert.equal(row.id, 'b9');
  assert.match(sql, /INSERT INTO merchant_stock/i);
  assert.match(sql, /interval/i, 'expiry computed in SQL');
  assert.deepEqual(params, ['w1', 'v1', 3, 5, 7, BUYBACK_DAYS]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/merchantStock.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `backend/src/services/merchantStock.js`**

```js
// Merchant stock: a village's base catalog (seller_user_id IS NULL — infinite,
// never expires) plus player buyback rows (seller_user_id set — one instance
// each, expiring after BUYBACK_DAYS at the price they were sold for).

const SELL_FRACTION = 0.5;
const BUYBACK_DAYS = 3;

function sellPriceFor(value) {
  const v = Number(value) || 0;
  return Math.max(0, Math.floor(v * SELL_FRACTION));
}

function mapRow(r) {
  return {
    id: r.id,
    itemTypeId: r.item_type_id,
    price: Number(r.price) || 0,
    quantity: Number(r.quantity) || 1,
    sellerUserId: r.seller_user_id == null ? null : Number(r.seller_user_id),
  };
}

// One base-catalog row per sellable catalog item. Idempotent per village only in
// the sense that callers seed once at village creation.
async function seedBaseCatalog(pool, worldId, villageId) {
  await pool.query(
    `INSERT INTO merchant_stock (world_id, village_id, item_type_id, price, seller_user_id, expires_at, quantity)
     SELECT $1, $2, id, value, NULL, NULL, 1
       FROM item_types
      WHERE category IN ('weapon','armor') AND value > 0`,
    [worldId, villageId],
  );
}

// Lazily sweep expired buyback rows, then read the shop.
async function fetchShop(pool, villageId) {
  await pool.query(
    'DELETE FROM merchant_stock WHERE village_id = $1 AND expires_at IS NOT NULL AND expires_at < now()',
    [villageId],
  );
  const r = await pool.query(
    `SELECT id, item_type_id, price, quantity, seller_user_id
       FROM merchant_stock
      WHERE village_id = $1 AND (expires_at IS NULL OR expires_at > now())
      ORDER BY seller_user_id NULLS FIRST, created_at ASC`,
    [villageId],
  );
  const rows = r.rows.map(mapRow);
  return {
    catalog: rows.filter((x) => x.sellerUserId == null),
    buyback: rows.filter((x) => x.sellerUserId != null),
  };
}

async function insertBuyback(pool, worldId, villageId, itemTypeId, price, sellerUserId, days = BUYBACK_DAYS) {
  const r = await pool.query(
    `INSERT INTO merchant_stock (world_id, village_id, item_type_id, price, seller_user_id, expires_at, quantity)
     VALUES ($1, $2, $3, $4, $5, now() + ($6::int * interval '1 day'), 1)
     RETURNING id, item_type_id, price, quantity, seller_user_id`,
    [worldId, villageId, itemTypeId, price, sellerUserId, days],
  );
  return r.rows[0];
}

module.exports = { SELL_FRACTION, BUYBACK_DAYS, sellPriceFor, seedBaseCatalog, fetchShop, insertBuyback };
```

- [ ] **Step 4: Seed the base catalog on village creation**

In `backend/src/index.js`'s `POST /api/worlds/:id/villages`, after the village INSERT (and after `insertVillageGuards`), add:

```js
    await seedBaseCatalog(pool, id, row.id);
```

Import `seedBaseCatalog` from `./services/merchantStock`.

- [ ] **Step 5: Run tests + full suite**

Run: `cd backend && node --test tests/merchantStock.test.js tests/villageRoutes.test.js` → PASS (update the village-create mock pool to answer the new `INSERT INTO merchant_stock` query — a legitimate mock update).
Run: `cd backend && node --test "tests/**/*.test.js"` → all pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/merchantStock.js backend/src/index.js backend/tests/
git commit -m "feat(merchant): stock service — catalog seed, shop read, buyback insert"
```

---

### Task 4: `interact` handler — open the shop

**Files:**
- Modify: `backend/src/authority/server.js` (merchant lookup helper + `interact` handler)
- Test: `backend/tests/merchantInteract.test.js`

**Interfaces:**
- Consumes: `entry.villages` (each with `merchantX/merchantY`), `fetchShop`.
- Produces:
  - `nearestMerchantVillage(villages, cx, cy, radius)` (exported from server.js, pure) → the village whose merchant is within `radius` of `(cx,cy)`, nearest first, else `null`.
  - `INTERACT_RADIUS = 120` (exported).
  - Message `interact` → replies `{ type:'shop', villageId, catalog, buyback }` or `{type:'error', message:'no merchant nearby'}`.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/merchantInteract.test.js
const test = require('node:test');
const assert = require('node:assert');
const { nearestMerchantVillage, INTERACT_RADIUS } = require('../src/authority/server');

const V = (id, x, y) => ({ id, merchantX: x, merchantY: y });

test('nearestMerchantVillage picks the closest merchant inside the radius', () => {
  const villages = [V('far', 1000, 0), V('near', 100, 0)];
  assert.equal(nearestMerchantVillage(villages, 0, 0, 400).id, 'near');
});

test('returns null when every merchant is beyond the radius', () => {
  assert.equal(nearestMerchantVillage([V('a', 1000, 0)], 0, 0, INTERACT_RADIUS), null);
});

test('skips villages with no merchant position', () => {
  const villages = [{ id: 'nomerchant', merchantX: null, merchantY: null }, V('ok', 50, 0)];
  assert.equal(nearestMerchantVillage(villages, 0, 0, 400).id, 'ok');
});

test('returns null for an empty or missing village list', () => {
  assert.equal(nearestMerchantVillage([], 0, 0, 400), null);
  assert.equal(nearestMerchantVillage(null, 0, 0, 400), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/merchantInteract.test.js`
Expected: FAIL — not exported.

- [ ] **Step 3: Add the helper + constant to `server.js`**

Near `planBind` (module scope):

```js
const INTERACT_RADIUS = 120; // px: how close a player must stand to trade

// The village whose merchant is nearest to (cx,cy) within `radius`, or null.
// Villages without a merchant position are skipped.
function nearestMerchantVillage(villages, cx, cy, radius) {
  if (!villages || !villages.length) return null;
  let best = null, bd2 = radius * radius;
  for (const v of villages) {
    if (v.merchantX == null || v.merchantY == null) continue;
    const dx = v.merchantX - cx, dy = v.merchantY - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 <= bd2) { bd2 = d2; best = v; }
  }
  return best;
}
```

Add both to `module.exports`.

- [ ] **Step 4: Add the `interact` handler**

Insert it alongside the other handlers (e.g. right after the `drop` block), mirroring `drop`'s shape exactly:

```js
      if (msg.type === 'interact') {
        const entry = worlds.get(ws.worldId);
        if (!entry) return;
        ws._opChain = (ws._opChain || Promise.resolve()).then(async () => {
          try {
            const p = entry.world.getPlayer(ws.userId);
            if (!p) return;
            const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
            const village = nearestMerchantVillage(entry.villages, cx, cy, INTERACT_RADIUS);
            if (!village) { send(ws, { type: 'error', message: 'no merchant nearby' }); return; }
            const shop = await fetchShop(pool, village.id);
            send(ws, { type: 'shop', villageId: village.id, catalog: shop.catalog, buyback: shop.buyback });
          } catch (err) {
            console.error('interact failed:', err);
            send(ws, { type: 'error', message: 'interact failed' });
          }
        });
        return;
      }
```

Import `fetchShop` from `../services/merchantStock`.

- [ ] **Step 5: Run tests + full suite**

Run: `cd backend && node --test tests/merchantInteract.test.js` → PASS (4).
Run: `cd backend && node -e "require('./src/authority/server.js')" && node --test "tests/**/*.test.js"` → clean load, all pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/authority/server.js backend/tests/merchantInteract.test.js
git commit -m "feat(merchant): interact handler opens the village shop"
```

---

### Task 5: `buy` and `sell` handlers

**Files:**
- Create: `backend/src/authority/trade.js`
- Modify: `backend/src/authority/server.js` (`buy` / `sell` handlers)
- Test: `backend/tests/trade.test.js`

**Interfaces:**
- Produces (exported from `trade.js`):
  - `buyStock(pool, entry, userId, stockId)` → `{ ok:true, gold, item:{id,typeId,quantity} }` or `{ ok:false, reason }`.
  - `sellItem(pool, entry, userId, villageId, itemId)` → `{ ok:true, gold, price }` or `{ ok:false, reason }`.
- Messages: `buy {stockId}` → `{type:'bought', item, gold}` (+ `{type:'wallet',gold}`) or `error`; `sell {itemId}` → `{type:'sold', itemId, price, gold}` (+ wallet) or `error`.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/trade.test.js
const test = require('node:test');
const assert = require('node:assert');
const { buyStock, sellItem } = require('../src/authority/trade');

function mkEntry(player, worldId = 'w1') {
  return { worldId, world: { getPlayer: () => player } };
}
const PLAYER = () => ({ userId: 1, gold: 100, x: 0, y: 0, width: 64, height: 64,
  inv: { items: [{ id: 'i1', typeId: 3, quantity: 1 }], equipment: {} } });

test('buyStock debits gold, grants the item, and leaves a base-catalog row in place', async () => {
  const p = PLAYER(); const seen = [];
  const pool = { query: async (sql, params) => {
    seen.push(sql);
    if (/FROM merchant_stock WHERE id/i.test(sql)) return { rows: [{ id: 's1', item_type_id: 3, price: 20, seller_user_id: null, village_id: 'v1' }] };
    if (/UPDATE users SET gold = gold - /i.test(sql)) { assert.match(sql, /gold >= /, 'debit must be overdraft-safe'); return { rowCount: 1, rows: [{ gold: 80 }] }; }
    if (/INSERT INTO player_items/i.test(sql)) return { rows: [{ id: 'new1', item_type_id: 3, quantity: 1 }] };
    throw new Error('unexpected ' + sql);
  } };
  const r = await buyStock(pool, mkEntry(p), 1, 's1');
  assert.equal(r.ok, true);
  assert.equal(r.gold, 80);
  assert.equal(p.gold, 80, 'in-memory wallet mirrors');
  assert.ok(p.inv.items.some((it) => it.id === 'new1'), 'item added to in-memory inventory');
  assert.ok(!seen.some((s) => /DELETE FROM merchant_stock/i.test(s)), 'base-catalog row is NOT consumed');
});

test('buying a buyback row deletes it', async () => {
  const p = PLAYER(); let deleted = false;
  const pool = { query: async (sql) => {
    if (/FROM merchant_stock WHERE id/i.test(sql)) return { rows: [{ id: 's2', item_type_id: 3, price: 5, seller_user_id: 7, village_id: 'v1' }] };
    if (/UPDATE users SET gold = gold - /i.test(sql)) return { rowCount: 1, rows: [{ gold: 95 }] };
    if (/INSERT INTO player_items/i.test(sql)) return { rows: [{ id: 'new2', item_type_id: 3, quantity: 1 }] };
    if (/DELETE FROM merchant_stock/i.test(sql)) { deleted = true; return { rowCount: 1 }; }
    throw new Error('unexpected ' + sql);
  } };
  const r = await buyStock(pool, mkEntry(p), 1, 's2');
  assert.equal(r.ok, true);
  assert.equal(deleted, true, 'buyback rows are one-off and must be removed');
});

test('buyStock with insufficient gold errors and grants nothing', async () => {
  const p = PLAYER(); const seen = [];
  const pool = { query: async (sql) => {
    seen.push(sql);
    if (/FROM merchant_stock WHERE id/i.test(sql)) return { rows: [{ id: 's1', item_type_id: 3, price: 500, seller_user_id: null, village_id: 'v1' }] };
    if (/UPDATE users SET gold = gold - /i.test(sql)) return { rowCount: 0, rows: [] }; // guard rejected
    throw new Error('unexpected ' + sql);
  } };
  const r = await buyStock(pool, mkEntry(p), 1, 's1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /gold/i);
  assert.equal(p.gold, 100, 'wallet untouched');
  assert.ok(!seen.some((s) => /INSERT INTO player_items/i.test(s)), 'no item granted');
});

test('sellItem removes the item, credits gold, and inserts a buyback row', async () => {
  const p = PLAYER();
  const pool = { query: async (sql, params) => {
    if (/DELETE FROM player_items/i.test(sql)) {
      assert.match(sql, /user_id = \$2/, 'ownership enforced in SQL');
      return { rowCount: 1, rows: [{ item_type_id: 3, quantity: 1 }] };
    }
    if (/SELECT value FROM item_types/i.test(sql)) return { rows: [{ value: 20 }] };
    if (/UPDATE users SET gold = gold \+ /i.test(sql)) return { rowCount: 1, rows: [{ gold: 110 }] };
    if (/INSERT INTO merchant_stock/i.test(sql)) return { rows: [{ id: 'b1' }] };
    throw new Error('unexpected ' + sql);
  } };
  const r = await sellItem(pool, mkEntry(p), 1, 'v1', 'i1');
  assert.equal(r.ok, true);
  assert.equal(r.price, 10, 'sell price is half of value 20');
  assert.equal(r.gold, 110);
  assert.equal(p.gold, 110);
  assert.ok(!p.inv.items.some((it) => it.id === 'i1'), 'item removed from in-memory inventory');
});

test('sellItem refuses an equipped item and mutates nothing', async () => {
  const p = PLAYER(); p.inv.equipment = { main_hand: 'i1' };
  const pool = { query: async (sql) => { throw new Error('must not query: ' + sql); } };
  const r = await sellItem(pool, mkEntry(p), 1, 'v1', 'i1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /unequip/i);
});

test('sellItem refuses an item the player does not own', async () => {
  const p = PLAYER();
  const pool = { query: async (sql) => {
    if (/DELETE FROM player_items/i.test(sql)) return { rowCount: 0, rows: [] };
    throw new Error('unexpected ' + sql);
  } };
  const r = await sellItem(pool, mkEntry(p), 1, 'v1', 'nope');
  assert.equal(r.ok, false);
  assert.match(r.reason, /own/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/trade.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `backend/src/authority/trade.js`**

```js
// Merchant transactions. Gold moves through guarded atomic UPDATEs (never a
// read-modify-write), ownership is enforced by the SQL predicate, and the
// in-memory inventory/wallet are kept in step so a later equip validates
// against fresh state.

const { sellPriceFor, insertBuyback, BUYBACK_DAYS } = require('../services/merchantStock');

async function buyStock(pool, entry, userId, stockId) {
  const p = entry.world.getPlayer(userId);
  if (!p) return { ok: false, reason: 'no player' };

  const sr = await pool.query(
    'SELECT id, item_type_id, price, seller_user_id, village_id FROM merchant_stock WHERE id = $1',
    [stockId],
  );
  if (sr.rows.length !== 1) return { ok: false, reason: 'that item is no longer for sale' };
  const stock = sr.rows[0];
  const price = Number(stock.price) || 0;

  // Overdraft-safe: the WHERE guard makes "not enough gold" a 0-row result
  // rather than a negative balance.
  const gr = await pool.query(
    'UPDATE users SET gold = gold - $2 WHERE id = $1 AND gold >= $2 RETURNING gold',
    [userId, price],
  );
  if (gr.rowCount !== 1) return { ok: false, reason: 'not enough gold' };
  const gold = Number(gr.rows[0].gold) || 0;

  const ins = await pool.query(
    'INSERT INTO player_items (user_id, item_type_id, quantity) VALUES ($1, $2, 1) RETURNING id, item_type_id, quantity',
    [userId, stock.item_type_id],
  );
  const row = ins.rows[0];

  // A base-catalog row (seller_user_id NULL) is infinite stock; a buyback row is
  // one specific instance and is consumed.
  if (stock.seller_user_id != null) {
    await pool.query('DELETE FROM merchant_stock WHERE id = $1', [stockId]);
  }

  p.gold = gold;
  const item = { id: row.id, typeId: row.item_type_id, quantity: Number(row.quantity) || 1 };
  if (p.inv) p.inv.items.push(item);
  return { ok: true, gold, item };
}

async function sellItem(pool, entry, userId, villageId, itemId) {
  const p = entry.world.getPlayer(userId);
  if (!p || !p.inv) return { ok: false, reason: 'no player' };
  if (Object.values(p.inv.equipment).includes(itemId)) {
    return { ok: false, reason: 'unequip it first' };
  }

  // The user_id predicate IS the ownership check.
  const del = await pool.query(
    'DELETE FROM player_items WHERE id = $1 AND user_id = $2 RETURNING item_type_id, quantity',
    [itemId, userId],
  );
  if (del.rowCount !== 1) return { ok: false, reason: 'you do not own that item' };
  const itemTypeId = del.rows[0].item_type_id;

  const vr = await pool.query('SELECT value FROM item_types WHERE id = $1', [itemTypeId]);
  const value = vr.rows.length ? Number(vr.rows[0].value) || 0 : 0;
  const price = sellPriceFor(value);

  const gr = await pool.query(
    'UPDATE users SET gold = gold + $2 WHERE id = $1 RETURNING gold',
    [userId, price],
  );
  const gold = gr.rows.length ? Number(gr.rows[0].gold) || 0 : p.gold;

  await insertBuyback(pool, entry.worldId, villageId, itemTypeId, price, userId, BUYBACK_DAYS);

  p.gold = gold;
  p.inv.items = p.inv.items.filter((it) => it.id !== itemId);
  return { ok: true, gold, price };
}

module.exports = { buyStock, sellItem };
```

- [ ] **Step 4: Add the `buy` and `sell` handlers to `server.js`**

Mirror `drop` exactly (wire-validate → `_opChain` → try/catch):

```js
      if (msg.type === 'buy') {
        const entry = worlds.get(ws.worldId);
        if (!entry) return;
        if (typeof msg.stockId !== 'string') return;
        ws._opChain = (ws._opChain || Promise.resolve()).then(async () => {
          try {
            const p = entry.world.getPlayer(ws.userId);
            if (!p) return;
            const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
            if (!nearestMerchantVillage(entry.villages, cx, cy, INTERACT_RADIUS)) {
              send(ws, { type: 'error', message: 'no merchant nearby' }); return;
            }
            const r = await buyStock(pool, entry, ws.userId, msg.stockId);
            if (r.ok) {
              send(ws, { type: 'bought', item: r.item, gold: r.gold });
              send(ws, { type: 'wallet', gold: r.gold });
            } else send(ws, { type: 'error', message: r.reason });
          } catch (err) {
            console.error('buy failed:', err);
            send(ws, { type: 'error', message: 'buy failed' });
          }
        });
        return;
      }

      if (msg.type === 'sell') {
        const entry = worlds.get(ws.worldId);
        if (!entry) return;
        if (typeof msg.itemId !== 'string') return;
        ws._opChain = (ws._opChain || Promise.resolve()).then(async () => {
          try {
            const p = entry.world.getPlayer(ws.userId);
            if (!p) return;
            const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
            const village = nearestMerchantVillage(entry.villages, cx, cy, INTERACT_RADIUS);
            if (!village) { send(ws, { type: 'error', message: 'no merchant nearby' }); return; }
            const r = await sellItem(pool, entry, ws.userId, village.id, msg.itemId);
            if (r.ok) {
              send(ws, { type: 'sold', itemId: msg.itemId, price: r.price, gold: r.gold });
              send(ws, { type: 'wallet', gold: r.gold });
            } else send(ws, { type: 'error', message: r.reason });
          } catch (err) {
            console.error('sell failed:', err);
            send(ws, { type: 'error', message: 'sell failed' });
          }
        });
        return;
      }
```

Import `buyStock, sellItem` from `./trade`.

- [ ] **Step 5: Run tests + full suite**

Run: `cd backend && node --test tests/trade.test.js` → PASS (6).
Run: `cd backend && node -e "require('./src/authority/server.js')" && node --test "tests/**/*.test.js"` → clean load, all pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/authority/trade.js backend/src/authority/server.js backend/tests/trade.test.js
git commit -m "feat(merchant): buy and sell handlers with overdraft-safe gold moves"
```

---

### Task 6: Client plumbing — merchant position, interact key, shop messages

**Files:**
- Modify: `backend/src/authority/server.js` (send merchant positions in `joined`)
- Modify: `frontend/src/games/something2/src/js/net/WorldAuthorityClient.js` (`onShop`/`onBought`/`onSold`; `sendInteract`/`sendBuy`/`sendSell`)
- Modify: `frontend/src/games/something2/src/js/core/Game.js` (merchant state, interact key, shop state)
- Modify: `frontend/src/games/something2/src/js/systems/RenderSystem.js` (draw the merchant)
- Test: the existing `WorldAuthorityClient` net test file

**Interfaces:**
- `joined` frame gains `merchants: [{ villageId, x, y }]`.
- Client: `this.merchants` (array), `this.shop` (`{villageId, catalog, buyback}|null`), `this.shopOpen` (bool).

- [ ] **Step 1: Send merchant positions in the `joined` frame**

In `server.js`'s join reply, add:

```js
            merchants: (entry.villages || [])
              .filter((v) => v.merchantX != null && v.merchantY != null)
              .map((v) => ({ villageId: v.id, x: v.merchantX, y: v.merchantY })),
```

- [ ] **Step 2: Add client callbacks + senders**

In `WorldAuthorityClient.js`: add `onShop, onBought, onSold` to the constructor destructure with `|| (() => {})` defaults, and cases:

```js
      case 'shop': this.onShop(msg); break;
      case 'bought': this.onBought(msg); break;
      case 'sold': this.onSold(msg); break;
```

Add senders next to `sendDrop`:

```js
  sendInteract() { this._send({ type: 'interact' }); }
  sendBuy(stockId) { this._send({ type: 'buy', stockId }); }
  sendSell(itemId) { this._send({ type: 'sell', itemId }); }
```

- [ ] **Step 3: Write the failing dispatch test**

In the existing net test file (`frontend/src/games/something2/src/js/net/__tests__/WorldAuthorityClient.test.js`), mirroring the `wallet` test added in Slice C:

```js
test('a shop message invokes onShop with the catalog and buyback', () => {
  let seen = null;
  const c = new WorldAuthorityClient({ url: 'ws://x', token: 't', onShop: (m) => { seen = m; } });
  c._handleMessage({ type: 'shop', villageId: 'v1', catalog: [{ id: 's1' }], buyback: [] });
  assert.equal(seen.villageId, 'v1');
  assert.equal(seen.catalog.length, 1);
});
```

Run it (RED), implement Step 2, run again (GREEN).

- [ ] **Step 4: Track merchants + shop in `Game.js`**

Add to the per-join state (BOTH the constructor init and the re-join reset, next to `this.gold = 0;`):

```js
        this.merchants = [];
        this.shop = null;
        this.shopOpen = false;
```

In `onJoined`, capture the merchants:

```js
                    this.merchants = Array.isArray(msg.merchants) ? msg.merchants : [];
```

Add the callbacks alongside `onWallet`:

```js
                onShop: (msg) => { this.shop = { villageId: msg.villageId, catalog: msg.catalog || [], buyback: msg.buyback || [] }; this.shopOpen = true; },
                onBought: (msg) => { if (msg.item) addItem(this.inventory, msg.item); if (this.authorityClient) this.authorityClient.sendInteract(); },
                onSold: (msg) => { removeItem(this.inventory, msg.itemId); if (this.authorityClient) this.authorityClient.sendInteract(); },
```

(Re-issuing `interact` after a trade refreshes the shop so the panel reflects the new stock — the server is the source of truth.)

- [ ] **Step 5: Add the interact keybind**

In `_keydownHandler`, following the `g`/pickup pattern:

```js
        if (key === 'e' && this.state === 'playing' && this.chunked && !e.repeat && !this.inventoryOpen) {
            if (this.shopOpen) { this.shopOpen = false; return; }
            if (this.authorityClient) this.authorityClient.sendInteract();
            return;
        }
```

Also close the shop on `escape` where the pause branch lives — if `this.shopOpen`, set it false and return instead of pausing.

- [ ] **Step 6: Draw the merchant**

Pass `merchants: this.merchants` into the `renderChunked({...})` options (next to `gold`). In `RenderSystem.renderChunked`, destructure `merchants = []` and push each into the drawables array the same way ground items are, so depth sorting is correct — draw a simple marker (a filled diamond in a distinct colour with a `Merchant` label), reusing the existing `worldToScreen` + `depthKey` helpers that the ground-item loop uses.

- [ ] **Step 7: Build + test**

Run: `cd frontend && npm run build && npm test`
Expected: build succeeds; suite green (180 + your new net test).

- [ ] **Step 8: Commit**

```bash
git add backend/src/authority/server.js frontend/src/games/something2/src/js/
git commit -m "feat(client): merchant position, interact key, shop message plumbing"
```

---

### Task 7: Shop panel UI

**Files:**
- Modify: `frontend/src/games/something2/src/js/systems/RenderSystem.js` (`renderShop` + `_shopHitAreas`)
- Modify: `frontend/src/games/something2/src/js/core/Game.js` (`_handleShopClick`, mouse routing)

**Interfaces:**
- Consumes: `this.shop` / `this.shopOpen` (Task 6), `this.inventory`, the item-type catalog.
- Produces: a centred shop panel listing **Catalog**, **Buyback**, and **Your items** (sell), pushing hit areas `{x,y,w,h,kind,id}` with `kind` in `'buy'`(id = stockId) / `'sell'`(id = item instance id) / `'close'`.

- [ ] **Step 1: Render the shop panel**

Mirror `renderInventory` (`RenderSystem.js:537-649`) — same centred-panel geometry and the same hit-area contract. Signature:

```js
  renderShop(ctx, shop, inventory, itemTypes, gold, hitAreas) { ... }
```

Draw three columns/sections: catalog rows (`name — price g` + a `Buy` rect → `{kind:'buy', id: row.id}`), buyback rows (same, visually distinguished), and the player's inventory rows with a `Sell` rect → `{kind:'sell', id: item.id}`. Show the player's gold in the header and a `Close` rect → `{kind:'close'}`. Resolve item names via the catalog the client already has (`joined.itemTypes`).

Call it from `renderChunked` right after the inventory panel block, resetting the hit areas each frame:

```js
    this._shopHitAreas = [];
    if (shopOpen && shop) {
      this.renderShop(this.ctx, shop, inventory, itemTypes, gold, this._shopHitAreas);
    }
```

(Thread `shopOpen`/`shop` through `renderChunked`'s options from Game.js.)

- [ ] **Step 2: Route clicks**

In `Game.js`'s `_mouseDownHandler`, add the shop branch BEFORE the inventory branch (a panel that is open consumes the click):

```js
            if (this.shopOpen) { this._handleShopClick(this._cursorX ?? 0, this._cursorY ?? 0); return; }
```

And add the handler, mirroring `_handleInventoryClick`:

```js
    _handleShopClick(cx, cy) {
        const hitAreas = (this.renderSystem && this.renderSystem._shopHitAreas) || [];
        const hit = hitAreas.find((a) => cx >= a.x && cx <= a.x + a.w && cy >= a.y && cy <= a.y + a.h);
        if (!hit) return;
        if (hit.kind === 'close') { this.shopOpen = false; return; }
        if (hit.kind === 'buy') { if (this.authorityClient) this.authorityClient.sendBuy(hit.id); return; }
        if (hit.kind === 'sell') { if (this.authorityClient) this.authorityClient.sendSell(hit.id); return; }
    }
```

- [ ] **Step 3: Build + test**

Run: `cd frontend && npm run build && npm test`
Expected: build succeeds; suite green.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/games/something2/src/js/
git commit -m "feat(client): merchant shop panel with buy/sell actions"
```

---

## Final runtime verification (whole-slice, after all tasks)

Restart the stack (backend node AND the Vite dev server are both manually started):
```bash
docker start something2-db-1 something2-backend-1 something2-frontend-1
docker exec something2-backend-1 sh -c 'pkill -f "node src/index.js"; sleep 2'
docker exec -d something2-backend-1 sh -c 'cd /app && node src/index.js > /tmp/backend.log 2>&1'
docker exec -d something2-frontend-1 sh -c 'cd /app && npm run dev -- --host 0.0.0.0 > /tmp/vite.log 2>&1'
```

Then, with an admin token + a WS client:
1. Create a bounded world + a village → confirm `villages.merchant_x/merchant_y` are set to an interior tile, and `merchant_stock` has base-catalog rows (`seller_user_id IS NULL`) for weapons/armor at `price = value`.
2. Join → the `joined` frame carries `merchants: [{villageId,x,y}]`.
3. Stand ON the merchant tile and send `interact` → a `shop` frame with a non-empty `catalog` and empty `buyback`. Stand far away → `error: no merchant nearby`.
4. Give the player gold, `buy` a catalog row → `bought` + `wallet`; `users.gold` drops by exactly the price; a `player_items` row appears; **the base-catalog row still exists** (infinite stock).
5. `sell` that item → `sold` + `wallet`; gold rises by `floor(value/2)`; the `player_items` row is gone; a `merchant_stock` buyback row exists with `seller_user_id` = the user and `expires_at ≈ now + 3 days`.
6. `interact` again → the buyback row appears in `buyback`; `buy` it back at the stored price → the buyback row is DELETED (not infinite).
7. Try to sell an EQUIPPED item → `error: unequip it first`, nothing mutated. Try to buy with insufficient gold → `error: not enough gold`, gold unchanged, no item granted.

---

## Self-Review

**Spec coverage** (Slice D section of `2026-07-22-villages-economy-design.md`):
- Merchant per village at `merchant_x/merchant_y`, rendered as a static NPC → Tasks 1, 2, 6. ✅
- `interact` → `shop {catalog, buyback}` → Task 4. ✅
- `buy {stockId}`: proximity + gold check, deduct, grant, remove stock, reply/error → Task 5. ✅
- `sell {itemId}`: ownership + proximity, remove item, credit a fraction of value, insert expiring buyback row → Task 5. ✅
- Buyback = `merchant_stock` row with `seller_user_id`; base catalog `NULL` + never expires → Tasks 1, 3. ✅
- Expiry filtered on read + swept lazily on shop open → Task 3. ✅
- Proximity radius on all three messages → Tasks 4, 5. ✅
- Tests named in the spec (interact returns non-expired; buy deducts/grants/removes; insufficient gold errors with no mutation; sell removes+credits+inserts; expired excluded) → Tasks 3, 5. ✅

**Placeholder scan:** none — every code step carries complete code, except Task 6 Step 6 and Task 7 Step 1 which describe canvas drawing in prose because they must match the existing panel/drawable geometry; both name the exact function to mirror, the exact call site, and the exact hit-area contract.

**Type consistency:** `sellPriceFor`/`insertBuyback`/`fetchShop` signatures match between Task 3 (definition) and Task 5 (use). `nearestMerchantVillage(villages, cx, cy, radius)` matches between Task 4 (definition) and Task 5 (use). Shop row shape `{id,itemTypeId,price,quantity,sellerUserId}` is identical across `fetchShop` (Task 3), the `shop` frame (Task 4), and the panel's `{kind:'buy', id}` (Task 7). `merchants: [{villageId,x,y}]` matches between Task 6 Step 1 (send) and Step 4 (receive). `buyStock` returns `{ok, gold, item}` and `sellItem` returns `{ok, gold, price}`, matching both handlers.

**Known deliberate scope:** no merchant restock timers beyond buyback expiry, no haggling/reputation, no multi-merchant villages, no stack splitting (each buyback row is one instance). Gold itself (`value = 0`) can never be sold.
