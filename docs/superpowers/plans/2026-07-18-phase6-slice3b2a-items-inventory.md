# Phase 6 Slice 3b-2a: Items, Inventory, Equipment & Damage Types — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make items real — a generalized `item_types` catalog (weapons + armor), account-wide item instances, an 8-slot paper-doll with a two-handed rule, and a damage-type pipeline (elements + resistances) — retiring the 3b-1 number-key weapon stand-in.

**Architecture:** The authority gains an account-scoped layer (`items.js`) beside its per-world layer. Equipment determines the active weapon. All damage to players funnels through one pure helper (`damage.js applyDamage`) called by both the melee and projectile resolvers. A session registry enforces one live socket per account (newest-wins).

**Tech Stack:** Node.js (CommonJS) authority, `node-pg-migrate`, `ws`, `node --test`; frontend Vite/React ESM, Vitest (env `node`, no jsdom — render layer verified by build + browser), styled-components, TanStack Query.

## Global Constraints

- Server owns all item state: ownership, equipment legality, mitigation, active weapon. Client sends item/slot **ids** only — never stats, damage, defense, or resistances.
- **One** mitigation path: `damage.js applyDamage(target, raw, element, mit)`. The melee resolver and the projectile resolver must BOTH call it for player damage. Neither may compute damage independently.
- Inventory and equipment are **account-wide** (`user_id`), independent of world.
- Exactly one live authority socket per account; a new join kicks the older (**newest-wins**). A kicked socket's late `close` must not evict the new session (identity check).
- `ELEMENTS = ['physical','arcane','fire','ice','lightning']`; `element` constrained at the DB and API; `resistances` keys must be within that set.
- Category-conditional CHECKs at the **DB** level (not only the API), so the editor cannot author an invalid/unhittable item.
- `MIN_DAMAGE = 1` (damage floor), `RESIST_CAP = 0.8` (nothing is immune).
- The 3b-1 number-key switch and `equip{weaponId}` are **removed**, not left alongside.
- Slots: `main_hand, off_hand, head, chest, hands, feet, ring1, ring2`.
- Backend tests: `cd backend && node --test tests/<file>`. Frontend: `cd frontend && npx vitest run <file>`.

## Seeded data (authoritative — used verbatim)

Existing 4 weapon rows are backfilled `category='weapon'`, `slot='main_hand'`; `halberd.two_handed=true` (others false). New armor seed:

| name | category | slot | defense | resistances |
|------|----------|------|---------|-------------|
| leather-vest | armor | chest | 2 | `{}` |
| arcane-ward | armor | head | 1 | `{"arcane":0.3}` |

Starting loadout: one `dagger` + one `leather-vest`.

---

### Task 1: Migration — item_types, player_items, player_equipment

**Files:**
- Create: `backend/migrations/1714440017000_items_inventory.js`

**Interfaces:**
- Produces: table `item_types` (renamed from `weapon_types`, extended), `player_items`, `player_equipment`.

- [ ] **Step 1: Write the migration**

Create `backend/migrations/1714440017000_items_inventory.js`:

```js
const ELEMENTS = ['physical', 'arcane', 'fire', 'ice', 'lightning'];
const SLOTS = ['main_hand', 'off_hand', 'head', 'chest', 'hands', 'feet', 'ring1', 'ring2'];

exports.up = (pgm) => {
  // 1. Generalize the weapon catalog into an item catalog.
  pgm.renameTable('weapon_types', 'item_types');
  pgm.addColumns('item_types', {
    category: { type: 'text', notNull: true, default: 'weapon' },
    slot: { type: 'text' },
    two_handed: { type: 'boolean', notNull: true, default: false },
    defense: { type: 'real' },
    resistances: { type: 'jsonb' },
  });
  pgm.sql(`UPDATE item_types SET slot = 'main_hand' WHERE category = 'weapon' AND slot IS NULL;`);
  pgm.sql(`UPDATE item_types SET two_handed = true WHERE name = 'halberd';`);
  pgm.alterColumn('item_types', 'category', { default: null });

  pgm.addConstraint('item_types', 'item_types_category_check',
    "CHECK (category IN ('weapon','armor'))");
  pgm.addConstraint('item_types', 'item_types_slot_check',
    `CHECK (slot IS NULL OR slot IN (${SLOTS.map((s) => `'${s}'`).join(',')}))`);
  pgm.addConstraint('item_types', 'item_types_element_check',
    `CHECK (element IS NULL OR element IN (${ELEMENTS.map((e) => `'${e}'`).join(',')}))`);
  // Category-conditional required fields — the DB must reject an item that can never work.
  pgm.addConstraint('item_types', 'item_types_weapon_fields_check', `CHECK (
    category <> 'weapon' OR (
      kind IS NOT NULL
      AND (kind <> 'melee' OR (reach IS NOT NULL AND arc_width IS NOT NULL))
      AND (kind <> 'projectile' OR (range IS NOT NULL AND projectile_speed IS NOT NULL AND projectile_radius IS NOT NULL))
    ))`);
  pgm.addConstraint('item_types', 'item_types_armor_fields_check',
    "CHECK (category <> 'armor' OR (slot IS NOT NULL AND defense IS NOT NULL))");

  pgm.sql(`
    INSERT INTO item_types (name, category, slot, defense, resistances, kind, damage, cooldown, mana_cost)
    VALUES
      ('leather-vest', 'armor', 'chest', 2, '{}'::jsonb,                 NULL, 0, 0, 0),
      ('arcane-ward',  'armor', 'head',  1, '{"arcane":0.3}'::jsonb,     NULL, 0, 0, 0)
    ON CONFLICT (name) DO NOTHING;
  `);

  // 2. Account-wide item instances.
  pgm.createTable('player_items', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'text', notNull: true },
    item_type_id: { type: 'integer', notNull: true, references: 'item_types', onDelete: 'CASCADE' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('player_items', 'user_id');

  // 3. Account-wide paper-doll. An instance may occupy at most one slot.
  pgm.createTable('player_equipment', {
    user_id: { type: 'text', notNull: true },
    slot: { type: 'text', notNull: true },
    item_id: { type: 'uuid', notNull: true, references: 'player_items', onDelete: 'CASCADE' },
  }, {
    constraints: { primaryKey: ['user_id', 'slot'] },
  });
  pgm.addConstraint('player_equipment', 'player_equipment_slot_check',
    `CHECK (slot IN (${SLOTS.map((s) => `'${s}'`).join(',')}))`);
  pgm.addConstraint('player_equipment', 'player_equipment_item_unique', { unique: ['item_id'] });
};

exports.down = (pgm) => {
  pgm.dropTable('player_equipment');
  pgm.dropTable('player_items');
  pgm.sql(`DELETE FROM item_types WHERE name IN ('leather-vest','arcane-ward');`);
  pgm.dropConstraint('item_types', 'item_types_armor_fields_check');
  pgm.dropConstraint('item_types', 'item_types_weapon_fields_check');
  pgm.dropConstraint('item_types', 'item_types_element_check');
  pgm.dropConstraint('item_types', 'item_types_slot_check');
  pgm.dropConstraint('item_types', 'item_types_category_check');
  pgm.dropColumns('item_types', ['category', 'slot', 'two_handed', 'defense', 'resistances']);
  pgm.renameTable('item_types', 'weapon_types');
};
```

- [ ] **Step 2: Apply it**

Run: `cd backend && npm run migrate:up` (or `docker exec something2-backend-1 npm run migrate:up` if using the container).
Expected: applies cleanly. Verify:
```bash
docker exec something2-backend-1 node -e "
const {Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL});
p.query('SELECT id,name,category,slot,two_handed,defense,resistances FROM item_types ORDER BY id').then(r=>{console.table(r.rows);return p.end();});"
```
Expected: 4 weapons (`category='weapon'`, `slot='main_hand'`, halberd `two_handed=true`) + `leather-vest` + `arcane-ward`.

- [ ] **Step 3: Commit**

```bash
git add backend/migrations/1714440017000_items_inventory.js
git commit -m "feat(db): item_types catalog + account-wide player_items/player_equipment"
```

---

### Task 2: `damage.js` — the single mitigation path

**Files:**
- Create: `backend/src/authority/damage.js`
- Test: `backend/tests/authority_damage.test.js`

**Interfaces:**
- Produces: `applyDamage(target, raw, element, mit) -> number` (mutates `target.hp`, returns damage applied); `MIN_DAMAGE`, `RESIST_CAP`, `ELEMENTS`, `NO_MITIGATION`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/authority_damage.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { applyDamage, MIN_DAMAGE, RESIST_CAP, ELEMENTS, NO_MITIGATION } = require('../src/authority/damage.js');

const t = (hp = 100) => ({ hp });

test('with no mitigation, damage passes through unchanged', () => {
  const x = t();
  assert.equal(applyDamage(x, 10, 'physical', NO_MITIGATION), 10);
  assert.equal(x.hp, 90);
});

test('flat defense subtracts before resistance', () => {
  const x = t();
  const dealt = applyDamage(x, 10, 'physical', { defense: 4, resistances: {} });
  assert.equal(dealt, 6);
  assert.equal(x.hp, 94);
});

test('resistance scales the post-defense damage for the matching element', () => {
  const x = t();
  const dealt = applyDamage(x, 20, 'arcane', { defense: 0, resistances: { arcane: 0.5 } });
  assert.equal(dealt, 10);
});

test('resistance for a different element does not apply', () => {
  const x = t();
  assert.equal(applyDamage(x, 20, 'fire', { defense: 0, resistances: { arcane: 0.5 } }), 20);
});

