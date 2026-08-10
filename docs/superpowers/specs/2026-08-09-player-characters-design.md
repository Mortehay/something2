# Player Characters & Player-Facing Game View — Design

Date: 2026-08-09
Status: approved (brainstorming), ready for planning

## Problem

The game has no notion of a character. One account is one player: every piece
of player state — position, respawn bind, progression, inventory, equipment,
gold — hangs directly off `users.id`. A player therefore has exactly one
playthrough per account, and the only way to start over is to register again.

Separately, the player-facing surface is thin. Non-admins already see just the
Game View in the sidebar (`visibleSections(isAdmin)`,
`frontend/src/ui/navSections.js:38`), but they have no way to see the shape of
the world they are exploring, and there is no seeded account for testing the
player experience — only an optional env-driven admin
(`backend/migrations/1714440025000_users.js:43-50`).

## Goals

1. Up to **8 characters per account**, each with its own position, respawn
   bind, progression, inventory and equipment. Gold stays account-wide.
2. Character creation picks a **name and a class** (Warrior / Ranger / Mage),
   where class determines base stats and starting gear.
3. Login resumes at the character's **exact logout position**, falling back to
   the **nearest portal** when that position is no longer valid.
4. A player sees exactly two tabs: **Game View** and a read-only,
   **fog-of-war World Map** showing only worlds that character has visited.
5. A **seeded test player account**, guarded so its committed password can
   never become a live login on an environment that does not opt in.

## Non-goals

- Sprites for the three classes. Coding agents cannot generate images; the new
  entity types render as placeholder colour boxes until sprites are generated
  locally. This is expected and is not a defect.
- Class-gated abilities, class-gated gear, or any rebalance of the XP curve.
- Character rename, character transfer, or an admin character browser.
- Shared-stash / bank UI for the account-wide gold.

## Decisions

| Question | Decision |
|---|---|
| What is per-character? | Position, bind, progression, inventory, equipment. **Gold stays per-account.** |
| Login spawn | Exact saved position; nearest portal only as a fallback when invalid. |
| World map | Fog of war — visited worlds only, plus anonymous stubs for linked-but-unvisited neighbours. |
| Creation | Name + class picker. Delete frees the slot (hard delete). |
| Classes | Three, differing in base stats **and** starting loadout. |
| Test account | Migration, no-op unless `SEED_TEST_USER=1`. |
| Character select location | Inside `/game`, gating the canvas. |
| Admins | Same character flow; they additionally keep the world picker and every admin tab. |

---

## 1. Data model

### 1.1 `characters`

The 8-slot cap is a **schema invariant**, not an application `COUNT(*)`. A
counted check is racy: two concurrent creates on the last slot both read 7 and
both insert. A `slot` column with a range check plus a per-user unique
constraint makes a ninth character unrepresentable.

```js
characters:
  id          'id'                                          // serial, matching entity_types/item_types
  user_id     integer NOT NULL REFERENCES users ON DELETE CASCADE
  slot        smallint NOT NULL CHECK (slot BETWEEN 1 AND 8)
  name        citext NOT NULL UNIQUE
  entity_type_id integer NOT NULL REFERENCES entity_types
  starting_loadout_granted_at timestamptz NULL
  created_at  timestamptz NOT NULL DEFAULT now()
  UNIQUE (user_id, slot)
```

Creation takes the lowest free slot for that user. The loser of a race gets a
unique violation, which the API maps to 409.

`name` is **globally** unique, not per-account: other players see it in-world,
so two characters called "Gorm" would be ambiguous. `citext` matches how
`users.username` is already declared (`1714440025000_users.js:6`).

`starting_loadout_granted_at` moves here from `users`. The once-ever guarantee
that `1714440035000_starting_loadout_granted.js` exists to enforce is
preserved, now scoped per character — which is required anyway, since the
loadout is class-dependent.

### 1.2 Re-keying player state

All five player-state tables are uniformly `user_id integer NOT NULL REFERENCES
users ON DELETE CASCADE` today (`1714440025000_users.js:16-23` re-typed three of
them; `player_progression` and `player_binds` were created that way). Each gains
`character_id integer NOT NULL REFERENCES characters ON DELETE CASCADE` and
drops `user_id`:

| table | primary key before | primary key after |
|---|---|---|
| `world_players` | `(world_id, user_id)` | `(world_id, character_id)` |
| `player_binds` | `user_id` | `character_id` |
| `player_progression` | `user_id` | `character_id` |
| `player_equipment` | `(user_id, slot)` | `(character_id, slot)` |
| `player_items` | `id` (+ `user_id` index) | `id` (+ `character_id` index) |

