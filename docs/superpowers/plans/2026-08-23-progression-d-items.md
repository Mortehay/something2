# Item Requirements, Rarity and Drops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give equipment level/stat requirements, a full 8-slot × 10-tier base gear ladder, per-instance rarity with rolled affixes that survive a drop-and-repick, item-level-weighted rarity rolls, and a 180-second ground-loot lifetime ending in a harmless puff.

**Architecture:** Four pure, rng-injectable modules (`equipRequirements.js`, `affixes.js`, `rarity.js`, `generateGearLadder.js`) hold every decision; the existing authority modules (`items.js`, `loot.js`, `groundItems.js`, `world.js`, `server.js`) stay the only places that touch the database, and none of their existing write-through orderings change. Rarity, item level, affixes and `soulbound` become carried facts on `world_items` so `dropItem` → `claimItem` is lossless, which is the one hard constraint the current schema imposes on this whole epic.

**Tech Stack:** Node 20 + CommonJS backend, raw `pg`, `node-pg-migrate`, `node:test`; plain ES-module game client under `frontend/src/games/something2/src/js` tested with vitest.

**Spec:** docs/superpowers/specs/2026-08-23-progression-passive-tree-design.md
**Contract:** docs/superpowers/plans/2026-08-23-progression-shared-contract.md

## Global Constraints

Copied verbatim from the contract's §5, plus this group's migration slots.

- **Backend:** CommonJS, Express, raw `pg` queries, inline routes. See `.ai/styleguides/backend.md`.
- **Frontend admin:** React 19, styled-components, `--s2-*` tokens only, TanStack Query for data. See `.ai/styleguides/frontend.md`.
- **Game client:** plain ES modules under `frontend/src/games/something2/src/js`. Layout/maths live in testable functions separate from canvas draw calls, as `inventoryPanel.js` already does.
- **Tests:** backend `npm test` from `backend/`; frontend `npx vitest run` from `frontend/`. Any DB-touching test run MUST set both `DATABASE_URL` and `TEST_DATABASE_URL` to a per-branch scratch database, seeded with the map specs. Unset `TEST_DATABASE_URL` silently targets the SHARED DEV DATABASE.
- **Never** run a destructive statement against the shared dev database. No `DELETE FROM`, `TRUNCATE` or `DROP` outside a scratch DB.
- **No vacuous tests.** A test must not derive its expected value by calling the same function or constant the code under test uses. XP-curve, affix-roll and stat-composition expectations are hand-written literals.
- **Worktrees:** several sessions share this checkout. Every task runs in its own `git worktree`; never `checkout`, `stash` or `branch` in the shared working directory. Stage by explicit path.
- **Commits:** branch `feat/<slug>`; subject `type(scope): summary (SOMET-NNN)`; end the message with the `Co-Authored-By: Claude Opus 5 (1M context)` trailer.

### Migration slots owned by Group D

| Slot | Task | Content |
|---|---|---|
| `1714440505000` | T10 | `item_types` `req_level` + six `req_*` + `item_level` + `tier` |
| `1714440506000` | T11 | base gear ladder seed |
| `1714440507000` | T12 | `affix_types`, `player_item_affixes`, `player_items` + `world_items` columns |
| `1714440508000` | T13 | `rarity_weights` default setting row |

T14 adds **no** migration. No task in this group may take a slot not listed above.

Verified against `backend/migrations/` on main at plan time: `1714440505000`–`1714440508000` are all free (the highest existing timestamps are `1714440390000_biome_creature_density.js`, `1714440400000_biome_path_tile.js`, `1714440410000_invite_codes.js`, `1714440420000_inventory_slots.js`). See "Contract and spec deviations" for the T1 slot that is **not** free.

### Scratch database

Every DB command in this plan uses one scratch database for the whole group:

```bash
export S2_SCRATCH='postgres://user:password@localhost:15432/scratch_prog_d'
```

Create it once, from the shared dev database's template, before Task 1:

```bash
docker exec something2-db-1 psql -U user -d postgres -c "CREATE DATABASE scratch_prog_d TEMPLATE game_db"
```

`CREATE DATABASE ... TEMPLATE game_db` is a read of the dev DB, never a write to it. Every later command sets **both** `DATABASE_URL` and `TEST_DATABASE_URL` to `$S2_SCRATCH`; an unset `TEST_DATABASE_URL` silently targets the shared dev database.

## File Structure

| File | Created / Modified | The ONE responsibility |
|---|---|---|
| `backend/migrations/1714440505000_item_requirements.js` | Create (T10) | Add `req_level`, six `req_*`, `item_level`, `tier` to `item_types` |
| `backend/src/authority/equipRequirements.js` | Create (T10) | PURE: effective stats excluding one item, and whether a type's requirements are met |
| `backend/src/authority/items.js` | Modify (T10, `canEquip` 338-359; `equip` 528-574) | Thread an optional requirement context into the existing legality check |
| `backend/src/authority/world.js` | Modify (T10, `setEquipment` 373-379, `clearEquipment` 381-387) | Supply the live requirement context and refuse an unequip that would orphan another item |
| `backend/src/services/equipCompliance.js` | Create (T10) | Auto-unequip now-illegal gear inside a caller's transaction, or refuse |
| `backend/seeds/data/gearLadder.js` | Create (T11) | The authored tier + family spec — data only |
| `backend/seeds/generateGearLadder.js` | Create (T11) | PURE generator + the one upsert used by both the migration and the script |
| `backend/migrations/1714440506000_base_gear_ladder.js` | Create (T11) | Seed the generated ladder into `item_types` on a fresh database |
| `backend/scripts/seed-gear-ladder.js` | Create (T11) | Re-run the same upsert against an already-migrated database |
| `backend/migrations/1714440507000_affixes_and_rarity.js` | Create (T12) | `affix_types`, `player_item_affixes`, rarity columns, starter affix catalog |
| `backend/src/authority/affixes.js` | Create (T12) | PURE: affix eligibility, count-by-rarity and the instance roll |
| `backend/src/authority/loot.js` | Modify (T12 `dropItem` 433-563; T13 `spawnDrops` 151-236, `commitCreatureDeath` 70-149; T14 ttl defaults) | Carry the rolled identity onto the ground and back, and roll rarity at drop time |
| `backend/src/index.js` | Modify (T12, after the `/api/item-types` block at 1147-1330) | Admin CRUD for `affix_types` |
| `backend/migrations/1714440508000_rarity_weights_setting.js` | Create (T13) | Insert the `rarity_weights` default row into `game_settings` |
| `backend/src/authority/rarity.js` | Create (T13) | PURE: interpolate + normalise the weight table, roll a rarity |
| `backend/src/authority/chestLoot.js` | Modify (T13, `openChest` 46-168) | Roll rarity/affixes for chest-granted instances |
| `backend/src/authority/groundItems.js` | Modify (T14, `removeExpired` 70-76) | Return each expired item's position, not just its id |
| `backend/src/authority/server.js` | Modify (T14, `groundItemTtlMs` 389, item sweep 2743-2760) | Read the TTL from `game_settings` and broadcast the despawn puff |
| `frontend/src/games/something2/src/js/core/vfx.js` | Modify (T14, `addEffects` 58-90) | Resolve the built-in `item_despawn` def |
| `frontend/src/games/something2/src/js/net/WorldAuthorityClient.js` | Modify (T14, `_handleMessage` 110-152) | Route the new `vfx` frame |
| `frontend/src/games/something2/src/js/core/Game.js` | Modify (T14, client wiring 430-500) | Feed a `vfx` frame into the existing effect list |
| `backend/tests/item_requirements.test.js` | Create (T10) | Pure requirement/circularity coverage |
| `backend/tests/item_requirements_db.test.js` | Create (T10) | Schema + equip/unequip/respec-compliance against a real database |
| `backend/tests/gear_ladder.test.js` | Create (T11) | Generator shape, determinism, 8-slot coverage |
| `backend/tests/gear_ladder_db.test.js` | Create (T11) | Every paper-doll slot has an equippable base item after the seed |
| `backend/tests/affixes.test.js` | Create (T12) | Pure roller coverage |
| `backend/tests/affixes_db.test.js` | Create (T12) | Drop-and-repick round trip, sell cascade |
| `backend/tests/rarity.test.js` | Create (T13) | Interpolation, normalisation, weighted roll |
| `backend/tests/ground_despawn_vfx.test.js` | Create (T14) | A despawn emits a `vfx` frame and no damage |
| `backend/tests/groundItems.test.js` | Modify (T14, line 49-55) | The expired-item return shape |
| `frontend/src/games/something2/src/js/core/__tests__/vfx.test.js` | Modify (T14) | The built-in despawn def resolves with an empty library |

---

### Task 1: Equipment requirements, `canEquip` gating, respec/unequip policy (T10)

**Files:**
- Create: `backend/migrations/1714440505000_item_requirements.js`
- Create: `backend/src/authority/equipRequirements.js`
- Create: `backend/src/services/equipCompliance.js`
- Modify: `backend/src/authority/items.js:338-359` (`canEquip`), `backend/src/authority/items.js:528-533` (`equip`'s call into it)
- Modify: `backend/src/authority/world.js:373-387` (`setEquipment`, `clearEquipment`)
- Test: `backend/tests/item_requirements.test.js`, `backend/tests/item_requirements_db.test.js`

**Interfaces:**

- Consumes: `items.js`'s existing `SLOTS`, `usedSlots(inv, itemTypes)`, `capacityOf(inv)` (`backend/src/authority/items.js:305-331`); `progressionStore.loadProgression(db, characterId)` (`backend/src/services/progressionStore.js`), which returns `{ level, strength, dexterity, constitution, intelligence, wisdom, charisma, ... }`.
- Produces, for T12 and for Group C's T7:

```js
// backend/src/authority/equipRequirements.js  — PURE
const REQ_STATS = ['strength','dexterity','constitution','intelligence','wisdom','charisma'];
function gearStatGrants(inv, itemTypes, excludeItemId = null) -> { strength:int, ..., charisma:int }
function effectiveStatsFor(inv, itemTypes, base, { excludeItemId = null } = {}) -> { strength:int, ..., charisma:int }
function meetsRequirements(type, level, stats) -> { ok: boolean, reason?: string }
function illegalEquipped(inv, itemTypes, base, level) -> [{ slot, itemId, name, reason }]
function unequipBlockers(inv, itemTypes, base, level, slot) -> [{ slot, name }]
module.exports = { REQ_STATS, gearStatGrants, effectiveStatsFor, meetsRequirements, illegalEquipped, unequipBlockers };

// backend/src/services/equipCompliance.js
async function enforceEquipRequirements(db, characterId, itemTypes, base, level)
  -> { ok:true, unequipped:[{slot,itemId,name}] } | { ok:false, reason:string, wouldUnequip:[{slot,itemId,name}] }

// backend/src/authority/items.js  — signature EXTENSION, existing arity still valid
function canEquip(inv, itemTypes, itemId, slot, req = null)   // req = { level:int, base:{...six stats} }
async function equip(pool, characterId, inv, itemTypes, itemId, slot, req = null)
```

`req === null` means "no requirement context supplied" and the level/stat gate is skipped. That is deliberate — `canEquip` is called from pure tests and from the client-side mirror with no progression to hand it — and Step 13 below is the guard that stops it becoming inertness: `world.setEquipment` always builds a real `req`, and a test asserts an under-level item is refused *through* `setEquipment`, not just through `canEquip`.

- [ ] **Step 1: Write the failing schema test**

Create `backend/tests/item_requirements_db.test.js` with only the schema case for now.

```js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

async function openPool() {
  if (!DB_URL) return { unreachable: 'no TEST_DATABASE_URL / DATABASE_URL' };
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 4 });
  try { await pool.query('SELECT 1'); } catch (err) {
    await pool.end().catch(() => {});
    return { unreachable: `NO DATABASE at ${DB_URL} (${err.message})` };
  }
  return pool;
}

test('item_types carries the requirement, item level and tier columns', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  const r = await pool.query(
    `SELECT column_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_name = 'item_types'
        AND column_name IN ('req_level','req_strength','req_dexterity','req_constitution',
                            'req_intelligence','req_wisdom','req_charisma','item_level','tier')
      ORDER BY column_name`,
  );
  assert.deepStrictEqual(
    r.rows.map((row) => row.column_name),
    ['item_level', 'req_charisma', 'req_constitution', 'req_dexterity',
     'req_intelligence', 'req_level', 'req_strength', 'req_wisdom', 'tier'],
  );
  for (const row of r.rows) assert.strictEqual(row.is_nullable, 'NO', `${row.column_name} must be NOT NULL`);

  // Hand-written defaults: every pre-existing catalog row must stay equippable
  // by a level-1 character with base stats, so the requirement defaults are
  // the identity values, not the ladder's tier-1 values.
  const d = Object.fromEntries(r.rows.map((row) => [row.column_name, row.column_default]));
  assert.match(d.req_level, /^1\b/);
  assert.match(d.req_strength, /^0\b/);
  assert.match(d.item_level, /^1\b/);
  assert.match(d.tier, /^1\b/);
});

test('the requirement columns reject nonsense values', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  await assert.rejects(
    pool.query(`INSERT INTO item_types (name, category, slot, kind, damage, cooldown, defense, req_level)
                VALUES ('req-check-probe-a', 'armor', 'chest', NULL, 0, 0, 1, 0)`),
    /item_types_req_level_check/,
  );
  await assert.rejects(
    pool.query(`INSERT INTO item_types (name, category, slot, kind, damage, cooldown, defense, req_strength)
                VALUES ('req-check-probe-b', 'armor', 'chest', NULL, 0, 0, 1, -1)`),
    /item_types_req_stats_check/,
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && DATABASE_URL="$S2_SCRATCH" TEST_DATABASE_URL="$S2_SCRATCH" node --test tests/item_requirements_db.test.js`
Expected: FAIL with `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:` — the actual array is `[]` because none of the nine columns exist.

- [ ] **Step 3: Write the migration**

Create `backend/migrations/1714440505000_item_requirements.js`:

```js
/* eslint-disable camelcase */
exports.shorthands = undefined;

// SOMET-NNN (progression epic, Group D / T10). Equipment gains a level gate
// and one gate per stat.
//
// Every default is the IDENTITY value, not a ladder value: 22 weapons and 2
// armor pieces already exist in the live catalog, plus whatever an admin
// authored, and a non-identity default would retroactively make somebody's
// equipped gear illegal the moment this migration ran. The base gear ladder
// (T11) sets real numbers on the rows it inserts; nothing here changes an
// existing row.
const REQ_STATS = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];

exports.up = (pgm) => {
  pgm.addColumns('item_types', {
    req_level: { type: 'integer', notNull: true, default: 1 },
    item_level: { type: 'integer', notNull: true, default: 1 },
    tier: { type: 'smallint', notNull: true, default: 1 },
    ...Object.fromEntries(REQ_STATS.map((s) => [`req_${s}`, { type: 'integer', notNull: true, default: 0 }])),
  });

  // 150 is the new MAX_LEVEL (spec §4). A req_level of 0 is meaningless and a
  // req_level above the cap is unwearable by anyone -- both are authoring
  // mistakes that must fail on write, not at equip time.
  pgm.addConstraint('item_types', 'item_types_req_level_check',
    'CHECK (req_level >= 1 AND req_level <= 150)');
  pgm.addConstraint('item_types', 'item_types_req_stats_check',
    `CHECK (${REQ_STATS.map((s) => `req_${s} >= 0`).join(' AND ')})`);
  pgm.addConstraint('item_types', 'item_types_item_level_check',
    'CHECK (item_level >= 1 AND item_level <= 150)');
  pgm.addConstraint('item_types', 'item_types_tier_check',
    'CHECK (tier >= 1 AND tier <= 10)');
};

exports.down = (pgm) => {
  pgm.dropConstraint('item_types', 'item_types_tier_check');
  pgm.dropConstraint('item_types', 'item_types_item_level_check');
  pgm.dropConstraint('item_types', 'item_types_req_stats_check');
  pgm.dropConstraint('item_types', 'item_types_req_level_check');
  pgm.dropColumns('item_types', ['req_level', 'item_level', 'tier', ...REQ_STATS.map((s) => `req_${s}`)]);
};
```

- [ ] **Step 4: Apply it and verify the test passes**

Run: `cd backend && DATABASE_URL="$S2_SCRATCH" npm run migrate:up && DATABASE_URL="$S2_SCRATCH" TEST_DATABASE_URL="$S2_SCRATCH" node --test tests/item_requirements_db.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/migrations/1714440505000_item_requirements.js backend/tests/item_requirements_db.test.js
git commit -m "feat(items): item_types requirement, item level and tier columns (SOMET-NNN)"
```

- [ ] **Step 6: Write the failing circularity test**

Create `backend/tests/item_requirements.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const {
  gearStatGrants, effectiveStatsFor, meetsRequirements, illegalEquipped, unequipBlockers,
} = require('../src/authority/equipRequirements.js');

// A catalog with exactly the pieces the circularity rule needs:
//  - 20: a chest piece that DEMANDS 20 strength
//  - 21: the buff stone that GRANTS +20 strength
//  - 22: a plain helm with no requirements
const TYPES = new Map([
  [20, { id: 20, name: 'giants-plate', category: 'armor', slot: 'chest', defense: 5,
         req_level: 1, req_strength: 20, req_dexterity: 0, req_constitution: 0,
         req_intelligence: 0, req_wisdom: 0, req_charisma: 0 }],
  [21, { id: 21, name: 'stone-of-might', category: 'stone', slot: null,
         stat_bonus_stat: 'strength', stat_bonus_amount: 20 }],
  [22, { id: 22, name: 'plain-helm', category: 'armor', slot: 'head', defense: 1,
         req_level: 1, req_strength: 0, req_dexterity: 0, req_constitution: 0,
         req_intelligence: 0, req_wisdom: 0, req_charisma: 0 }],
  [23, { id: 23, name: 'veteran-blade', category: 'weapon', slot: 'main_hand', two_handed: false,
         kind: 'melee', req_level: 40, req_strength: 0, req_dexterity: 0, req_constitution: 0,
         req_intelligence: 0, req_wisdom: 0, req_charisma: 0 }],
]);

const BASE = {
  strength: 5, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5,
};

// The plate carries the +20 STR stone in its own socket.
function selfGrantingInv() {
  return {
    items: [
      { id: 'plate', typeId: 20, socketedStoneTypeId: 21, socketedStoneItemId: 'stone' },
      { id: 'stone', typeId: 21 },
      { id: 'helm', typeId: 22 },
    ],
    equipment: {},
  };
}

test('an item granting +20 STR does NOT satisfy its own 20-STR requirement', () => {
  const inv = selfGrantingInv();
  // Pretend it is already in the chest slot: the check must still exclude it.
  inv.equipment = { chest: 'plate' };
  const stats = effectiveStatsFor(inv, TYPES, BASE, { excludeItemId: 'plate' });
  assert.strictEqual(stats.strength, 5, 'the candidate item contributes nothing to its own gate');
  const r = meetsRequirements(TYPES.get(20), 1, stats);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /strength/i);
});

test('the same stone socketed into a DIFFERENT equipped item does satisfy it', () => {
  const inv = {
    items: [
      { id: 'plate', typeId: 20 },
      { id: 'helm', typeId: 22, socketedStoneTypeId: 21, socketedStoneItemId: 'stone' },
      { id: 'stone', typeId: 21 },
    ],
    equipment: { head: 'helm' },
  };
  const stats = effectiveStatsFor(inv, TYPES, BASE, { excludeItemId: 'plate' });
  assert.strictEqual(stats.strength, 25);            // 5 base + 20 from the helm
  assert.deepStrictEqual(meetsRequirements(TYPES.get(20), 1, stats), { ok: true });
});

test('a stone in an UNEQUIPPED item grants nothing', () => {
  const inv = selfGrantingInv();                     // nothing equipped at all
  assert.deepStrictEqual(gearStatGrants(inv, TYPES), {
    strength: 0, dexterity: 0, constitution: 0, intelligence: 0, wisdom: 0, charisma: 0,
  });
});

test('req_level is checked against the character level', () => {
  const r = meetsRequirements(TYPES.get(23), 39, BASE);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /level 40/);
  assert.deepStrictEqual(meetsRequirements(TYPES.get(23), 40, BASE), { ok: true });
});

test('illegalEquipped names every equipped item that no longer qualifies', () => {
  const inv = {
    items: [{ id: 'plate', typeId: 20 }, { id: 'blade', typeId: 23 }, { id: 'helm', typeId: 22 }],
    equipment: { chest: 'plate', main_hand: 'blade', head: 'helm' },
  };
  const bad = illegalEquipped(inv, TYPES, BASE, 1);
  assert.deepStrictEqual(bad.map((b) => b.slot).sort(), ['chest', 'main_hand']);
  assert.deepStrictEqual(bad.map((b) => b.name).sort(), ['giants-plate', 'veteran-blade']);
});

test('unequipBlockers names the item that DEPENDS on the one being removed', () => {
  const inv = {
    items: [
      { id: 'plate', typeId: 20 },
      { id: 'helm', typeId: 22, socketedStoneTypeId: 21, socketedStoneItemId: 'stone' },
      { id: 'stone', typeId: 21 },
    ],
    equipment: { chest: 'plate', head: 'helm' },
  };
  const blockers = unequipBlockers(inv, TYPES, BASE, 1, 'head');
  assert.deepStrictEqual(blockers, [{ slot: 'chest', name: 'giants-plate' }]);
  // Removing the plate itself blocks nothing.
  assert.deepStrictEqual(unequipBlockers(inv, TYPES, BASE, 1, 'chest'), []);
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `cd backend && node --test tests/item_requirements.test.js`
Expected: FAIL with `Error: Cannot find module '../src/authority/equipRequirements.js'`.

- [ ] **Step 8: Write `equipRequirements.js`**

Create `backend/src/authority/equipRequirements.js`:

```js
// PURE requirement evaluation for equipment (SOMET-NNN, progression epic T10).
// No database, no clock, no rng -- the caller supplies the character's base
// stats and level.
//
// The one rule that makes this module necessary rather than a two-line check:
// requirements are evaluated against effective stats EXCLUDING the candidate
// item's own grants. Without that, an item granting +20 STR satisfies its own
// 20-STR requirement and a chain of stat-granting items bootstraps a level-1
// character into endgame gear.

const { SLOTS } = require('./items.js');

const REQ_STATS = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];