test('total resistance is capped at RESIST_CAP (never immune)', () => {
  const x = t();
  const dealt = applyDamage(x, 100, 'ice', { defense: 0, resistances: { ice: 5 } }); // absurd resist
  assert.equal(dealt, 100 * (1 - RESIST_CAP));
  assert.ok(dealt > 0);
});

test('damage is floored at MIN_DAMAGE even against huge defense', () => {
  const x = t();
  assert.equal(applyDamage(x, 5, 'physical', { defense: 999, resistances: {} }), MIN_DAMAGE);
  assert.equal(x.hp, 100 - MIN_DAMAGE);
});

test('a missing/unknown element is treated as physical with no resistance', () => {
  const x = t();
  assert.equal(applyDamage(x, 10, null, { defense: 0, resistances: { physical: 0.5 } }), 5);
  const y = t();
  assert.equal(applyDamage(y, 10, 'nonsense', { defense: 0, resistances: { arcane: 0.5 } }), 10);
});

test('ELEMENTS lists the supported set with physical first', () => {
  assert.deepEqual(ELEMENTS, ['physical', 'arcane', 'fire', 'ice', 'lightning']);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && node --test tests/authority_damage.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `backend/src/authority/damage.js`:

```js
// The SINGLE mitigation path for damage dealt to an equipped actor (players).
// Both the melee resolver (world.js) and the projectile resolver
// (projectiles.js) must call this — they must never compute damage
// independently, or the two paths drift.

const MIN_DAMAGE = 1;    // damage floor: nothing is ever fully negated
const RESIST_CAP = 0.8;  // resistance ceiling: nothing is ever immune
const ELEMENTS = ['physical', 'arcane', 'fire', 'ice', 'lightning'];
const NO_MITIGATION = { defense: 0, resistances: {} };

// Reduce `raw` by the target's mitigation, apply it to target.hp, return the
// amount actually dealt. `element` defaults to 'physical'; an element with no
// matching resistance takes full (post-defense) damage.
function applyDamage(target, raw, element, mit = NO_MITIGATION) {
  const el = ELEMENTS.includes(element) ? element : 'physical';
  const defense = mit.defense || 0;
  const raw2 = raw - defense;
  const resist = Math.min(RESIST_CAP, (mit.resistances && mit.resistances[el]) || 0);
  const final = Math.max(MIN_DAMAGE, raw2 * (1 - resist));
  target.hp -= final;
  return final;
}

module.exports = { applyDamage, MIN_DAMAGE, RESIST_CAP, ELEMENTS, NO_MITIGATION };
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && node --test tests/authority_damage.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/damage.js backend/tests/authority_damage.test.js
git commit -m "feat(authority): single damage-mitigation path (defense + element resistance)"
```

---

### Task 3: `items.js` — catalog loader (replaces `loadWeaponTypes`)

**Files:**
- Create: `backend/src/authority/items.js`
- Modify: `backend/src/authority/weapons.js` (remove `loadWeaponTypes`/`resolveDefaultWeaponId`; keep the pure geometry helpers)
- Modify: `backend/tests/authority_weapons_catalog.test.js` → delete (superseded) or retarget; see Step 1
- Test: `backend/tests/authority_items_catalog.test.js`

**Interfaces:**
- Consumes: `pool.query`.
- Produces: `loadItemTypes(pool) -> Promise<Map<id, itemType>>`; `resolveDefaultWeaponId(mapById) -> id` (the `dagger` weapon, else the first weapon); `DEFAULT_WEAPON_NAME = 'dagger'`; `SLOTS`.
- `weapons.js` keeps: `normalizeAim`, `inArc`, `vectorFromFacing`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/authority_items_catalog.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { loadItemTypes, resolveDefaultWeaponId, SLOTS } = require('../src/authority/items.js');

function fakePool(rows) {
  return { query: async (sql) => { assert.match(sql, /FROM item_types/i); return { rows }; } };
}

const ROWS = [
  { id: 1, name: 'dagger', category: 'weapon', slot: 'main_hand', two_handed: false, kind: 'melee',
    damage: '8', cooldown: '0.3', reach: '80', arc_width: '0.6', range: null, projectile_speed: null,
    projectile_radius: null, pierce: null, mana_cost: '0', element: null, defense: null, resistances: null },
  { id: 2, name: 'halberd', category: 'weapon', slot: 'main_hand', two_handed: true, kind: 'melee',
    damage: '18', cooldown: '0.9', reach: '190', arc_width: '1.8', range: null, projectile_speed: null,
    projectile_radius: null, pierce: null, mana_cost: '0', element: null, defense: null, resistances: null },
  { id: 5, name: 'leather-vest', category: 'armor', slot: 'chest', two_handed: false, kind: null,
    damage: '0', cooldown: '0', reach: null, arc_width: null, range: null, projectile_speed: null,
    projectile_radius: null, pierce: null, mana_cost: '0', element: null, defense: '2', resistances: {} },
  { id: 6, name: 'arcane-ward', category: 'armor', slot: 'head', two_handed: false, kind: null,
    damage: '0', cooldown: '0', reach: null, arc_width: null, range: null, projectile_speed: null,
    projectile_radius: null, pierce: null, mana_cost: '0', element: null, defense: '1', resistances: { arcane: 0.3 } },
];

test('loadItemTypes maps weapons and armor, coercing numbers and defaulting resistances', async () => {
  const m = await loadItemTypes(fakePool(ROWS));
  assert.equal(m.size, 4);
  const dagger = m.get(1);
  assert.equal(dagger.category, 'weapon');
  assert.strictEqual(dagger.damage, 8);
  assert.strictEqual(dagger.reach, 80);
  assert.strictEqual(dagger.two_handed, false);
  assert.deepEqual(dagger.resistances, {});      // null -> {}
  const halberd = m.get(2);
  assert.strictEqual(halberd.two_handed, true);
  const vest = m.get(5);
  assert.equal(vest.category, 'armor');
  assert.equal(vest.slot, 'chest');
  assert.strictEqual(vest.defense, 2);
  const ward = m.get(6);
  assert.deepEqual(ward.resistances, { arcane: 0.3 });
});

test('resolveDefaultWeaponId returns the dagger weapon id', async () => {
  const m = await loadItemTypes(fakePool(ROWS));
  assert.equal(resolveDefaultWeaponId(m), 1);
});

test('resolveDefaultWeaponId falls back to the first WEAPON, never armor', async () => {
  const m = await loadItemTypes(fakePool(ROWS.filter((r) => r.name !== 'dagger')));
  assert.equal(resolveDefaultWeaponId(m), 2); // halberd, not leather-vest
});

test('SLOTS lists the eight paper-doll slots', () => {
  assert.deepEqual(SLOTS, ['main_hand', 'off_hand', 'head', 'chest', 'hands', 'feet', 'ring1', 'ring2']);
});
```

Then **delete** the superseded `backend/tests/authority_weapons_catalog.test.js` (its `loadWeaponTypes` is being removed) — its coverage is replaced by the above.

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && node --test tests/authority_items_catalog.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `items.js` (catalog part) and trim `weapons.js`**

Create `backend/src/authority/items.js`:

```js
// Account-scoped item layer: the generalized item catalog plus a user's
// inventory and paper-doll equipment. Inventory/equipment are keyed by
// user_id and are independent of any world.

const DEFAULT_WEAPON_NAME = 'dagger';
const SLOTS = ['main_hand', 'off_hand', 'head', 'chest', 'hands', 'feet', 'ring1', 'ring2'];

function num(v) { return v == null ? null : Number(v); }

// Load the whole item catalog (weapons + armor) keyed by id.
async function loadItemTypes(pool) {
  const r = await pool.query(
    `SELECT id, name, category, slot, two_handed, kind, damage, cooldown, reach, arc_width,
            range, projectile_speed, projectile_radius, pierce, mana_cost, element,
            defense, resistances
     FROM item_types ORDER BY id ASC`,
  );
  const m = new Map();
  for (const row of r.rows) {
    m.set(row.id, {
      id: row.id,
      name: row.name,
      category: row.category,
      slot: row.slot ?? null,
      two_handed: row.two_handed === true,
      kind: row.kind ?? null,
      damage: Number(row.damage ?? 0),
      cooldown: Number(row.cooldown ?? 0),
      reach: num(row.reach),
      arc_width: num(row.arc_width),
      range: num(row.range),
      projectile_speed: num(row.projectile_speed),
      projectile_radius: num(row.projectile_radius),
      pierce: num(row.pierce),
      mana_cost: Number(row.mana_cost ?? 0),
      element: row.element ?? null,
      defense: Number(row.defense ?? 0),
      resistances: row.resistances || {},
    });
  }
  return m;
}

// The default active weapon: the dagger, else the first WEAPON (never armor).
function resolveDefaultWeaponId(mapById) {
  let firstWeapon = null;
  for (const [id, t] of mapById) {
    if (t.category !== 'weapon') continue;
    if (t.name === DEFAULT_WEAPON_NAME) return id;
    if (firstWeapon === null) firstWeapon = id;
  }
  return firstWeapon;
}

module.exports = { loadItemTypes, resolveDefaultWeaponId, DEFAULT_WEAPON_NAME, SLOTS };
```

In `backend/src/authority/weapons.js`: delete `num`, `loadWeaponTypes`, `resolveDefaultWeaponId`, and `DEFAULT_WEAPON_NAME`; leave `vectorFromFacing`, `normalizeAim`, `inArc`. Final export line:

```js
module.exports = { normalizeAim, inArc, vectorFromFacing };
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && node --test tests/authority_items_catalog.test.js tests/authority_weapons.test.js`
Expected: PASS. (`authority_weapons.test.js` may import `DEFAULT_WEAPON_NAME` — if so, drop that import and its assertion; the constant now lives in `items.js` and is covered by the catalog tests.)

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/items.js backend/src/authority/weapons.js backend/tests/authority_items_catalog.test.js backend/tests/authority_weapons.test.js
git rm -f backend/tests/authority_weapons_catalog.test.js
git commit -m "feat(authority): generalized item catalog loader (items.js), trim weapons.js to geometry"
```

---

### Task 4: `items.js` — inventory load + starting loadout

**Files:**
- Modify: `backend/src/authority/items.js` (append)
- Test: `backend/tests/authority_items_inventory.test.js`

**Interfaces:**
- Produces: `loadInventory(pool, userId) -> {items:[{id,typeId}], equipment:{slot:itemId}}`; `grantStartingLoadout(pool, userId, itemTypes) -> Promise<boolean>`; `STARTING_LOADOUT = ['dagger','leather-vest']`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/authority_items_inventory.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { loadInventory, grantStartingLoadout, STARTING_LOADOUT } = require('../src/authority/items.js');

// Records queries so we can assert what was written.
function recordingPool(handlers) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      for (const [re, fn] of handlers) if (re.test(sql)) return fn(sql, params);
      return { rows: [], rowCount: 0 };
    },
  };
}