Stays on `users`: `gold`.
Moves off `users`: `starting_loadout_granted_at`.

`world_players` keeps one row per (world, character), so a character retains a
remembered position in every world it has been in — unchanged semantics, new key.

### 1.3 Backfill

Non-destructive, inside the same migration. Unlike `1714440025000`, which
truncated three tables because they held anonymous test detritus, this data is
real player state and must survive.

1. Insert one character per user holding **any** row in the five tables:
   `slot = 1`, `name = users.username`, `entity_type_id = Warrior`,
   `starting_loadout_granted_at = users.starting_loadout_granted_at`.
   Name collision is impossible by construction: character names are globally
   unique `citext` and usernames are globally unique `citext`, and every
   backfilled name is a username.
2. `UPDATE` each table's `character_id` through the user → character map.
3. Only then `SET NOT NULL` and drop `user_id`.

Users with no player state get no character; they will create one on first login.

### 1.4 Down migration

Re-key each user's **lowest-slot** character back to `user_id`, drop the rows
belonging to slots 2–8, then drop `characters`. This is lossy for accounts that
have more than one character, and the migration comment must say so in those
words. A `backend/tests/migration_characters_down.test.js` guards it, following
the existing `backend/tests/migration_biomes_down.test.js` pattern.

---

## 2. Playable classes

- `entity_types.is_playable boolean NOT NULL DEFAULT false`.
- **Warrior is an exact stat clone of the existing `Player` row**
  (`1714440006000_seed_player_entity.js`). This is what keeps the epic free of a
  balance change: every backfilled character points at Warrior and is exactly as
  powerful after the migration as before it.
- Ranger and Mage are defined relative to Warrior, which stays at whatever
  `Player` currently is (call it `hp H`, `defense D`):

  | class | hp | defense | stat bump |
  |---|---|---|---|
  | Warrior | `H` | `D` | strength +1 |
  | Ranger | `H - 15%` | `D` | dexterity +1 |
  | Mage | `H - 25%` | `D - 1` (floored at 0) | intelligence +1 |

  The single binding constraint is that Warrior equals `Player` exactly; the
  other two rows may be retuned during planning.
- The `Player` row stays, `is_playable = false`. It is referenced elsewhere and
  removing it is out of scope.
- All three classes are added to `backend/seeds/data/entityTypes.js` as well as
  to the migration, so `make seed-catalogs` can rebuild them. This is the Wolf
  lesson recorded in that file's header: an entity the repo cannot rebuild is an
  entity that vanishes when the volume is rebuilt, leaving dangling references
  behind it.

### 2.1 Class loadouts

New `class_loadouts(entity_type_id, item_type_id, quantity, equip_slot NULL)`,
seeded for the three classes (Warrior: sword + shield + leather; Ranger: bow +
arrows + leather; Mage: staff + robe — subject to what the item catalog
actually contains at planning time).

`grantStartingLoadout` (`backend/src/authority/items.js`) reads this table by
the joining character's `entity_type_id` instead of a hardcoded set, and stamps
`characters.starting_loadout_granted_at`.

---

## 3. Characters API

All routes `requireAuth`; every route that names a character verifies
`characters.user_id = req.user.id` before doing anything else.

| route | behaviour |
|---|---|
| `GET /api/characters` | The account's characters: id, name, class, level, last world name, slot. |
| `GET /api/characters/classes` | The `is_playable` entity types: id, name, colour, base stats. |
| `POST /api/characters` | Body `{name, entity_type_id}`. 201 on success. 409 duplicate name. 409 no free slot. 400 if `entity_type_id` is not `is_playable`. |
| `DELETE /api/characters/:id` | Hard delete; the FK cascade removes all five tables' rows and frees the slot. 403 if not owned. |

Slot allocation and the insert happen in one statement so the unique constraint
is what arbitrates a race, rather than a read-then-write window.

---

## 4. Authority changes

The WebSocket `join` frame gains `character_id`
(`backend/src/authority/server.js:745`). The handler verifies ownership against
the token's `user_id` and closes with a policy code otherwise — a client-supplied
character id is never trusted.

The existing "kick the previous session for the same user" rule stays keyed on
**user**, so one account has at most one character in the world at a time.

Every per-user load in the join path becomes per-character: `loadSpawn`, binds,
progression, items, equipment. **Gold alone stays per-user.** Position
persistence (`server.js:490-497`, on socket close and on the 30s flush timer)
writes `character_id`.