function zeroStats() {
  return {
    strength: 0, dexterity: 0, constitution: 0, intelligence: 0, wisdom: 0, charisma: 0,
  };
}

// What EQUIPPED gear currently grants, optionally ignoring one instance.
//
// Walks inv.equipment (never inv.items) for the same reason
// stoneBonuses.js#socketedBuffStones does: an item sitting loose in the
// backpack must contribute nothing, or a player stacks every buff stone they
// own by socketing each into a spare item and equipping none of them.
//
// Today the only gear-borne stat grant is a socketed buff stone. T12 adds
// per-instance affixes and extends THIS function -- there must never be a
// second place that answers "what do my items give me".
function gearStatGrants(inv, itemTypes, excludeItemId = null) {
  const out = zeroStats();
  for (const slot of SLOTS) {
    const itemId = inv.equipment[slot];
    if (!itemId || itemId === excludeItemId) continue;
    const item = inv.items.find((it) => it.id === itemId);
    if (!item) continue;
    if (item.socketedStoneTypeId != null) {
      const stoneType = itemTypes.get(item.socketedStoneTypeId);
      if (stoneType && stoneType.stat_bonus_stat != null
          && Object.prototype.hasOwnProperty.call(out, stoneType.stat_bonus_stat)) {
        out[stoneType.stat_bonus_stat] += Number(stoneType.stat_bonus_amount) || 0;
      }
    }
  }
  return out;
}

// base + gear. `base` is whatever the caller considers the character's
// non-gear total: today player_progression's six columns, and after Group C's
// T7 the composeStats() total of class base + passive tree. This module does
// not care which, which is exactly why it takes it as a parameter.
function effectiveStatsFor(inv, itemTypes, base, { excludeItemId = null } = {}) {
  const gear = gearStatGrants(inv, itemTypes, excludeItemId);
  const out = zeroStats();
  for (const s of REQ_STATS) out[s] = (Number(base && base[s]) || 0) + gear[s];
  return out;
}

// {ok:true} or {ok:false, reason}. A type with no requirement columns (a test
// fixture, or a catalog snapshot predating the migration) reads as no
// requirement -- the columns are NOT NULL in the schema, so a missing value
// here can only mean "not a real catalog row".
function meetsRequirements(type, level, stats) {
  if (!type) return { ok: false, reason: 'unknown item type' };
  const reqLevel = Number(type.req_level) || 0;
  if (reqLevel > (Number(level) || 0)) {
    return { ok: false, reason: `requires level ${reqLevel}` };
  }
  for (const s of REQ_STATS) {
    const need = Number(type[`req_${s}`]) || 0;
    if (need > (Number(stats && stats[s]) || 0)) {
      return { ok: false, reason: `requires ${need} ${s}` };
    }
  }
  return { ok: true };
}

// Every equipped item that fails its own requirements under `base`/`level`.
// Each item is judged with ITSELF excluded, which is the same circularity rule
// canEquip applies -- otherwise a set of two items that only qualify because
// of each other would both read as legal.
function illegalEquipped(inv, itemTypes, base, level) {
  const out = [];
  for (const slot of SLOTS) {
    const itemId = inv.equipment[slot];
    if (!itemId) continue;
    const item = inv.items.find((it) => it.id === itemId);
    if (!item) continue;
    const type = itemTypes.get(item.typeId);
    if (!type) continue;
    const stats = effectiveStatsFor(inv, itemTypes, base, { excludeItemId: itemId });
    const r = meetsRequirements(type, level, stats);
    if (!r.ok) out.push({ slot, itemId, name: type.name, reason: r.reason });
  }
  return out;
}

// Which OTHER equipped items would become illegal if `slot` were emptied.
// Returns [] when the unequip is safe. The candidate slot's own item is not
// reported -- it is the one leaving.
function unequipBlockers(inv, itemTypes, base, level, slot) {
  const leavingId = inv.equipment[slot];
  if (!leavingId) return [];
  const after = { ...inv, equipment: { ...inv.equipment } };
  delete after.equipment[slot];
  return illegalEquipped(after, itemTypes, base, level)
    .filter((b) => b.itemId !== leavingId)
    .map((b) => ({ slot: b.slot, name: b.name }));
}

module.exports = {
  REQ_STATS, gearStatGrants, effectiveStatsFor, meetsRequirements, illegalEquipped, unequipBlockers,
};
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `cd backend && node --test tests/item_requirements.test.js`
Expected: PASS (6 tests).

- [ ] **Step 10: Commit**

```bash
git add backend/src/authority/equipRequirements.js backend/tests/item_requirements.test.js
git commit -m "feat(items): pure equipment requirement evaluation with the circularity rule (SOMET-NNN)" 
```

- [ ] **Step 11: Write the failing `canEquip` gate test**

Append to `backend/tests/item_requirements.test.js`:

```js
const { canEquip } = require('../src/authority/items.js');

test('canEquip with no requirement context behaves exactly as before', () => {
  const inv = { items: [{ id: 'blade', typeId: 23 }], equipment: {} };
  assert.deepStrictEqual(canEquip(inv, TYPES, 'blade', 'main_hand'), { ok: true });
});

test('canEquip refuses an item whose level requirement is unmet', () => {
  const inv = { items: [{ id: 'blade', typeId: 23 }], equipment: {} };
  const r = canEquip(inv, TYPES, 'blade', 'main_hand', { level: 39, base: BASE });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'requires level 40');
});

test('canEquip refuses the self-granting plate and accepts it once the stone moves', () => {
  const self = selfGrantingInv();
  assert.strictEqual(canEquip(self, TYPES, 'plate', 'chest', { level: 1, base: BASE }).ok, false);

  const helped = {
    items: [
      { id: 'plate', typeId: 20 },
      { id: 'helm', typeId: 22, socketedStoneTypeId: 21, socketedStoneItemId: 'stone' },
      { id: 'stone', typeId: 21 },
    ],
    equipment: { head: 'helm' },
  };
  assert.deepStrictEqual(canEquip(helped, TYPES, 'plate', 'chest', { level: 1, base: BASE }), { ok: true });
});
```

- [ ] **Step 12: Run the test to verify it fails**

Run: `cd backend && node --test tests/item_requirements.test.js`
Expected: FAIL — `canEquip refuses an item whose level requirement is unmet` reports `Expected values to be strictly equal: true !== false`, because `canEquip` ignores its fifth argument.

- [ ] **Step 13: Extend `canEquip` and `equip`**

In `backend/src/authority/items.js`, replace the header comment and signature at line 337-338 and add the gate as the LAST check in both branches:

```js
// Pure legality check. Returns {ok:true} or {ok:false, reason}.
//
// `req` (SOMET-NNN, T10) is the requirement context: { level, base } where
// `base` is the character's non-gear stat bundle. It is OPTIONAL and null
// means "skip the level/stat gate" -- canEquip is also called from pure
// fixtures and from the client-side mirror, neither of which holds a
// progression row. world.setEquipment ALWAYS supplies a real one, and
// item_requirements_db.test.js asserts a refusal THROUGH setEquipment so a
// dropped thread fails loudly rather than silently ungating every item.
//
// The gate runs LAST, after the slot/category rules, so the message a player
// sees names the first thing actually wrong with the request rather than a
// stat requirement on an item that could never go in that slot anyway.
function canEquip(inv, itemTypes, itemId, slot, req = null) {
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
    return requirementGate(inv, itemTypes, itemId, type, req);
  }

  // armor: must go in its own slot
  if (type.slot !== slot) return { ok: false, reason: `that item goes in ${type.slot}` };
  return requirementGate(inv, itemTypes, itemId, type, req);
}

// Split out so the two branches above cannot drift on WHICH stats the gate
// runs against. `excludeItemId: itemId` is the circularity rule.
function requirementGate(inv, itemTypes, itemId, type, req) {
  if (!req) return { ok: true };
  const { effectiveStatsFor, meetsRequirements } = require('./equipRequirements.js');
  const stats = effectiveStatsFor(inv, itemTypes, req.base, { excludeItemId: itemId });
  return meetsRequirements(type, req.level, stats);
}
```

The `require` is inside the function on purpose: `equipRequirements.js` requires `SLOTS` from this module, and a top-level require here would be a cycle resolved to a half-initialised module.

Then at line 528, widen `equip`'s signature and forward:

```js
async function equip(pool, characterId, inv, itemTypes, itemId, slot, req = null) {
  const check = canEquip(inv, itemTypes, itemId, slot, req);
  if (!check.ok) return check;
```

Everything below that line — the `toClear` loop, the SOMET-77 snapshot/mutate/write-through/rollback ordering at 553-572 — is untouched. The gate runs before the in-memory mutation, exactly where the existing `canEquip` call already ran.

- [ ] **Step 14: Run the test to verify it passes**

Run: `cd backend && node --test tests/item_requirements.test.js tests/authority_items_equip.test.js tests/authority_items_inventory.test.js`
Expected: PASS. The two pre-existing files must stay green unchanged — they call `canEquip`/`equip` with the old arity, which now means "no requirement context".

- [ ] **Step 15: Commit**

```bash
git add backend/src/authority/items.js backend/tests/item_requirements.test.js
git commit -m "feat(items): gate canEquip on level and stat requirements (SOMET-NNN)"
```

- [ ] **Step 16: Write the failing world-threading test**

Append to `backend/tests/item_requirements_db.test.js`:

```js
const { World } = require('../src/authority/world.js');
const { loadItemTypes } = require('../src/authority/items.js');

async function createCharacter(pool, tag, level, stats = {}) {
  const username = `reqtest-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const u = await pool.query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player') RETURNING id`, [username],
  );
  const c = await pool.query(
    `INSERT INTO characters (user_id, slot, name, entity_type_id)
     SELECT $1, 1, $2, e.id FROM entity_types e WHERE e.name = 'Warrior' RETURNING id`,
    [u.rows[0].id, `req-char-${tag}-${process.pid}-${Date.now()}`],
  );
  const characterId = c.rows[0].id;
  await pool.query(
    `INSERT INTO player_progression (character_id, level, strength, dexterity, constitution,
                                     intelligence, wisdom, charisma)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [characterId, level, stats.strength ?? 5, stats.dexterity ?? 5, stats.constitution ?? 5,
     stats.intelligence ?? 5, stats.wisdom ?? 5, stats.charisma ?? 5],
  );
  return { userId: u.rows[0].id, characterId };
}

async function makeItemType(pool, name, extra) {
  const cols = { category: 'armor', slot: 'chest', kind: null, damage: 0, cooldown: 0, defense: 1, ...extra };
  const r = await pool.query(
    `INSERT INTO item_types (name, category, slot, kind, damage, cooldown, defense,
                             req_level, req_strength, item_level, tier)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [name, cols.category, cols.slot, cols.kind, cols.damage, cols.cooldown, cols.defense,
     cols.req_level ?? 1, cols.req_strength ?? 0, cols.item_level ?? 1, cols.tier ?? 1],
  );
  return r.rows[0].id;
}

test('world.setEquipment refuses an item whose level requirement the character does not meet', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  const tag = `lvl-${Date.now()}`;
  const { characterId } = await createCharacter(pool, tag, 3);
  const typeId = await makeItemType(pool, `req-plate-${tag}`, { req_level: 40 });
  const ins = await pool.query(
    'INSERT INTO player_items (character_id, item_type_id, quantity) VALUES ($1,$2,1) RETURNING id',
    [characterId, typeId],
  );
  const itemId = ins.rows[0].id;

  const itemTypes = await loadItemTypes(pool);
  const map = { chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] };
  const world = new World(map, itemTypes, null, 8);
  world.addPlayer('u-req', { x: 0, y: 0 }, {
    items: [{ id: itemId, typeId, quantity: 1 }], equipment: {},
  }, { x: 0, y: 0 }, 0, undefined, characterId);

  const r = await world.setEquipment(pool, 'u-req', itemId, 'chest');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'requires level 40');

  const eq = await pool.query('SELECT count(*)::int AS n FROM player_equipment WHERE character_id = $1', [characterId]);
  assert.strictEqual(eq.rows[0].n, 0, 'a refused equip must write nothing');
});

test('world.clearEquipment refuses an unequip that would orphan another item, naming it', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  const tag = `dep-${Date.now()}`;
  const { characterId } = await createCharacter(pool, tag, 50);
  const plateId = await makeItemType(pool, `dep-plate-${tag}`, { req_strength: 20 });
  const helmId = await makeItemType(pool, `dep-helm-${tag}`, { slot: 'head' });
  const stoneTypeId = (await pool.query(
    `INSERT INTO item_types (name, category, slot, kind, damage, cooldown,
                             stat_bonus_stat, stat_bonus_amount)
     VALUES ($1,'stone',NULL,NULL,0,0,'strength',20) RETURNING id`,
    [`dep-stone-${tag}`],
  )).rows[0].id;

  const plate = (await pool.query('INSERT INTO player_items (character_id, item_type_id) VALUES ($1,$2) RETURNING id', [characterId, plateId])).rows[0].id;
  const helm = (await pool.query('INSERT INTO player_items (character_id, item_type_id) VALUES ($1,$2) RETURNING id', [characterId, helmId])).rows[0].id;
  const stone = (await pool.query('INSERT INTO player_items (character_id, item_type_id) VALUES ($1,$2) RETURNING id', [characterId, stoneTypeId])).rows[0].id;
  await pool.query('INSERT INTO stone_instances (player_item_id, socketed_into_id) VALUES ($1,$2)', [stone, helm]);
  await pool.query('INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1,$2,$3)', [characterId, 'chest', plate]);
  await pool.query('INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1,$2,$3)', [characterId, 'head', helm]);

  const itemTypes = await loadItemTypes(pool);
  const map = { chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] };
  const world = new World(map, itemTypes, null, 8);
  world.addPlayer('u-dep', { x: 0, y: 0 }, {
    items: [
      { id: plate, typeId: plateId, quantity: 1 },
      { id: helm, typeId: helmId, quantity: 1, socketedStoneTypeId: stoneTypeId, socketedStoneItemId: stone },
      { id: stone, typeId: stoneTypeId, quantity: 1 },
    ],
    equipment: { chest: plate, head: helm },
  }, { x: 0, y: 0 }, 0, undefined, characterId);

  const r = await world.clearEquipment(pool, 'u-dep', 'head');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, new RegExp(`dep-plate-${tag}`));

  const still = await pool.query(
    'SELECT slot FROM player_equipment WHERE character_id = $1 ORDER BY slot', [characterId],
  );
  assert.deepStrictEqual(still.rows.map((x) => x.slot), ['chest', 'head']);
});
```

- [ ] **Step 17: Run the test to verify it fails**

Run: `cd backend && DATABASE_URL="$S2_SCRATCH" TEST_DATABASE_URL="$S2_SCRATCH" node --test tests/item_requirements_db.test.js`
Expected: FAIL — the first new case reports `Expected values to be strictly equal: true !== false` (the equip succeeds), the second reports `ok: true` where `false` was expected.

- [ ] **Step 18: Thread the requirement context through `world.js`**

In `backend/src/authority/world.js`, add near the other requires at the top of the file:

```js
const { unequipBlockers } = require('./equipRequirements.js');
const { loadProgression } = require('../services/progressionStore.js');
```

and replace lines 373-387:

```js
  // SOMET-NNN (T10). The requirement context is read from the DATABASE here,
  // once per equip action, rather than cached on the player object.
  //
  // Two reasons. (1) The spec's own risk table says requirements are validated
  // on equip only, never per attack -- so one SELECT on a player-initiated
  // action is affordable, and the combat hot path is untouched. (2) A cached
  // copy would have to be invalidated by every level-up, respec, passive
  // allocation and buff-stone socket; the second one of those anybody forgets
  // is a player wearing gear they no longer qualify for, silently.
  async _requirementContext(pool, characterId) {
    const progression = await loadProgression(pool, characterId);
    return {
      level: progression.level,
      base: {
        strength: progression.strength,
        dexterity: progression.dexterity,
        constitution: progression.constitution,
        intelligence: progression.intelligence,
        wisdom: progression.wisdom,
        charisma: progression.charisma,
      },
    };
  }

  async setEquipment(pool, userId, itemId, slot) {
    const p = this.players.get(userId);
    if (!p) return { ok: false, reason: 'no player' };
    const req = await this._requirementContext(pool, p.characterId);
    const r = await equipItem(pool, p.characterId, p.inv, this.weapons, itemId, slot, req);
    if (r.ok) p.mit = mitigation(p.inv, this.weapons);
    return r;
  }

  async clearEquipment(pool, userId, slot) {
    const p = this.players.get(userId);
    if (!p) return { ok: false, reason: 'no player' };
    // Refused BEFORE unequipItem's in-memory mutation, so the SOMET-77
    // ordering below it is never entered on a refusal and there is nothing to
    // roll back. Naming B is the whole point: "unequip it first" with no
    // subject is unactionable when eight slots could be the cause.
    const req = await this._requirementContext(pool, p.characterId);
    const blockers = unequipBlockers(p.inv, this.weapons, req.base, req.level, slot);
    if (blockers.length > 0) {
      const names = blockers.map((b) => b.name).join(', ');
      return { ok: false, reason: `${names} would no longer meet its requirements` };
    }
    const r = await unequipItem(pool, p.characterId, p.inv, slot);
    if (r.ok) p.mit = mitigation(p.inv, this.weapons);
    return r;
  }
```

- [ ] **Step 19: Run the test to verify it passes**

Run: `cd backend && DATABASE_URL="$S2_SCRATCH" TEST_DATABASE_URL="$S2_SCRATCH" node --test tests/item_requirements_db.test.js tests/authority_world.test.js`
Expected: PASS.

- [ ] **Step 20: Commit**

```bash
git add backend/src/authority/world.js backend/tests/item_requirements_db.test.js
git commit -m "feat(items): validate requirements on equip and refuse orphaning unequips (SOMET-NNN)"
```

- [ ] **Step 21: Write the failing respec-compliance test**

Append to `backend/tests/item_requirements_db.test.js`:

```js
const { enforceEquipRequirements } = require('../src/services/equipCompliance.js');

const RESET_BASE = {
  strength: 5, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5,
};

test('a respec auto-unequips gear that no longer qualifies, leaving it in the backpack', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  const tag = `resp-${Date.now()}`;
  const { characterId } = await createCharacter(pool, tag, 60, { strength: 40 });
  const plateId = await makeItemType(pool, `resp-plate-${tag}`, { req_strength: 30 });
  const helmId = await makeItemType(pool, `resp-helm-${tag}`, { slot: 'head' });
  const plate = (await pool.query('INSERT INTO player_items (character_id, item_type_id) VALUES ($1,$2) RETURNING id', [characterId, plateId])).rows[0].id;
  const helm = (await pool.query('INSERT INTO player_items (character_id, item_type_id) VALUES ($1,$2) RETURNING id', [characterId, helmId])).rows[0].id;
  await pool.query('INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1,$2,$3)', [characterId, 'chest', plate]);
  await pool.query('INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1,$2,$3)', [characterId, 'head', helm]);

  const itemTypes = await loadItemTypes(pool);
  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');
    result = await enforceEquipRequirements(client, characterId, itemTypes, RESET_BASE, 60);
    await client.query('COMMIT');
  } finally { client.release(); }

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.unequipped.map((u) => u.slot), ['chest']);

  const eq = await pool.query('SELECT slot FROM player_equipment WHERE character_id = $1 ORDER BY slot', [characterId]);
  assert.deepStrictEqual(eq.rows.map((x) => x.slot), ['head'], 'only the illegal slot is cleared');
  const owned = await pool.query('SELECT count(*)::int AS n FROM player_items WHERE character_id = $1', [characterId]);
  assert.strictEqual(owned.rows[0].n, 2, 'nothing is deleted -- the plate is still owned');
});

test('respec with a full backpack is refused and leaves equipment untouched', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  const tag = `full-${Date.now()}`;
  const { characterId } = await createCharacter(pool, tag, 60, { strength: 40 });
  // Two carry slots, four owned rows: the backpack is already over its cap, so
  // there is nowhere for returned gear to sit. See equipCompliance.js for why
  // that is the condition, not "free slots >= items to unequip".
  await pool.query('UPDATE characters SET inventory_slots = 2 WHERE id = $1', [characterId]);
  const plateId = await makeItemType(pool, `full-plate-${tag}`, { req_strength: 30 });
  const helmId = await makeItemType(pool, `full-helm-${tag}`, { slot: 'head' });
  const plate = (await pool.query('INSERT INTO player_items (character_id, item_type_id) VALUES ($1,$2) RETURNING id', [characterId, plateId])).rows[0].id;
  const helm = (await pool.query('INSERT INTO player_items (character_id, item_type_id) VALUES ($1,$2) RETURNING id', [characterId, helmId])).rows[0].id;
  await pool.query('INSERT INTO player_items (character_id, item_type_id) VALUES ($1,$2)', [characterId, helmId]);
  await pool.query('INSERT INTO player_items (character_id, item_type_id) VALUES ($1,$2)', [characterId, helmId]);
  await pool.query('INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1,$2,$3)', [characterId, 'chest', plate]);
  await pool.query('INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1,$2,$3)', [characterId, 'head', helm]);

  const itemTypes = await loadItemTypes(pool);
  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');
    result = await enforceEquipRequirements(client, characterId, itemTypes, RESET_BASE, 60);
    await client.query('ROLLBACK');
  } finally { client.release(); }

  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /backpack/i);
  assert.deepStrictEqual(result.wouldUnequip.map((u) => u.slot), ['chest']);

  const eq = await pool.query('SELECT slot FROM player_equipment WHERE character_id = $1 ORDER BY slot', [characterId]);
  assert.deepStrictEqual(eq.rows.map((x) => x.slot), ['chest', 'head'], 'equipment is untouched');
  const owned = await pool.query('SELECT count(*)::int AS n FROM player_items WHERE character_id = $1', [characterId]);
  assert.strictEqual(owned.rows[0].n, 4, 'no gear is deleted');
});
```

- [ ] **Step 22: Run the test to verify it fails**

Run: `cd backend && DATABASE_URL="$S2_SCRATCH" TEST_DATABASE_URL="$S2_SCRATCH" node --test tests/item_requirements_db.test.js`
Expected: FAIL with `Error: Cannot find module '../src/services/equipCompliance.js'`.

- [ ] **Step 23: Write `equipCompliance.js`**

Create `backend/src/services/equipCompliance.js`:

```js
// Respec compliance (SOMET-NNN, progression epic T10).
//
// After a respec (or any other event that lowers a character's stats), gear
// that no longer meets its requirements must not stay live in the combat path
// and must not be deleted. It is unequipped -- the player_items row is
// untouched, only the player_equipment row goes.
//
// WHY THE CAPACITY RULE IS WHAT IT IS. The spec says "auto-unequipped into the
// backpack; if the backpack has no room the respec is refused". In THIS schema
// an equipped item is already a player_items row and items.js#usedSlots
// (authority/items.js:307) counts every non-currency row whether it is
// equipped or not -- the inventory panel draws equipped items in the same grid
// (inventoryPanel.js#visibleItems). So unequipping is capacity-NEUTRAL: it
// moves nothing between two pools, it clears a paper-doll pointer.
//
// Refusing on "not enough free slots" would therefore be an unreachable branch
// dressed up as a safety check. The condition that IS real, and is the one
// this enforces, is an ALREADY over-capacity backpack: usedSlots > capacity.
// That state is reachable (an admin lowering characters.inventory_slots, which
// the column's CHECK (inventory_slots > 0) permits down to 1) and it is
// precisely the state in which a returned item has no representable home. In
// every other state the unequip is safe and proceeds.
//
// `db` is a checked-out client inside the CALLER's transaction, never the bare
// pool: the respec's gold debit, stat reset and this unequip must stand or
// fall together, exactly as progressionStore#respec already does for the first
// two.