test('loadInventory returns owned instances and the equipment map', async () => {
  const pool = recordingPool([
    [/FROM player_items/i, () => ({ rows: [
      { id: 'i1', item_type_id: 1 },
      { id: 'i2', item_type_id: 5 },
    ] })],
    [/FROM player_equipment/i, () => ({ rows: [
      { slot: 'main_hand', item_id: 'i1' },
    ] })],
  ]);
  const inv = await loadInventory(pool, 'u1');
  assert.deepEqual(inv.items, [{ id: 'i1', typeId: 1 }, { id: 'i2', typeId: 5 }]);
  assert.deepEqual(inv.equipment, { main_hand: 'i1' });
});

test('grantStartingLoadout inserts the starter set for a user with no items', async () => {
  const inserts = [];
  const pool = recordingPool([
    [/SELECT .* FROM player_items/i, () => ({ rows: [] })],          // no items yet
    [/INSERT INTO player_items/i, (sql, p) => { inserts.push(p); return { rows: [{ id: 'new' }] }; }],
  ]);
  const itemTypes = new Map([
    [1, { id: 1, name: 'dagger', category: 'weapon' }],
    [5, { id: 5, name: 'leather-vest', category: 'armor' }],
  ]);
  const granted = await grantStartingLoadout(pool, 'u1', itemTypes);
  assert.equal(granted, true);
  assert.equal(inserts.length, STARTING_LOADOUT.length);
  // each insert carries (user_id, item_type_id)
  assert.deepEqual(inserts.map((p) => p[0]), ['u1', 'u1']);
  assert.deepEqual(inserts.map((p) => p[1]).sort(), [1, 5]);
});

test('grantStartingLoadout is a no-op when the user already owns items', async () => {
  let inserted = 0;
  const pool = recordingPool([
    [/SELECT .* FROM player_items/i, () => ({ rows: [{ id: 'i1' }] })], // already has items
    [/INSERT INTO player_items/i, () => { inserted++; return { rows: [] }; }],
  ]);
  const granted = await grantStartingLoadout(pool, 'u1', new Map([[1, { id: 1, name: 'dagger' }]]));
  assert.equal(granted, false);
  assert.equal(inserted, 0);
});

test('grantStartingLoadout skips loadout entries missing from the catalog (no crash)', async () => {
  const inserts = [];
  const pool = recordingPool([
    [/SELECT .* FROM player_items/i, () => ({ rows: [] })],
    [/INSERT INTO player_items/i, (sql, p) => { inserts.push(p); return { rows: [] }; }],
  ]);
  const granted = await grantStartingLoadout(pool, 'u1', new Map([[1, { id: 1, name: 'dagger' }]]));
  assert.equal(granted, true);
  assert.equal(inserts.length, 1); // only the dagger existed
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && node --test tests/authority_items_inventory.test.js`
Expected: FAIL — `loadInventory is not a function`.

- [ ] **Step 3: Append to `items.js`**

```js
const STARTING_LOADOUT = ['dagger', 'leather-vest'];

// A user's owned instances + their paper-doll, both account-wide.
async function loadInventory(pool, userId) {
  const ir = await pool.query(
    'SELECT id, item_type_id FROM player_items WHERE user_id = $1 ORDER BY created_at ASC, id ASC',
    [userId],
  );
  const er = await pool.query(
    'SELECT slot, item_id FROM player_equipment WHERE user_id = $1',
    [userId],
  );
  const equipment = {};
  for (const row of er.rows) equipment[row.slot] = row.item_id;
  return { items: ir.rows.map((r) => ({ id: r.id, typeId: r.item_type_id })), equipment };
}

// Grant the starter set to a user who owns nothing. Idempotent: a user with
// any item is left alone. Returns whether anything was granted.
async function grantStartingLoadout(pool, userId, itemTypes) {
  const existing = await pool.query('SELECT id FROM player_items WHERE user_id = $1 LIMIT 1', [userId]);
  if (existing.rows.length) return false;
  const byName = new Map();
  for (const t of itemTypes.values()) byName.set(t.name, t.id);
  for (const name of STARTING_LOADOUT) {
    const typeId = byName.get(name);
    if (typeId == null) continue; // catalog missing this type -> skip, don't crash
    await pool.query(
      'INSERT INTO player_items (user_id, item_type_id) VALUES ($1, $2)',
      [userId, typeId],
    );
  }
  return true;
}
```

Add `loadInventory, grantStartingLoadout, STARTING_LOADOUT` to `module.exports`.

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && node --test tests/authority_items_inventory.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/items.js backend/tests/authority_items_inventory.test.js
git commit -m "feat(authority): account-wide inventory load + idempotent starting loadout"
```

---

### Task 5: `items.js` — equip legality, equip/unequip, mitigation

**Files:**
- Modify: `backend/src/authority/items.js` (append)
- Test: `backend/tests/authority_items_equip.test.js`

**Interfaces:**
- Produces (pure): `canEquip(inv, itemTypes, itemId, slot) -> {ok, reason?}`; `mitigation(inv, itemTypes) -> {defense, resistances}`; `activeWeaponType(inv, itemTypes, defaultWeaponId) -> itemType|null`.
- Produces (DB): `equip(pool, userId, inv, itemTypes, itemId, slot) -> {ok, reason?}`; `unequip(pool, userId, inv, slot) -> {ok}`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/authority_items_equip.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { canEquip, mitigation, activeWeaponType, equip, unequip } = require('../src/authority/items.js');

const TYPES = new Map([
  [1, { id: 1, name: 'dagger',       category: 'weapon', slot: 'main_hand', two_handed: false, damage: 8, resistances: {}, defense: 0 }],
  [2, { id: 2, name: 'halberd',      category: 'weapon', slot: 'main_hand', two_handed: true,  damage: 18, resistances: {}, defense: 0 }],
  [5, { id: 5, name: 'leather-vest', category: 'armor',  slot: 'chest',     two_handed: false, defense: 2, resistances: {} }],
  [6, { id: 6, name: 'arcane-ward',  category: 'armor',  slot: 'head',      two_handed: false, defense: 1, resistances: { arcane: 0.3 } }],
]);

// u1 owns: i1 dagger, i2 halberd, i5 vest, i6 ward
const inv = () => ({
  items: [{ id: 'i1', typeId: 1 }, { id: 'i2', typeId: 2 }, { id: 'i5', typeId: 5 }, { id: 'i6', typeId: 6 }],
  equipment: {},
});

test('canEquip rejects an item the user does not own', () => {
  const r = canEquip(inv(), TYPES, 'nope', 'main_hand');
  assert.equal(r.ok, false);
  assert.match(r.reason, /own/i);
});

test('canEquip rejects a slot/category mismatch', () => {
  assert.equal(canEquip(inv(), TYPES, 'i5', 'main_hand').ok, false); // chest armor into main_hand
  assert.equal(canEquip(inv(), TYPES, 'i1', 'head').ok, false);      // weapon into head
  assert.equal(canEquip(inv(), TYPES, 'i6', 'chest').ok, false);     // head armor into chest
});

test('canEquip allows a one-handed weapon in either hand, armor in its own slot', () => {
  assert.equal(canEquip(inv(), TYPES, 'i1', 'main_hand').ok, true);
  assert.equal(canEquip(inv(), TYPES, 'i1', 'off_hand').ok, true);
  assert.equal(canEquip(inv(), TYPES, 'i5', 'chest').ok, true);
});

test('canEquip refuses a two-handed weapon in the off hand', () => {
  assert.equal(canEquip(inv(), TYPES, 'i2', 'off_hand').ok, false);
});

test('canEquip refuses filling off_hand while a two-handed weapon is held', () => {
  const i = inv();
  i.equipment = { main_hand: 'i2' }; // halberd (two-handed)
  const r = canEquip(i, TYPES, 'i1', 'off_hand');
  assert.equal(r.ok, false);
  assert.match(r.reason, /two[- ]handed/i);
});

test('mitigation sums equipped armor defense and merges resistances', () => {
  const i = inv();
  i.equipment = { chest: 'i5', head: 'i6', main_hand: 'i1' };
  const m = mitigation(i, TYPES);
  assert.equal(m.defense, 3);                   // 2 + 1 (weapon contributes none)
  assert.deepEqual(m.resistances, { arcane: 0.3 });
});

test('mitigation of an empty paper-doll is zero', () => {
  const m = mitigation(inv(), TYPES);
  assert.equal(m.defense, 0);
  assert.deepEqual(m.resistances, {});
});

test('activeWeaponType resolves main_hand, else the default', () => {
  const i = inv();
  i.equipment = { main_hand: 'i2' };
  assert.equal(activeWeaponType(i, TYPES, 1).id, 2);
  assert.equal(activeWeaponType(inv(), TYPES, 1).id, 1); // empty -> default
});

// --- DB-backed behaviour ---
function fakePool() {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rows: [], rowCount: 0 }; } };
}