The `joined` frame is unchanged in shape apart from carrying the character's
identity alongside `user_id`.

---

## 5. Login spawn — portal fallback

`chooseSpawn` (`backend/src/services/mapService.js:852`) gains one step:

```
1. pending doorway/portal arrival          (unchanged)
2. saved world_players position            — if still valid
3. nearest PORTAL in that world            — NEW
4. entry_spawn / bounded centre / chunk centre   (unchanged)
```

**Valid** means inside the world's current bounds *and* standing on a walkable
tile. This reuses the existing collision predicate rather than adding a third
copy — `resolveMove` already exists as two byte-for-byte copies across
`frontend/.../movement.js` and `backend/src/authority/collision.js`, and this
design does not add to that.

**Nearest portal** is the minimum Euclidean distance over
`map_links WHERE edge = 'PORTAL' AND from_world_id = $1`, spawning at
`(from_x, from_y)`. If a world has no portals, step 4 applies as today.

A character whose world was deleted entirely follows the existing world-gone
path, unchanged.

The whole step is a pure function of (saved position, world bounds, tile grid,
portal list) and is unit-testable with no database.

---

## 6. Frontend — character select gate

`GameShell` gains one branch ahead of the canvas:

```
/game (GameShell)
  no active character → <CharacterSelect>
  active character    → <canvas> + HUD   (existing path, unchanged)
```

- The active character id lives in `localStorage` under
  `something2.activeCharacterId`, and is **cleared on `signOut`** alongside the
  auth token. Without that, the next account to sign in on the same browser
  inherits a stale id and is bounced by the ownership check.
- On mount the stored id is validated against `GET /api/characters`. A character
  deleted from another device falls back to the list rather than to a failed join.
- `useCharacters`, a TanStack Query hook alongside
  `frontend/src/games/something2/useWorlds.js`, following its conventions.
- "Change character" in the HUD closes the socket and returns to the list.
- Admins hit `CharacterSelect` first and then their existing world picker. There
  is exactly one path into the world, so the path players use is the path admins
  exercise.
- The create form is name + class radios. Create is disabled with an explanatory
  line at 8/8; the server enforces the cap regardless of what the UI does.

---

## 7. Fog-of-war world map

### 7.1 Tracking

`character_visited_worlds(character_id, world_id, first_seen_at)`, primary key
`(character_id, world_id)`.

The write happens on **both** entry paths — the `join` handler and the
`transition` handler — through a single shared helper, with a test asserting
both call sites invoke it. This is a deliberate guard against the two-loader
inertness trap from the creature-behaviours epic: a feature wired into one of
two paths passes its tests and is dead in half of real play.

### 7.2 Endpoint

`GET /api/player/world-map?character_id=` (`requireAuth` + ownership) returns:

- visited worlds: `id`, `name`, `graph_x`, `graph_y`, `is_entry`, level band
- the links **among** visited worlds
- each directly-linked unvisited neighbour as `{ id, unvisited: true }` — with
  **no name**, so the graph shows an anonymous grey stub instead of spoiling
  what lies through the door
- `currentWorldId`

### 7.3 Component

A new slim `PlayerWorldMap.jsx` sharing
`frontend/src/games/something2/mapGraphLayout.js`, rather than a `readOnly` prop
threaded through the 37KB `MapGraphAdmin`. Two reasons: fog of war needs a
different data source anyway, and a read-only flag through an admin component is
one missed branch away from leaking an edit affordance.

No edgehandles, no drag-persist, no forms. Pan, zoom, click-to-inspect only.
`react-cytoscapejs` fits once at mount — a known behaviour from the map-link
graph work, not something to fight.

---

## 8. Navigation and role gating

`NAV_SECTIONS` already filters on `adminType`
(`frontend/src/ui/navSections.js:38`), so this is additive.

| entry | path | player | admin |
|---|---|:--:|:--:|
| Game View | `/game` | yes | yes |
| World Map | `/game/map` | yes | yes |
| Tile Types / Entities / Items / Maps / Biomes / Creature Behaviors | various | — | yes |
| World Map **Editor** | `/game/world-map` | — | yes |

The existing entry is relabelled "World Map Editor" so the two remain
distinguishable. `/game/map` is **not** wrapped in `RequireAdmin`.
`frontend/src/ui/__tests__/navRoutes.test.js` keeps the table and `App.jsx` in
sync.

Hiding tabs is UI tidiness, not the security boundary: the admin HTTP routes are
already behind `requireAdmin` (`backend/src/index.js:102`), and they stay that
way.

