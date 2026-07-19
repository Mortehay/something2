# Phase 6 Slice 3b-3b — AoE and consumable ammo

**Date:** 2026-07-19
**Plane:** SOMET-61 (3b-3), sub-slice b
**Depends on:** Slice 3b-3a (weapon catalog, stamina, melee LOS — merged `4e50a51`)

## Goal

Give ranged martial weapons a supply cost, and give staves an area-of-effect identity —
so that "which weapon" becomes a question about logistics and positioning, not just stats.

## Decomposition context

SOMET-61 is being built as three sub-slices:

- **3b-3a** (merged) — the content catalog, stamina, melee line-of-sight.
- **3b-3b (this spec)** — AoE and consumable ammo.
- **3b-3c** — elemental identity, status effects, mana economy depth.

## Decisions (locked during brainstorming)

1. **Ammo is a real item with a quantity**, not a parallel counter system. It stacks in
   `player_items`, so it loots, drops, and gets picked up through the machinery 3b-2b
   already built.
2. **Ammo is written through to Postgres on every shot.** No in-memory count, no
   write-behind cache.
3. **Redis is explicitly deferred**, and gets its own epic. See "Why not Redis" below.
4. **A weapon names its ammo via `ammo_type_id`; ammo occupies no equipment slot.**
5. **An AoE blast damages everything in radius except the caster.**
6. **Blast damage falls off linearly**, full at the impact point to zero at the edge.

## Why not Redis

Redis is already provisioned in `compose/docker-compose.yml` (appendonly on) but is wired
only to the frozen `game-engine` service; the Node authority has no client and no
`REDIS_URL`. Introducing it here was considered and rejected for this slice:

- **There is no write pressure to relieve.** The fastest-firing ranged weapon in the game
  (darts, 0.35s cooldown) does not even use ammo. A sling at 0.50s is 2 writes/sec per
  actively-shooting player. Single-row indexed UPDATEs at that rate are not a Postgres
  workload.
- **It would add a copy, not remove one.** The authority is a single process already
  holding the whole world in memory. Memory → Redis → Postgres is three copies, two of
  which can disagree, and a periodic flush refunds ammo the player already fired on a
  crash — the same class of bug as the mirrored `autoLoot` flag fixed in the 3b-2b
  fast-follows.
- **What Redis actually buys is cross-process state**: sharding the authority, or restart
  recovery without replaying Postgres. Both are plausible futures for the chunked-world
  epic. Neither is true today.

The conclusion is not "Redis is wrong" but "Redis is an infrastructure epic, and ammo is a
bad excuse to smuggle it in". A separate Plane epic captures it.

## Schema

### `item_types` — three new columns

| column | type | meaning |
|---|---|---|
| `stackable` | `boolean NOT NULL DEFAULT false` | true for ammo; gates the quantity path |
| `ammo_type_id` | `integer REFERENCES item_types(id)` | the ammo this weapon consumes; `NULL` = none |
| `aoe_radius` | `real` | blast radius in px; `NULL` = point-collision as today |

`item_types_category_check` is replaced to permit `'ammo'` alongside `'weapon'` and
`'armor'`.

Three new CHECK constraints, following the category-conditional pattern established in
3b-2a — the DB must reject an item that can never work:

```sql
-- Ammo rows are stackable and carry no weapon kind.
CHECK (category <> 'ammo' OR (stackable = true AND kind IS NULL))

-- A detonating projectile has nothing left to pierce with. Allowing both makes
-- "what happens on impact" ambiguous, so the DB forbids the combination.
CHECK (aoe_radius IS NULL OR pierce IS NULL OR pierce <= 1)

-- Only a projectile weapon can consume ammo. A melee sword with ammo_type_id
-- set would silently never check it.
CHECK (ammo_type_id IS NULL OR kind = 'projectile')
```

Verified against the current seed: `flame staff`, `storm staff` and `archmage staff` all
carry `pierce = 1`, so the AoE/pierce CHECK admits them without any pierce edit. Only
`arbalest` has `pierce = 2`, and it gets no `aoe_radius`.

`ammo_type_id` is a self-referencing FK on `item_types`. It uses `ON DELETE RESTRICT`, not
`CASCADE`: deleting the `arrow` type should fail loudly while a bow points at it, rather
than cascading the bow away.

### `player_items` — quantity

```sql
quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0)
```

The `> 0` bound is load-bearing. It makes spending the last arrow a constraint violation
rather than a silent negative, so the invariant is enforced by Postgres rather than by
remembering to check it at every call site. The default of 1 means every existing row and
every existing INSERT (loot drops, starting loadout, admin grants) keeps working unchanged.

### Migration ordering

The ammo item rows must be inserted before the weapons that reference them, because
`ammo_type_id` is a foreign key. The migration inserts ammo types first, then sets
`ammo_type_id` on the weapons by name subquery — the same guarded pattern the loot seed
uses, so a missing row skips rather than aborting the migration.