test('equip writes through and updates the in-memory inventory', async () => {
  const pool = fakePool(); const i = inv();
  const r = await equip(pool, 'u1', i, TYPES, 'i1', 'main_hand');
  assert.equal(r.ok, true);
  assert.equal(i.equipment.main_hand, 'i1');
  assert.ok(pool.calls.some((c) => /INSERT INTO player_equipment/i.test(c.sql)));
});

test('equipping a two-handed weapon clears the off hand', async () => {
  const pool = fakePool(); const i = inv();
  i.equipment = { off_hand: 'i1' };
  const r = await equip(pool, 'u1', i, TYPES, 'i2', 'main_hand'); // halberd
  assert.equal(r.ok, true);
  assert.equal(i.equipment.main_hand, 'i2');
  assert.equal(i.equipment.off_hand, undefined, 'off hand cleared by two-handed');
});

test('equipping an already-equipped instance moves it between slots', async () => {
  const pool = fakePool(); const i = inv();
  i.equipment = { main_hand: 'i1' };
  await equip(pool, 'u1', i, TYPES, 'i1', 'off_hand');
  assert.equal(i.equipment.off_hand, 'i1');
  assert.equal(i.equipment.main_hand, undefined, 'vacated the previous slot');
});

test('a rejected equip changes nothing', async () => {
  const pool = fakePool(); const i = inv();
  i.equipment = { main_hand: 'i1' };
  const r = await equip(pool, 'u1', i, TYPES, 'i5', 'main_hand'); // armor into main_hand
  assert.equal(r.ok, false);
  assert.equal(i.equipment.main_hand, 'i1');
  assert.ok(!pool.calls.some((c) => /INSERT INTO player_equipment/i.test(c.sql)));
});

test('unequip clears the slot and deletes the row', async () => {
  const pool = fakePool(); const i = inv();
  i.equipment = { chest: 'i5' };
  await unequip(pool, 'u1', i, 'chest');
  assert.equal(i.equipment.chest, undefined);
  assert.ok(pool.calls.some((c) => /DELETE FROM player_equipment/i.test(c.sql)));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && node --test tests/authority_items_equip.test.js`
Expected: FAIL — `canEquip is not a function`.

- [ ] **Step 3: Append to `items.js`**

```js
const HAND_SLOTS = ['main_hand', 'off_hand'];

function findItem(inv, itemId) { return inv.items.find((it) => it.id === itemId) || null; }

// Pure legality check. Returns {ok:true} or {ok:false, reason}.
function canEquip(inv, itemTypes, itemId, slot) {
  if (!SLOTS.includes(slot)) return { ok: false, reason: 'unknown slot' };
  const item = findItem(inv, itemId);
  if (!item) return { ok: false, reason: 'you do not own that item' };
  const type = itemTypes.get(item.typeId);
  if (!type) return { ok: false, reason: 'unknown item type' };

  if (type.category === 'weapon') {
    if (!HAND_SLOTS.includes(slot)) return { ok: false, reason: 'weapons go in a hand slot' };
    if (slot === 'off_hand' && type.two_handed) return { ok: false, reason: 'two-handed weapon needs the main hand' };
    if (slot === 'off_hand') {
      const mh = inv.equipment.main_hand;
      const mhType = mh ? itemTypes.get((findItem(inv, mh) || {}).typeId) : null;
      if (mhType && mhType.two_handed) return { ok: false, reason: 'a two-handed weapon is equipped' };
    }
    return { ok: true };
  }

  // armor: must go in its own slot
  if (type.slot !== slot) return { ok: false, reason: `that item goes in ${type.slot}` };
  return { ok: true };
}

// Sum equipped ARMOR defense and merge resistances per element.
function mitigation(inv, itemTypes) {
  let defense = 0;
  const resistances = {};
  for (const slot of SLOTS) {
    const itemId = inv.equipment[slot];
    if (!itemId) continue;
    const item = findItem(inv, itemId);
    if (!item) continue;
    const type = itemTypes.get(item.typeId);
    if (!type || type.category !== 'armor') continue;
    defense += type.defense || 0;
    for (const [el, v] of Object.entries(type.resistances || {})) {
      resistances[el] = (resistances[el] || 0) + v;
    }
  }
  return { defense, resistances };
}

// The item type driving attacks: whatever is in main_hand, else the default.
function activeWeaponType(inv, itemTypes, defaultWeaponId) {
  const itemId = inv.equipment.main_hand;
  if (itemId) {
    const item = findItem(inv, itemId);
    const type = item ? itemTypes.get(item.typeId) : null;
    if (type && type.category === 'weapon') return type;
  }
  return itemTypes.get(defaultWeaponId) || null;
}

// Equip with write-through. Clears any slot the instance currently occupies and,
// for a two-handed weapon, the off hand.
async function equip(pool, userId, inv, itemTypes, itemId, slot) {
  const check = canEquip(inv, itemTypes, itemId, slot);
  if (!check.ok) return check;

  const type = itemTypes.get(findItem(inv, itemId).typeId);
  const toClear = [];
  for (const s of SLOTS) if (inv.equipment[s] === itemId && s !== slot) toClear.push(s);
  if (slot === 'main_hand' && type.two_handed && inv.equipment.off_hand) toClear.push('off_hand');

  for (const s of toClear) {
    await pool.query('DELETE FROM player_equipment WHERE user_id = $1 AND slot = $2', [userId, s]);
    delete inv.equipment[s];
  }
  await pool.query(
    `INSERT INTO player_equipment (user_id, slot, item_id) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, slot) DO UPDATE SET item_id = $3`,
    [userId, slot, itemId],
  );
  inv.equipment[slot] = itemId;
  return { ok: true };
}

async function unequip(pool, userId, inv, slot) {
  if (!SLOTS.includes(slot)) return { ok: false, reason: 'unknown slot' };
  await pool.query('DELETE FROM player_equipment WHERE user_id = $1 AND slot = $2', [userId, slot]);
  delete inv.equipment[slot];
  return { ok: true };
}
```

Add `canEquip, mitigation, activeWeaponType, equip, unequip` to `module.exports`.

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && node --test tests/authority_items_equip.test.js`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/items.js backend/tests/authority_items_equip.test.js
git commit -m "feat(authority): equip legality (ownership/slot/two-handed), write-through, mitigation"
```

---

### Task 6: `World` — inventory-driven weapon, mitigated player damage, equipment in snapshot

**Files:**
- Modify: `backend/src/authority/world.js`
- Test: `backend/tests/authority_world_items.test.js`

**Interfaces:**
- Consumes: `items.js` (`activeWeaponType`, `mitigation`, `equip`, `unequip`), `damage.js` (`applyDamage`).
- Produces: `addPlayer(userId, spawn, inv)`; `setEquipment(pool, userId, itemId, slot)`, `clearEquipment(pool, userId, slot)`; `PlayerState.inv`/`.mit`; `snapshot()` players gain `equipment`. **Removes** `setWeapon` and `PlayerState.weaponId`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/authority_world_items.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { World } = require('../src/authority/world.js');

const TYPES = new Map([
  [1, { id: 1, name: 'dagger', category: 'weapon', slot: 'main_hand', two_handed: false, kind: 'melee',
        damage: 10, cooldown: 0.3, reach: 200, arc_width: 3.0, mana_cost: 0, element: null, defense: 0, resistances: {} }],
  [3, { id: 3, name: 'bow', category: 'weapon', slot: 'main_hand', two_handed: false, kind: 'projectile',
        damage: 10, cooldown: 0.05, range: 2000, projectile_speed: 4000, projectile_radius: 40, pierce: 1,
        mana_cost: 0, element: null, defense: 0, resistances: {} }],
  [5, { id: 5, name: 'leather-vest', category: 'armor', slot: 'chest', two_handed: false,
        defense: 4, resistances: {}, damage: 0, cooldown: 0, mana_cost: 0, element: null }],
]);

function armWorld() {
  const map = { chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] };
  return new World(map, TYPES, 1);
}
const emptyInv = () => ({ items: [], equipment: {} });
const armoredInv = () => ({ items: [{ id: 'a5', typeId: 5 }], equipment: { chest: 'a5' } });

test('a player with no equipment uses the default weapon', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 }, emptyInv());
  assert.equal(w.activeWeapon('u1').id, 1);
});

test('main_hand equipment determines the active weapon', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 }, { items: [{ id: 'b3', typeId: 3 }], equipment: { main_hand: 'b3' } });
  assert.equal(w.activeWeapon('u1').id, 3);
});

test('MELEE player damage is mitigated by the target armor', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, emptyInv());      // attacker, dagger dmg 10
  w.addPlayer('u2', { x: 150, y: 100 }, armoredInv());    // defender, chest defense 4
  const before = w.getPlayer('u2').hp;
  w.attack('u1', 1, 0);
  assert.equal(before - w.getPlayer('u2').hp, 6, '10 raw - 4 defense');
});

test('PROJECTILE player damage is mitigated by the SAME path (paths must not drift)', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 }, { items: [{ id: 'b3', typeId: 3 }], equipment: { main_hand: 'b3' } });
  w.addPlayer('u2', { x: 200, y: -32 }, armoredInv());    // center (232,0); attacker center (32,32)
  // aim from u1 center toward u2 center
  const p = w.getPlayer('u1'), q = w.getPlayer('u2');
  const ax = (q.x + q.width / 2) - (p.x + p.width / 2);
  const ay = (q.y + q.height / 2) - (p.y + p.height / 2);
  const before = q.hp;
  w.attack('u1', ax, ay);
  for (let i = 0; i < 30 && q.hp === before; i++) w.tickProjectiles(0.02);
  assert.equal(before - q.hp, 6, 'bow 10 raw - 4 defense, same mitigation as melee');
});

test('snapshot exposes each player equipment map', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 }, armoredInv());
  const pl = w.snapshot().players[0];
  assert.deepEqual(pl.equipment, { chest: 'a5' });
  assert.equal(pl.weaponId, undefined, 'weaponId is retired');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && node --test tests/authority_world_items.test.js`
Expected: FAIL — `addPlayer` ignores the inv arg / `activeWeapon` missing / damage unmitigated.

- [ ] **Step 3: Edit `world.js`**

Add requires:

```js
const { applyDamage, NO_MITIGATION } = require('./damage');
const { activeWeaponType, mitigation, equip: equipItem, unequip: unequipItem } = require('./items');
```

`addPlayer(userId, spawn, inv = { items: [], equipment: {} })` — replace the `weaponId` field with:

```js
      inv,
      mit: mitigation(inv, this.weapons),
```
(keep `hp/maxHp/mana/maxMana/spawn/_attackCd` as-is; **delete** `weaponId`).

Add helpers and replace `setWeapon`:

```js
  activeWeapon(userId) {
    const p = this.players.get(userId);
    if (!p) return null;
    return activeWeaponType(p.inv, this.weapons, this.defaultWeaponId);
  }

  async setEquipment(pool, userId, itemId, slot) {
    const p = this.players.get(userId);
    if (!p) return { ok: false, reason: 'no player' };
    const r = await equipItem(pool, userId, p.inv, this.weapons, itemId, slot);
    if (r.ok) p.mit = mitigation(p.inv, this.weapons);
    return r;
  }

  async clearEquipment(pool, userId, slot) {
    const p = this.players.get(userId);
    if (!p) return { ok: false, reason: 'no player' };
    const r = await unequipItem(pool, userId, p.inv, slot);
    if (r.ok) p.mit = mitigation(p.inv, this.weapons);
    return r;
  }
```
(**Delete** the old `setWeapon`.)

In `attack(userId, ax, ay)`: replace the weapon lookup

```js
    const w = this.weapons.get(p.weaponId) || this.weapons.get(this.defaultWeaponId);
```
with
```js
    const w = activeWeaponType(p.inv, this.weapons, this.defaultWeaponId);
```

and in the melee branch replace the direct player-damage line

```js
        if (inArc(cx, cy, nx, ny, ocx, ocy, w.reach, w.arc_width)) other.hp -= w.damage;
```
with
```js
        if (inArc(cx, cy, nx, ny, ocx, ocy, w.reach, w.arc_width)) {
          applyDamage(other, w.damage, w.element, other.mit || NO_MITIGATION);
        }
```

In `snapshot()`, replace `weaponId: p.weaponId` with `equipment: p.inv ? p.inv.equipment : {}`.

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && node --test tests/authority_world_items.test.js`
Expected: PASS. Then `cd backend && node --test tests/authority_world_combat.test.js tests/authority_world.test.js` — these Slice 3b-1 tests construct `World` and call `attack`/`snapshot`; update them for the new `addPlayer(userId, spawn, inv)` signature and the `weaponId`→`equipment` snapshot key. **Widen, do not weaken**: keep the strict key-list assertion, swapping `weaponId` for `equipment`; replace `setWeapon(id)` calls with an equipment-bearing `addPlayer` (or `setEquipment`). If a failure is anything other than these two mechanical changes, STOP and report.

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/world.js backend/tests/authority_world_items.test.js backend/tests/authority_world_combat.test.js backend/tests/authority_world.test.js
git commit -m "feat(authority): equipment drives the active weapon; mitigated player damage in World"
```

---

### Task 7: Projectiles use the shared mitigation path

**Files:**
- Modify: `backend/src/authority/projectiles.js`
- Test: `backend/tests/authority_projectiles.test.js` (append)

**Interfaces:**
- Consumes: `damage.js` (`applyDamage`, `NO_MITIGATION`). Player objects may carry `.mit`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/authority_projectiles.test.js`:

```js
const { applyDamage } = require('../src/authority/damage.js');

test('a projectile hitting an armored player goes through the shared mitigation path', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...BOW, damage: 20 } });
  const target = { userId: 'u2', x: 62, y: -32, width: 64, height: 64, hp: 100,
    mit: { defense: 5, resistances: {} } };
  sim.step(0.12, { creatures: creaturesStub([]), players: [target], map: WALK_ALL });
  assert.equal(target.hp, 85, '20 raw - 5 defense = 15');
});