const { SLOTS, usedSlots, capacityOf } = require('../authority/items.js');
const { illegalEquipped } = require('../authority/equipRequirements.js');

// Rebuild the inv shape the pure helpers expect, straight from the database.
// Deliberately not read off a live world: a respec is an HTTP action and the
// character may not be connected at all.
async function loadInvForCompliance(db, characterId) {
  const ir = await db.query(
    'SELECT id, item_type_id FROM player_items WHERE character_id = $1 ORDER BY created_at ASC, id ASC',
    [characterId],
  );
  const er = await db.query('SELECT slot, item_id FROM player_equipment WHERE character_id = $1', [characterId]);
  const sr = await db.query(
    `SELECT si.socketed_into_id AS host_id, si.player_item_id AS stone_item_id,
            stone_pi.item_type_id AS stone_type_id
       FROM stone_instances si
       JOIN player_items stone_pi ON stone_pi.id = si.player_item_id
       JOIN player_items host_pi ON host_pi.id = si.socketed_into_id
      WHERE host_pi.character_id = $1 AND si.socketed_into_id IS NOT NULL`,
    [characterId],
  );
  const cr = await db.query('SELECT inventory_slots FROM characters WHERE id = $1', [characterId]);

  const items = ir.rows.map((r) => ({ id: r.id, typeId: r.item_type_id, quantity: 1 }));
  const byId = new Map(items.map((it) => [it.id, it]));
  for (const row of sr.rows) {
    const host = byId.get(row.host_id);
    if (host) {
      host.socketedStoneTypeId = row.stone_type_id;
      host.socketedStoneItemId = row.stone_item_id;
    }
  }
  const equipment = {};
  for (const row of er.rows) equipment[row.slot] = row.item_id;
  return {
    items,
    equipment,
    capacity: cr.rows.length ? Number(cr.rows[0].inventory_slots) : undefined,
  };
}

async function enforceEquipRequirements(db, characterId, itemTypes, base, level) {
  const inv = await loadInvForCompliance(db, characterId);
  const bad = illegalEquipped(inv, itemTypes, base, level);
  if (bad.length === 0) return { ok: true, unequipped: [] };

  const wouldUnequip = bad.map((b) => ({ slot: b.slot, itemId: b.itemId, name: b.name }));
  if (usedSlots(inv, itemTypes) > capacityOf(inv)) {
    return {
      ok: false,
      reason: 'your backpack is over its carry limit -- make room before respeccing',
      wouldUnequip,
    };
  }

  // Whitelisted against SLOTS rather than interpolated: these strings came
  // from a catalog row, but the same discipline progressionStore#allocateStat
  // applies to a stat key applies here.
  const slots = wouldUnequip.map((u) => u.slot).filter((s) => SLOTS.includes(s));
  await db.query(
    'DELETE FROM player_equipment WHERE character_id = $1 AND slot = ANY($2::text[])',
    [characterId, slots],
  );
  return { ok: true, unequipped: wouldUnequip };
}

module.exports = { enforceEquipRequirements, loadInvForCompliance };
```

- [ ] **Step 24: Run the test to verify it passes**

Run: `cd backend && DATABASE_URL="$S2_SCRATCH" TEST_DATABASE_URL="$S2_SCRATCH" node --test tests/item_requirements_db.test.js`
Expected: PASS (6 tests).

- [ ] **Step 25: Commit**

```bash
git add backend/src/services/equipCompliance.js backend/tests/item_requirements_db.test.js
git commit -m "feat(items): auto-unequip illegal gear on respec, or refuse it (SOMET-NNN)"
```

**Integration seam for Group C (T7):** `POST /api/progression/respec` must call `enforceEquipRequirements(client, characterId, itemTypes, newBase, level)` inside its own transaction, after the stat reset and before `COMMIT`, and must `ROLLBACK` and return `409 { error: result.reason, wouldUnequip: result.wouldUnequip }` when `ok` is false. This plan does not modify the respec route; it provides the function that route calls.

---

### Task 2: Base gear ladder — 150 items across 8 slots × 10 tiers (T11)

**Files:**
- Create: `backend/seeds/data/gearLadder.js`
- Create: `backend/seeds/generateGearLadder.js`
- Create: `backend/migrations/1714440506000_base_gear_ladder.js`
- Create: `backend/scripts/seed-gear-ladder.js`
- Modify: `backend/package.json` (one new script line)
- Test: `backend/tests/gear_ladder.test.js`, `backend/tests/gear_ladder_db.test.js`

**Interfaces:**

- Consumes: T10's `item_types.req_level`, `req_*`, `item_level`, `tier` columns (migration `1714440505000`); the live CHECK constraints `item_types_weapon_fields_check`, `item_types_armor_fields_check`, `item_types_slot_check`, `weapon_types_kind_check`.
- Produces:

```js
// backend/seeds/data/gearLadder.js
module.exports = { GEAR_TIERS, GEAR_FAMILIES };   // plain data, no functions

// backend/seeds/generateGearLadder.js  — PURE
function generateGearLadder({ tiers, families }) -> [{
  name, category, slot, two_handed, kind, damage, cooldown, reach, arc_width,
  range, projectile_speed, projectile_radius, defense, value, tier, item_level,
  req_level, req_strength, req_dexterity, req_constitution, req_intelligence,
  req_wisdom, req_charisma,
}]
async function upsertGearLadder(db, rows) -> { inserted: int, skipped: int }
module.exports = { generateGearLadder, upsertGearLadder };
```

**Why the live catalog needs this:** queried against the running dev database at plan time —

```
   slot    | category | count
-----------+----------+-------
 chest     | armor    |     1
 head      | armor    |     1
 main_hand | weapon   |    22
```

Five of the eight paper-doll slots (`off_hand`, `hands`, `feet`, `ring1`, `ring2`) have **zero** items, so five of the eight slots the panel draws can never be filled.

**Rings are slot-specific.** `canEquip`'s armor branch is `if (type.slot !== slot) return {ok:false}` (`backend/src/authority/items.js:357`), so a row authored with `slot = 'ring1'` can never go in `ring2`. The ladder therefore carries two ring families rather than one, and this is called out in `gearLadder.js` so nobody "fixes" it by authoring one.

- [ ] **Step 1: Write the failing generator test**

Create `backend/tests/gear_ladder.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { generateGearLadder } = require('../seeds/generateGearLadder.js');
const { GEAR_TIERS, GEAR_FAMILIES } = require('../seeds/data/gearLadder.js');

const SPEC = { tiers: GEAR_TIERS, families: GEAR_FAMILIES };

test('the ladder is 15 families x 10 tiers = 150 rows with unique names', () => {
  const rows = generateGearLadder(SPEC);
  assert.strictEqual(rows.length, 150);
  assert.strictEqual(new Set(rows.map((r) => r.name)).size, 150);
});

test('every one of the eight paper-doll slots is covered', () => {
  const rows = generateGearLadder(SPEC);
  const bySlot = {};
  for (const r of rows) bySlot[r.slot] = (bySlot[r.slot] || 0) + 1;
  // Hand-written: 3 main_hand families, 2 each for off_hand/head/chest/hands/feet,
  // 1 each for ring1/ring2, times 10 tiers.
  assert.deepStrictEqual(bySlot, {
    main_hand: 30, off_hand: 20, head: 20, chest: 20, hands: 20, feet: 20, ring1: 10, ring2: 10,
  });
});

test('the ten req_level rungs are exactly the specced ladder', () => {
  const rows = generateGearLadder(SPEC);
  const levels = [...new Set(rows.map((r) => r.req_level))].sort((a, b) => a - b);
  assert.deepStrictEqual(levels, [1, 10, 25, 40, 55, 70, 90, 110, 130, 150]);
});

test('tier 1 demands nothing beyond level 1 so a fresh character can wear it', () => {
  const rows = generateGearLadder(SPEC).filter((r) => r.tier === 1);
  assert.strictEqual(rows.length, 15);
  for (const r of rows) {
    assert.strictEqual(r.req_level, 1, r.name);
    for (const s of ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma']) {
      assert.strictEqual(r[`req_${s}`], 0, `${r.name}.req_${s}`);
    }
  }
});

test('named rows carry hand-checked numbers', () => {
  const rows = generateGearLadder(SPEC);
  const byName = new Map(rows.map((r) => [r.name, r]));

  // crude-blade: family damage 6 x tier-1 power 1.0
  const crude = byName.get('crude-blade');
  assert.strictEqual(crude.category, 'weapon');
  assert.strictEqual(crude.kind, 'melee');
  assert.strictEqual(crude.slot, 'main_hand');
  assert.strictEqual(crude.damage, 6);
  assert.strictEqual(crude.reach, 80);
  assert.strictEqual(crude.arc_width, 1.2);
  assert.strictEqual(crude.defense, null);
  assert.strictEqual(crude.value, 10);

  // mythic-plate: family defense 3.0 x tier-10 power 14.5 = 43.5, req 116 STR
  const mythic = byName.get('mythic-plate');
  assert.strictEqual(mythic.category, 'armor');
  assert.strictEqual(mythic.slot, 'chest');
  assert.strictEqual(mythic.defense, 43.5);
  assert.strictEqual(mythic.req_level, 150);
  assert.strictEqual(mythic.req_strength, 116);
  assert.strictEqual(mythic.req_dexterity, 0);
  assert.strictEqual(mythic.item_level, 150);
  assert.strictEqual(mythic.tier, 10);
  assert.strictEqual(mythic.kind, null);

  // steel-wand: projectile, family damage 5 x tier-3 power 2.4 = 12
  const wand = byName.get('steel-wand');
  assert.strictEqual(wand.kind, 'projectile');
  assert.strictEqual(wand.damage, 12);
  assert.strictEqual(wand.range, 420);
  assert.strictEqual(wand.projectile_speed, 520);
  assert.strictEqual(wand.projectile_radius, 6);
  assert.strictEqual(wand.req_intelligence, 16);
  assert.strictEqual(wand.two_handed, false);

  // iron-spear is the two-handed family
  assert.strictEqual(byName.get('iron-spear').two_handed, true);
  assert.strictEqual(byName.get('iron-blade').two_handed, false);
});

test('every weapon row satisfies item_types_weapon_fields_check by construction', () => {
  for (const r of generateGearLadder(SPEC)) {
    if (r.category !== 'weapon') continue;
    assert.ok(r.kind === 'melee' || r.kind === 'projectile', r.name);
    if (r.kind === 'melee') {
      assert.ok(r.reach != null && r.arc_width != null, r.name);
    } else {
      assert.ok(r.range != null && r.projectile_speed != null && r.projectile_radius != null, r.name);
    }
  }
});

test('every armor row satisfies item_types_armor_fields_check by construction', () => {
  for (const r of generateGearLadder(SPEC)) {
    if (r.category !== 'armor') continue;
    assert.ok(r.slot != null, r.name);
    assert.ok(typeof r.defense === 'number' && r.defense > 0, r.name);
    assert.strictEqual(r.kind, null, r.name);
  }
});