## Content

**Ammo types** (`category='ammo'`, `stackable=true`, `kind=NULL`):

| name | notes |
|---|---|
| arrow | consumed by bow |
| bolt | consumed by arbalest |
| stone | consumed by sling |

**Weapon changes:**

| weapon | change |
|---|---|
| bow | `ammo_type_id` → arrow |
| arbalest | `ammo_type_id` → bolt; keeps `pierce 2`, stays single-target |
| sling | `ammo_type_id` → stone |
| darts | **unchanged — no ammo** |
| flame staff | `aoe_radius` 90 |
| storm staff | `aoe_radius` 70 |
| archmage staff | `aoe_radius` 110 |

Darts staying ammo-free is deliberate: it is what makes them the weak-but-always-available
option and gives the ranged tier a real progression — darts cost nothing but hit for 7,
while the arbalest hits for 20 and needs a supply chain. Staves cost mana and never take
ammo, keeping the martial/magic resource split from 3b-3a intact.

Storm staff gets the *smallest* radius despite the highest tier, matching the pike
precedent from 3b-3a: it is the precision option, trading area for speed (1000 px/s
projectile) so that no staff is strictly better than another.

## Ammo consumption — ordering is the whole problem

The obvious implementation is wrong. If ammo is consumed and *then* `attack` is called, an
attack refused for cooldown or insufficient stamina has already destroyed an arrow.
**Ammo must be the last gate before the attack commits, not the first.**

`World.attack` therefore splits:

```js
// world.js — pure, no I/O. Cooldown + mana + stamina, exactly the checks
// attack() already performs, extracted so the caller can gate on them
// BEFORE spending anything irreversible.
canAttack(userId) // -> { ok: boolean, weapon: itemType|null }
```

`attack()` keeps its own checks — it does not become dependent on the caller having called
`canAttack` first. The extraction is additive, so `attack()` remains correct when called
directly (as it still is for every ammo-free weapon).

The handler in `server.js` becomes, in order:

1. `canAttack` — if not ok, return. Nothing spent, no cooldown consumed.
2. If `weapon.ammo_type_id` is null → `attack()` directly, synchronously as today.
3. Otherwise, the atomic decrement:

```sql
UPDATE player_items SET quantity = quantity - 1
 WHERE user_id = $1 AND item_type_id = $2 AND quantity > 0
 RETURNING id, quantity
```

4. `rowCount === 0` → out of ammo. Send a `noammo` frame. **No cooldown consumed** —
   matching the mana and stamina denial rule from 3b-3a.
5. `rowCount === 1` → `attack()`.
6. If the returned `quantity` is 0, `DELETE` the empty stack.

The `rowCount` **is** the has-ammo check. There is no separate SELECT that could drift out
of sync with the write — the same reasoning that made the loot claim CTE a single
statement.

### Serialization and its two consequences

The ammo path is async, so the `attack` handler moves onto `ws._opChain` alongside
equip/unequip/pickup/drop. Both consequences are accepted deliberately:

- **Attacks now serialize behind equip and pickup.** This is what makes the
  check → consume → attack window non-interleavable for a single player: a player has one
  connection, and the chain guarantees their second attack cannot start before their first
  finishes. The cost is that a slow DB write delays a swing.
- **`input` stays synchronous, so input and attack frames can be reordered.** An attack can
  now resolve against a position up to one tick stale. At 20Hz that is ≤50ms. The
  alternative — putting `input` on the op chain — would make movement wait on database
  writes, which is clearly worse. Watch it during the browser pass.

Ammo-free weapons (all melee, all staves, darts) keep the synchronous path entirely, so
the common case is unaffected.

### Client

The HUD shows the equipped weapon's ammo count, or nothing when the weapon takes no ammo.
The count arrives on the existing inventory frame rather than the 20Hz `state` snapshot —
ammo changes only on a shot, and putting a rarely-changing integer in the hot broadcast
would cost every player bandwidth for every other player's arrows.

A `noammo` frame drives a brief HUD flash so an out-of-ammo player learns why nothing
happened. Silence here reads as a bug.

## AoE

A projectile with `aoe_radius` detonates on **any** impact — terrain, creature, or player —
and dies. Terrain is included deliberately: if a shot that hits the wall beside a target
did nothing while a direct hit did full damage, missing would be strictly better for the
attacker's target than being hit, and near-misses are most of what a blast weapon is for.

On detonation, for every creature and every non-owner player within `aoe_radius` of the
impact point:

1. **`hasLineOfSight(map, impactX, impactY, targetX, targetY)` must pass.** Without this,
   AoE reintroduces the melee-through-walls exploit that 3b-3a closed, with a larger
   hitbox. This reuses the exact helper and its shared `MAX_SUB`.
2. Damage scales linearly: `raw * (1 - dist / aoe_radius)`, so a target at the impact point
   takes full damage and one at the edge takes zero.