test('a projectile element is resisted by the target', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...BOW, damage: 20, element: 'arcane' } });
  const target = { userId: 'u2', x: 62, y: -32, width: 64, height: 64, hp: 100,
    mit: { defense: 0, resistances: { arcane: 0.5 } } };
  sim.step(0.12, { creatures: creaturesStub([]), players: [target], map: WALK_ALL });
  assert.equal(target.hp, 90, '20 raw * (1 - 0.5) = 10');
});

test('a player with no mit field takes unmitigated damage (no crash)', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...BOW, damage: 20 } });
  const target = { userId: 'u2', x: 62, y: -32, width: 64, height: 64, hp: 100 };
  sim.step(0.12, { creatures: creaturesStub([]), players: [target], map: WALK_ALL });
  assert.equal(target.hp, 80);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && node --test tests/authority_projectiles.test.js`
Expected: the two mitigation tests FAIL (damage still applied raw).

- [ ] **Step 3: Edit `projectiles.js`**

Add at the top: `const { applyDamage, NO_MITIGATION } = require('./damage');`

In the player-collision branch, replace `pl.hp -= p.damage;` with:

```js
            applyDamage(pl, p.damage, p.element, pl.mit || NO_MITIGATION);
```

(Creature hits are unchanged — creatures have no equipment this slice.)

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && node --test tests/authority_projectiles.test.js`
Expected: PASS (all, including the 3 new).

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/projectiles.js backend/tests/authority_projectiles.test.js
git commit -m "feat(authority): projectile player-damage routes through the shared mitigation path"
```

---

### Task 8: Single active session per account (newest-wins kick)

**Files:**
- Modify: `backend/src/authority/server.js`
- Test: `backend/tests/authority_server.test.js` (append)

**Interfaces:**
- Produces: a module-scoped `sessionsByUser` registry inside `attachAuthority`; a `kicked` server→client message.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/authority_server.test.js`:

```js
test('a second session for the same account kicks the first (newest wins)', async () => {
  const { url, handle, server } = await boot();
  const a = connect(url, 1);
  await new Promise((r) => a.on('open', r));
  a.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(a, 'joined');

  // Second connection, same user id.
  const b = connect(url, 1);
  await new Promise((r) => b.on('open', r));
  const aClosed = new Promise((res) => a.on('close', () => res(true)));
  b.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(b, 'joined');

  const closed = await Promise.race([aClosed, new Promise((r) => setTimeout(() => r(false), 1500))]);
  assert.ok(closed, 'the first session should be terminated by the second');

  // The new session stays alive and keeps receiving state.
  const s = await nextMsg(b, 'state');
  assert.ok(Array.isArray(s.players));
  b.close(); handle.close(); server.close();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && node --test tests/authority_server.test.js`
Expected: the new test FAILS — the first socket is never closed.

- [ ] **Step 3: Implement the registry**

In `attachAuthority`, alongside `worlds`/`loading`:

```js
  const sessionsByUser = new Map(); // userId -> ws (exactly one live authority session per account)
```

In the `join` handler, immediately **after** the world/spawn are resolved and before/at registration:

```js
        // One live session per account: the newest join wins. (Refusing instead
        // would lock a user out for up to a full heartbeat cycle after a crash,
        // since the dead-socket reaper needs one interval to notice.)
        const prev = sessionsByUser.get(ws.userId);
        if (prev && prev !== ws) {
          try { send(prev, { type: 'kicked', reason: 'signed_in_elsewhere' }); } catch { /* best-effort */ }
          prev.terminate();
        }
        sessionsByUser.set(ws.userId, ws);
```