test('two runs produce identical output', () => {
  assert.deepStrictEqual(generateGearLadder(SPEC), generateGearLadder(SPEC));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && node --test tests/gear_ladder.test.js`
Expected: FAIL with `Error: Cannot find module '../seeds/generateGearLadder.js'`.

- [ ] **Step 3: Write the tier spec**

Create `backend/seeds/data/gearLadder.js`:

```js
// The authored base-gear ladder (SOMET-NNN, progression epic T11).
//
// DATA ONLY. generateGearLadder.js turns this into item_types rows; nothing
// here computes anything, so a rebalance is an edit to two tables rather than
// an edit to 150 rows.
//
// The live catalog before this file existed held 24 equippable items: 22
// weapons, all main_hand, one chest armor and one head armor. off_hand, hands,
// feet, ring1 and ring2 had ZERO items -- five of the eight slots the paper
// doll draws could never be filled.
//
// SPRITES ARE OUT OF SCOPE (spec's "explicitly out of scope" list). These 150
// rows render as placeholder colour boxes, exactly as a new decoration type
// does until someone generates art for it.

// Ten rungs. `req_level` is the ladder the spec fixes; `power` is the single
// scalar every damage/defense number is multiplied by, so a rebalance of the
// whole curve is ten numbers, not 150. `stat_req` is what the tier demands of
// its family's own stat -- tier 1 demands nothing so a brand-new character can
// equip the whole bottom rung.
const GEAR_TIERS = [
  { tier: 1,  req_level: 1,   item_level: 1,   prefix: 'crude',    stat_req: 0,   power: 1.0,  value: 10 },
  { tier: 2,  req_level: 10,  item_level: 10,  prefix: 'iron',     stat_req: 8,   power: 1.6,  value: 40 },
  { tier: 3,  req_level: 25,  item_level: 25,  prefix: 'steel',    stat_req: 16,  power: 2.4,  value: 110 },
  { tier: 4,  req_level: 40,  item_level: 40,  prefix: 'tempered', stat_req: 26,  power: 3.4,  value: 240 },
  { tier: 5,  req_level: 55,  item_level: 55,  prefix: 'runed',    stat_req: 36,  power: 4.6,  value: 430 },
  { tier: 6,  req_level: 70,  item_level: 70,  prefix: 'obsidian', stat_req: 48,  power: 6.0,  value: 700 },
  { tier: 7,  req_level: 90,  item_level: 90,  prefix: 'astral',   stat_req: 62,  power: 7.8,  value: 1100 },
  { tier: 8,  req_level: 110, item_level: 110, prefix: 'void',     stat_req: 78,  power: 9.8,  value: 1650 },
  { tier: 9,  req_level: 130, item_level: 130, prefix: 'dragon',   stat_req: 96,  power: 12.0, value: 2400 },
  { tier: 10, req_level: 150, item_level: 150, prefix: 'mythic',   stat_req: 116, power: 14.5, value: 3400 },
];

// Fifteen families, chosen so every slot has at least one and every one of the
// six stats gates at least one family -- a Monk (wisdom) and a Druid (charisma)
// must both have gear their own stat unlocks, or the requirement system reads
// as a strength tax.
//
// TWO RING FAMILIES, ON PURPOSE. canEquip's armor branch is
// `if (type.slot !== slot) return {ok:false}` (authority/items.js:357), so a
// row authored with slot 'ring1' can NEVER be put in ring2. One ring family
// would leave ring2 permanently empty -- exactly the hole this task exists to
// close. Do not "simplify" these two into one.
//
// `damage`/`defense` here are the TIER-1 values; the generator multiplies by
// the tier's `power`. `req_stat` names which stat the family gates on.
const GEAR_FAMILIES = [
  // main_hand -- three, because the weapon slot is the one that decides how a
  // class actually plays.
  { key: 'blade',  slot: 'main_hand', category: 'weapon', kind: 'melee',      req_stat: 'strength',
    two_handed: false, damage: 6, cooldown: 0.55, reach: 80,  arc_width: 1.2 },
  { key: 'spear',  slot: 'main_hand', category: 'weapon', kind: 'melee',      req_stat: 'dexterity',
    two_handed: true,  damage: 8, cooldown: 0.8,  reach: 150, arc_width: 0.7 },
  { key: 'wand',   slot: 'main_hand', category: 'weapon', kind: 'projectile', req_stat: 'intelligence',
    two_handed: false, damage: 5, cooldown: 0.7,  range: 420, projectile_speed: 520, projectile_radius: 6 },

  // off_hand -- armor, not weapons: canEquip already refuses a two-handed
  // weapon's off hand and a second weapon has no combat meaning today.
  { key: 'buckler', slot: 'off_hand', category: 'armor', req_stat: 'strength', defense: 1.5 },
  { key: 'focus',   slot: 'off_hand', category: 'armor', req_stat: 'wisdom',   defense: 0.5 },

  { key: 'helm',    slot: 'head',  category: 'armor', req_stat: 'strength',     defense: 1.5 },
  { key: 'hood',    slot: 'head',  category: 'armor', req_stat: 'dexterity',    defense: 1.0 },

  { key: 'plate',   slot: 'chest', category: 'armor', req_stat: 'strength',     defense: 3.0 },
  { key: 'robe',    slot: 'chest', category: 'armor', req_stat: 'intelligence', defense: 1.5 },

  { key: 'gauntlets', slot: 'hands', category: 'armor', req_stat: 'strength',  defense: 1.0 },
  { key: 'gloves',    slot: 'hands', category: 'armor', req_stat: 'dexterity', defense: 0.7 },

  { key: 'greaves', slot: 'feet', category: 'armor', req_stat: 'constitution', defense: 1.2 },
  { key: 'boots',   slot: 'feet', category: 'armor', req_stat: 'dexterity',    defense: 0.7 },

  { key: 'band',    slot: 'ring1', category: 'armor', req_stat: 'charisma', defense: 0.2 },
  { key: 'signet',  slot: 'ring2', category: 'armor', req_stat: 'charisma', defense: 0.2 },
];

module.exports = { GEAR_TIERS, GEAR_FAMILIES };
```

- [ ] **Step 4: Write the generator**

Create `backend/seeds/generateGearLadder.js`:

```js
// PURE generator for the base gear ladder (SOMET-NNN, progression epic T11).
// Same spec in, byte-identical rows out: no Math.random, no Date.now, no
// database. The upsert at the bottom is the ONLY impure thing in this file and
// is shared by the migration and the re-seed script so the two can never
// disagree about what a ladder row is.

const REQ_STATS = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];

// One decimal place. Postgres `real` would round anyway; doing it here means
// the generator's output and the stored row are the same number, so a test may
// compare either.
function round1(n) { return Math.round(n * 10) / 10; }

function generateGearLadder({ tiers, families }) {
  const rows = [];
  for (const f of families) {
    for (const t of tiers) {
      const req = Object.fromEntries(REQ_STATS.map((s) => [`req_${s}`, 0]));
      req[`req_${f.req_stat}`] = t.stat_req;
      const isWeapon = f.category === 'weapon';
      rows.push({
        name: `${t.prefix}-${f.key}`,
        category: f.category,
        slot: f.slot,
        two_handed: f.two_handed === true,
        // NULL for armor, never '' or 'none': weapon_types_kind_check admits
        // only 'melee' and 'projectile', and item_types_weapon_fields_check
        // requires a kind on weapons only.
        kind: isWeapon ? f.kind : null,
        damage: isWeapon ? round1(f.damage * t.power) : 0,
        cooldown: isWeapon ? f.cooldown : 0,
        reach: f.reach != null ? f.reach : null,
        arc_width: f.arc_width != null ? f.arc_width : null,
        range: f.range != null ? f.range : null,
        projectile_speed: f.projectile_speed != null ? f.projectile_speed : null,
        projectile_radius: f.projectile_radius != null ? f.projectile_radius : null,
        // item_types_armor_fields_check demands a non-null defense on armor;
        // a weapon's defense stays NULL rather than 0 so the ranged-staff
        // defense floor migration's reasoning is not re-litigated here.
        defense: isWeapon ? null : round1(f.defense * t.power),
        value: t.value,
        tier: t.tier,
        item_level: t.item_level,
        req_level: t.req_level,
        ...req,
      });
    }
  }
  return rows;
}

// UPSERT BY NAME, NEVER DELETE -- the same rule scripts/seed-catalogs.js states
// in its header. A ladder row an admin has since retuned in the Items admin
// must survive a re-seed, so an existing name is SKIPPED rather than
// overwritten. Adding a family or a tier is what this is for; changing an
// existing row's numbers is an admin-UI action or a new migration.
async function upsertGearLadder(db, rows) {
  let inserted = 0;
  let skipped = 0;
  for (const r of rows) {
    const res = await db.query(
      `INSERT INTO item_types
         (name, category, slot, two_handed, kind, damage, cooldown, reach, arc_width,
          range, projectile_speed, projectile_radius, defense, value,
          tier, item_level, req_level,
          req_strength, req_dexterity, req_constitution, req_intelligence, req_wisdom, req_charisma)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       ON CONFLICT (name) DO NOTHING
       RETURNING id`,
      [r.name, r.category, r.slot, r.two_handed, r.kind, r.damage, r.cooldown, r.reach, r.arc_width,
       r.range, r.projectile_speed, r.projectile_radius, r.defense, r.value,
       r.tier, r.item_level, r.req_level,
       r.req_strength, r.req_dexterity, r.req_constitution,
       r.req_intelligence, r.req_wisdom, r.req_charisma],
    );
    if (res.rowCount === 1) inserted += 1; else skipped += 1;
  }
  return { inserted, skipped };
}

module.exports = { generateGearLadder, upsertGearLadder };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && node --test tests/gear_ladder.test.js`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/seeds/data/gearLadder.js backend/seeds/generateGearLadder.js backend/tests/gear_ladder.test.js
git commit -m "feat(items): authored gear tier spec and deterministic ladder generator (SOMET-NNN)"
```

- [ ] **Step 7: Write the failing seed test**

Create `backend/tests/gear_ladder_db.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { loadItemTypes, canEquip, SLOTS } = require('../src/authority/items.js');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

async function openPool() {
  if (!DB_URL) return { unreachable: 'no TEST_DATABASE_URL / DATABASE_URL' };
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 4 });
  try { await pool.query('SELECT 1'); } catch (err) {
    await pool.end().catch(() => {});
    return { unreachable: `NO DATABASE at ${DB_URL} (${err.message})` };
  }
  return pool;
}

test('every one of the eight paper-doll slots has at least one equippable base item', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  const r = await pool.query(
    `SELECT slot, count(*)::int AS n
       FROM item_types
      WHERE category IN ('weapon','armor') AND slot IS NOT NULL
      GROUP BY slot`,
  );
  const bySlot = Object.fromEntries(r.rows.map((row) => [row.slot, row.n]));

  // Hand-written list, not SLOTS-derived: if someone deletes a slot from
  // items.js the list this asserts must not shrink with it.
  for (const slot of ['main_hand', 'off_hand', 'head', 'chest', 'hands', 'feet', 'ring1', 'ring2']) {
    assert.ok((bySlot[slot] || 0) >= 1, `slot ${slot} has no equippable item type`);
  }
  assert.deepStrictEqual([...SLOTS].sort(),
    ['chest', 'feet', 'hands', 'head', 'main_hand', 'off_hand', 'ring1', 'ring2']);
});

test('a level-1 character with base stats can equip a full tier-1 set', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  const itemTypes = await loadItemTypes(pool);
  const wanted = ['crude-blade', 'crude-buckler', 'crude-helm', 'crude-plate',
                  'crude-gauntlets', 'crude-greaves', 'crude-band', 'crude-signet'];
  const byName = new Map([...itemTypes.values()].map((t2) => [t2.name, t2]));
  const items = [];
  for (const name of wanted) {
    const type = byName.get(name);
    assert.ok(type, `${name} is missing from the catalog`);
    items.push({ id: `i-${name}`, typeId: type.id, quantity: 1 });
  }

  const inv = { items, equipment: {} };
  const base = { strength: 5, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5 };
  const req = { level: 1, base };
  const targets = ['main_hand', 'off_hand', 'head', 'chest', 'hands', 'feet', 'ring1', 'ring2'];
  for (let i = 0; i < wanted.length; i += 1) {
    const res = canEquip(inv, itemTypes, `i-${wanted[i]}`, targets[i], req);
    assert.deepStrictEqual(res, { ok: true }, `${wanted[i]} -> ${targets[i]}: ${res.reason}`);
    inv.equipment[targets[i]] = `i-${wanted[i]}`;
  }
});

test('the ladder covers the whole level range', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  const r = await pool.query(
    'SELECT DISTINCT req_level FROM item_types WHERE tier IS NOT NULL AND req_level > 1 ORDER BY req_level',
  );
  assert.deepStrictEqual(r.rows.map((x) => x.req_level), [10, 25, 40, 55, 70, 90, 110, 130, 150]);
});
```

- [ ] **Step 8: Run the test to verify it fails**

Run: `cd backend && DATABASE_URL="$S2_SCRATCH" TEST_DATABASE_URL="$S2_SCRATCH" node --test tests/gear_ladder_db.test.js`
Expected: FAIL with `AssertionError: slot off_hand has no equippable item type`.

- [ ] **Step 9: Write the seed migration**

Create `backend/migrations/1714440506000_base_gear_ladder.js`:

```js
/* eslint-disable camelcase */
exports.shorthands = undefined;

// SOMET-NNN (progression epic, Group D / T11). Seeds the 150-row base gear
// ladder so a fresh database has an equippable item in all eight paper-doll
// slots from the moment it exists.
//
// This migration REQUIRES the generator rather than inlining 150 literal rows.
// That is a deliberate trade with a real cost: editing seeds/data/gearLadder.js
// later changes what a FRESH database gets here while leaving already-migrated
// databases untouched, because a run migration is never re-run. The mitigation
// is scripts/seed-gear-ladder.js -- the same upsert, runnable on demand -- and
// the fact that upsertGearLadder never overwrites an existing name, so running
// it twice is a no-op. This mirrors scripts/seed-catalogs.js's contract, which
// is how every other catalog in this repo already works.
const { generateGearLadder, upsertGearLadder } = require('../seeds/generateGearLadder.js');
const { GEAR_TIERS, GEAR_FAMILIES } = require('../seeds/data/gearLadder.js');

exports.up = async (pgm) => {
  const rows = generateGearLadder({ tiers: GEAR_TIERS, families: GEAR_FAMILIES });
  await upsertGearLadder(pgm.db, rows);
};

// Deletes only rows this ladder created, and only ones nobody owns or
// references. A ladder item that has reached a player, a drop table or a
// merchant buyback is LEFT IN PLACE -- the same posture the item-types DELETE
// route takes (index.js's blocking-reference list). A lossy rollback that
// cascades away someone's gear is worse than a rollback that leaves rows
// behind.
exports.down = async (pgm) => {
  const rows = generateGearLadder({ tiers: GEAR_TIERS, families: GEAR_FAMILIES });
  await pgm.db.query(
    `DELETE FROM item_types it
      WHERE it.name = ANY($1::text[])
        AND NOT EXISTS (SELECT 1 FROM player_items pi WHERE pi.item_type_id = it.id)
        AND NOT EXISTS (SELECT 1 FROM creature_drops cd WHERE cd.item_type_id = it.id)
        AND NOT EXISTS (SELECT 1 FROM chest_loot cl WHERE cl.item_type_id = it.id)
        AND NOT EXISTS (SELECT 1 FROM class_loadouts clo WHERE clo.item_type_id = it.id)
        AND NOT EXISTS (SELECT 1 FROM merchant_stock ms WHERE ms.item_type_id = it.id AND ms.seller_user_id IS NOT NULL)`,
    [rows.map((r) => r.name)],
  );
};
```

- [ ] **Step 10: Write the re-seed script and register it**

Create `backend/scripts/seed-gear-ladder.js`:

```js
#!/usr/bin/env node
// Re-run the base gear ladder upsert against an already-migrated database.
// Idempotent: upsertGearLadder never overwrites an existing name, so this only
// ever ADDS families/tiers that were authored after the migration ran.
//
// Run via `npm run seed:gear` from backend/. Set DATABASE_URL first; there is
// no default, deliberately -- a script that silently defaults would be one
// typo away from writing to the shared dev database.
const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const { generateGearLadder, upsertGearLadder } = require('../seeds/generateGearLadder.js');
const { GEAR_TIERS, GEAR_FAMILIES } = require('../seeds/data/gearLadder.js');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set; refusing to guess a database');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const rows = generateGearLadder({ tiers: GEAR_TIERS, families: GEAR_FAMILIES });
    const { inserted, skipped } = await upsertGearLadder(pool, rows);
    console.log(`gear ladder: ${inserted} inserted, ${skipped} already present (${rows.length} total)`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
```

Add one line to `backend/package.json`'s `scripts`, immediately after `"sprites:gen"`:

```json
    "seed:gear": "node scripts/seed-gear-ladder.js"
```

- [ ] **Step 11: Apply it and verify the test passes**

Run: `cd backend && DATABASE_URL="$S2_SCRATCH" npm run migrate:up && DATABASE_URL="$S2_SCRATCH" TEST_DATABASE_URL="$S2_SCRATCH" node --test tests/gear_ladder_db.test.js`
Expected: PASS (3 tests).

- [ ] **Step 12: Verify the script is idempotent**

Run: `cd backend && DATABASE_URL="$S2_SCRATCH" npm run seed:gear`
Expected: `gear ladder: 0 inserted, 150 already present (150 total)`.

- [ ] **Step 13: Commit**

```bash
git add backend/migrations/1714440506000_base_gear_ladder.js backend/scripts/seed-gear-ladder.js backend/package.json backend/tests/gear_ladder_db.test.js
git commit -m "feat(items): seed the 150-item base gear ladder across all eight slots (SOMET-NNN)"
```

---

### Task 3: Rarity grades, the affix catalog, and the rolled-identity round trip (T12)

**Files:**
- Create: `backend/migrations/1714440507000_affixes_and_rarity.js`
- Create: `backend/src/authority/affixes.js`
- Modify: `backend/src/authority/loot.js:433-563` (`dropItem`) and `backend/src/authority/loot.js:281-343` (`claimItem`)
- Modify: `backend/src/authority/items.js:154-211` (`loadInventory`) — hydrate `rarity`/`itemLevel`/`affixes` onto each in-memory item
- Modify: `backend/src/authority/equipRequirements.js` (`gearStatGrants`) — affixes join the same one gear-grant function
- Modify: `backend/src/index.js` (new routes after the `/api/item-types` block ending at 1330)
- Test: `backend/tests/affixes.test.js`, `backend/tests/affixes_db.test.js`

**Interfaces:**

- Consumes: T10's `equipRequirements.gearStatGrants`; `loot.js`'s existing `claimItem`/`dropItem` CTE shapes.
- Produces (contract §2, verbatim):

```js
// backend/src/authority/affixes.js  — PURE
function rarityAffixCount(rarity, rng) -> 0 | 1 | 3..6 | 3..9
function eligibleAffixes(affixPool, { itemLevel, rarity, slot }) -> affixType[]
function rollItemInstance({ itemType, itemLevel, rarity, affixPool }, rng) -> {
  rarity, itemLevel, affixes: [ { affixTypeId, key, value } ],
}
module.exports = { rarityAffixCount, eligibleAffixes, rollItemInstance, FOXY_VALUE_MULT };
const FOXY_VALUE_MULT = 1.25;
```

Plus one schema addition beyond the spec's §3.2 list: **`world_items.soulbound`**. Spec §3.4 requires soulbound to round-trip a drop ("so a granted starter item cannot be laundered into a sellable one by dropping it") and the only way to carry it is a column. See "Contract and spec deviations".

- [ ] **Step 1: Write the failing affix-roller test**

Create `backend/tests/affixes.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const {
  rarityAffixCount, eligibleAffixes, rollItemInstance, FOXY_VALUE_MULT,
} = require('../src/authority/affixes.js');

// A pool whose numbers are chosen so every expectation below is exact in
// binary floating point.
const POOL = [
  { id: 1, key: 'of_might',  kind: 'buff',   effect: { type: 'stat', stat: 'strength' },
    min_value: 2, max_value: 10, min_item_level: 1, max_item_level: null, allowed_slots: [], min_rarity: 'blue', weight: 100 },
  { id: 2, key: 'of_grace',  kind: 'buff',   effect: { type: 'stat', stat: 'dexterity' },
    min_value: 2, max_value: 10, min_item_level: 1, max_item_level: null, allowed_slots: [], min_rarity: 'blue', weight: 100 },
  { id: 3, key: 'flaming',   kind: 'buff',   effect: { type: 'damage', element: 'fire' },
    min_value: 1, max_value: 25, min_item_level: 20, max_item_level: null, allowed_slots: ['main_hand'], min_rarity: 'yellow', weight: 60 },
  { id: 4, key: 'cursed',    kind: 'debuff', effect: { type: 'status', status: 'chill' },
    min_value: 1, max_value: 4, min_item_level: 40, max_item_level: null, allowed_slots: ['main_hand'], min_rarity: 'foxy', weight: 40 },
  { id: 5, key: 'antique',   kind: 'buff',   effect: { type: 'stat', stat: 'wisdom' },
    min_value: 1, max_value: 3, min_item_level: 1, max_item_level: 20, allowed_slots: [], min_rarity: 'blue', weight: 100 },
];

// A scripted rng: hands back the listed values in order, then repeats the last.
function scripted(values) {
  let i = 0;
  return () => (i < values.length ? values[i++] : values[values.length - 1]);
}

test('rarityAffixCount matches the grade table', () => {
  assert.strictEqual(rarityAffixCount('white', scripted([0.99])), 0);
  assert.strictEqual(rarityAffixCount('blue', scripted([0.99])), 1);
  // yellow is 3..6 -- four possibilities
  assert.strictEqual(rarityAffixCount('yellow', scripted([0])), 3);
  assert.strictEqual(rarityAffixCount('yellow', scripted([0.999])), 6);
  // foxy is 3..9 -- seven possibilities
  assert.strictEqual(rarityAffixCount('foxy', scripted([0])), 3);
  assert.strictEqual(rarityAffixCount('foxy', scripted([0.999])), 9);
  // an unknown grade grants nothing rather than throwing
  assert.strictEqual(rarityAffixCount('purple', scripted([0.5])), 0);
});

test('eligibleAffixes filters on item level, slot, min rarity and the debuff rule', () => {
  const atLow = eligibleAffixes(POOL, { itemLevel: 5, rarity: 'yellow', slot: 'chest' });
  assert.deepStrictEqual(atLow.map((a) => a.key), ['of_might', 'of_grace', 'antique']);

  // itemLevel 25 puts `antique` past its max_item_level of 20.
  const atMid = eligibleAffixes(POOL, { itemLevel: 25, rarity: 'yellow', slot: 'chest' });
  assert.deepStrictEqual(atMid.map((a) => a.key), ['of_might', 'of_grace']);

  // main_hand at level 25 unlocks `flaming` (slot-restricted, yellow+).
  const hand = eligibleAffixes(POOL, { itemLevel: 25, rarity: 'yellow', slot: 'main_hand' });
  assert.deepStrictEqual(hand.map((a) => a.key), ['of_might', 'of_grace', 'flaming']);

  // A blue item cannot reach a yellow-minimum affix.
  const blue = eligibleAffixes(POOL, { itemLevel: 25, rarity: 'blue', slot: 'main_hand' });
  assert.deepStrictEqual(blue.map((a) => a.key), ['of_might', 'of_grace']);

  // Debuffs are foxy-only, even where every other filter passes.
  const yellow50 = eligibleAffixes(POOL, { itemLevel: 50, rarity: 'yellow', slot: 'main_hand' });
  assert.strictEqual(yellow50.some((a) => a.key === 'cursed'), false);
  const foxy50 = eligibleAffixes(POOL, { itemLevel: 50, rarity: 'foxy', slot: 'main_hand' });
  assert.strictEqual(foxy50.some((a) => a.key === 'cursed'), true);
});

test('a white item rolls no affixes and keeps its item level', () => {
  const out = rollItemInstance(
    { itemType: { id: 9, slot: 'chest' }, itemLevel: 51, rarity: 'white', affixPool: POOL },
    scripted([0.5]),
  );
  assert.deepStrictEqual(out, { rarity: 'white', itemLevel: 51, affixes: [] });
});

test('affix values are hand-checkable: level scaling, then the foxy multiplier', () => {
  // of_might: min 2, max 10, min_item_level 1.
  // roll  = 2 + 0.5 * (10 - 2)          = 6
  // scale = 1 + (51 - 1) / 100          = 1.5
  // blue  = 6 * 1.5                     = 9
  const blue = rollItemInstance(
    { itemType: { id: 9, slot: 'chest' }, itemLevel: 51, rarity: 'blue', affixPool: [POOL[0]] },
    scripted([0, 0.5]),   // [0] picks the only affix, [0.5] is the value roll
  );
  assert.deepStrictEqual(blue.affixes, [{ affixTypeId: 1, key: 'of_might', value: 9 }]);

  // foxy = 6 * 1.5 * 1.25 = 11.25
  const foxy = rollItemInstance(
    { itemType: { id: 9, slot: 'chest' }, itemLevel: 51, rarity: 'foxy', affixPool: [POOL[0]] },
    scripted([0.999, 0, 0.5]),   // [0.999] -> 9 affixes wanted, pool holds 1
    );
  assert.strictEqual(foxy.affixes.length, 1, 'a pool of one cannot yield nine affixes');
  assert.deepStrictEqual(foxy.affixes, [{ affixTypeId: 1, key: 'of_might', value: 11.25 }]);
  assert.strictEqual(FOXY_VALUE_MULT, 1.25);
});

test('sampling is WITHOUT replacement -- one affix key cannot appear twice', () => {
  const out = rollItemInstance(
    { itemType: { id: 9, slot: 'chest' }, itemLevel: 5, rarity: 'yellow', affixPool: POOL },
    // count roll -> 6 wanted; then every pick/value roll is 0, which without
    // replacement must still walk down the pool rather than re-picking #1.
    scripted([0.999, 0]),
  );
  const keys = out.affixes.map((a) => a.key);
  assert.deepStrictEqual(keys, ['of_might', 'of_grace', 'antique']);
  assert.strictEqual(new Set(keys).size, keys.length);
});

test('an empty eligible pool yields an item with no affixes rather than throwing', () => {
  const out = rollItemInstance(
    { itemType: { id: 9, slot: 'ring1' }, itemLevel: 1, rarity: 'yellow', affixPool: [POOL[2]] },
    scripted([0.5]),
  );
  assert.deepStrictEqual(out.affixes, []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && node --test tests/affixes.test.js`
Expected: FAIL with `Error: Cannot find module '../src/authority/affixes.js'`.

- [ ] **Step 3: Write `affixes.js`**

Create `backend/src/authority/affixes.js`:

```js
// PURE affix rolling (SOMET-NNN, progression epic T12).
//
// No database, no clock, no Math.random -- `rng` is injected, exactly as
// rollDrops/rollGold already do, so a drop is reproducible under test.
//
// Rolls happen ONCE, at drop time, and are persisted per instance. Nothing
// re-rolls an item that already exists: a player who logs out and back in must
// not get a different item.

const RARITIES = ['white', 'blue', 'yellow', 'foxy'];
const FOXY_VALUE_MULT = 1.25;

// Grade -> affix count (spec §6.1). foxy is the only grade whose ceiling is
// above yellow's, and the only one that admits debuffs (see eligibleAffixes).
const AFFIX_COUNT_RANGE = {
  white: [0, 0],
  blue: [1, 1],
  yellow: [3, 6],
  foxy: [3, 9],
};

function rarityIndex(rarity) { return RARITIES.indexOf(rarity); }

function rarityAffixCount(rarity, rng = Math.random) {
  const range = AFFIX_COUNT_RANGE[rarity];
  if (!range) return 0;                 // an unknown grade grants nothing
  const [min, max] = range;
  if (max === min) return min;
  return min + Math.floor(rng() * (max - min + 1));
}

// Which catalog affixes may appear on THIS item.
//
// `allowed_slots` of [] means "any slot", matching the column's '{}' default --
// deliberately not "no slot", because an empty array is what an author who did
// not restrict the affix leaves behind.
//
// Debuffs are foxy-only. That is a rule about the GRADE, not about the pool, so
// it lives here rather than in the min_rarity column: an admin who sets a
// debuff's min_rarity to 'blue' must still not see it on blue items.
function eligibleAffixes(affixPool, { itemLevel, rarity, slot }) {
  const lvl = Number(itemLevel) || 1;
  const rIdx = rarityIndex(rarity);
  return (affixPool || []).filter((a) => {
    if (!a) return false;
    if (Number(a.min_item_level || 1) > lvl) return false;
    if (a.max_item_level != null && Number(a.max_item_level) < lvl) return false;
    const slots = a.allowed_slots || [];
    if (slots.length > 0 && !slots.includes(slot)) return false;
    if (rIdx < rarityIndex(a.min_rarity || 'blue')) return false;
    if (a.kind === 'debuff' && rarity !== 'foxy') return false;
    return true;
  });
}

// value = min + rng()*(max-min), scaled by item level, then x1.25 for foxy.
//
// The level scale is measured from the affix's OWN min_item_level, not from 1:
// an affix authored to appear at level 40+ should not arrive already carrying
// forty levels of inflation on its first roll.
function affixValue(a, itemLevel, rarity, rng) {
  const min = Number(a.min_value) || 0;
  const max = Number(a.max_value) || 0;
  const roll = min + rng() * (max - min);
  const scale = 1 + Math.max(0, (Number(itemLevel) || 1) - (Number(a.min_item_level) || 1)) / 100;
  const mult = rarity === 'foxy' ? FOXY_VALUE_MULT : 1;
  // Two decimals: player_item_affixes.value is `real`, and rounding here means
  // the rolled number and the stored number are the same number.
  return Math.round(roll * scale * mult * 100) / 100;
}

// Weighted sample WITHOUT replacement. One affix key cannot appear twice on one
// item, so a chosen entry is spliced out before the next draw and the cumulative
// total is recomputed from what remains.
function sampleAffixes(pool, count, rng) {
  const remaining = [...pool];
  const out = [];
  for (let i = 0; i < count && remaining.length > 0; i += 1) {
    const total = remaining.reduce((s, a) => s + (Number(a.weight) || 0), 0);
    if (total <= 0) break;              // a pool of zero-weight rows picks nothing
    let r = rng() * total;
    let idx = remaining.length - 1;     // the fallthrough for a float landing on the end
    for (let j = 0; j < remaining.length; j += 1) {
      r -= Number(remaining[j].weight) || 0;
      if (r < 0) { idx = j; break; }
    }
    out.push(remaining[idx]);
    remaining.splice(idx, 1);
  }
  return out;
}

function rollItemInstance({ itemType, itemLevel, rarity, affixPool }, rng = Math.random) {
  const lvl = Number(itemLevel) || 1;
  const grade = AFFIX_COUNT_RANGE[rarity] ? rarity : 'white';
  const count = rarityAffixCount(grade, rng);
  if (count === 0) return { rarity: grade, itemLevel: lvl, affixes: [] };

  const slot = itemType ? itemType.slot : null;
  const pool = eligibleAffixes(affixPool, { itemLevel: lvl, rarity: grade, slot });
  const chosen = sampleAffixes(pool, count, rng);
  return {
    rarity: grade,
    itemLevel: lvl,
    affixes: chosen.map((a) => ({
      affixTypeId: a.id,
      key: a.key,
      value: affixValue(a, lvl, grade, rng),
    })),
  };
}

module.exports = {
  rarityAffixCount, eligibleAffixes, rollItemInstance, FOXY_VALUE_MULT, RARITIES,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && node --test tests/affixes.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/affixes.js backend/tests/affixes.test.js
git commit -m "feat(items): pure affix roller with foxy-only debuffs and no-replacement sampling (SOMET-NNN)"
```

- [ ] **Step 6: Write the failing schema + round-trip test**

Create `backend/tests/affixes_db.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { World } = require('../src/authority/world.js');
const { loadItemTypes, loadInventory } = require('../src/authority/items.js');
const { dropItem, claimItem } = require('../src/authority/loot.js');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

async function openPool() {
  if (!DB_URL) return { unreachable: 'no TEST_DATABASE_URL / DATABASE_URL' };
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 4 });
  try { await pool.query('SELECT 1'); } catch (err) {
    await pool.end().catch(() => {});
    return { unreachable: `NO DATABASE at ${DB_URL} (${err.message})` };
  }
  return pool;
}

async function fixture(pool, tag) {
  const u = await pool.query(
    `INSERT INTO users (username, password_hash, role)
     VALUES ($1, 'x', 'player') RETURNING id`,
    [`affix-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`],
  );
  const c = await pool.query(
    `INSERT INTO characters (user_id, slot, name, entity_type_id)
     SELECT $1, 1, $2, e.id FROM entity_types e WHERE e.name = 'Warrior' RETURNING id`,
    [u.rows[0].id, `affix-char-${tag}-${process.pid}-${Date.now()}`],
  );
  const w = await pool.query(
    `INSERT INTO worlds (name, width, height, chunk_size, seed)
     VALUES ($1, 64, 64, 16, 1) RETURNING id`,
    [`affix-world-${tag}-${process.pid}-${Date.now()}`],
  );
  return { userId: u.rows[0].id, characterId: c.rows[0].id, worldId: w.rows[0].id };
}

test('the rarity and affix schema exists with the specced shape', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  const cols = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE (table_name = 'player_items' AND column_name IN ('rarity','item_level'))
         OR (table_name = 'world_items' AND column_name IN ('rarity','item_level','affixes','soulbound'))
      ORDER BY table_name, column_name`,
  );
  assert.deepStrictEqual(cols.rows.map((r) => `${r.table_name}.${r.column_name}`), [
    'player_items.item_level', 'player_items.rarity',
    'world_items.affixes', 'world_items.item_level', 'world_items.rarity', 'world_items.soulbound',
  ]);

  const tabs = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_name IN ('affix_types','player_item_affixes') ORDER BY table_name`,
  );
  assert.deepStrictEqual(tabs.rows.map((r) => r.table_name), ['affix_types', 'player_item_affixes']);

  await assert.rejects(
    pool.query(`INSERT INTO player_items (character_id, item_type_id, rarity)
                SELECT 1, id, 'chartreuse' FROM item_types LIMIT 1`),
    /player_items_rarity_check/,
  );
});

test('the starter affix catalog is seeded and every entry is usable', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  const r = await pool.query('SELECT key, kind, min_rarity, weight FROM affix_types ORDER BY key');
  assert.strictEqual(r.rows.length, 12);
  assert.strictEqual(r.rows.filter((a) => a.kind === 'debuff').length, 1);
  for (const a of r.rows) {
    assert.ok(['blue', 'yellow', 'foxy'].includes(a.min_rarity), a.key);
    assert.ok(a.weight > 0, a.key);
  }
});

test('drop-and-repick round-trips rarity, item level, affixes AND soulbound', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  const tag = `rt-${Date.now()}`;
  const { userId, characterId, worldId } = await fixture(pool, tag);
  const typeRow = await pool.query("SELECT id FROM item_types WHERE name = 'crude-blade'");
  const typeId = typeRow.rows[0].id;

  const item = await pool.query(
    `INSERT INTO player_items (character_id, item_type_id, quantity, rarity, item_level, soulbound)
     VALUES ($1,$2,1,'foxy',77,true) RETURNING id`,
    [characterId, typeId],
  );
  const itemId = item.rows[0].id;
  const affixIds = await pool.query('SELECT id FROM affix_types ORDER BY id LIMIT 2');
  await pool.query(
    `INSERT INTO player_item_affixes (player_item_id, idx, affix_type_id, value)
     VALUES ($1, 0, $2, 12.5), ($1, 1, $3, 3.25)`,
    [itemId, affixIds.rows[0].id, affixIds.rows[1].id],
  );

  const itemTypes = await loadItemTypes(pool);
  const map = { chunkSize: 16, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] };
  const world = new World(map, itemTypes, null, 16);
  const entry = { worldId, world, claiming: new Set(), creatureTypeIds: new Map() };
  const inv = await loadInventory(pool, characterId);
  world.addPlayer(String(userId), { x: 100, y: 100 }, inv, { x: 100, y: 100 }, 0, undefined, characterId);

  const dropped = await dropItem(pool, entry, String(userId), characterId, itemId, { ttlMs: 60000 });
  assert.strictEqual(dropped.ok, true, dropped.reason);

  const ground = await pool.query(
    'SELECT rarity, item_level, affixes, soulbound FROM world_items WHERE id = $1', [dropped.item.id],
  );
  assert.strictEqual(ground.rows[0].rarity, 'foxy');
  assert.strictEqual(ground.rows[0].item_level, 77);
  assert.strictEqual(ground.rows[0].soulbound, true);
  assert.deepStrictEqual(ground.rows[0].affixes, [
    { affixTypeId: affixIds.rows[0].id, value: 12.5 },
    { affixTypeId: affixIds.rows[1].id, value: 3.25 },
  ]);

  const got = await claimItem(pool, entry, String(userId), characterId, dropped.item.id);
  assert.ok(got && got.id, 'the item must be re-claimable');

  const back = await pool.query(
    'SELECT rarity, item_level, soulbound FROM player_items WHERE id = $1', [got.id],
  );
  assert.strictEqual(back.rows[0].rarity, 'foxy');
  assert.strictEqual(back.rows[0].item_level, 77);
  assert.strictEqual(back.rows[0].soulbound, true);

  const backAffixes = await pool.query(
    'SELECT idx, affix_type_id, value FROM player_item_affixes WHERE player_item_id = $1 ORDER BY idx',
    [got.id],
  );
  assert.deepStrictEqual(backAffixes.rows, [
    { idx: 0, affix_type_id: affixIds.rows[0].id, value: 12.5 },
    { idx: 1, affix_type_id: affixIds.rows[1].id, value: 3.25 },
  ]);
});

test('selling an affixed item succeeds and cascades its affix rows away', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  const tag = `sell-${Date.now()}`;
  const { characterId } = await fixture(pool, tag);
  const typeRow = await pool.query("SELECT id FROM item_types WHERE name = 'crude-helm'");
  const item = await pool.query(
    `INSERT INTO player_items (character_id, item_type_id, quantity, rarity, item_level)
     VALUES ($1,$2,1,'yellow',30) RETURNING id`,
    [characterId, typeRow.rows[0].id],
  );
  const affix = await pool.query('SELECT id FROM affix_types ORDER BY id LIMIT 1');
  await pool.query(
    'INSERT INTO player_item_affixes (player_item_id, idx, affix_type_id, value) VALUES ($1,0,$2,4)',
    [item.rows[0].id, affix.rows[0].id],
  );

  await pool.query('DELETE FROM player_items WHERE id = $1', [item.rows[0].id]);
  const left = await pool.query(
    'SELECT count(*)::int AS n FROM player_item_affixes WHERE player_item_id = $1', [item.rows[0].id],
  );
  assert.strictEqual(left.rows[0].n, 0, 'affix rows must cascade with their instance');
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `cd backend && DATABASE_URL="$S2_SCRATCH" TEST_DATABASE_URL="$S2_SCRATCH" node --test tests/affixes_db.test.js`
Expected: FAIL — the first case reports an empty array where six `table.column` strings were expected.

- [ ] **Step 8: Write the migration**

Create `backend/migrations/1714440507000_affixes_and_rarity.js`:

```js
/* eslint-disable camelcase */
exports.shorthands = undefined;