---

## 9. Test account

`backend/migrations/1714440091000_seed_test_player.js` — a **no-op unless
`SEED_TEST_USER=1`**. An environment that does not opt in cannot have this
account, so a password committed to the repository can never be a live login.

When enabled it:

- creates `testplayer` with role `player`, bcrypt at 12 rounds (matching
  `1714440025000_users.js`)
- creates **one** slot-1 Warrior for it, so login-resume is testable
  immediately, leaving 7 slots free to exercise creation and deletion
- `down` deletes the user; the FK cascade removes the character and its state

`backend/migrations/test-user-readme.md` documents the credentials, the env
flag, how to enable it in the repo-root `.env`, and states plainly that the
account cannot exist without the flag.

---

## 10. Testing

### Backend (`node --test`, from `backend/`)

- characters CRUD; concurrent double-create on the last slot yields 8 characters
  and one 409, never 9
- cross-user `DELETE` → 403; duplicate name → 409; non-playable
  `entity_type_id` → 400
- `chooseSpawn` portal fallback as a pure function: valid position,
  out-of-bounds, blocked tile, no portals in world, several portals at differing
  distances
- `character_visited_worlds` written from **both** the join path and the
  transition path
- class loadout granted once per character, and not re-granted after the
  character sells everything and reconnects
- migration down test

### Frontend (vitest)

- select-gate states: no characters, some characters, stale stored id
- Create disabled at 8/8
- nav visibility per role, both directions
- `PlayerWorldMap` renders **no** edit affordances (assert absence, not
  presence of a flag)
- an unvisited world is absent from the graph

### Anti-vacuous rules for the plan

This repository has a documented history of tests that pass without exercising
anything. Two rules are binding on this work:

1. No assertion may be derived from the same constant the code under test
   reads. Expected values are written out literally.
2. The fog-of-war test must feed a world the character genuinely has not
   visited and assert its absence — counting nodes is not sufficient.

### Browser verification

Static tests have repeatedly missed defects here that a browser caught. Required
before the epic is called done:

1. Log in as `testplayer`; create a Mage; confirm the **staff** loadout, not the
   Warrior one.
2. Walk to a distinct position, hard-refresh, confirm the exact resume position.
3. Confirm the World Map shows only visited worlds and anonymous stubs.
4. Confirm `/game/maps` redirects for a player.
5. Confirm the stack is serving fresh code before trusting any of the above —
   a stale bundle or backend has faked a clean pass here before.

---

## 11. Slices

Tracked in Plane under epic **SOMET-256**.

| | slice | ticket | depends on |
|---|---|---|---|
| A | `characters` schema + backfill + down-migration test | SOMET-257 | — |
| B | playable classes (`is_playable`, three types, `class_loadouts`, seed data) | SOMET-258 | A |
| C | characters REST API (list, classes, create, delete; slot cap; ownership) | SOMET-259 | A, B |
| D | authority: join-by-character, per-character state, per-class loadout | SOMET-260 | A, B |
| E | spawn: nearest-portal fallback | SOMET-261 | — |
| F | `CharacterSelect` UI, active-character lifecycle, HUD switch | SOMET-262 | C, D |
| G | fog-of-war tracking, player world-map endpoint, `PlayerWorldMap`, nav | SOMET-263 | D |
| H | test-player migration, `test-user-readme.md`, browser verification | SOMET-264 | F, G |

A carries the risk; everything after it is additive.

E is independent of the character work in behaviour — the fallback is a pure
function of position, bounds, tiles and portals, and it is correct for the
current one-player-per-account model too. It can land first as a standalone
improvement. Its only coupling to A is textual: both touch `chooseSpawn`'s
signature area, so whichever lands second rebases onto the other.

---

## Risks

- **The backfill is the one irreversible-feeling step.** It rewrites the primary
  key of every player-state table. Mitigation: it is non-destructive by
  construction (insert characters, repoint, then drop the old column), it has a
  down-migration test, and the dev database must not be experimented on
  destructively while it is being developed.
- **Warrior drifting from `Player`.** If Warrior is not an exact stat clone,
  every existing character is silently rebalanced by the migration. The plan
  must assert this equality in a test, not merely intend it.
- **Two-loader inertness.** Visited-world tracking and per-character state both
  have two call sites (join and transition). Each needs a test proving both
  paths are wired.
- **Placeholder sprites.** Three new playable classes will be coloured boxes
  until sprites are generated locally. Known and accepted; worth stating in the
  Plane tickets so it is not reported as a bug.