In the `ws.on('close')` handler, add an **identity-checked** cleanup (so a kicked socket's late close cannot evict the new session):

```js
      if (sessionsByUser.get(ws.userId) === ws) sessionsByUser.delete(ws.userId);
```

In the returned `close()`, add `sessionsByUser.clear();`.

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && node --test tests/authority_server.test.js`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/server.js backend/tests/authority_server.test.js
git commit -m "feat(authority): one live session per account (newest-wins kick)"
```

---

### Task 9: `server.js` — inventory wiring, equip/unequip messages, joined/state payloads

**Files:**
- Modify: `backend/src/authority/server.js`
- Test: `backend/tests/authority_server.test.js` (append; extend `fakePool`)

**Interfaces:**
- Consumes: `items.js` (`loadItemTypes`, `resolveDefaultWeaponId`, `loadInventory`, `grantStartingLoadout`).
- Produces: `joined` carries `itemTypes`/`items`/`equipment`; new `equip{itemId,slot}` and `unequip{slot}` messages; `state` players carry `equipment`. **Removes** `equip{weaponId}`.

- [ ] **Step 1: Extend the test fixture + write failing tests**

In `authority_server.test.js`'s shared `fakePool()`, replace the `weapon_types` branch with `item_types` and add inventory branches:

```js
      if (/FROM item_types/i.test(sql)) {
        return { rows: [
          { id: 1, name: 'dagger', category: 'weapon', slot: 'main_hand', two_handed: false, kind: 'melee',
            damage: 8, cooldown: 0.3, reach: 80, arc_width: 6.3, range: null, projectile_speed: null,
            projectile_radius: null, pierce: null, mana_cost: 0, element: null, defense: null, resistances: null },
          { id: 5, name: 'leather-vest', category: 'armor', slot: 'chest', two_handed: false, kind: null,
            damage: 0, cooldown: 0, reach: null, arc_width: null, range: null, projectile_speed: null,
            projectile_radius: null, pierce: null, mana_cost: 0, element: null, defense: 2, resistances: {} },
        ] };
      }
      if (/FROM player_items/i.test(sql)) return { rows: [{ id: 'i1', item_type_id: 1 }, { id: 'i5', item_type_id: 5 }] };
      if (/FROM player_equipment/i.test(sql)) return { rows: [] };
      if (/INSERT INTO player_equipment/i.test(sql)) return { rows: [], rowCount: 1 };
      if (/DELETE FROM player_equipment/i.test(sql)) return { rows: [], rowCount: 1 };
      if (/INSERT INTO player_items/i.test(sql)) return { rows: [], rowCount: 1 };
```

Append:

```js
test('joined carries the item catalog, the owned items and the equipment map', async () => {
  const { url, handle, server } = await boot();
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  const joined = await nextMsg(ws, 'joined');
  assert.ok(Array.isArray(joined.itemTypes) && joined.itemTypes.length >= 2);
  assert.ok(Array.isArray(joined.items) && joined.items.length >= 1);
  assert.equal(typeof joined.equipment, 'object');
  assert.equal(joined.weapons, undefined, 'the 3b-1 weapons payload is retired');
  ws.close(); handle.close(); server.close();
});

test('equip is reflected in a later state; unequip clears it', async () => {
  const { url, handle, server } = await boot();
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws, 'joined');

  ws.send(JSON.stringify({ type: 'equip', itemId: 'i5', slot: 'chest' }));
  let got = null;
  for (let i = 0; i < 25 && !got; i++) {
    const s = await nextMsg(ws, 'state');
    const me = s.players.find((p) => p.id === '1');
    if (me && me.equipment && me.equipment.chest === 'i5') got = me;
  }
  assert.ok(got, 'chest equipment appears in state');

  ws.send(JSON.stringify({ type: 'unequip', slot: 'chest' }));
  let cleared = false;
  for (let i = 0; i < 25 && !cleared; i++) {
    const s = await nextMsg(ws, 'state');
    const me = s.players.find((p) => p.id === '1');
    if (me && me.equipment && me.equipment.chest === undefined) cleared = true;
  }
  assert.ok(cleared, 'chest equipment cleared in state');
  ws.close(); handle.close(); server.close();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && node --test tests/authority_server.test.js`
Expected: FAIL — `joined.itemTypes` undefined; equip/unequip unhandled.

- [ ] **Step 3: Wire `server.js`**

Replace the weapons require with:

```js
const { loadItemTypes, resolveDefaultWeaponId, loadInventory, grantStartingLoadout } = require('./items');
```

In `loadWorld`, replace the catalog load:

```js
        const itemTypes = await loadItemTypes(pool);
        const defaultWeaponId = resolveDefaultWeaponId(itemTypes);
```
and construct `new World(map, itemTypes, defaultWeaponId)` (World's 2nd arg is still the type map).

In the `join` handler, after the spawn is resolved and the session kick (Task 8), load/grant the inventory and pass it to `addPlayer`:

```js
        let inv = await loadInventory(pool, ws.userId);
        if (inv.items.length === 0) {
          const granted = await grantStartingLoadout(pool, ws.userId, entry.world.weapons);
          if (granted) inv = await loadInventory(pool, ws.userId);
        }
        ws.worldId = msg.world_id;
        entry.world.addPlayer(ws.userId, spawn, inv);
        entry.sockets.set(ws.userId, ws);
        send(ws, {
          type: 'joined', user_id: ws.userId, spawn, tickRate: 1000 / tickMs,
          itemTypes: [...entry.world.weapons.values()],
          items: inv.items,
          equipment: inv.equipment,
        });
        return;
```

Replace the 3b-1 `equip` handler with:

```js
      if (msg.type === 'equip') {
        const entry = worlds.get(ws.worldId);
        if (entry) {
          const r = await entry.world.setEquipment(pool, ws.userId, msg.itemId, msg.slot);
          if (!r.ok) send(ws, { type: 'error', message: r.reason || 'cannot equip' });
        }
        return;
      }

      if (msg.type === 'unequip') {
        const entry = worlds.get(ws.worldId);
        if (entry) await entry.world.clearEquipment(pool, ws.userId, msg.slot);
        return;
      }
```

(`state` already sends `snap.players`, which now carries `equipment` from Task 6 — no change needed there.)

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && node --test tests/authority_server.test.js`
Expected: PASS. Then the full authority suite: `cd backend && node --test tests/authority_*.test.js` — all green. (Known flake: the ws glob run occasionally hangs on socket drain; if it hangs but individual files pass, re-run once and note it.)

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/server.js backend/tests/authority_server.test.js
git commit -m "feat(authority): wire inventory load/grant, equip+unequip messages, joined/state payloads"
```

---

### Task 10: `/api/item-types` CRUD + admin item grant

**Files:**
- Modify: `backend/src/index.js`
- Test: `backend/tests/item_types_api.test.js`

**Interfaces:**
- Produces: `GET/POST/PUT/DELETE /api/item-types`, `POST /api/players/:userId/items`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/item_types_api.test.js` (use the project's existing `__setPool` mock seam — mirror an existing API test file such as `worlds.test.js` for the harness):

```js
const test = require('node:test');
const assert = require('node:assert');
const request = require('node:http'); // if the repo's API tests use a helper, mirror that instead
const { app, __setPool } = require('../src/index.js');

// NOTE: mirror the exact harness used by backend/tests/worlds.test.js
// (same __setPool + request style). The assertions below are the contract.

test('GET /api/item-types returns the catalog', async () => {
  __setPool({ query: async () => ({ rows: [{ id: 1, name: 'dagger', category: 'weapon' }] }) });
  // expect 200 and the array
});

test('POST /api/item-types rejects an unknown element', async () => {
  __setPool({ query: async () => ({ rows: [] }) });
  // body { name:'x', category:'weapon', kind:'melee', reach:10, arc_width:1, element:'plasma' }
  // expect 400 mentioning element
});

test('POST /api/item-types rejects a melee weapon missing reach/arc_width', async () => {
  // body { name:'x', category:'weapon', kind:'melee' } -> 400
});

test('POST /api/item-types rejects armor missing slot/defense', async () => {
  // body { name:'x', category:'armor' } -> 400
});

test('POST /api/item-types rejects resistances with an unknown element key', async () => {
  // body { name:'x', category:'armor', slot:'chest', defense:1, resistances:{plasma:0.5} } -> 400
});

test('POST /api/players/:userId/items grants an item instance', async () => {
  // expect 201 and an INSERT INTO player_items
});
```

The implementer should flesh these into the repo's actual API-test style (same as `worlds.test.js`), keeping every assertion above.

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && node --test tests/item_types_api.test.js`
Expected: FAIL — routes not found (404).

- [ ] **Step 3: Add the routes**

In `backend/src/index.js`, mirroring the `/api/entity-types` block:

```js
const ITEM_ELEMENTS = ['physical', 'arcane', 'fire', 'ice', 'lightning'];
const ITEM_SLOTS = ['main_hand', 'off_hand', 'head', 'chest', 'hands', 'feet', 'ring1', 'ring2'];

// Mirror the DB CHECKs so the API returns 400 instead of a constraint error.
function validateItemType(b) {
  if (!b.name) return 'Name is required';
  if (!['weapon', 'armor'].includes(b.category)) return "category must be 'weapon' or 'armor'";
  if (b.element != null && !ITEM_ELEMENTS.includes(b.element)) return `element must be one of ${ITEM_ELEMENTS.join(', ')}`;
  if (b.slot != null && !ITEM_SLOTS.includes(b.slot)) return `slot must be one of ${ITEM_SLOTS.join(', ')}`;
  if (b.resistances) {
    for (const k of Object.keys(b.resistances)) {
      if (!ITEM_ELEMENTS.includes(k)) return `resistances key '${k}' is not a known element`;
    }
  }
  if (b.category === 'weapon') {
    if (!['melee', 'projectile'].includes(b.kind)) return "weapon kind must be 'melee' or 'projectile'";
    if (b.kind === 'melee' && (b.reach == null || b.arc_width == null)) return 'melee weapons need reach and arc_width';
    if (b.kind === 'projectile' && (b.range == null || b.projectile_speed == null || b.projectile_radius == null)) {
      return 'projectile weapons need range, projectile_speed and projectile_radius';
    }
  } else {
    if (b.slot == null || b.defense == null) return 'armor needs slot and defense';
  }
  return null;
}

app.get('/api/item-types', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM item_types ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to fetch item types' }); }
});

app.post('/api/item-types', async (req, res) => {
  try {
    const b = req.body;
    const bad = validateItemType(b);
    if (bad) return res.status(400).json({ error: bad });
    const result = await pool.query(
      `INSERT INTO item_types
        (name, category, slot, two_handed, kind, damage, cooldown, reach, arc_width,
         range, projectile_speed, projectile_radius, pierce, mana_cost, element, defense, resistances, icon)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [b.name, b.category, b.slot ?? null, b.two_handed ?? false, b.kind ?? null,
       b.damage ?? 0, b.cooldown ?? 0, b.reach ?? null, b.arc_width ?? null,
       b.range ?? null, b.projectile_speed ?? null, b.projectile_radius ?? null, b.pierce ?? null,
       b.mana_cost ?? 0, b.element ?? null, b.defense ?? null,
       JSON.stringify(b.resistances ?? {}), b.icon ?? null],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to create item type' }); }
});