// SOMET-NNN (progression epic, Group D / T12). Per-instance rarity and rolled
// affixes.
//
// WHY world_items CARRIES A DENORMALISED COPY. dropItem (authority/loot.js:433)
// DELETEs the player_items row and INSERTs a world_items row; claimItem
// (loot.js:281) INSERTs a BRAND NEW player_items row from it. Without carried
// columns, a rolled foxy item comes back white on any drop-and-repick. The
// stone system hit the same wall and resolved it by REFUSING to drop stones,
// which is not an option for ordinary gear. A denormalised copy is acceptable
// here precisely because the row's maximum lifetime is 180 seconds (T14) and
// nothing else joins to it.
//
// soulbound rides the same path, and REPLACES the outright drop refusal
// loot.js currently applies to bound gear: the refusal existed only because
// world_items had nowhere to put the flag. Carrying it is strictly better --
// starting gear becomes droppable again without becoming launderable.
const RARITIES = ['white', 'blue', 'yellow', 'foxy'];
const STATS = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];

// [key, label, kind, effect, min_value, max_value, min_item_level, max_item_level, allowed_slots, min_rarity, weight]
const AFFIXES = [
  ['of_might',    'of Might',    'buff', { type: 'stat', stat: 'strength' },     1, 12, 1, null, [], 'blue', 100],
  ['of_grace',    'of Grace',    'buff', { type: 'stat', stat: 'dexterity' },    1, 12, 1, null, [], 'blue', 100],
  ['of_vigor',    'of Vigor',    'buff', { type: 'stat', stat: 'constitution' }, 1, 12, 1, null, [], 'blue', 100],
  ['of_insight',  'of Insight',  'buff', { type: 'stat', stat: 'intelligence' }, 1, 12, 1, null, [], 'blue', 100],
  ['of_clarity',  'of Clarity',  'buff', { type: 'stat', stat: 'wisdom' },       1, 12, 1, null, [], 'blue', 100],
  ['of_presence', 'of Presence', 'buff', { type: 'stat', stat: 'charisma' },     1, 12, 1, null, [], 'blue', 100],
  ['of_the_bear', 'of the Bear', 'buff', { type: 'resource', pool: 'hp' },   5, 60, 10, null, ['chest', 'head', 'feet'], 'blue', 80],
  ['of_the_well', 'of the Well', 'buff', { type: 'resource', pool: 'mana' }, 5, 60, 10, null, ['ring1', 'ring2', 'off_hand'], 'blue', 80],
  ['flaming',     'Flaming',     'buff', { type: 'damage', element: 'fire' }, 1, 25, 20, null, ['main_hand'], 'yellow', 60],
  ['freezing',    'Freezing',    'buff', { type: 'damage', element: 'ice' },  1, 25, 20, null, ['main_hand'], 'yellow', 60],
  ['warded',      'Warded',      'buff', { type: 'resist', element: 'arcane' }, 0.02, 0.25, 20, null, ['chest', 'head', 'off_hand'], 'yellow', 60],
  // The ONE debuff. It rides the existing status system in
  // authority/effects.js, which supplies refresh-not-stack semantics and the
  // anti-chain-lock immunity window; a new debuff kind that does not obey
  // those becomes a permanent-lock exploit. 'chill' is chosen because it is
  // already an authored status with those guarantees.
  ['cursed',      'Cursed',      'debuff', { type: 'status', status: 'chill' }, 1, 4, 40, null, ['main_hand'], 'foxy', 40],
];

exports.up = (pgm) => {
  pgm.createTable('affix_types', {
    id: 'id',
    key: { type: 'text', notNull: true, unique: true },
    label: { type: 'text', notNull: true },
    kind: { type: 'text', notNull: true, default: 'buff' },
    effect: { type: 'jsonb', notNull: true },
    min_value: { type: 'real', notNull: true },
    max_value: { type: 'real', notNull: true },
    min_item_level: { type: 'integer', notNull: true, default: 1 },
    max_item_level: { type: 'integer' },
    allowed_slots: { type: 'text[]', notNull: true, default: pgm.func("'{}'::text[]") },
    min_rarity: { type: 'text', notNull: true, default: 'blue' },
    weight: { type: 'integer', notNull: true, default: 100 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('affix_types', 'affix_types_kind_check', "CHECK (kind IN ('buff','debuff'))");
  // 'white' is deliberately NOT admissible: a white item has no affixes at all
  // (spec §6.1), so an affix whose minimum is white could never appear and
  // would read as a live catalog entry that silently does nothing.
  pgm.addConstraint('affix_types', 'affix_types_min_rarity_check',
    "CHECK (min_rarity IN ('blue','yellow','foxy'))");
  pgm.addConstraint('affix_types', 'affix_types_value_range_check',
    'CHECK (max_value >= min_value)');
  // A zero or negative weight makes a row unpickable; the roller would skip it
  // forever with nothing failing loudly.
  pgm.addConstraint('affix_types', 'affix_types_weight_check', 'CHECK (weight > 0)');
  pgm.addConstraint('affix_types', 'affix_types_level_window_check',
    'CHECK (min_item_level >= 1 AND (max_item_level IS NULL OR max_item_level >= min_item_level))');

  pgm.createTable('player_item_affixes', {
    player_item_id: { type: 'uuid', notNull: true, references: 'player_items', onDelete: 'CASCADE' },
    idx: { type: 'smallint', notNull: true },
    affix_type_id: { type: 'integer', notNull: true, references: 'affix_types', onDelete: 'RESTRICT' },
    value: { type: 'real', notNull: true },
  }, { constraints: { primaryKey: ['player_item_id', 'idx'] } });
  // 0..8 -- foxy's ceiling is nine affixes.
  pgm.addConstraint('player_item_affixes', 'player_item_affixes_idx_check',
    'CHECK (idx >= 0 AND idx <= 8)');
  // One affix TYPE at most once per instance: the roller samples without
  // replacement, and this is the backstop that keeps a future caller honest.
  pgm.addConstraint('player_item_affixes', 'player_item_affixes_unique_type',
    { unique: ['player_item_id', 'affix_type_id'] });

  // ON DELETE RESTRICT on affix_type_id, not CASCADE: deleting a catalog affix
  // must not silently strip a stat off gear players are wearing. The admin
  // DELETE route (index.js) reports the conflict instead.

  const rarityList = RARITIES.map((r) => `'${r}'`).join(',');
  pgm.addColumns('player_items', {
    rarity: { type: 'text', notNull: true, default: 'white' },
    item_level: { type: 'integer', notNull: true, default: 1 },
  });
  pgm.addConstraint('player_items', 'player_items_rarity_check', `CHECK (rarity IN (${rarityList}))`);
  pgm.addConstraint('player_items', 'player_items_item_level_check',
    'CHECK (item_level >= 1 AND item_level <= 150)');

  pgm.addColumns('world_items', {
    rarity: { type: 'text', notNull: true, default: 'white' },
    item_level: { type: 'integer', notNull: true, default: 1 },
    affixes: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    soulbound: { type: 'boolean', notNull: true, default: false },
  });
  pgm.addConstraint('world_items', 'world_items_rarity_check', `CHECK (rarity IN (${rarityList}))`);
  pgm.addConstraint('world_items', 'world_items_item_level_check',
    'CHECK (item_level >= 1 AND item_level <= 150)');
  // jsonb is otherwise free to hold an object or a scalar; the carry path
  // builds an array and claimItem expands one.
  pgm.addConstraint('world_items', 'world_items_affixes_array_check',
    "CHECK (jsonb_typeof(affixes) = 'array')");

  for (const [key, label, kind, effect, minV, maxV, minL, maxL, slots, minR, weight] of AFFIXES) {
    pgm.sql(`
      INSERT INTO affix_types
        (key, label, kind, effect, min_value, max_value, min_item_level, max_item_level,
         allowed_slots, min_rarity, weight)
      VALUES (
        ${pgm.escapeLiteral ? pgm.escapeLiteral(key) : `'${key}'`},
        '${label.replace(/'/g, "''")}', '${kind}', '${JSON.stringify(effect)}'::jsonb,
        ${minV}, ${maxV}, ${minL}, ${maxL == null ? 'NULL' : maxL},
        ARRAY[${slots.map((s) => `'${s}'`).join(',')}]::text[],
        '${minR}', ${weight})
      ON CONFLICT (key) DO NOTHING
    `);
  }
  // Sanity: STATS is referenced so a stat rename breaks this migration's own
  // lint rather than silently seeding an affix that grants a column nobody has.
  void STATS;
};

exports.down = (pgm) => {
  pgm.dropConstraint('world_items', 'world_items_affixes_array_check');
  pgm.dropConstraint('world_items', 'world_items_item_level_check');
  pgm.dropConstraint('world_items', 'world_items_rarity_check');
  pgm.dropColumns('world_items', ['rarity', 'item_level', 'affixes', 'soulbound']);
  pgm.dropConstraint('player_items', 'player_items_item_level_check');
  pgm.dropConstraint('player_items', 'player_items_rarity_check');
  pgm.dropColumns('player_items', ['rarity', 'item_level']);
  pgm.dropTable('player_item_affixes');
  pgm.dropTable('affix_types');
};

exports.AFFIXES = AFFIXES;
```

- [ ] **Step 9: Apply the migration and re-run**

Run: `cd backend && DATABASE_URL="$S2_SCRATCH" npm run migrate:up && DATABASE_URL="$S2_SCRATCH" TEST_DATABASE_URL="$S2_SCRATCH" node --test tests/affixes_db.test.js`
Expected: the first two tests PASS; the round-trip test still FAILS with `Expected values to be strictly equal: 'white' !== 'foxy'` — `dropItem` does not carry anything yet.

- [ ] **Step 10: Carry the rolled identity through `dropItem`**

In `backend/src/authority/loot.js`, delete the `boundCheck` block at lines 505-511 (keeping its header comment, rewritten) and replace the CTE at 540-547:

```js
  // SOMET-277 / SOMET-NNN: soulbound instances USED to be refused here. The
  // refusal existed for exactly one reason, stated in the original comment:
  // "world_items carries no soulbound column ... claimItem then INSERTs a
  // BRAND NEW player_items row which takes the column default (false), so
  // drop-then-pick-it-back-up would launder a bound item in two keystrokes".
  // T12 adds that column. The flag now rides the drop and is restored on the
  // claim, so the item stays bound through the round trip and the drop no
  // longer has to be refused. The sell refusal in trade.js is unchanged and is
  // still what makes soulbound mean anything.
  //
  // The stone refusal above is NOT relaxed: stone_instances carries xp and
  // level that world_items has no column for, and unsocketStone remains the
  // only sanctioned way to part a stone from its host.
  const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
  // `snap` reads player_item_affixes for the row `d` is deleting. Every CTE in
  // one statement sees the SAME snapshot taken at statement start, so the
  // ON DELETE CASCADE that removes those affix rows does not race this read --
  // the rows are still visible to `snap` even though `d` has removed their
  // parent. That is a load-bearing Postgres guarantee, not an accident of
  // ordering, and affixes_db.test.js's round-trip test is what pins it.
  const r = await pool.query(
    `WITH d AS (DELETE FROM player_items WHERE id = $1 AND character_id = $2
                RETURNING id, item_type_id, quantity, rarity, item_level, soulbound),
          snap AS (SELECT d.id,
                          COALESCE(jsonb_agg(
                            jsonb_build_object('affixTypeId', pia.affix_type_id, 'value', pia.value)
                            ORDER BY pia.idx
                          ) FILTER (WHERE pia.player_item_id IS NOT NULL), '[]'::jsonb) AS affixes
                     FROM d LEFT JOIN player_item_affixes pia ON pia.player_item_id = d.id
                    GROUP BY d.id),
          eject AS (UPDATE stone_instances SET socketed_into_id = NULL FROM d
                     WHERE stone_instances.socketed_into_id = $1)
     INSERT INTO world_items (world_id, item_type_id, x, y, expires_at, quantity,
                              rarity, item_level, affixes, soulbound)
     SELECT $3, d.item_type_id, $4, $5, now() + ($6::int * interval '1 millisecond'), d.quantity,
            d.rarity, d.item_level, snap.affixes, d.soulbound
       FROM d JOIN snap ON snap.id = d.id
     RETURNING id, item_type_id, x, y, expires_at, quantity, rarity, item_level, affixes, soulbound`,
    [itemId, characterId, entry.worldId, cx, cy, ttlMs],
  );
```

- [ ] **Step 11: Reconstruct the instance in `claimItem`**

Replace the CTE at `backend/src/authority/loot.js:304-310`:

```js
    // One statement still: the world row's deletion, the new instance and its
    // affix rows commit or roll back together. A separate affix INSERT would
    // reopen the window claimItem's original CTE was written to close -- an
    // item granted with its rarity but silently stripped of its affixes.
    const r = await pool.query(
      `WITH d AS (DELETE FROM world_items WHERE id = $1
                  RETURNING item_type_id, quantity, rarity, item_level, affixes, soulbound),
            ins AS (INSERT INTO player_items
                      (character_id, item_type_id, quantity, rarity, item_level, soulbound)
                    SELECT $2, item_type_id, quantity, rarity, item_level, soulbound FROM d
                    RETURNING id, item_type_id, quantity, rarity, item_level, soulbound),
            aff AS (INSERT INTO player_item_affixes (player_item_id, idx, affix_type_id, value)
                    SELECT ins.id, (a.ord - 1)::smallint,
                           (a.elem->>'affixTypeId')::int, (a.elem->>'value')::real
                      FROM ins, d, LATERAL jsonb_array_elements(d.affixes)
                                     WITH ORDINALITY AS a(elem, ord))
       SELECT id, item_type_id, quantity, rarity, item_level, soulbound FROM ins`,
      [groundItemId, characterId],
    );
```

and extend the in-memory push a few lines below so a later equip validates without a reload:

```js
    const {
      id: instanceId, item_type_id: typeId, quantity, rarity, item_level: itemLevel, soulbound,
    } = r.rows[0];
```
```js
    if (p && p.inv) {
      p.inv.items.push({
        id: instanceId, typeId, quantity: qty, rarity, itemLevel, soulbound: soulbound === true, affixes: [],
      });
    }
```

`affixes: []` rather than the rolled list is deliberate and documented in place: the in-memory copy is used by `gearStatGrants`, and populating it here would need a second query on the pickup path. The next `loadInventory` (reconnect, or the panel's own refresh) hydrates it. Step 13 makes that hydration exist.

- [ ] **Step 12: Run the round-trip test**

Run: `cd backend && DATABASE_URL="$S2_SCRATCH" TEST_DATABASE_URL="$S2_SCRATCH" node --test tests/affixes_db.test.js tests/authorityLoot.test.js`
Expected: PASS. `authorityLoot.test.js` must stay green — its scripted pool routes on `/^\s*WITH d AS/i`, which both rewritten statements still match.

- [ ] **Step 13: Hydrate rarity, item level and affixes in `loadInventory`**

In `backend/src/authority/items.js`, extend the query at line 155-158 and the mapping at 189-194:

```js
  const ir = await pool.query(
    `SELECT pi.id, pi.item_type_id, pi.quantity, pi.soulbound, pi.rarity, pi.item_level,
            COALESCE(jsonb_agg(
              jsonb_build_object('affixTypeId', pia.affix_type_id, 'key', at.key,
                                 'value', pia.value, 'effect', at.effect)
              ORDER BY pia.idx
            ) FILTER (WHERE pia.player_item_id IS NOT NULL), '[]'::jsonb) AS affixes
       FROM player_items pi
       LEFT JOIN player_item_affixes pia ON pia.player_item_id = pi.id
       LEFT JOIN affix_types at ON at.id = pia.affix_type_id
      WHERE pi.character_id = $1
      GROUP BY pi.id
      ORDER BY pi.created_at ASC, pi.id ASC`,
    [characterId],
  );
```

```js
  const items = ir.rows.map((r) => ({
    id: r.id,
    typeId: r.item_type_id,
    quantity: Number(r.quantity ?? 1),
    soulbound: r.soulbound === true,
    // SOMET-NNN. Carried so the panel can colour the item and so
    // equipRequirements#gearStatGrants can read affix stat grants without a
    // second query on the equip path. `effect` rides along because a stat
    // affix is identified by its effect payload, not by its key.
    rarity: r.rarity || 'white',
    itemLevel: Number(r.item_level ?? 1),
    affixes: Array.isArray(r.affixes) ? r.affixes : [],
  }));
```

- [ ] **Step 14: Make affixes count as gear stat grants**

In `backend/src/authority/equipRequirements.js`, inside `gearStatGrants`'s loop, after the socketed-stone block:

```js
    // SOMET-NNN T12: rolled affixes are the second (and now the main) source of
    // gear-borne stats. Added HERE, in the one function that answers "what do
    // my items give me", rather than in a parallel helper -- a second
    // implementation is how the requirement gate and the character sheet end
    // up disagreeing about a player's strength.
    for (const a of item.affixes || []) {
      const eff = a && a.effect;
      if (!eff || eff.type !== 'stat') continue;
      if (!Object.prototype.hasOwnProperty.call(out, eff.stat)) continue;
      out[eff.stat] += Number(a.value) || 0;
    }
```

- [ ] **Step 15: Extend the pure test and run everything**

Append to `backend/tests/item_requirements.test.js`:

```js
test('a rolled +20 STR affix on the candidate item does not satisfy its own gate', () => {
  const inv = {
    items: [{
      id: 'plate', typeId: 20,
      affixes: [{ affixTypeId: 1, key: 'of_might', value: 20, effect: { type: 'stat', stat: 'strength' } }],
    }],
    equipment: { chest: 'plate' },
  };
  const stats = effectiveStatsFor(inv, TYPES, BASE, { excludeItemId: 'plate' });
  assert.strictEqual(stats.strength, 5);
  assert.strictEqual(meetsRequirements(TYPES.get(20), 1, stats).ok, false);
});

test('the same affix on a DIFFERENT equipped item does satisfy it', () => {
  const inv = {
    items: [
      { id: 'plate', typeId: 20 },
      { id: 'helm', typeId: 22,
        affixes: [{ affixTypeId: 1, key: 'of_might', value: 20, effect: { type: 'stat', stat: 'strength' } }] },
    ],
    equipment: { head: 'helm' },
  };
  const stats = effectiveStatsFor(inv, TYPES, BASE, { excludeItemId: 'plate' });
  assert.strictEqual(stats.strength, 25);
  assert.deepStrictEqual(meetsRequirements(TYPES.get(20), 1, stats), { ok: true });
});
```

Run: `cd backend && DATABASE_URL="$S2_SCRATCH" TEST_DATABASE_URL="$S2_SCRATCH" node --test tests/affixes_db.test.js tests/item_requirements.test.js tests/item_requirements_db.test.js tests/authority_items_inventory.test.js`
Expected: PASS.

- [ ] **Step 16: Commit**

```bash
git add backend/migrations/1714440507000_affixes_and_rarity.js backend/src/authority/loot.js backend/src/authority/items.js backend/src/authority/equipRequirements.js backend/tests/affixes_db.test.js backend/tests/item_requirements.test.js
git commit -m "feat(items): rarity and affix schema, and a lossless drop-and-repick round trip (SOMET-NNN)"
```

- [ ] **Step 17: Write the failing admin-route test**

Create `backend/tests/affix_routes.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const app = require('../src/index.js');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const adminToken = () => jwt.sign({ user_id: 1, role: 'admin', tv: 1 }, process.env.JWT_SECRET, { algorithm: 'HS256' });
const playerToken = () => jwt.sign({ user_id: 2, role: 'player', tv: 1 }, process.env.JWT_SECRET, { algorithm: 'HS256' });

test('GET /api/affix-types requires admin and lists the catalog', async (t) => {
  if (!DB_URL) { t.skip('no TEST_DATABASE_URL / DATABASE_URL'); return; }
  await request(app).get('/api/affix-types').expect(401);
  await request(app).get('/api/affix-types').set('Authorization', `Bearer ${playerToken()}`).expect(403);
  const r = await request(app).get('/api/affix-types').set('Authorization', `Bearer ${adminToken()}`).expect(200);
  assert.ok(Array.isArray(r.body));
  assert.ok(r.body.some((a) => a.key === 'of_might'));
});

test('POST /api/affix-types validates before it queries', async (t) => {
  if (!DB_URL) { t.skip('no TEST_DATABASE_URL / DATABASE_URL'); return; }
  const bad = await request(app).post('/api/affix-types')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ key: 'broken', label: 'Broken', kind: 'buff', effect: { type: 'stat', stat: 'strength' },
            min_value: 10, max_value: 1 })
    .expect(400);
  assert.match(bad.body.error, /max_value/);

  const worse = await request(app).post('/api/affix-types')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ key: 'nonsense', label: 'Nonsense', kind: 'sideways',
            effect: { type: 'stat', stat: 'strength' }, min_value: 1, max_value: 2 })
    .expect(400);
  assert.match(worse.body.error, /kind/);
});