3. The scaled damage goes through the normal paths — `applyDamage` for players (so
   defense and resistances still apply on top of falloff), `damageCreatureById` for
   creatures.

`applyDamage` floors at 1, so a player at the very edge still takes 1 damage. This is
accepted: it keeps "was I caught in that blast" unambiguous for the player.

The caster is exempt, matching the existing rule that a projectile never collides with its
owner — one rule, not two.

### Detonation events

`ProjectileSim.step` currently returns `{ killedCreatureIds }`. It gains a second field:

```js
{ killedCreatureIds, detonations: [{ x, y, radius, element }] }
```

A detonation is a one-frame event and cannot ride the projectile snapshot, which only
carries projectiles that are still alive. `server.js` forwards detonations on the
broadcast so the client can draw a blast; the client renders an expanding ring that fades
over ~250ms, tinted by element.

## Surfaces this touches

Adding item-catalog columns has caught this project out repeatedly. All of these move
together:

- **Migration** — 4 columns, 3 CHECKs, 3 ammo rows, 6 weapon updates.
- **`validateItemType` in `backend/src/index.js`** — must accept and validate `stackable`,
  `ammo_type_id`, `aoe_radius`. A validator lagging the schema produced a 500 in 3b-2a.
- **`items.js` `loadItemTypes`** — select and expose all three, or ammo silently never
  depletes and AoE silently never fires. Both the read path's SELECT column list and the
  write path's INSERT column/placeholder alignment are covered by the guard tests added at
  the end of 3b-3a; those tests must be extended, not just left passing.
- **`loadInventory`** — must return `quantity` per stack.
- **`ItemTypesAdmin.jsx`** — fields for the three new columns.
- **Loot** (`loot.js`) — `claimItem` must merge into an existing stack rather than creating
  a second row for the same stackable type, or a player accumulates many one-arrow rows and
  the consume UPDATE (which matches on `item_type_id`) empties them one at a time in
  arbitrary order.
- **`dropItem`** — dropping a stack drops the whole stack. Partial-stack drops are out of
  scope.
- **`world.js`** — `canAttack` extraction.
- **`projectiles.js`** — detonation.
- **Client** — HUD ammo count, `noammo` feedback, blast render.

## Testing

**Ammo (the ordering is what needs proving):**

- Firing a bow with arrows decrements the stack by exactly 1.
- **An attack refused for cooldown does NOT consume ammo.**
- **An attack refused for insufficient stamina does NOT consume ammo.**
  These two are the point. A test asserting only "firing costs an arrow" passes on the
  buggy ordering and proves nothing.
- Firing with zero arrows is refused, consumes no cooldown, and sends `noammo`.
- Spending the last arrow deletes the stack rather than leaving `quantity = 0`.
- The consume UPDATE's SQL names `quantity > 0` in its WHERE clause — the guard against a
  future edit dropping the predicate and allowing negatives to reach the CHECK as a 500.
- A weapon with `ammo_type_id IS NULL` never touches `player_items` at all.

**AoE:**

- A target inside the radius with clear terrain takes damage; **the same target behind a
  blocked tile takes none.** The pair is the test — either alone proves nothing.
- Falloff is monotonic: a target nearer the impact point takes strictly more than one
  further away.
- The caster takes no damage from their own blast.
- A blast damages multiple targets in one detonation.
- Detonation on terrain impact still damages nearby targets.
- An AoE projectile does not survive its detonation.

**Catalog:**

- Every seeded ammo row satisfies the ammo CHECK (stackable, no kind).
- Every weapon with `ammo_type_id` set points at a row whose category is `'ammo'`.
- No row has both `aoe_radius` and `pierce > 1`.

**Loot integration:**

- Claiming an arrow when the player already owns an arrow stack increments that stack
  rather than inserting a second row.

Live browser verification must cover: firing a bow until arrows run out and seeing the HUD
count fall and the `noammo` feedback; picking arrows up off the ground and the count
rising; a flame staff blast damaging two creatures at once; and a blast failing to damage
a creature behind a wall.

## Out of scope

Elemental ammo variants (fire arrows); ammo crafting, vendors, or any acquisition beyond
loot drops; chain lightning and other multi-hop effects; damage-over-time ground effects
(3b-3c); ammo weight or carry limits; partial-stack drops and stack splitting; a quiver UI
beyond the HUD count; AoE knockback.

## Known risks to watch, not to pre-solve

- **The input/attack reordering** described above. It is the least certain decision in this
  slice. Watch for an attack visibly resolving from a stale position during the browser
  pass.
- **`archmage staff` at radius 110 with 24 damage** is the most likely balance outlier,
  since falloff makes large radii weaker at the edge but it still covers a lot of ground.
  Watch rather than pre-nerf.
- **Stack merging in `claimItem`** changes a query that 3b-2b's tests were built around,
  including the contested-grab race test. Those tests must still pass unmodified, and if
  one needs changing that is a signal worth stopping on.