app.put('/api/item-types/:id', async (req, res) => {
  try {
    const b = req.body;
    const bad = validateItemType(b);
    if (bad) return res.status(400).json({ error: bad });
    const result = await pool.query(
      `UPDATE item_types SET
        name=$1, category=$2, slot=$3, two_handed=$4, kind=$5, damage=$6, cooldown=$7,
        reach=$8, arc_width=$9, range=$10, projectile_speed=$11, projectile_radius=$12,
        pierce=$13, mana_cost=$14, element=$15, defense=$16, resistances=$17, icon=$18,
        updated_at=now()
       WHERE id=$19 RETURNING *`,
      [b.name, b.category, b.slot ?? null, b.two_handed ?? false, b.kind ?? null,
       b.damage ?? 0, b.cooldown ?? 0, b.reach ?? null, b.arc_width ?? null,
       b.range ?? null, b.projectile_speed ?? null, b.projectile_radius ?? null, b.pierce ?? null,
       b.mana_cost ?? 0, b.element ?? null, b.defense ?? null,
       JSON.stringify(b.resistances ?? {}), b.icon ?? null, req.params.id],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Item type not found' });
    res.json(result.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update item type' }); }
});

app.delete('/api/item-types/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM item_types WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Item type not found' });
    res.status(204).end();
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to delete item type' }); }
});