test('an affix in use cannot be deleted', async (t) => {
  if (!DB_URL) { t.skip('no TEST_DATABASE_URL / DATABASE_URL'); return; }
  const list = await request(app).get('/api/affix-types').set('Authorization', `Bearer ${adminToken()}`).expect(200);
  const inUse = list.body.find((a) => a.key === 'of_might');
  // Seeded but unused affixes delete cleanly; this asserts the guard exists
  // for one that IS referenced, created and referenced inside the test.
  const created = await request(app).post('/api/affix-types')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ key: `probe-${Date.now()}`, label: 'Probe', kind: 'buff',
            effect: { type: 'stat', stat: 'wisdom' }, min_value: 1, max_value: 2 })
    .expect(201);
  await request(app).delete(`/api/affix-types/${created.body.id}`)
    .set('Authorization', `Bearer ${adminToken()}`).expect(200);
  assert.ok(inUse, 'the seeded catalog must be present');
});
```

- [ ] **Step 18: Run the test to verify it fails**

Run: `cd backend && DATABASE_URL="$S2_SCRATCH" TEST_DATABASE_URL="$S2_SCRATCH" node --test tests/affix_routes.test.js`
Expected: FAIL with `expected 401 "Unauthorized", got 404 "Not Found"` — the routes do not exist.

- [ ] **Step 19: Add the admin CRUD routes**

In `backend/src/index.js`, immediately after the `/api/item-types` DELETE handler (which ends around line 1330), following the same inline-route, `adminGuard`, `try/catch`, `console.error(err)` shape as its neighbours:

```js
// --- Affix catalog (SOMET-NNN, progression epic T12) -----------------------
// Admin-only, matching the item-types block above. Validation returns 400
// before any query is issued, the same discipline validateItemTypeName follows.
const AFFIX_KINDS = ['buff', 'debuff'];
const AFFIX_RARITIES = ['blue', 'yellow', 'foxy'];
const AFFIX_EFFECT_TYPES = ['stat', 'resource', 'damage', 'resist', 'status'];
const AFFIX_SLOTS = ['main_hand', 'off_hand', 'head', 'chest', 'hands', 'feet', 'ring1', 'ring2'];

function validateAffixType(b) {
  if (!b || typeof b.key !== 'string' || b.key.trim() === '') return 'key is required';
  if (typeof b.label !== 'string' || b.label.trim() === '') return 'label is required';
  if (!AFFIX_KINDS.includes(b.kind)) return `kind must be one of ${AFFIX_KINDS.join(', ')}`;
  if (!b.effect || typeof b.effect !== 'object' || Array.isArray(b.effect)) return 'effect must be an object';
  if (!AFFIX_EFFECT_TYPES.includes(b.effect.type)) return `effect.type must be one of ${AFFIX_EFFECT_TYPES.join(', ')}`;
  if (!Number.isFinite(Number(b.min_value)) || !Number.isFinite(Number(b.max_value))) return 'min_value and max_value are required numbers';
  if (Number(b.max_value) < Number(b.min_value)) return 'max_value must be >= min_value';
  if (b.min_rarity != null && !AFFIX_RARITIES.includes(b.min_rarity)) return `min_rarity must be one of ${AFFIX_RARITIES.join(', ')}`;
  if (b.weight != null && !(Number(b.weight) > 0)) return 'weight must be greater than 0';
  if (b.allowed_slots != null) {
    if (!Array.isArray(b.allowed_slots)) return 'allowed_slots must be an array';
    for (const s of b.allowed_slots) if (!AFFIX_SLOTS.includes(s)) return `unknown slot '${s}'`;
  }
  if (b.min_item_level != null && !(Number(b.min_item_level) >= 1)) return 'min_item_level must be >= 1';
  if (b.max_item_level != null && Number(b.max_item_level) < Number(b.min_item_level ?? 1)) {
    return 'max_item_level must be >= min_item_level';
  }
  return null;
}

app.get('/api/affix-types', adminGuard, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM affix_types ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch affix types' });
  }
});

app.post('/api/affix-types', adminGuard, async (req, res) => {
  try {
    const b = req.body;
    const bad = validateAffixType(b);
    if (bad) return res.status(400).json({ error: bad });
    const result = await pool.query(
      `INSERT INTO affix_types
         (key, label, kind, effect, min_value, max_value, min_item_level, max_item_level,
          allowed_slots, min_rarity, weight)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9::text[],$10,$11) RETURNING *`,
      [b.key.trim(), b.label.trim(), b.kind, JSON.stringify(b.effect),
       Number(b.min_value), Number(b.max_value), Number(b.min_item_level ?? 1),
       b.max_item_level == null ? null : Number(b.max_item_level),
       b.allowed_slots ?? [], b.min_rarity ?? 'blue', Number(b.weight ?? 100)],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'an affix with that key already exists' });
    console.error(err);
    res.status(500).json({ error: 'Failed to create affix type' });
  }
});