// Admin grant: give a user an instance of an item type.
app.post('/api/players/:userId/items', async (req, res) => {
  try {
    const { item_type_id } = req.body;
    if (item_type_id == null) return res.status(400).json({ error: 'item_type_id is required' });
    const result = await pool.query(
      'INSERT INTO player_items (user_id, item_type_id) VALUES ($1,$2) RETURNING *',
      [req.params.userId, item_type_id],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to grant item' }); }
});
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && node --test tests/item_types_api.test.js`
Expected: PASS. Then the whole backend suite: `cd backend && node --test` — all green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/index.js backend/tests/item_types_api.test.js
git commit -m "feat(api): item-types CRUD with category-conditional validation + admin item grant"
```

---

### Task 11: Client `WorldAuthorityClient` — equip/unequip/kicked

**Files:**
- Modify: `frontend/src/games/something2/src/js/net/WorldAuthorityClient.js`
- Test: `frontend/src/games/something2/src/js/net/__tests__/WorldAuthorityClient.test.js` (append)

**Interfaces:**
- Produces: `sendEquip(itemId, slot)` → `{type:'equip',itemId,slot}`; `sendUnequip(slot)` → `{type:'unequip',slot}`; an `onKicked` callback invoked on a `kicked` message.

- [ ] **Step 1: Write the failing tests**

Append:

```js
it('sendEquip sends itemId + slot', () => {
  const c = armClient();
  c.sendEquip('i5', 'chest');
  expect(FakeWS.last.sent.find((m) => m.type === 'equip')).toEqual({ type: 'equip', itemId: 'i5', slot: 'chest' });
});

it('sendUnequip sends the slot', () => {
  const c = armClient();
  c.sendUnequip('chest');
  expect(FakeWS.last.sent.find((m) => m.type === 'unequip')).toEqual({ type: 'unequip', slot: 'chest' });
});

it('a kicked message invokes onKicked', () => {
  const seen = [];
  const c = new WorldAuthorityClient({ url: 'ws://x/authority', token: 't', onKicked: (m) => seen.push(m) });
  c.connect('w1');
  FakeWS.last._l.open();
  FakeWS.last._l.message({ data: JSON.stringify({ type: 'kicked', reason: 'signed_in_elsewhere' }) });
  expect(seen).toHaveLength(1);
  expect(seen[0].reason).toBe('signed_in_elsewhere');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/games/something2/src/js/net/__tests__/WorldAuthorityClient.test.js`
Expected: FAIL.

- [ ] **Step 3: Edit the client**

- Add `onKicked` to the constructor options: `this.onKicked = onKicked || (() => {});`
- Replace `sendEquip(weaponId)` with:
```js
  sendEquip(itemId, slot) { this._send({ type: 'equip', itemId, slot }); }

  sendUnequip(slot) { this._send({ type: 'unequip', slot }); }
```
- Add to the message switch: `case 'kicked': this.onKicked(msg); break;`

- [ ] **Step 4: Run to verify pass**

Run: the same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/net/WorldAuthorityClient.js frontend/src/games/something2/src/js/net/__tests__/WorldAuthorityClient.test.js
git commit -m "feat(client): equip/unequip frames + kicked handling"
```

---

### Task 12: Client inventory store + slot-legality helper (pure)

**Files:**
- Create: `frontend/src/games/something2/src/js/core/inventory.js`
- Test: `frontend/src/games/something2/src/js/core/__tests__/inventory.test.js`

**Interfaces:**
- Produces: `SLOTS`; `createInventory()`; `applyJoined(inv, msg)`; `applyEquipment(inv, equipment)`; `canEquipClient(inv, itemId, slot) -> boolean` (UI affordance mirroring the server rule); `typeOf(inv, itemId)`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/games/something2/src/js/core/__tests__/inventory.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { createInventory, applyJoined, applyEquipment, canEquipClient, typeOf, SLOTS } from '../inventory.js';

const JOINED = {
  itemTypes: [
    { id: 1, name: 'dagger', category: 'weapon', slot: 'main_hand', two_handed: false },
    { id: 2, name: 'halberd', category: 'weapon', slot: 'main_hand', two_handed: true },
    { id: 5, name: 'leather-vest', category: 'armor', slot: 'chest' },
  ],
  items: [{ id: 'i1', typeId: 1 }, { id: 'i2', typeId: 2 }, { id: 'i5', typeId: 5 }],
  equipment: { main_hand: 'i1' },
};

it('applyJoined populates the catalog, items and equipment', () => {
  const inv = createInventory();
  applyJoined(inv, JOINED);
  expect(inv.items).toHaveLength(3);
  expect(inv.equipment.main_hand).toBe('i1');
  expect(typeOf(inv, 'i5').name).toBe('leather-vest');
});

it('applyEquipment replaces the equipment map', () => {
  const inv = createInventory();
  applyJoined(inv, JOINED);
  applyEquipment(inv, { chest: 'i5' });
  expect(inv.equipment).toEqual({ chest: 'i5' });
});

it('canEquipClient mirrors the server slot rules', () => {
  const inv = createInventory();
  applyJoined(inv, JOINED);
  expect(canEquipClient(inv, 'i1', 'main_hand')).toBe(true);
  expect(canEquipClient(inv, 'i1', 'off_hand')).toBe(true);
  expect(canEquipClient(inv, 'i5', 'main_hand')).toBe(false); // armor in a hand
  expect(canEquipClient(inv, 'i1', 'chest')).toBe(false);     // weapon in armor slot
  expect(canEquipClient(inv, 'i2', 'off_hand')).toBe(false);  // two-handed in off hand
});

it('canEquipClient blocks the off hand while a two-handed weapon is held', () => {
  const inv = createInventory();
  applyJoined(inv, JOINED);
  applyEquipment(inv, { main_hand: 'i2' }); // halberd
  expect(canEquipClient(inv, 'i1', 'off_hand')).toBe(false);
});

it('SLOTS matches the server paper-doll', () => {
  expect(SLOTS).toEqual(['main_hand', 'off_hand', 'head', 'chest', 'hands', 'feet', 'ring1', 'ring2']);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/games/something2/src/js/core/__tests__/inventory.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `frontend/src/games/something2/src/js/core/inventory.js`:

```js
// Client-side inventory mirror. The SERVER is authoritative for equip legality;
// canEquipClient only drives UI affordances (disabled slots), and must mirror
// the server rule in items.js canEquip.

export const SLOTS = ['main_hand', 'off_hand', 'head', 'chest', 'hands', 'feet', 'ring1', 'ring2'];
const HAND_SLOTS = ['main_hand', 'off_hand'];

export function createInventory() {
  return { types: new Map(), items: [], equipment: {} };
}

export function applyJoined(inv, msg) {
  inv.types = new Map((msg.itemTypes || []).map((t) => [t.id, t]));
  inv.items = (msg.items || []).map((i) => ({ id: i.id, typeId: i.typeId }));
  inv.equipment = { ...(msg.equipment || {}) };
  return inv;
}

export function applyEquipment(inv, equipment) {
  inv.equipment = { ...(equipment || {}) };
  return inv;
}

export function typeOf(inv, itemId) {
  const item = inv.items.find((i) => i.id === itemId);
  return item ? inv.types.get(item.typeId) || null : null;
}

export function canEquipClient(inv, itemId, slot) {
  if (!SLOTS.includes(slot)) return false;
  const type = typeOf(inv, itemId);
  if (!type) return false;
  if (type.category === 'weapon') {
    if (!HAND_SLOTS.includes(slot)) return false;
    if (slot === 'off_hand' && type.two_handed) return false;
    if (slot === 'off_hand') {
      const mh = typeOf(inv, inv.equipment.main_hand);
      if (mh && mh.two_handed) return false;
    }
    return true;
  }
  return type.slot === slot;
}
```

- [ ] **Step 4: Run to verify pass**

Run: the same command. Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/core/inventory.js frontend/src/games/something2/src/js/core/__tests__/inventory.test.js
git commit -m "feat(client): inventory store + slot-legality helper"
```

---

### Task 13: `InventoryPanel` + Game wiring (retire the number-key switch)

**Files:**
- Create: `frontend/src/games/something2/src/js/ui/InventoryPanel.js` (canvas-drawn panel) **or** a React overlay — see Step 1
- Modify: `frontend/src/games/something2/src/js/core/Game.js`
- Modify: `frontend/src/games/something2/src/js/systems/RenderSystem.js`

No unit tests (DOM/canvas layer). Verified by build + browser.

- [ ] **Step 1: Decide the panel host and wire state**

The game is canvas-based; the existing HUD is drawn in `RenderSystem.renderHud`. Implement the inventory as a **canvas-drawn overlay** inside `RenderSystem` (consistent with the existing HUD), driven by state on `Game`. Do NOT introduce a React overlay for the in-game panel.

In `Game.js`:
- `import { createInventory, applyJoined, applyEquipment, canEquipClient, typeOf, SLOTS } from "./inventory.js";`
- In `initChunked`: `this.inventory = createInventory(); this.inventoryOpen = false;`
- In the authority client options: `onJoined: (msg) => { applyJoined(this.inventory, msg); ...existing... }`, and `onKicked: () => { /* surface + disconnect */ this.state = 'kicked'; }`.
- In `_onWorldState`: for the local player, `applyEquipment(this.inventory, me.equipment || {})`.
- **Remove** the number-key (1–4) weapon-switch block entirely.
- Add `i` to toggle `this.inventoryOpen` (guarded `state==='playing' && chunked`).
- Add click handling while the panel is open: hit-test the drawn slot/item rects (stored by `RenderSystem` on `this._invHitAreas` when it draws) and call `authorityClient.sendEquip(itemId, slot)` / `sendUnequip(slot)`. When the panel is open, a left-click must NOT also fire an attack — early-return from the attack handler when `this.inventoryOpen`.

- [ ] **Step 2: Draw the panel**

In `RenderSystem`, add `renderInventory(ctx, inventory, hitAreas)` called from `renderChunked` when open:
- a paper-doll column: one box per `SLOTS` entry, labelled, showing the equipped item's type name (or empty), greyed when `canEquipClient` is false for the currently-selected item;
- an item list: each owned item's type name + a short stat line (weapon: damage/cooldown; armor: defense + resistances);
- push `{x,y,w,h,kind:'slot'|'item',id}` rects into `hitAreas` so `Game` can hit-test clicks.
Keep the styling consistent with the existing HUD box.

- [ ] **Step 3: HUD shows the equipped weapon from equipment**

Replace the 3b-1 `weaponId`-based HUD lookup with: resolve `inventory.equipment.main_hand` → `typeOf(...)` → name (fall back to the default weapon name when empty).

- [ ] **Step 4: Build**

Run: `cd frontend && npm run build`
Expected: succeeds.

- [ ] **Step 5: Frontend regression**

Run: `cd frontend && npx vitest run`
Expected: all green.

- [ ] **Step 6: Live browser verification**

With the stack running and the migration applied:
- Join a chunked world as a fresh user → starting loadout granted (dagger + leather-vest appear in the panel; `i` toggles it).
- Equip the dagger to main_hand → HUD weapon name updates; attacking uses it.
- Equip leather-vest to chest → a creature's contact damage against you drops (defense 2).
- Equip a two-handed weapon (halberd, grant via the admin endpoint if not owned) → off_hand becomes disabled.
- Attempt an illegal equip (armor into main_hand) → refused, panel state unchanged, an `error` surfaces.
- Open a second tab as the SAME user → the first tab is kicked (disconnects with the signed-in-elsewhere reason).
- Console clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/games/something2/src/js/core/Game.js frontend/src/games/something2/src/js/systems/RenderSystem.js
git commit -m "feat(client): inventory/paper-doll panel; equipment drives the weapon (number-key switch retired)"
```

---

### Task 14: `ItemTypesAdmin` editor

**Files:**
- Create: `frontend/src/games/something2/ItemTypesAdmin.jsx`
- Modify: `frontend/src/games/something2/useMaps.js` (add item-type query hooks)
- Modify: `frontend/src/games/something2/Something2.jsx` (route/tab to the new admin)

No unit tests (React render layer). Verified by build + browser.

- [ ] **Step 1: Add data hooks**

In `useMaps.js`, mirroring the existing entity-type hooks: `useItemTypes()`, `useCreateItemType()`, `useUpdateItemType()`, `useDeleteItemType()` against `${API_URL}/api/item-types`, invalidating the `['itemTypes']` key on mutation and surfacing errors like the existing hooks.

- [ ] **Step 2: Build the editor**

Create `ItemTypesAdmin.jsx` mirroring `EntityTypesAdmin.jsx`'s structure (same styled-components idiom, card grid, create/edit form, toast on error):
- A **category** selector ('weapon' | 'armor') that drives field visibility:
  - weapon → `kind` (melee|projectile), `damage`, `cooldown`, `two_handed`, and kind-conditional fields (melee: `reach`, `arc_width`; projectile: `range`, `projectile_speed`, `projectile_radius`, `pierce`), `mana_cost`, `element` (dropdown from the element list, plus "none").
  - armor → `slot` (dropdown of the 8 slots), `defense`, and a **resistances editor** (add rows of element→fraction, element chosen from the same dropdown).
- Client-side validation mirroring the API rules so the user sees the error before submitting; still surface the API's 400 message via toast.

- [ ] **Step 3: Route it**

In `Something2.jsx`, add an "Items" tab/route alongside the existing Entity/Tile admin entries, rendering `ItemTypesAdmin`.

- [ ] **Step 4: Build + regression**

Run: `cd frontend && npm run build` then `cd frontend && npx vitest run`
Expected: both green.

- [ ] **Step 5: Live browser verification**

- Open the Items admin: the 6 seeded types list (4 weapons + 2 armor).
- Create a melee weapon missing `arc_width` → blocked with a clear message (client and/or API 400).
- Create an armor piece with a resistance (e.g. `fire: 0.25`) → saved; equip it in-game and confirm fire damage is reduced (or at least that it loads in the catalog).
- Edit and delete a type round-trip cleanly.
- Console clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/games/something2/ItemTypesAdmin.jsx frontend/src/games/something2/useMaps.js frontend/src/games/something2/Something2.jsx
git commit -m "feat(admin): item-types editor (category-driven fields, resistances)"
```

---

## Self-Review

**Spec coverage:**
- `item_types` rename+extend, category CHECKs, element CHECK, armor seed → Task 1. ✓
- Account-wide `player_items`/`player_equipment` → Task 1; load/grant → Task 4. ✓
- Damage pipeline (defense, resistance, cap, floor) in ONE helper → Task 2; used by melee (Task 6) and projectiles (Task 7) — with a test on each path asserting equal mitigation. ✓
- Paper-doll + two-handed rule + ownership validation → Task 5 (server) and Task 12 (client affordance). ✓
- Equipment drives the active weapon; `setWeapon`/`weaponId` removed → Task 6. ✓
- Single active session, newest-wins, identity-checked cleanup → Task 8. ✓
- joined/state payloads, equip/unequip messages, `equip{weaponId}` removed → Task 9. ✓
- Item-type CRUD with validation mirroring the DB CHECKs + admin grant → Task 10. ✓
- Client frames + kicked → Task 11; inventory store → Task 12; panel + number-key retirement → Task 13; editor → Task 14. ✓
- Starting loadout idempotent → Task 4 (+ browser check in Task 13). ✓

**Placeholder scan:** Task 10's test file is deliberately specified as "flesh into the repo's existing API-test harness, keeping these assertions" — the contract is explicit even though the harness boilerplate is deferred to the implementer, because the repo's API-test style must be matched exactly. Everything else carries complete code.

**Type consistency:** `inv` shape `{items:[{id,typeId}], equipment:{slot:itemId}}` is identical across items.js (Tasks 4/5), world.js (Task 6), server.js (Task 9) and the client mirror (Task 12). `mit` shape `{defense, resistances}` matches `applyDamage`'s 4th arg (Tasks 2/6/7). `equip(pool,userId,inv,itemTypes,itemId,slot)` argument order is consistent between definition (Task 5) and callers (Task 6). `SLOTS` is defined once server-side (items.js) and mirrored client-side (inventory.js) with a test asserting they match.