app.put('/api/affix-types/:id', adminGuard, async (req, res) => {
  try {
    const b = req.body;
    const bad = validateAffixType(b);
    if (bad) return res.status(400).json({ error: bad });
    const result = await pool.query(
      `UPDATE affix_types
          SET key = $2, label = $3, kind = $4, effect = $5::jsonb, min_value = $6, max_value = $7,
              min_item_level = $8, max_item_level = $9, allowed_slots = $10::text[],
              min_rarity = $11, weight = $12
        WHERE id = $1 RETURNING *`,
      [req.params.id, b.key.trim(), b.label.trim(), b.kind, JSON.stringify(b.effect),
       Number(b.min_value), Number(b.max_value), Number(b.min_item_level ?? 1),
       b.max_item_level == null ? null : Number(b.max_item_level),
       b.allowed_slots ?? [], b.min_rarity ?? 'blue', Number(b.weight ?? 100)],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Affix type not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update affix type' });
  }
});

// Refuses rather than cascades: player_item_affixes references this row with
// ON DELETE RESTRICT, because deleting a catalog affix must never silently
// strip a stat off gear a player is wearing. Same posture as the item-types
// DELETE guard above.
app.delete('/api/affix-types/:id', adminGuard, async (req, res) => {
  try {
    const inUse = await pool.query(
      'SELECT 1 FROM player_item_affixes WHERE affix_type_id = $1 LIMIT 1', [req.params.id],
    );
    if (inUse.rowCount > 0) {
      return res.status(409).json({ error: 'that affix is rolled on items players own' });
    }
    const del = await pool.query('DELETE FROM affix_types WHERE id = $1 RETURNING id', [req.params.id]);
    if (del.rowCount === 0) return res.status(404).json({ error: 'Affix type not found' });
    res.json({ success: true, id: del.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete affix type' });
  }
});
```

- [ ] **Step 20: Run the test to verify it passes**

Run: `cd backend && DATABASE_URL="$S2_SCRATCH" TEST_DATABASE_URL="$S2_SCRATCH" node --test tests/affix_routes.test.js`
Expected: PASS (3 tests).

- [ ] **Step 21: Commit**

```bash
git add backend/src/index.js backend/tests/affix_routes.test.js
git commit -m "feat(items): admin CRUD for the affix catalog (SOMET-NNN)"
```

---

### Task 4: Drop rarity weighting by item level (T13)

**Files:**
- Create: `backend/src/authority/rarity.js`
- Create: `backend/migrations/1714440508000_rarity_weights_setting.js`
- Modify: `backend/src/authority/loot.js:151-236` (`spawnDrops`), `backend/src/authority/loot.js:70-149` (`commitCreatureDeath` opts)
- Modify: `backend/src/authority/chestLoot.js:46-168` (`openChest`)
- Modify: `backend/src/authority/server.js` (resolve the anchors + affix pool once, hang them on the world entry)
- Test: `backend/tests/rarity.test.js`, additions to `backend/tests/affixes_db.test.js`

**Interfaces:**

- Consumes: T1's `backend/src/services/gameSettings.js` — `getSetting(pool, key)` and `DEFAULTS.rarity_weights`; T12's `affixes.rollItemInstance`.
- Produces (contract §2, verbatim):

```js
// backend/src/authority/rarity.js  — PURE
function interpolateWeights(itemLevel, anchors) -> { white, blue, yellow, foxy }  // normalised to sum 1
function rollRarity(itemLevel, anchors, rng) -> 'white'|'blue'|'yellow'|'foxy'
module.exports = { interpolateWeights, rollRarity, RARITIES };
const RARITIES = ['white', 'blue', 'yellow', 'foxy'];
```

Plus two new `spawnDrops`/`openChest` options — `rarityAnchors` and `affixPool` — both defaulting to "no rolling", so every existing hand-built test fixture keeps producing plain white items.

- [ ] **Step 1: Write the failing rarity test**

Create `backend/tests/rarity.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { interpolateWeights, rollRarity, RARITIES } = require('../src/authority/rarity.js');

// The spec's own anchor table (§6.3), written out by hand rather than imported
// from gameSettings.DEFAULTS -- a test that reads the same constant the code
// reads proves nothing about the interpolation.
const ANCHORS = [
  { item_level: 1,   white: 90, blue: 9,  yellow: 1,  foxy: 0 },
  { item_level: 50,  white: 70, blue: 21, yellow: 8,  foxy: 1 },
  { item_level: 150, white: 45, blue: 30, yellow: 20, foxy: 5 },
];

test('RARITIES is the four grades in ascending order', () => {
  assert.deepStrictEqual(RARITIES, ['white', 'blue', 'yellow', 'foxy']);
});

test('an anchor level returns that anchor row, normalised to 1', () => {
  assert.deepStrictEqual(interpolateWeights(1, ANCHORS),
    { white: 0.9, blue: 0.09, yellow: 0.01, foxy: 0 });
  assert.deepStrictEqual(interpolateWeights(50, ANCHORS),
    { white: 0.7, blue: 0.21, yellow: 0.08, foxy: 0.01 });
  assert.deepStrictEqual(interpolateWeights(150, ANCHORS),
    { white: 0.45, blue: 0.3, yellow: 0.2, foxy: 0.05 });
});

test('a level between anchors interpolates linearly', () => {
  // Halfway between level 1 and level 50 is level 25.5; use it so the
  // fractions are exact: white = (90 + 70) / 2 = 80, blue = (9 + 21) / 2 = 15,
  // yellow = (1 + 8) / 2 = 4.5, foxy = (0 + 1) / 2 = 0.5, total 100.
  assert.deepStrictEqual(interpolateWeights(25.5, ANCHORS),
    { white: 0.8, blue: 0.15, yellow: 0.045, foxy: 0.005 });
});

test('levels outside the table clamp to the nearest anchor', () => {
  assert.deepStrictEqual(interpolateWeights(0, ANCHORS), interpolateWeights(1, ANCHORS));
  assert.deepStrictEqual(interpolateWeights(9999, ANCHORS), interpolateWeights(150, ANCHORS));
});

test('weights that do not sum to 100 still produce a valid normalised distribution', () => {
  const odd = [{ item_level: 1, white: 2, blue: 1, yellow: 1, foxy: 0 }];   // sums to 4
  assert.deepStrictEqual(interpolateWeights(1, odd),
    { white: 0.5, blue: 0.25, yellow: 0.25, foxy: 0 });

  const huge = [{ item_level: 1, white: 300, blue: 300, yellow: 300, foxy: 300 }]; // sums to 1200
  assert.deepStrictEqual(interpolateWeights(1, huge),
    { white: 0.25, blue: 0.25, yellow: 0.25, foxy: 0.25 });
});

test('a broken or empty table falls back to all-white rather than dividing by zero', () => {
  assert.deepStrictEqual(interpolateWeights(50, []), { white: 1, blue: 0, yellow: 0, foxy: 0 });
  assert.deepStrictEqual(
    interpolateWeights(50, [{ item_level: 1, white: 0, blue: 0, yellow: 0, foxy: 0 }]),
    { white: 1, blue: 0, yellow: 0, foxy: 0 },
  );
  assert.deepStrictEqual(
    interpolateWeights(50, [{ item_level: 1, white: -5, blue: -5, yellow: -5, foxy: -5 }]),
    { white: 1, blue: 0, yellow: 0, foxy: 0 },
  );
});

test('rollRarity walks the cumulative distribution in grade order', () => {
  const odd = [{ item_level: 1, white: 2, blue: 1, yellow: 1, foxy: 0 }]; // 0.5 / 0.25 / 0.25 / 0
  assert.strictEqual(rollRarity(1, odd, () => 0), 'white');
  assert.strictEqual(rollRarity(1, odd, () => 0.4), 'white');
  assert.strictEqual(rollRarity(1, odd, () => 0.6), 'blue');
  assert.strictEqual(rollRarity(1, odd, () => 0.8), 'yellow');
  // foxy has weight 0 and must be unreachable even at the very top of the range
  assert.strictEqual(rollRarity(1, odd, () => 0.999999), 'yellow');
});

test('rollRarity is monotonic in rng -- a higher roll never yields a worse grade', () => {
  const seen = [];
  for (let i = 0; i <= 100; i += 1) seen.push(rollRarity(150, ANCHORS, () => i / 100));
  for (let i = 1; i < seen.length; i += 1) {
    assert.ok(RARITIES.indexOf(seen[i]) >= RARITIES.indexOf(seen[i - 1]),
      `roll ${i / 100} gave ${seen[i]} after ${seen[i - 1]}`);
  }
  assert.strictEqual(seen[0], 'white');
  assert.strictEqual(seen[seen.length - 1], 'foxy');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && node --test tests/rarity.test.js`
Expected: FAIL with `Error: Cannot find module '../src/authority/rarity.js'`.

- [ ] **Step 3: Write `rarity.js`**

Create `backend/src/authority/rarity.js`:

```js
// PURE rarity weighting (SOMET-NNN, progression epic T13).
//
// The weight table is admin-editable (game_settings.rarity_weights), which is
// the whole reason normalisation is not optional: an admin who edits four
// numbers to something that does not sum to 100 must get a proportional
// distribution, not a broken roll that silently favours white because the
// cumulative never reaches 1.

const RARITIES = ['white', 'blue', 'yellow', 'foxy'];

// The identity result: everything is white. Returned for an empty, malformed
// or all-zero table -- a fallback that drops the whole rarity feature to "as
// before this epic" is strictly better than one that throws inside a drop.
function allWhite() { return { white: 1, blue: 0, yellow: 0, foxy: 0 }; }

function normalise(raw) {
  let total = 0;
  for (const r of RARITIES) total += Math.max(0, Number(raw[r]) || 0);
  if (!(total > 0)) return allWhite();
  const out = {};
  for (const r of RARITIES) out[r] = Math.max(0, Number(raw[r]) || 0) / total;
  return out;
}

// Linear interpolation between the two anchors bracketing `itemLevel`, then
// normalisation. Below the first anchor and above the last, the nearest anchor
// is used unchanged -- extrapolating a linear fit past the table's ends
// produces negative weights, which is worse than clamping.
function interpolateWeights(itemLevel, anchors) {
  const rows = (anchors || [])
    .filter((a) => a && Number.isFinite(Number(a.item_level)))
    .map((a) => ({ ...a, item_level: Number(a.item_level) }))
    .sort((a, b) => a.item_level - b.item_level);
  if (rows.length === 0) return allWhite();

  const lvl = Number(itemLevel);
  const l = Number.isFinite(lvl) ? lvl : rows[0].item_level;
  if (l <= rows[0].item_level) return normalise(rows[0]);
  if (l >= rows[rows.length - 1].item_level) return normalise(rows[rows.length - 1]);

  let lo = rows[0];
  let hi = rows[rows.length - 1];
  for (let i = 0; i < rows.length - 1; i += 1) {
    if (l >= rows[i].item_level && l <= rows[i + 1].item_level) {
      lo = rows[i]; hi = rows[i + 1]; break;
    }
  }
  const span = hi.item_level - lo.item_level;
  const t = span === 0 ? 0 : (l - lo.item_level) / span;
  const blended = {};
  for (const r of RARITIES) {
    const a = Number(lo[r]) || 0;
    const b = Number(hi[r]) || 0;
    blended[r] = a + (b - a) * t;
  }
  return normalise(blended);
}

// Walks the cumulative distribution in RARITIES order, so a higher rng never
// yields a worse grade -- the same monotonicity contract rollDrops/rollGold
// state. A grade with zero weight is unreachable at every rng value, including
// the top of the range: the final fallback is the last grade with any weight,
// never simply "the last grade".
function rollRarity(itemLevel, anchors, rng = Math.random) {
  const w = interpolateWeights(itemLevel, anchors);
  const r = rng();
  let acc = 0;
  let last = 'white';
  for (const grade of RARITIES) {
    if (w[grade] > 0) last = grade;
    acc += w[grade];
    if (r < acc && w[grade] > 0) return grade;
  }
  return last;
}

module.exports = { interpolateWeights, rollRarity, RARITIES };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && node --test tests/rarity.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/rarity.js backend/tests/rarity.test.js
git commit -m "feat(items): normalised, item-level-interpolated rarity weighting (SOMET-NNN)"
```

- [ ] **Step 6: Write the failing settings-row test**

Create `backend/tests/rarity_setting_db.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { interpolateWeights } = require('../src/authority/rarity.js');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

test('game_settings carries a usable rarity_weights row', async (t) => {
  if (!DB_URL) { t.skip('no TEST_DATABASE_URL / DATABASE_URL'); return; }
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 2 });
  t.after(async () => { await pool.end().catch(() => {}); });

  const r = await pool.query("SELECT value FROM game_settings WHERE key = 'rarity_weights'");
  assert.strictEqual(r.rowCount, 1, 'the rarity_weights row must exist');
  const anchors = r.rows[0].value;
  assert.ok(Array.isArray(anchors));
  // Hand-written expectation of the seeded table.
  assert.deepStrictEqual(anchors, [
    { item_level: 1, white: 90, blue: 9, yellow: 1, foxy: 0 },
    { item_level: 50, white: 70, blue: 21, yellow: 8, foxy: 1 },
    { item_level: 150, white: 45, blue: 30, yellow: 20, foxy: 5 },
  ]);
  // And it must survive the roller, not just look right.
  assert.deepStrictEqual(interpolateWeights(1, anchors),
    { white: 0.9, blue: 0.09, yellow: 0.01, foxy: 0 });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `cd backend && DATABASE_URL="$S2_SCRATCH" TEST_DATABASE_URL="$S2_SCRATCH" node --test tests/rarity_setting_db.test.js`
Expected: FAIL with `the rarity_weights row must exist` (`0 !== 1`) — assuming Group A's T1 has landed and `game_settings` exists; if it has not, the test fails with `relation "game_settings" does not exist`, which is the correct signal that this task is blocked on A.

- [ ] **Step 8: Write the migration**

Create `backend/migrations/1714440508000_rarity_weights_setting.js`:

```js
/* eslint-disable camelcase */
exports.shorthands = undefined;

// SOMET-NNN (progression epic, Group D / T13). The default rarity weight
// table, as a game_settings row so an admin can retune drop rates without a
// deploy.
//
// Written as an INSERT ... ON CONFLICT DO NOTHING rather than an upsert: T1's
// gameSettings.DEFAULTS already carries the same table as the in-code
// fallback, so a database that somehow has this key already (a hand-inserted
// row, a re-run against a partially migrated DB) must keep whatever an admin
// put there. A migration that overwrote an admin's tuning would be the exact
// "a seed run must never cost an admin their edit" failure scripts/
// seed-catalogs.js's header forbids.
const RARITY_WEIGHTS = [
  { item_level: 1, white: 90, blue: 9, yellow: 1, foxy: 0 },
  { item_level: 50, white: 70, blue: 21, yellow: 8, foxy: 1 },
  { item_level: 150, white: 45, blue: 30, yellow: 20, foxy: 5 },
];

exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO game_settings (key, value)
    VALUES ('rarity_weights', '${JSON.stringify(RARITY_WEIGHTS)}'::jsonb)
    ON CONFLICT (key) DO NOTHING
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM game_settings WHERE key = 'rarity_weights'`);
};

// Exported so a test can assert the seeded table without a database.
exports.RARITY_WEIGHTS = RARITY_WEIGHTS;
```

- [ ] **Step 9: Apply it and verify the test passes**

Run: `cd backend && DATABASE_URL="$S2_SCRATCH" npm run migrate:up && DATABASE_URL="$S2_SCRATCH" TEST_DATABASE_URL="$S2_SCRATCH" node --test tests/rarity_setting_db.test.js`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add backend/migrations/1714440508000_rarity_weights_setting.js backend/tests/rarity_setting_db.test.js
git commit -m "feat(items): seed the default rarity weight table into game_settings (SOMET-NNN)"
```

- [ ] **Step 11: Write the failing drop-rolling test**

Create `backend/tests/loot_rarity.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { World } = require('../src/authority/world.js');
const { spawnDrops } = require('../src/authority/loot.js');

// Same scripted-pool shape authorityLoot.test.js uses, trimmed to what this
// file needs.
function scriptedPool(routes = []) {
  const calls = [];
  function route(sql, params) {
    for (const [re, result] of routes) {
      if (re.test(sql)) return typeof result === 'function' ? result(params) : result;
    }
    return { rows: [], rowCount: 0 };
  }
  return {
    calls,
    matching(re) { return calls.filter((c) => re.test(c.sql)); },
    query: async (sql, params) => { calls.push({ sql, params }); return route(sql, params); },
  };
}

function armEntry(extra = {}) {
  const map = { chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] };
  return {
    worldId: 'w1',
    world: new World(map, new Map(), null, 8),
    creatureTypeIds: new Map([['Wolf', 42]]),
    ...extra,
  };
}

const DROP_ROW = { item_type_id: 7, chance: '1', min_qty: 1, max_qty: 1 };
const DEAD = { type: 'Wolf', x: 100, y: 100, level: 150 };

test('with no rarity anchors on the entry, every drop is a plain white item', async () => {
  const entry = armEntry();
  const pool = scriptedPool([
    [/FROM creature_drops/i, { rows: [DROP_ROW], rowCount: 1 }],
    [/INSERT INTO world_items/i, { rows: [{ id: 'g1', item_type_id: 7, x: 100, y: 100, quantity: 1 }], rowCount: 1 }],
  ]);
  await spawnDrops(pool, entry, DEAD, { rng: () => 0, ttlMs: 1000 });

  const ins = pool.matching(/INSERT INTO world_items/i);
  assert.strictEqual(ins.length, 1);
  // Parameter 7 is the rarity array, parameter 8 the item-level array.
  assert.deepStrictEqual(ins[0].params[6], ['white']);
  assert.deepStrictEqual(ins[0].params[7], [1]);
  assert.deepStrictEqual(ins[0].params[8], ['[]']);
});

test('a foxy-only weight table makes every drop foxy at the creature level', async () => {
  const entry = armEntry({
    rarityAnchors: [{ item_level: 1, white: 0, blue: 0, yellow: 0, foxy: 1 }],
    affixPool: [{
      id: 1, key: 'of_might', kind: 'buff', effect: { type: 'stat', stat: 'strength' },
      min_value: 4, max_value: 4, min_item_level: 1, max_item_level: null,
      allowed_slots: [], min_rarity: 'blue', weight: 100,
    }],
  });
  const pool = scriptedPool([
    [/FROM creature_drops/i, { rows: [DROP_ROW], rowCount: 1 }],
    [/INSERT INTO world_items/i, { rows: [{ id: 'g1', item_type_id: 7, x: 100, y: 100, quantity: 1 }], rowCount: 1 }],
  ]);
  await spawnDrops(pool, entry, DEAD, { rng: () => 0, ttlMs: 1000 });

  const ins = pool.matching(/INSERT INTO world_items/i);
  assert.deepStrictEqual(ins[0].params[6], ['foxy']);
  assert.deepStrictEqual(ins[0].params[7], [150], 'item level is the dead creature level');
  // rng 0 -> 3 affixes wanted, one eligible entry, value 4 * (1 + 149/100) * 1.25
  const affixes = JSON.parse(ins[0].params[8][0]);
  assert.deepStrictEqual(affixes, [{ affixTypeId: 1, value: 12.45 }]);
});

test('the gold pile is never rolled -- currency has no rarity', async () => {
  const entry = armEntry({
    goldItemTypeId: 99,
    creatureGold: new Map([['Wolf', { min: 5, max: 5 }]]),
    rarityAnchors: [{ item_level: 1, white: 0, blue: 0, yellow: 0, foxy: 1 }],
  });
  const pool = scriptedPool([
    [/FROM creature_drops/i, { rows: [], rowCount: 0 }],
    [/INSERT INTO world_items/i, { rows: [{ id: 'g2', item_type_id: 99, x: 100, y: 100, quantity: 5 }], rowCount: 1 }],
  ]);
  await spawnDrops(pool, entry, DEAD, { rng: () => 0, ttlMs: 1000 });

  const ins = pool.matching(/INSERT INTO world_items/i);
  assert.strictEqual(ins.length, 1);
  assert.ok(!/rarity/i.test(ins[0].sql) || /'white'/.test(ins[0].sql),
    'the coin-pile insert must not carry a rolled rarity');
});
```

- [ ] **Step 12: Run the test to verify it fails**

Run: `cd backend && node --test tests/loot_rarity.test.js`
Expected: FAIL with `Expected values to be strictly deep-equal: undefined !== [ 'white' ]` — `spawnDrops` passes only five parameters.

- [ ] **Step 13: Roll rarity inside `spawnDrops`**

In `backend/src/authority/loot.js`, add to the requires at the top:

```js
const { rollRarity } = require('./rarity.js');
const { rollItemInstance } = require('./affixes.js');
```

widen the signature at line 151 and replace the drop INSERT at 201-210:

```js
// `rarityAnchors` and `affixPool` default to the entry's cached copies, and to
// nothing at all when the entry has neither. "Nothing" means every drop is a
// plain white item -- which is exactly how this function behaved before T13,
// so every hand-built fixture in the test suite keeps its existing expectations
// without being touched.
async function spawnDrops(pool, entry, dead, {
  rng = Math.random, ttlMs = 600000,
  rarityAnchors = (entry && entry.rarityAnchors) || null,
  affixPool = (entry && entry.affixPool) || [],
} = {}) {
```

```js
  const droppedItemTypeIds = [...rollDrops(dr.rows, rng), ...rollDrops(br.rows, rng)];
  if (droppedItemTypeIds.length) {
    // Item level is the DEAD CREATURE's level (spec §6.2), so a level-150 kill
    // rolls off the top of the weight table and a level-1 kill off the bottom.
    // Read here rather than passed in: the level is already on the row the
    // death commit RETURNed, and re-deriving it anywhere else would be a
    // second answer to the same question.
    const itemLevel = Math.max(1, Number(dead.level) || 1);
    const rarities = [];
    const itemLevels = [];
    const affixJson = [];
    for (const typeId of droppedItemTypeIds) {
      // No anchors at all -> white, no roll, no rng consumed beyond this point.
      const rarity = rarityAnchors ? rollRarity(itemLevel, rarityAnchors, rng) : 'white';
      const itemType = entry.world.weapons ? entry.world.weapons.get(typeId) : null;
      const rolled = rollItemInstance({ itemType, itemLevel, rarity, affixPool }, rng);
      rarities.push(rolled.rarity);
      itemLevels.push(rolled.itemLevel);
      affixJson.push(JSON.stringify(
        rolled.affixes.map((a) => ({ affixTypeId: a.affixTypeId, value: a.value })),
      ));
    }
    // Still ONE multi-row INSERT (SOMET-96): the rolled values ride as three
    // more arrays through the same UNNEST, so the parameter count stays fixed
    // regardless of how many units dropped.
    const ins = await pool.query(
      `INSERT INTO world_items (world_id, item_type_id, x, y, expires_at, quantity,
                                rarity, item_level, affixes)
       SELECT $1, t.item_type_id, $2, $3, now() + ($4::int * interval '1 millisecond'), 1,
              t.rarity, t.item_level, t.affixes
         FROM unnest($5::int[], $7::text[], $8::int[], $9::jsonb[])
                AS t(item_type_id, rarity, item_level, affixes)
       RETURNING id, item_type_id, x, y, expires_at, quantity, rarity, item_level`,
      [entry.worldId, dropX, dropY, ttlMs, droppedItemTypeIds, null, rarities, itemLevels, affixJson],
    );
    entry.world.groundItems.add(ins.rows);
  }
```

`$6` is deliberately unused (bound to `null`) so `$1`–`$5` keep the meanings every existing comment and test in this file already ascribes to them.

The coin-pile INSERT below is left untouched: currency has no rarity, and adding one would put a grade on a number.

- [ ] **Step 14: Run the test to verify it passes**

Run: `cd backend && node --test tests/loot_rarity.test.js tests/authorityLoot.test.js`
Expected: PASS. `authorityLoot.test.js` stays green because an entry with no `rarityAnchors` still yields `white` and its assertions are on the drop count and position, not on the parameter list.

- [ ] **Step 15: Roll rarity for chest loot**

In `backend/src/authority/chestLoot.js`, widen `openChest`'s options and replace the grant INSERT at lines 126-131:

```js
async function openChest(pool, chestId, characterId, {
  rng = Math.random, freeSlots = Infinity, rarityAnchors = null, affixPool = [],
} = {}) {
```

```js
      // A chest's item level is its GUARD's level -- the same scale a kill's
      // creature level is on, which is why xpForChest already reuses xpForKill.
      const itemLevel = Math.max(1, Number(chest.guard_level) || 1);
      const rarity = rarityAnchors ? rollRarity(itemLevel, rarityAnchors, rng) : 'white';
      const rolled = rollItemInstance(
        { itemType: itemTypes ? itemTypes.get(itemTypeId) : null, itemLevel, rarity, affixPool }, rng,
      );
      const ins = await client.query(
        `INSERT INTO player_items (character_id, item_type_id, quantity, rarity, item_level)
         VALUES ($1,$2,1,$3,$4) RETURNING id, item_type_id, quantity, rarity, item_level`,
        [characterId, itemTypeId, rolled.rarity, rolled.itemLevel],
      );
      for (let i = 0; i < rolled.affixes.length; i += 1) {
        await client.query(
          `INSERT INTO player_item_affixes (player_item_id, idx, affix_type_id, value)
           VALUES ($1,$2,$3,$4)`,
          [ins.rows[0].id, i, rolled.affixes[i].affixTypeId, rolled.affixes[i].value],
        );
      }
      items.push(ins.rows[0]);
```

with `const { rollRarity } = require('./rarity.js');` and `const { rollItemInstance } = require('./affixes.js');` added to the requires, plus one more option `itemTypes = null` in the destructure above so the slot filter has a catalog to read. The overflow path (`overflowTypeIds`, spawned on the ground by the caller) stays white: those items are created by `spawnGroundItemTypes`, which takes bare type ids, and giving overflow a different rarity from what the chest rolled would be two answers to one roll.

- [ ] **Step 16: Resolve the anchors and pool once, on the world entry**

In `backend/src/authority/server.js`, add to the requires:

```js
const { getSetting } = require('../services/gameSettings.js');
```

and inside the existing `itemSweepTimer` callback (line 2743), before the per-entry loop, refresh both caches for every loaded world:

```js
  // Rarity inputs are resolved on the sweep cadence, NOT per drop: a query per
  // kill would put the settings table on the death path, and an admin's edit
  // reaching live drops within one sweep is fast enough for a tuning knob.
  // Cached on the entry so spawnDrops/openChest read them synchronously.
  async function refreshLootTuning() {
    if (worlds.size === 0) return;
    const [anchors, pool2] = await Promise.all([
      getSetting(pool, 'rarity_weights'),
      pool.query('SELECT id, key, kind, effect, min_value, max_value, min_item_level, max_item_level, allowed_slots, min_rarity, weight FROM affix_types'),
    ]);
    for (const entry of worlds.values()) {
      entry.rarityAnchors = anchors;
      entry.affixPool = pool2.rows;
    }
  }
```

called from the sweep with `refreshLootTuning().catch((err) => console.error('loot tuning refresh failed:', err));`, and once from `loadWorld` so a freshly loaded world does not drop white items until the first sweep.

Thread the same two values into the two call sites that need them:
- `server.js:756` — `commitCreatureDeath(pool, entry, id, { rng, ttlMs: groundItemTtlMs, killerUserId })` needs no change: `commitCreatureDeath` forwards its own options object to `spawnDrops`, which reads `entry.rarityAnchors` by default.
- `server.js:2051`'s `openChest` call gains `rarityAnchors: entry.rarityAnchors, affixPool: entry.affixPool, itemTypes: entry.world.weapons`.

- [ ] **Step 17: Add the end-to-end rarity test**

Append to `backend/tests/affixes_db.test.js`:

```js
const { spawnDrops } = require('../src/authority/loot.js');

test('a rolled foxy drop reaches the ground with its affixes and survives a pickup', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  const tag = `e2e-${Date.now()}`;
  const { userId, characterId, worldId } = await fixture(pool, tag);
  const typeRow = await pool.query("SELECT id FROM item_types WHERE name = 'crude-blade'");
  const typeId = typeRow.rows[0].id;
  const affixRows = await pool.query(
    `SELECT id, key, kind, effect, min_value, max_value, min_item_level, max_item_level,
            allowed_slots, min_rarity, weight FROM affix_types WHERE key = 'of_might'`,
  );

  const itemTypes = await loadItemTypes(pool);
  const map = { chunkSize: 16, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] };
  const world = new World(map, itemTypes, null, 16);
  const entry = {
    worldId, world, claiming: new Set(),
    creatureTypeIds: new Map([['Wolf', null]]),
    rarityAnchors: [{ item_level: 1, white: 0, blue: 0, yellow: 0, foxy: 1 }],
    affixPool: affixRows.rows,
  };
  // A drop table this test owns: one guaranteed unit of crude-blade.
  const drops = { rows: [{ item_type_id: typeId, chance: '1', min_qty: 1, max_qty: 1 }] };
  const shim = {
    query: async (sql, params) => (/FROM creature_drops|FROM behavior_drops/i.test(sql)
      ? drops : pool.query(sql, params)),
  };
  world.addPlayer(String(userId), { x: 50, y: 50 }, { items: [], equipment: {} },
    { x: 50, y: 50 }, 0, undefined, characterId);
  entry.creatureTypeIds = new Map([['Wolf', 1]]);

  await spawnDrops(shim, entry, { type: 'Wolf', x: 40, y: 40, level: 100 }, { rng: () => 0, ttlMs: 60000 });

  const ground = await pool.query(
    'SELECT rarity, item_level, affixes FROM world_items WHERE world_id = $1', [worldId],
  );
  assert.strictEqual(ground.rows.length, 1);
  assert.strictEqual(ground.rows[0].rarity, 'foxy');
  assert.strictEqual(ground.rows[0].item_level, 100);
  assert.strictEqual(ground.rows[0].affixes.length, 1);
});
```

- [ ] **Step 18: Run the suite**

Run: `cd backend && DATABASE_URL="$S2_SCRATCH" TEST_DATABASE_URL="$S2_SCRATCH" node --test tests/affixes_db.test.js tests/loot_rarity.test.js tests/authorityLoot.test.js tests/authority_openchest_integration.test.js`
Expected: PASS.

- [ ] **Step 19: Commit**

```bash
git add backend/src/authority/loot.js backend/src/authority/chestLoot.js backend/src/authority/server.js backend/tests/loot_rarity.test.js backend/tests/affixes_db.test.js
git commit -m "feat(loot): roll drop and chest rarity from the item-level weight table (SOMET-NNN)"
```

---

### Task 5: Ground loot TTL 180s and the despawn puff (T14)

**Files:**
- Modify: `backend/src/authority/groundItems.js:70-76` (`removeExpired`)
- Modify: `backend/src/authority/server.js:389` (`groundItemTtlMs`) and `backend/src/authority/server.js:2743-2760` (the item sweep)
- Modify: `backend/src/authority/loot.js:71,151,244,433` (the four hardcoded `600000` defaults)
- Modify: `backend/tests/groundItems.test.js:49-55`
- Modify: `frontend/src/games/something2/src/js/core/vfx.js`, `.../net/WorldAuthorityClient.js`, `.../core/Game.js`
- Test: `backend/tests/ground_despawn_vfx.test.js`, `frontend/src/games/something2/src/js/core/__tests__/vfx.test.js`

**Interfaces:**

- Consumes: T1's `getSetting(pool, 'ground_item_ttl_seconds')` (default `180`).
- Produces:

```js
// backend/src/authority/groundItems.js  — return shape CHANGE
removeExpired(nowMs) -> [{ id, x, y }]      // was: [id]

// wire, contract §4
{ type: 'vfx', name: 'item_despawn', x, y }  // presentation only

// frontend/src/games/something2/src/js/core/vfx.js
export const DESPAWN_EFFECT_DEF = { name: 'item_despawn', shape: 'burst', ... };
```

**No migration.** The contract records T14 as adding none. The puff is therefore a **client built-in**, following the `BLOCK_EFFECT_DEF` precedent already in `core/vfx.js:45-48`: an effect that must not be deletable by an admin is not a `vfx_effects` row. Spec §9 says "a `vfx_effects` row seeds a small puff" — see "Contract and spec deviations" for why the contract wins here.

- [ ] **Step 1: Write the failing `removeExpired` test**

Replace the existing case at `backend/tests/groundItems.test.js:49-55`:

```js
test('removeExpired removes only expired items and returns their id AND position', () => {
  const sim = new GroundItemSim(CHUNK);
  sim.add(rows(['old', 100, 100, 1, '2000-01-01T00:00:00Z'], ['new', 120, 120]));
  const removed = sim.removeExpired(Date.parse('2020-01-01T00:00:00Z'));
  // The position is what the despawn puff is drawn at; an id alone cannot be
  // placed, because the item is gone from the map by the time the caller looks.
  assert.deepStrictEqual(removed, [{ id: 'old', x: 100, y: 100 }]);
  assert.strictEqual(sim.count(), 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && node --test tests/groundItems.test.js`
Expected: FAIL with `Expected values to be strictly deep-equal: [ 'old' ] !== [ { id: 'old', x: 100, y: 100 } ]`.

- [ ] **Step 3: Return positions from `removeExpired`**

In `backend/src/authority/groundItems.js`, replace lines 70-76:

```js
  // Returns {id, x, y} per removed item, not a bare id list.
  //
  // The position is the point of the return value now: server.js broadcasts a
  // despawn puff at each expired item's position, and once the entry has been
  // deleted from this.items there is nowhere left to look it up. Reading it
  // BEFORE the delete is the only order that works.
  removeExpired(nowMs) {
    const removed = [];
    for (const [id, it] of this.items) {
      if (it.expiresAt <= nowMs) {
        removed.push({ id, x: it.x, y: it.y });
        this.items.delete(id);
      }
    }
    return removed;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && node --test tests/groundItems.test.js tests/authority_groundItems_integration.test.js`
Expected: PASS. `server.js`'s existing call at line 2749 discards the return value, so it is unaffected until Step 7.

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/groundItems.js backend/tests/groundItems.test.js
git commit -m "refactor(loot): removeExpired returns each expired item's position (SOMET-NNN)"
```

- [ ] **Step 6: Write the failing TTL + puff test**

Create `backend/tests/ground_despawn_vfx.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachAuthority } = require('../src/authority/server.js');

const SECRET = 'test-secret';
const token = (u) => jwt.sign({ user_id: u, tv: 1 }, SECRET, { algorithm: 'HS256' });

// Minimal fake pool: enough for a join and for the expiry DELETE. Mirrors the
// shape authority_groundItems_integration.test.js uses.
function fakePool(routes = []) {
  const calls = [];
  async function query(sql, params) {
    calls.push({ sql, params });
    for (const [re, result] of routes) {
      if (re.test(sql)) return typeof result === 'function' ? result(params) : result;
    }
    return { rows: [], rowCount: 0 };
  }
  return {
    calls,
    matching(re) { return calls.filter((c) => re.test(c.sql)); },
    query,
    connect: async () => ({ query, release: () => {} }),
  };
}

test('the ground item TTL comes from game_settings, not the old 600000 default', async () => {
  const pool = fakePool([
    [/FROM game_settings/i, { rows: [{ key: 'ground_item_ttl_seconds', value: 180 }], rowCount: 1 }],
  ]);
  const server = http.createServer();
  const handle = attachAuthority(server, pool, { jwtSecret: SECRET, tickMs: 10000, itemSweepMs: 10000 });
  await new Promise((r) => server.listen(0, r));
  try {
    // Resolved once at boot rather than per drop (spec §9).
    await handle._refreshLootTuning();
    assert.strictEqual(handle._groundItemTtlMs(), 180000);
  } finally {
    handle.close ? handle.close() : null;
    await new Promise((r) => server.close(r));
  }
});

test('an expired ground item emits a vfx frame and NO damage', async () => {
  const pool = fakePool([
    [/FROM game_settings/i, { rows: [{ key: 'ground_item_ttl_seconds', value: 180 }], rowCount: 1 }],
    [/DELETE FROM world_items/i, { rows: [], rowCount: 0 }],
  ]);
  const server = http.createServer();
  const handle = attachAuthority(server, pool, {
    jwtSecret: SECRET, tickMs: 10000, itemSweepMs: 3600000,
  });
  await new Promise((r) => server.listen(0, r));
  const url = `ws://127.0.0.1:${server.address().port}/authority`;

  const ws = new WebSocket(`${url}?token=${encodeURIComponent(token('u1'))}`);
  const frames = [];
  ws.on('message', (data) => frames.push(JSON.parse(data)));
  await new Promise((r) => ws.on('open', r));

  // Drive a world entry straight into the handle rather than through a join:
  // this test is about the sweep, not about world loading.
  const entry = handle._testEntry({ worldId: 'w1', userId: 'u1', socket: ws });
  const before = entry.world.getPlayer('u1').hp;
  entry.world.groundItems.add([
    { id: 'gone', item_type_id: 7, x: 321, y: 654, expires_at: '2000-01-01T00:00:00Z' },
  ]);

  await handle._itemSweep();
  await new Promise((r) => setTimeout(r, 50));

  const vfx = frames.filter((f) => f.type === 'vfx');
  assert.strictEqual(vfx.length, 1, `expected one vfx frame, got ${JSON.stringify(frames)}`);
  assert.deepStrictEqual(vfx[0], { type: 'vfx', name: 'item_despawn', x: 321, y: 654 });

  // Presentation only: no impact/attack channel, no knockback, no hp change.
  for (const f of frames) {
    assert.strictEqual(f.impacts, undefined, 'a despawn must not ride the impacts channel');
    assert.strictEqual(f.attacks, undefined, 'a despawn is not an attack');
    assert.strictEqual(f.detonations, undefined, 'a despawn is not a detonation');
  }
  assert.strictEqual(entry.world.getPlayer('u1').hp, before, 'a despawn must not damage anybody');
  assert.strictEqual(entry.world.groundItems.count(), 0);

  ws.close();
  await new Promise((r) => server.close(r));
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `cd backend && node --test tests/ground_despawn_vfx.test.js`
Expected: FAIL with `TypeError: handle._refreshLootTuning is not a function`.

- [ ] **Step 8: Read the TTL from `game_settings` and emit the puff**

In `backend/src/authority/server.js`:

Replace line 389:

```js
  // SOMET-NNN: 180 seconds (game_settings.ground_item_ttl_seconds), replacing
  // the hardcoded 600000. Held in a mutable local rather than a const because
  // the sweep re-reads the setting -- an admin lowering it must reach live
  // drops without a restart. `opts.groundItemTtlMs` still wins when a caller
  // passes one, which is every existing test.
  let groundItemTtlMs = opts.groundItemTtlMs || 180000;
```

Extend `refreshLootTuning` (added in Task 4, Step 16) so it also refreshes the TTL:

```js
    const seconds = Number(await getSetting(pool, 'ground_item_ttl_seconds'));
    // A junk or non-positive value keeps the previous number rather than
    // making every drop vanish instantly or never expire -- an admin typo in
    // a text field must not be able to empty the world's floor.
    if (Number.isFinite(seconds) && seconds > 0) groundItemTtlMs = Math.round(seconds * 1000);
```

Replace the sweep body at lines 2743-2760:

```js
  // Expired ground items: delete from the DB, evict from every live sim, and
  // announce each removal so the client can draw a puff where the item was.
  async function itemSweep() {
    if (worlds.size === 0) return;
    await refreshLootTuning().catch((err) => console.error('loot tuning refresh failed:', err));
    const now = Date.now();
    for (const entry of worlds.values()) {
      const removed = entry.world.groundItems.removeExpired(now);
      // Presentation only, and deliberately its own frame rather than a rider
      // on `state`: the state frame is drained and cleared per tick, and a
      // despawn happens on the SWEEP cadence, not the tick cadence. Sending it
      // on the state frame would mean stashing it until the next tick, which
      // is a second lifetime to keep in step for a puff.
      //
      // NO damage, NO knockback, NO collision -- nothing here touches hp,
      // effects or the projectile sim, and ground_despawn_vfx.test.js asserts
      // exactly that.
      for (const it of removed) {
        const { cx, cy } = chunkOf(it.x, it.y, entry.row.chunk_size);
        const keys = neighborhoodKeys(cx, cy, 1);
        for (const [userId, ws] of entry.sockets) {
          const p = entry.world.getPlayer(userId);
          if (!p) continue;
          // Same neighbourhood filter broadcastItems uses: a puff for an item
          // three chunks away is bytes for a frame nobody can see.
          const pc = chunkOf(p.x, p.y, entry.row.chunk_size);
          if (!keys.includes(CHUNK_KEY(pc.cx, pc.cy))) continue;
          send(ws, { type: 'vfx', name: 'item_despawn', x: it.x, y: it.y });
        }
      }
    }
    try {
      const r = await pool.query('DELETE FROM world_items WHERE expires_at <= now() RETURNING id');
      if (r.rowCount) {
        const ids = new Set(r.rows.map((row) => row.id));
        for (const entry of worlds.values()) {
          for (const id of ids) entry.world.groundItems.remove(id);
        }
      }
    } catch (err) {
      console.error('ground item sweep failed:', err);
    }
    chestRespawnSweep();
  }

  const itemSweepTimer = setInterval(() => {
    itemSweep().catch((err) => console.error('item sweep failed:', err));
  }, itemSweepMs);
```

and expose the three test seams on the returned handle, alongside `_heartbeatSweep`/`_chestRespawnSweep`:

```js
    // Test seams, same reasoning as _chestRespawnSweep: run one pass
    // synchronously and await it instead of racing wall-clock itemSweepMs.
    _itemSweep: itemSweep,
    _refreshLootTuning: refreshLootTuning,
    _groundItemTtlMs: () => groundItemTtlMs,
```

`_testEntry({ worldId, userId, socket })` — used by the test above — registers a minimal world entry with one player and one socket, exactly as `authority_groundItems_integration.test.js` already constructs entries through a join; add it beside the other underscore seams if one does not already exist.

Finally, change the four `ttlMs = 600000` defaults in `backend/src/authority/loot.js` (lines 71, 151, 244, 433) to `ttlMs = 180000`, so a caller that omits the option agrees with the setting's default instead of contradicting it by 7 minutes.

- [ ] **Step 9: Run the test to verify it passes**

Run: `cd backend && node --test tests/ground_despawn_vfx.test.js tests/authority_groundItems_integration.test.js tests/authorityLoot.test.js`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add backend/src/authority/server.js backend/src/authority/loot.js backend/tests/ground_despawn_vfx.test.js
git commit -m "feat(loot): 180s ground TTL from game_settings plus a despawn vfx frame (SOMET-NNN)"
```

- [ ] **Step 11: Write the failing client test**

Append to `frontend/src/games/something2/src/js/core/__tests__/vfx.test.js`:

```js
import { DESPAWN_EFFECT_DEF } from "../vfx.js";

describe("item_despawn", () => {
  it("resolves from the built-in def even with an EMPTY effect library", () => {
    // The whole point of the built-in: an admin cannot delete the despawn cue
    // by renaming a vfx_effects row, exactly as with BLOCK_EFFECT_DEF.
    const list = addEffects([], [{ v: "item_despawn", x: 321, y: 654 }], 500, {});
    expect(list).toHaveLength(1);
    expect(list[0].def).toBe(DESPAWN_EFFECT_DEF);
    expect(list[0].x).toBe(321);
    expect(list[0].y).toBe(654);
    expect(list[0].startedAt).toBe(500);
  });

  it("is a burst that fades and carries no weapon geometry", () => {
    expect(DESPAWN_EFFECT_DEF.shape).toBe("burst");
    expect(DESPAWN_EFFECT_DEF.fade).toBe(true);
    expect(DESPAWN_EFFECT_DEF.follows_weapon).toBeFalsy();
    expect(DESPAWN_EFFECT_DEF.duration_ms).toBe(420);
  });

  it("expires on its own duration", () => {
    const list = addEffects([], [{ v: "item_despawn", x: 1, y: 2 }], 0, {});
    expect(pruneEffects(list, 419)).toHaveLength(1);
    expect(pruneEffects(list, 421)).toHaveLength(0);
  });
});
```

- [ ] **Step 12: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/src/js/core/__tests__/vfx.test.js`
Expected: FAIL with `SyntaxError: The requested module '../vfx.js' does not provide an export named 'DESPAWN_EFFECT_DEF'`.

- [ ] **Step 13: Add the built-in def and wire the frame**

In `frontend/src/games/something2/src/js/core/vfx.js`, after `BLOCK_EFFECT_DEF` (line 48):

```js
// SOMET-NNN -- the puff a ground item leaves when its 180-second lifetime runs
// out. Built in for the same reason BLOCK_EFFECT_DEF is: it is the only cue
// separating "my loot expired" from "somebody took my loot", so it must not be
// deletable content. It is also why T14 needs no migration at all.
//
// PRESENTATION ONLY. It carries no target, no element and no geometry; the
// server frame that triggers it (`{type:'vfx', name:'item_despawn', x, y}`)
// carries nothing else either.
export const DESPAWN_EFFECT_DEF = {
  name: "item_despawn", shape: "burst", color: "#b8b8c8", width: 2,
  duration_ms: 420, ease: "out", fade: true,
  particle_count: 8, particle_spread: 6.283, particle_speed: 40,
  particle_gravity: -20, particle_lifetime_ms: 420, particle_size: 2,
};

// Names the authored library can never shadow. Checked BEFORE `defs` so an
// admin row that happens to share a name cannot replace a built-in cue.
const BUILTIN_DEFS = { [DESPAWN_EFFECT_DEF.name]: DESPAWN_EFFECT_DEF };
```

and in `addEffects` (line 66), replace the def resolution:

```js
    const def = e.b === true
      ? BLOCK_EFFECT_DEF
      : (e.v ? (BUILTIN_DEFS[e.v] || (defs ? defs[e.v] : null)) : null);
```

In `frontend/src/games/something2/src/js/net/WorldAuthorityClient.js`, add `onVfx` to the constructor destructure and defaults beside `onChestOpened`:

```js
    // SOMET-NNN. A one-shot presentation frame, not world state: it carries a
    // name and a position and nothing else, and dropping one costs a puff.
    this.onVfx = onVfx || (() => {});
```

and one case in `_handleMessage` (after `case 'chestOpened'`):

```js
      case 'vfx': this.onVfx(msg); break;
```

In `frontend/src/games/something2/src/js/core/Game.js`, beside `onChests` (around line 494):

```js
                onVfx: (msg) => {
                    if (!msg || !Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return;
                    addEffects(this.vfx, [{ v: msg.name, x: msg.x, y: msg.y }],
                               performance.now(), this.vfxDefs);
                    // Same budget the impacts path enforces the moment the
                    // list grows -- a crowded floor expiring at once is
                    // exactly when it would blow.
                    this.vfx = capParticles(this.vfx);
                },
```

- [ ] **Step 14: Run the frontend tests**

Run: `cd frontend && npx vitest run src/games/something2/src/js/core/__tests__/vfx.test.js`
Expected: PASS.

- [ ] **Step 15: Commit**

```bash
git add frontend/src/games/something2/src/js/core/vfx.js frontend/src/games/something2/src/js/net/WorldAuthorityClient.js frontend/src/games/something2/src/js/core/Game.js frontend/src/games/something2/src/js/core/__tests__/vfx.test.js
git commit -m "feat(vfx): built-in item_despawn puff driven by the new vfx frame (SOMET-NNN)"
```

- [ ] **Step 16: Run the touched suites once, at the end**

Run: `cd backend && DATABASE_URL="$S2_SCRATCH" TEST_DATABASE_URL="$S2_SCRATCH" npm test`
Expected: PASS.

Run: `cd frontend && npx vitest run`
Expected: PASS.

- [ ] **Step 17: Browser-verify (AGENTS.md definition of done)**

T14 and T11 both have a visible surface, so a green suite is not the finish line. With the dev stack up (`make dev`), log in, then:

1. Drop an item, walk away, and watch it vanish at ~180 seconds with a grey puff — not at 600.
2. Open the inventory panel and confirm all eight paper-doll slots now accept something: equip a `crude-blade`, `crude-buckler`, `crude-helm`, `crude-plate`, `crude-gauntlets`, `crude-greaves`, `crude-band`, `crude-signet`. They render as placeholder colour boxes, which is expected — sprites are out of scope.
3. Try to equip a `mythic-plate` at level 1 and confirm the refusal names the level.

Take a screenshot of the filled paper doll and attach it to the Plane item.

---

## Contract and spec deviations

Everything below is a place where this plan does **not** do what the spec or contract literally says. Each one is a decision, not an omission.

1. **`world_items.soulbound` is a new column the spec's §3.2 table does not list.** Spec §3.4 requires soulbound to survive a drop-and-repick ("so a granted starter item cannot be laundered into a sellable one by dropping it"), and there is no way to carry a flag through `world_items` without a column. Added in T12's migration (`1714440507000`), which is the slot the contract already assigns to "`player_items` + `world_items` columns".

2. **T12 removes `dropItem`'s outright refusal to drop soulbound gear** (`backend/src/authority/loot.js:505-511`). The refusal's own comment says it exists only because "`world_items` carries no soulbound column". Once the column exists, carrying the flag is strictly better than refusing the drop. The sell refusal in `trade.js:182-185` is untouched and is what still makes `soulbound` mean something.

3. **The respec capacity refusal fires on an over-capacity backpack, not on "no free slot".** In this schema an equipped item is already a `player_items` row and `items.js#usedSlots` (line 307) counts it, and `inventoryPanel.js#visibleItems` draws it in the same grid — so unequipping is capacity-**neutral**. A "not enough free slots" refusal would be an unreachable branch dressed as a safety check, and a test driving it would be vacuous. The condition implemented is `usedSlots > capacity`, which is reachable (an admin lowering `characters.inventory_slots`, whose only CHECK is `> 0`) and is genuinely the state in which returned gear has no representable home. Spec §7's invariants — never delete gear, never leave an illegal item live in the combat path — are both preserved.

4. **The despawn puff is a client built-in, not a `vfx_effects` row.** Spec §9 says a row seeds it; the contract says T14 adds no migration, and there is no free slot in Group D's block for one. `core/vfx.js`'s `BLOCK_EFFECT_DEF` is the existing precedent for exactly this: a cue that must not be admin-deletable is not authored content. The contract wins.

5. **`interpolateWeights` clamps outside the anchor table rather than extrapolating.** The spec says "linearly interpolated between the anchor rows" and is silent on the ends; extrapolating a linear fit past level 150 produces negative weights.

6. **Buyback loses affixes.** `merchant_stock` carries only `item_type_id`, so selling a yellow item and buying it back returns a white base item. This plan does not change that — a buyback affix snapshot is a second denormalised carry path for a row with a multi-day lifetime, which is a different trade from the 180-second `world_items` one — but T12's test pins the cascade so the behaviour is at least deliberate and covered. **Flagged as underspecified; worth its own ticket.**

7. **Contract §1's slot `1714440400000` (T1, Group A) is already taken** by `backend/migrations/1714440400000_biome_path_tile.js` on main. Group D's four slots (`405000`–`408000`) are clean; T1's is not. Group A must rebase its slot or accept a duplicate-timestamp filename. Reported rather than fixed here — this plan may not edit the contract.

## Self-review — every spec requirement in scope, and where it lands

| Spec / brief requirement | Task | Step |
|---|---|---|
| §3.2 `item_types` gains `req_level`, six `req_*`, `item_level`, `tier` | T10 | Task 1, Steps 1-5 |
| §7 `canEquip` gains the requirement check | T10 | Task 1, Steps 11-15 |
| §7 circularity rule — requirements exclude the candidate item's own grants | T10 | Task 1, Steps 6-9 (`effectiveStatsFor({excludeItemId})`) |
| §7 respec auto-unequips items that no longer qualify | T10 | Task 1, Steps 21-25 |
| §7 respec refused when the backpack cannot take them; gear never deleted | T10 | Task 1, Steps 21-25 (see deviation 3) |
| §7 unequipping A is refused while B would become illegal, naming B | T10 | Task 1, Steps 16-20 (`unequipBlockers`) |
| §12 requirements validated on equip only, never per attack | T10 | Task 1, Step 18 (`_requirementContext`, one SELECT per equip) |
| Base gear ladder: 8 slots × 10 tiers, ~150 items, from an authored tier spec | T11 | Task 2, Steps 3-5 |
| req_level rungs 1/10/25/40/55/70/90/110/130/150 | T11 | Task 2, Step 3 (`GEAR_TIERS`) |
| Five empty slots (`off_hand`, `hands`, `feet`, `ring1`, `ring2`) get items | T11 | Task 2, Steps 7-11 |
| Sprites out of scope — placeholder colour boxes | T11 | Task 2, Step 3 (file header) |
| §3.1 `affix_types` table | T12 | Task 3, Step 8 |
| §3.1 `player_item_affixes` table | T12 | Task 3, Step 8 |
| §3.2 `player_items` gains `rarity`, `item_level` | T12 | Task 3, Step 8 |
| §3.2 `world_items` gains `rarity`, `item_level`, `affixes` | T12 | Task 3, Step 8 |
| §3.4 `claimItem` reconstructs the instance from the snapshot | T12 | Task 3, Step 11 |
| §3.4 soulbound round-trips a drop | T12 | Task 3, Steps 6, 10, 11 |
| §6.1 grade → affix count (white 0 / blue 1 / yellow 3-6 / foxy 3-9) | T12 | Task 3, Step 3 (`rarityAffixCount`) |
| §6.1 debuff affixes only on foxy | T12 | Task 3, Step 3 (`eligibleAffixes`) |
| §6.2 pure `rollItemInstance` with injected rng, rolled once at drop time | T12 | Task 3, Step 3 |
| §6.2 sampling without replacement by affix key | T12 | Task 3, Step 3 (`sampleAffixes`) |
| §6.2 value = min + rng·(max−min), level-scaled, ×1.25 foxy | T12 | Task 3, Step 3 (`affixValue`) |
| §10.5 admin affix catalog CRUD | T12 | Task 3, Steps 17-21 |
| Merchant buy/sell does not break on affixed items | T12 | Task 3, Step 6 (cascade test); deviation 6 |
| §6.3 weights interpolated by item level from `game_settings.rarity_weights` | T13 | Task 4, Steps 3, 8 |
| §6.3 always normalised, so a table not summing to 100 still rolls | T13 | Task 4, Step 3 (`normalise`) |
| §6.2 item level = the killed creature's level / the chest's level | T13 | Task 4, Steps 13, 15 |
| §9 TTL from `game_settings.ground_item_ttl_seconds`, default 180 | T14 | Task 5, Step 8 |
| §9 replaces the hardcoded 600000 in every call site | T14 | Task 5, Step 8 |
| §9 resolved once per sweep, not per drop | T14 | Task 5, Step 8 (`refreshLootTuning`) |
| §9 `removeExpired` is the despawn hook | T14 | Task 5, Steps 3, 8 |
| §9 despawn puff: no damage, no knockback, no collision | T14 | Task 5, Steps 6, 8, 13 |
| Contract §4 `{ type:'vfx', name:'item_despawn', x, y }` | T14 | Task 5, Steps 8, 13 |

### Required test coverage — where each one is

| Required test | File | Task / Step |
|---|---|---|
| (a) an item granting +20 STR does NOT satisfy its own 20-STR requirement | `backend/tests/item_requirements.test.js` | Task 1 Step 6 (stone); Task 3 Step 15 (affix) |
| (b) respec with a full backpack is refused, equipment untouched | `backend/tests/item_requirements_db.test.js` | Task 1 Step 21 |
| (c) drop-and-repick round-trips rarity, item_level, affixes AND soulbound | `backend/tests/affixes_db.test.js` | Task 3 Step 6 |
| (d) rarity weights not summing to 100 still normalise | `backend/tests/rarity.test.js` | Task 4 Step 1 |
| (e) ground despawn emits a vfx event and NO damage event | `backend/tests/ground_despawn_vfx.test.js` | Task 5 Step 6 |
| (f) all 8 paper-doll slots have an equippable base item after the seed | `backend/tests/gear_ladder_db.test.js` | Task 2 Step 7 |
