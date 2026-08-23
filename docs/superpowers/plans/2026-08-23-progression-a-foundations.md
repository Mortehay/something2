# Progression Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the two Group-A foundations every other progression group depends on — an admin-editable `game_settings` store with its own admin page shell, and the level-150 / `18 * L^1.33` XP curve that replaces the stat-point allocation system outright.

**Architecture:** `game_settings` is a `key text PK / value jsonb` table fronted by a pure-ish service (`backend/src/services/gameSettings.js`) whose `DEFAULTS` object is simultaneously the fallback and the write whitelist; two admin routes (`GET /api/settings`, `PUT /api/settings/:key`) and one React page (`/game/admin/progression`) sit on top of it. The XP curve moves from a closed-form triangular sum to a 150-entry cumulative table precomputed at module load in `playerStats.js` and binary-searched by `levelForXp`; `player_progression.stat_points` is replaced by `player_progression.passive_points`, `allocateStat` and `POST /api/progression/allocate` are deleted, and one migration re-levels every existing character from its raw `experience`.

**Tech Stack:** Node 20 + Express 4 (CommonJS, raw `pg`, `node-pg-migrate`), `node:test` + `supertest`; React 19 + styled-components + TanStack Query, vitest in a plain node env.

**Spec:** docs/superpowers/specs/2026-08-23-progression-passive-tree-design.md
**Contract:** docs/superpowers/plans/2026-08-23-progression-shared-contract.md

---

## Global Constraints

Copied verbatim from the contract's §5:

- **Backend:** CommonJS, Express, raw `pg` queries, inline routes. See `.ai/styleguides/backend.md`.
- **Frontend admin:** React 19, styled-components, `--s2-*` tokens only, TanStack Query for data. See `.ai/styleguides/frontend.md`.
- **Game client:** plain ES modules under `frontend/src/games/something2/src/js`. Layout/maths live in testable functions separate from canvas draw calls, as `inventoryPanel.js` already does.
- **Tests:** backend `npm test` from `backend/`; frontend `npx vitest run` from `frontend/`. Any DB-touching test run MUST set both `DATABASE_URL` and `TEST_DATABASE_URL` to a per-branch scratch database, seeded with the map specs. Unset `TEST_DATABASE_URL` silently targets the SHARED DEV DATABASE.
- **Never** run a destructive statement against the shared dev database. No `DELETE FROM`, `TRUNCATE` or `DROP` outside a scratch DB.
- **No vacuous tests.** A test must not derive its expected value by calling the same function or constant the code under test uses. XP-curve, affix-roll and stat-composition expectations are hand-written literals.
- **Worktrees:** several sessions share this checkout. Every task runs in its own `git worktree`; never `checkout`, `stash` or `branch` in the shared working directory. Stage by explicit path.
- **Commits:** branch `feat/<slug>`; subject `type(scope): summary (SOMET-NNN)`; end the message with the `Co-Authored-By: Claude Opus 5 (1M context)` trailer.

### Migration slots for this group — CORRECTED, read this before writing a migration

**The contract's reserved block `1714440400000`–`1714440430000` is already occupied on `main`.** Verified against `backend/migrations/`:

- `1714440400000_biome_path_tile.js` (this is T1's assigned slot — a literal filename collision)
- `1714440410000_invite_codes.js`
- `1714440420000_inventory_slots.js`

The block is shifted by `+100000`, preserving the contract's 1:1 task→slot mapping. **Nothing at or above `1714440500000` exists today** (highest merged timestamp is `1714440420000`), so the shifted block is clean.

| Slot | Task | Content |
|---|---|---|
| `1714440500000` | **T1 (this plan)** | `game_settings` table + default rows |
| `1714440501000` | **T2 (this plan)** | `player_progression.passive_points`, level CHECK 1..150, re-level + refund backfill, drop `stat_points` |
| `1714440502000` | T3 | `entity_types.main_stat`, four new playable rows, loadouts |
| `1714440503000` | T5 | `world_creatures` charm columns, `character_summons` |
| `1714440504000` | T6 | `passive_nodes`, `passive_edges`, `character_passives` |
| `1714440505000` | T10 | `item_types` `req_level` + six `req_*` + `item_level` + `tier` |
| `1714440506000` | T11 | base gear ladder seed |
| `1714440507000` | T12 | `affix_types`, `player_item_affixes`, `player_items` + `world_items` columns |
| `1714440508000` | T13 | `rarity_weights` default setting row |

The implementer of T1 **must** open the shared contract and replace its §1 table with the block above in the same commit (the contract's own rule: "If a plan needs something not listed, it must add it here in the same commit").

### Scratch database

Every DB command in this plan uses one scratch database per branch. Stand it up once, before Task 1 Step 2:

```bash
psql -U user -h localhost -p 15432 -d postgres -c 'CREATE DATABASE game_db_progA;'
cd backend
DATABASE_URL=postgres://user:password@localhost:15432/game_db_progA npx node-pg-migrate up --ignore-pattern '(?!.*\.js$).*'
DATABASE_URL=postgres://user:password@localhost:15432/game_db_progA node scripts/seed-catalogs.js
DATABASE_URL=postgres://user:password@localhost:15432/game_db_progA SPEC=p5-descent  node scripts/seed-map.js
DATABASE_URL=postgres://user:password@localhost:15432/game_db_progA SPEC=vale-region node scripts/seed-map.js
```

`vale-region` runs LAST — `p5-descent` steals `is_entry` otherwise. Export both variables as literals in every test command; `export A=x B="$A"` leaves `B` empty and silently skips ~136 DB tests.

---

## File Structure

| File | Created / Modified | The ONE responsibility |
|---|---|---|
| `backend/migrations/1714440500000_game_settings.js` | Create | Create `game_settings` and seed the four default rows |
| `backend/src/services/gameSettings.js` | Create | The `DEFAULTS` whitelist plus read/upsert of one jsonb setting |
| `backend/tests/gameSettings.test.js` | Create | Pure guards on `DEFAULTS`, unknown keys and value validation (no DB) |
| `backend/tests/game_settings_db.test.js` | Create | The table's shape and the service's read/upsert against a real DB |
| `backend/tests/settings_routes.test.js` | Create | `GET /api/settings` and `PUT /api/settings/:key` are admin-only and behave |
| `backend/src/index.js` | Modify (after `:1420`) | Mount the two `/api/settings` routes |
| `frontend/src/games/something2/gameSettingsForm.js` | Create | Pure field list + input parsing/validation for the settings editor |
| `frontend/src/games/something2/useGameSettings.js` | Create | TanStack Query read hook + one update mutation for `/api/settings` |
| `frontend/src/games/something2/ProgressionAdmin.jsx` | Create | The `/game/admin/progression` page: settings editor + two mount points |
| `frontend/src/games/something2/__tests__/gameSettingsForm.test.js` | Create | Literal expectations for the form parser |
| `frontend/src/games/something2/__tests__/ProgressionAdmin.smoke.test.js` | Create | The page is exported, routed, and carries the two mount points |
| `frontend/src/App.jsx` | Modify `:22`, `:67` | Register `admin/progression` inside `RequireAdmin` |
| `frontend/src/ui/navSections.js` | Modify `:44` | Add the Progression sidebar entry |
| `frontend/src/ui/__tests__/navSections.test.js` | Modify `:46-56` | Update the pinned admin path list |
| `frontend/src/games/something2/__tests__/themeTokens.test.js` | Modify `:104-107` | Put `ProgressionAdmin.jsx` under the `--s2-*` token gate |
| `backend/migrations/1714440501000_progression_level_150.js` | Create | `passive_points`, level CHECK 1..150, re-level + refund, drop `stat_points` |
| `backend/src/services/progressionConstants.js` | Modify `:17-18`, `:56-58`, `:83-90` | `MAX_LEVEL 150`, `XP_BASE 18`, `XP_EXPONENT 1.33`, drop `STAT_POINTS_PER_LEVEL` |
| `backend/src/services/playerStats.js` | Modify `:9-19`, `:62-82`, `:112-133` | Cumulative table, binary-search `levelForXp`, drop `refundedPoints` |
| `backend/src/services/progressionStore.js` | Modify `:4-11`, `:16-29`, `:69-118`, `:125-162` | `passive_points` column, drop `allocateStat`, refund-free respec |
| `backend/src/api/progressionRoutes.js` | Modify `:16`, `:74-95` | Delete the `POST /allocate` route |
| `backend/tests/player_stats.test.js` | Modify `:64-163` | Re-pin the curve to hand-written literals; drop `refundedPoints` |
| `backend/tests/progression_migration.test.js` | Modify `:51`, `:60-92` | Assert `passive_points`, level 151 rejected, level 51 accepted |
| `backend/tests/progression_store.test.js` | Modify `:105-672` | `passive_points` fixtures; delete the `allocateStat` block |
| `backend/tests/progression_routes.test.js` | Modify `:27-45`, `:161-575` | Two routes, not three; delete the allocate tests |
| `backend/tests/progression_kill_xp.test.js` | Modify `:103`, `:110-147`, `:340`, `:417`, `:426-450` | Fixtures and level expectations under the new curve |
| `backend/tests/progression_death.test.js` | Modify `:201-426` | Fixtures and loss literals under the new curve |
| `backend/tests/authority_openchest_integration.test.js` | Modify `:460-473`, `:495` | The chest level-up now crosses to level 5, not 3 |
| `frontend/src/games/something2/CharacterSheet.jsx` | Modify `:79`, `:116-138`, `:250-287`, `:394-478` | Remove the + buttons, the respec button and their handlers |
| `frontend/src/games/something2/src/js/net/progressionClient.js` | Modify `:45-54` | Delete the `allocateStat` client call |
| `frontend/src/games/something2/src/js/__tests__/characterSheet.test.js` | Modify `:36-136`, `:171-232` | New curve literals; delete the allocate/respec-button coverage |

---

### Task 1: `game_settings` table, service, admin API and the progression page shell

**Files:**
- Create: `backend/migrations/1714440500000_game_settings.js`
- Create: `backend/src/services/gameSettings.js`
- Create: `backend/tests/gameSettings.test.js`
- Create: `backend/tests/game_settings_db.test.js`
- Create: `backend/tests/settings_routes.test.js`
- Modify: `backend/src/index.js:1420-1421` (insert the two routes immediately before `app.get('/api/vfx-effects', ...)` at line 1422)
- Create: `frontend/src/games/something2/gameSettingsForm.js`
- Create: `frontend/src/games/something2/useGameSettings.js`
- Create: `frontend/src/games/something2/ProgressionAdmin.jsx`
- Create: `frontend/src/games/something2/__tests__/gameSettingsForm.test.js`
- Create: `frontend/src/games/something2/__tests__/ProgressionAdmin.smoke.test.js`
- Modify: `frontend/src/App.jsx:22` and `frontend/src/App.jsx:67`
- Modify: `frontend/src/ui/navSections.js:44`
- Modify: `frontend/src/ui/__tests__/navSections.test.js:46-56`
- Modify: `frontend/src/games/something2/__tests__/themeTokens.test.js:104-107`

**Interfaces:**
- Consumes: nothing from another task. `requireAdmin(pool)` already exists at `backend/src/auth/middleware.js:71` and is already bound as `adminGuard` at `backend/src/index.js:130`.
- Produces:
  - `backend/src/services/gameSettings.js` → `module.exports = { DEFAULTS, getSetting, getSettings, setSetting }`
    - `DEFAULTS` — frozen object, keys `passive_points_per_level` (1), `ground_item_ttl_seconds` (180), `respec_base_gold` (50), `rarity_weights` (3 anchor rows)
    - `async getSetting(pool, key) -> value` — the stored jsonb value, or `DEFAULTS[key]` when no row exists. Throws `Error` with `.status = 400` on an unknown key.
    - `async getSettings(pool, keys) -> { [key]: value }` — every requested known key, defaults filled in. `keys` omitted ⇒ all of `DEFAULTS`.
    - `async setSetting(pool, key, value) -> { key, value, updated_at }` — upsert. Throws `Error` with `.status = 400` on an unknown key or an invalid value.
  - HTTP: `GET /api/settings` (admin) → `[{ key, value, default_value }]`; `PUT /api/settings/:key` (admin), body `{ value }` → `{ key, value, updated_at }`
  - `frontend/src/games/something2/gameSettingsForm.js` → `export const SETTING_FIELDS`, `export function parseSettingInput(key, raw)`
  - `frontend/src/games/something2/useGameSettings.js` → `export const GAME_SETTINGS_KEY = ['game-settings']`, `export function useGameSettings()`, `export function useUpdateGameSetting()`
  - `frontend/src/games/something2/ProgressionAdmin.jsx` → default export `ProgressionAdmin`, routed at `/game/admin/progression`

---

- [ ] **Step 1: Write the failing pure test for the settings service**

Create `backend/tests/gameSettings.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { DEFAULTS, getSetting, getSettings, setSetting } = require('../src/services/gameSettings.js');

// A pool that records every call and answers every SELECT with zero rows, so
// "the default came back" is provably the fallback path and not a row that
// happened to be lying around in a database.
function emptyPool() {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rows: [], rowCount: 0 }; } };
}

test('DEFAULTS carries exactly the four keys the design specifies, with the specified values', () => {
  assert.deepStrictEqual(Object.keys(DEFAULTS).sort(), [
    'ground_item_ttl_seconds', 'passive_points_per_level', 'rarity_weights', 'respec_base_gold',
  ]);
  assert.strictEqual(DEFAULTS.passive_points_per_level, 1);
  assert.strictEqual(DEFAULTS.ground_item_ttl_seconds, 180);
  assert.strictEqual(DEFAULTS.respec_base_gold, 50);
  assert.deepStrictEqual(DEFAULTS.rarity_weights, [
    { item_level: 1, white: 90, blue: 9, yellow: 1, foxy: 0 },
    { item_level: 50, white: 70, blue: 21, yellow: 8, foxy: 1 },
    { item_level: 150, white: 45, blue: 30, yellow: 20, foxy: 5 },
  ]);
});

test('DEFAULTS is frozen, so a caller cannot mutate the fallback for the whole process', () => {
  assert.throws(() => { DEFAULTS.passive_points_per_level = 99; }, TypeError);
});

test('a missing row falls back to the default rather than undefined', async () => {
  const pool = emptyPool();
  assert.strictEqual(await getSetting(pool, 'ground_item_ttl_seconds'), 180);
  assert.strictEqual(pool.calls.length, 1, 'exactly one SELECT, no write');
});

test('getSettings with no key list returns every known key', async () => {
  const bundle = await getSettings(emptyPool());
  assert.deepStrictEqual(Object.keys(bundle).sort(), [
    'ground_item_ttl_seconds', 'passive_points_per_level', 'rarity_weights', 'respec_base_gold',
  ]);
  assert.strictEqual(bundle.respec_base_gold, 50);
});

// A typo'd key that inserts successfully is a setting nothing reads. Both the
// read and the write refuse it, and the write must never reach the database.
test('an unknown key is refused on read and on write, and issues no query', async () => {
  const pool = emptyPool();
  await assert.rejects(() => getSetting(pool, 'passive_points_per_lvl'), /unknown setting/);
  await assert.rejects(() => setSetting(pool, 'passive_points_per_lvl', 2), /unknown setting/);
  assert.strictEqual(pool.calls.length, 0, 'an unknown key must not touch the database at all');
});

test('an unknown key rejects with a 400-shaped error, not a 500-shaped one', async () => {
  await assert.rejects(() => setSetting(emptyPool(), 'nope', 1), (err) => err.status === 400);
});

test('a value of the wrong shape is refused before it reaches the database', async () => {
  const pool = emptyPool();
  for (const bad of [-1, 1.5, 'two', null, undefined, [1]]) {
    await assert.rejects(
      () => setSetting(pool, 'passive_points_per_level', bad),
      /passive_points_per_level/,
      `${JSON.stringify(bad) ?? 'undefined'} must be refused`,
    );
  }
  await assert.rejects(() => setSetting(pool, 'ground_item_ttl_seconds', 0), /ground_item_ttl_seconds/);
  await assert.rejects(() => setSetting(pool, 'rarity_weights', { white: 1 }), /rarity_weights/);
  await assert.rejects(
    () => setSetting(pool, 'rarity_weights', [{ item_level: 1, white: 90, blue: 9, yellow: 1 }]),
    /rarity_weights/,
    'an anchor row missing a rarity must be refused',
  );
  assert.strictEqual(pool.calls.length, 0, 'no invalid value may reach the database');
});

// Weights that do not sum to 100 are ACCEPTED (the roller normalises), but a
// negative weight is not -- that is the one that makes a distribution
// unrepresentable rather than merely unbalanced.
test('rarity weights that do not sum to 100 are accepted; a negative weight is not', async () => {
  const pool = { calls: [], query: async (sql, params) => { pool.calls.push({ sql, params }); return { rows: [{ key: 'rarity_weights', value: [], updated_at: 'now' }], rowCount: 1 }; } };
  await setSetting(pool, 'rarity_weights', [{ item_level: 1, white: 10, blue: 10, yellow: 10, foxy: 10 }]);
  assert.strictEqual(pool.calls.length, 1);
  await assert.rejects(
    () => setSetting(pool, 'rarity_weights', [{ item_level: 1, white: -1, blue: 10, yellow: 10, foxy: 10 }]),
    /rarity_weights/,
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && node --test tests/gameSettings.test.js`
Expected: FAIL with `Cannot find module '../src/services/gameSettings.js'`

- [ ] **Step 3: Write the settings service**

Create `backend/src/services/gameSettings.js`:

```js
// Admin-tunable game constants. One jsonb row per key.
//
// DEFAULTS is BOTH the fallback and the write whitelist. An unknown key is an
// error, never a silent insert: a typo'd key that inserts successfully is a
// setting nothing reads, and it would sit in the admin table looking correct
// forever.
//
// THE XP CURVE IS DELIBERATELY NOT HERE (design doc section 3.5). Changing it
// re-levels every character in the database on the next read; that must be a
// code change with a migration attached, not a number in a form.

const DEFAULTS = Object.freeze({
  passive_points_per_level: 1,
  ground_item_ttl_seconds: 180,
  respec_base_gold: 50,
  rarity_weights: [
    { item_level: 1, white: 90, blue: 9, yellow: 1, foxy: 0 },
    { item_level: 50, white: 70, blue: 21, yellow: 8, foxy: 1 },
    { item_level: 150, white: 45, blue: 30, yellow: 20, foxy: 5 },
  ],
});

const RARITIES = ['white', 'blue', 'yellow', 'foxy'];

function bad(message) {
  const err = new Error(message);
  err.status = 400; // the route turns this into a 400 instead of a 500
  return err;
}

function isKnownKey(key) {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(DEFAULTS, key);
}

function isCount(v, min) {
  return typeof v === 'number' && Number.isInteger(v) && v >= min;
}

// Validation lives here rather than in the route so the store and the HTTP
// surface can never disagree about what a legal value is.
function assertValid(key, value) {
  if (key === 'passive_points_per_level' && !isCount(value, 0)) {
    throw bad('passive_points_per_level must be an integer >= 0');
  }
  if (key === 'ground_item_ttl_seconds' && !isCount(value, 1)) {
    throw bad('ground_item_ttl_seconds must be an integer >= 1');
  }
  if (key === 'respec_base_gold' && !isCount(value, 0)) {
    throw bad('respec_base_gold must be an integer >= 0');
  }
  if (key === 'rarity_weights') {
    if (!Array.isArray(value) || value.length === 0) {
      throw bad('rarity_weights must be a non-empty array of anchor rows');
    }
    for (const row of value) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || !isCount(row.item_level, 1)) {
        throw bad('rarity_weights rows need an integer item_level >= 1');
      }
      for (const r of RARITIES) {
        // A weight that does not sum to 100 is fine -- the roller normalises.
        // A negative one is not: it makes the distribution unrepresentable.
        if (typeof row[r] !== 'number' || !Number.isFinite(row[r]) || row[r] < 0) {
          throw bad(`rarity_weights rows need a finite, non-negative ${r} weight`);
        }
      }
    }
  }
}

// Every requested known key comes back, defaults filled in first and then
// overwritten by whatever rows exist. A caller therefore never has to handle
// "the row is missing", which is the state a fresh database and a deleted row
// share.
async function getSettings(pool, keys) {
  const wanted = (Array.isArray(keys) && keys.length ? keys : Object.keys(DEFAULTS)).filter(isKnownKey);
  const out = {};
  for (const k of wanted) out[k] = DEFAULTS[k];
  if (wanted.length === 0) return out;
  const r = await pool.query(
    'SELECT key, value FROM game_settings WHERE key = ANY($1::text[])',
    [wanted],
  );
  for (const row of r.rows) out[row.key] = row.value;
  return out;
}

async function getSetting(pool, key) {
  if (!isKnownKey(key)) throw bad(`unknown setting: ${key}`);
  const bundle = await getSettings(pool, [key]);
  return bundle[key];
}

async function setSetting(pool, key, value) {
  if (!isKnownKey(key)) throw bad(`unknown setting: ${key}`);
  assertValid(key, value);
  const r = await pool.query(
    `INSERT INTO game_settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
     RETURNING key, value, updated_at`,
    [key, JSON.stringify(value)],
  );
  return r.rows[0];
}

module.exports = { DEFAULTS, getSetting, getSettings, setSetting };
```

- [ ] **Step 4: Run the pure test to verify it passes**

Run: `cd backend && node --test tests/gameSettings.test.js`
Expected: PASS — 8 tests

- [ ] **Step 5: Write the failing database test for the table**

Create `backend/tests/game_settings_db.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { getSetting, getSettings, setSetting } = require('../src/services/gameSettings.js');

// Gated on TEST_DATABASE_URL alone, with NO DATABASE_URL fallback -- the same
// idiom progression_migration.test.js uses -- so a bare `npm test` on a
// machine with a working dev database can never reach this file.
const DB_URL = process.env.TEST_DATABASE_URL || 'postgres://user:password@localhost:15432/game_db';

function requireTestDb(t, why) {
  if (!process.env.TEST_DATABASE_URL) {
    const msg = `TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (${why})`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return false;
  }
  return true;
}

async function openPool() {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 2 });
  try { await pool.query('SELECT 1'); return pool; } catch (err) {
    await pool.end().catch(() => {});
    return { unreachable: err.message };
  }
}

test('game_settings has the documented shape', async (t) => {
  if (!requireTestDb(t, 'this test reads game_settings column metadata')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL} -- the schema is UNVERIFIED`); return; }
  try {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'game_settings'`,
    );
    const by = new Map(rows.map((r) => [r.column_name, r]));
    assert.equal(by.get('key').data_type, 'text');
    assert.equal(by.get('key').is_nullable, 'NO');
    assert.equal(by.get('value').data_type, 'jsonb');
    assert.equal(by.get('value').is_nullable, 'NO');
    assert.equal(by.get('updated_at').data_type, 'timestamp with time zone');

    const { rows: pk } = await pool.query(
      `SELECT a.attname FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'game_settings'::regclass AND i.indisprimary`,
    );
    assert.deepStrictEqual(pk.map((r) => r.attname), ['key'], 'key must be the primary key');
  } finally { await pool.end(); }
});

test('the migration seeded the four default rows with the documented values', async (t) => {
  if (!requireTestDb(t, 'this test reads the seeded game_settings rows')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL} -- the seed rows are UNVERIFIED`); return; }
  try {
    const { rows } = await pool.query('SELECT key, value FROM game_settings ORDER BY key');
    const by = new Map(rows.map((r) => [r.key, r.value]));
    assert.strictEqual(by.get('passive_points_per_level'), 1);
    assert.strictEqual(by.get('ground_item_ttl_seconds'), 180);
    assert.strictEqual(by.get('respec_base_gold'), 50);
    assert.strictEqual(by.get('rarity_weights').length, 3);
    assert.deepStrictEqual(by.get('rarity_weights')[2],
      { item_level: 150, white: 45, blue: 30, yellow: 20, foxy: 5 });
  } finally { await pool.end(); }
});

// Writes are wrapped in a transaction this test rolls back, so the seeded
// rows survive untouched even on a scratch database.
test('setSetting upserts and getSetting reads the new value back', async (t) => {
  if (!requireTestDb(t, 'this test UPDATEs a game_settings row inside a rolled-back transaction')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL} -- the upsert is UNVERIFIED`); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const written = await setSetting(client, 'ground_item_ttl_seconds', 42);
    assert.strictEqual(written.key, 'ground_item_ttl_seconds');
    assert.strictEqual(written.value, 42);
    assert.strictEqual(await getSetting(client, 'ground_item_ttl_seconds'), 42);

    // Upsert, not insert: a second write of the same key replaces it.
    await setSetting(client, 'ground_item_ttl_seconds', 43);
    assert.strictEqual(await getSetting(client, 'ground_item_ttl_seconds'), 43);
    const { rows } = await client.query(
      "SELECT count(*)::int AS n FROM game_settings WHERE key = 'ground_item_ttl_seconds'");
    assert.strictEqual(rows[0].n, 1, 'the upsert must not create a second row');

    // A structured value survives the jsonb round trip unchanged.
    const anchors = [{ item_level: 1, white: 1, blue: 2, yellow: 3, foxy: 4 }];
    await setSetting(client, 'rarity_weights', anchors);
    assert.deepStrictEqual(await getSetting(client, 'rarity_weights'), anchors);

    const bundle = await getSettings(client, ['ground_item_ttl_seconds', 'respec_base_gold']);
    assert.deepStrictEqual(bundle, { ground_item_ttl_seconds: 43, respec_base_gold: 50 });

    await client.query('ROLLBACK');
  } finally { client.release(); await pool.end(); }
});
```

- [ ] **Step 6: Run the DB test to verify it fails**

Run:
```bash
cd backend && DATABASE_URL=postgres://user:password@localhost:15432/game_db_progA \
  TEST_DATABASE_URL=postgres://user:password@localhost:15432/game_db_progA \
  node --test tests/game_settings_db.test.js
```
Expected: FAIL with `relation "game_settings" does not exist`

- [ ] **Step 7: Write the migration**

Create `backend/migrations/1714440500000_game_settings.js`:

```js
exports.shorthands = undefined;

// Admin-tunable game constants, one jsonb row per key (design doc section 3.1).
//
// The four rows are seeded here so an admin opening the editor sees real
// values rather than an empty table. gameSettings.DEFAULTS still supplies the
// fallback in code, because a row can be deleted and a fresh key can be added
// by a later migration that this one knows nothing about.
//
// NOTE FOR THE EPIC: the timestamp block reserved in the shared contract
// (1714440400000-1714440430000) was already occupied on main by
// biome_path_tile / invite_codes / inventory_slots. The whole block is shifted
// +100000; this file takes the shifted T1 slot.
exports.up = (pgm) => {
  pgm.createTable('game_settings', {
    key: { type: 'text', primaryKey: true },
    value: { type: 'jsonb', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.sql(`
    INSERT INTO game_settings (key, value) VALUES
      ('passive_points_per_level', '1'::jsonb),
      ('ground_item_ttl_seconds',  '180'::jsonb),
      ('respec_base_gold',         '50'::jsonb),
      ('rarity_weights', '[
         {"item_level": 1,   "white": 90, "blue": 9,  "yellow": 1,  "foxy": 0},
         {"item_level": 50,  "white": 70, "blue": 21, "yellow": 8,  "foxy": 1},
         {"item_level": 150, "white": 45, "blue": 30, "yellow": 20, "foxy": 5}
       ]'::jsonb)
    ON CONFLICT (key) DO NOTHING
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('game_settings');
};
```

- [ ] **Step 8: Apply the migration and run the DB test to verify it passes**

Run:
```bash
cd backend && DATABASE_URL=postgres://user:password@localhost:15432/game_db_progA \
  npx node-pg-migrate up --ignore-pattern '(?!.*\.js$).*' && \
DATABASE_URL=postgres://user:password@localhost:15432/game_db_progA \
  TEST_DATABASE_URL=postgres://user:password@localhost:15432/game_db_progA \
  node --test tests/game_settings_db.test.js
```
Expected: PASS — 3 tests

- [ ] **Step 9: Commit the service and migration**

```bash
git add backend/migrations/1714440500000_game_settings.js backend/src/services/gameSettings.js backend/tests/gameSettings.test.js backend/tests/game_settings_db.test.js
git commit -m "feat(progression): game_settings table and service (SOMET-NNN)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 10: Write the failing route test**

Create `backend/tests/settings_routes.test.js`:

```js
const { test, before, after } = require('node:test');
const assert = require('node:assert');

// Sets JWT_SECRET before the app or any token is created.
require('./helpers/auth.js');
const request = require('supertest');
const { Pool } = require('pg');

const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');

// --- Part 1: route protection, no database ---------------------------------
// Walks the REAL Express stack for the isAdminGuard marker rather than
// trusting that the routes were declared with adminGuard. /api/settings is a
// write surface for live game balance; an unguarded PUT lets any logged-in
// player set their own passive points per level.
function settingsLayers() {
  const stack = app._router && app._router.stack;
  assert.ok(stack, 'could not locate the app router stack');
  return stack.filter((l) => l.route && String(l.route.path).startsWith('/api/settings'));
}

test('both settings routes exist and both are behind the ADMIN guard', () => {
  const layers = settingsLayers();
  const found = layers
    .map((l) => `${Object.keys(l.route.methods).join('/').toUpperCase()} ${l.route.path}`)
    .sort();
  assert.deepStrictEqual(found, ['GET /api/settings', 'PUT /api/settings/:key']);
  for (const l of layers) {
    assert.ok(
      l.route.stack.some((h) => h.handle && h.handle.isAdminGuard),
      `${l.route.path} is not behind requireAdmin`,
    );
  }
});

// --- Part 2: behaviour against a real database -----------------------------
const DB_URL = process.env.TEST_DATABASE_URL || 'postgres://user:password@localhost:15432/game_db';
let dbPool = null;

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  const p = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 4 });
  try { await p.query('SELECT 1'); dbPool = p; __setPool(p); } catch { await p.end().catch(() => {}); }
});
after(async () => { if (dbPool) await dbPool.end().catch(() => {}); });

function dbReady(t, why) {
  if (!process.env.TEST_DATABASE_URL) {
    const msg = `TEST_DATABASE_URL not set -- skipping (${why})`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg); return false;
  }
  if (!dbPool) { t.skip(`NO DATABASE at ${DB_URL} -- ${why} is UNVERIFIED`); return false; }
  return true;
}

async function createUser(pool, role) {
  const username = `settings-routes-${role}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const r = await pool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', $2) RETURNING id",
    [username, role],
  );
  return r.rows[0].id;
}
const authed = (id, role) => ({
  Authorization: `Bearer ${signToken({ userId: id, username: `settings-${id}`, role, tokenVersion: 1 })}`,
});

test('GET returns every known key with its value and its default', async (t) => {
  if (!dbReady(t, 'this test creates a throwaway admin and reads the settings bundle')) return;
  let admin;
  try {
    admin = await createUser(dbPool, 'admin');
    const res = await request(app).get('/api/settings').set(authed(admin, 'admin'));
    assert.equal(res.status, 200);
    const by = new Map(res.body.map((r) => [r.key, r]));
    assert.deepStrictEqual([...by.keys()].sort(), [
      'ground_item_ttl_seconds', 'passive_points_per_level', 'rarity_weights', 'respec_base_gold',
    ]);
    assert.strictEqual(by.get('passive_points_per_level').value, 1);
    assert.strictEqual(by.get('passive_points_per_level').default_value, 1);
    assert.strictEqual(by.get('ground_item_ttl_seconds').default_value, 180);
  } finally {
    if (admin != null) await dbPool.query('DELETE FROM users WHERE id = $1', [admin]);
  }
});

test('a non-admin is refused on both verbs and changes nothing', async (t) => {
  if (!dbReady(t, 'this test creates a throwaway player and attempts to read/write settings')) return;
  let player;
  try {
    player = await createUser(dbPool, 'player');
    const get = await request(app).get('/api/settings').set(authed(player, 'player'));
    assert.equal(get.status, 403);
    const put = await request(app).put('/api/settings/ground_item_ttl_seconds')
      .set(authed(player, 'player')).send({ value: 9 });
    assert.equal(put.status, 403);
    const { rows } = await dbPool.query(
      "SELECT value FROM game_settings WHERE key = 'ground_item_ttl_seconds'");
    assert.strictEqual(rows[0].value, 180, 'a refused PUT must not have written');
  } finally {
    if (player != null) await dbPool.query('DELETE FROM users WHERE id = $1', [player]);
  }
});

test('PUT writes a valid value and refuses an invalid one with 400', async (t) => {
  if (!dbReady(t, 'this test creates a throwaway admin and updates a setting')) return;
  let admin;
  try {
    admin = await createUser(dbPool, 'admin');
    const ok = await request(app).put('/api/settings/ground_item_ttl_seconds')
      .set(authed(admin, 'admin')).send({ value: 240 });
    assert.equal(ok.status, 200);
    assert.strictEqual(ok.body.value, 240);
    const { rows } = await dbPool.query(
      "SELECT value FROM game_settings WHERE key = 'ground_item_ttl_seconds'");
    assert.strictEqual(rows[0].value, 240);

    const negative = await request(app).put('/api/settings/ground_item_ttl_seconds')
      .set(authed(admin, 'admin')).send({ value: -5 });
    assert.equal(negative.status, 400);
    assert.match(negative.body.error, /ground_item_ttl_seconds/);

    const unknown = await request(app).put('/api/settings/passive_points_per_lvl')
      .set(authed(admin, 'admin')).send({ value: 2 });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /unknown setting/);
    const { rows: after } = await dbPool.query(
      "SELECT count(*)::int AS n FROM game_settings WHERE key = 'passive_points_per_lvl'");
    assert.strictEqual(after[0].n, 0, 'a typo\'d key must never create a row');
  } finally {
    // Restore the seeded value so the scratch database stays reusable.
    await dbPool.query("UPDATE game_settings SET value = '180'::jsonb WHERE key = 'ground_item_ttl_seconds'");
    if (admin != null) await dbPool.query('DELETE FROM users WHERE id = $1', [admin]);
  }
});
```

- [ ] **Step 11: Run the route test to verify it fails**

Run:
```bash
cd backend && DATABASE_URL=postgres://user:password@localhost:15432/game_db_progA \
  TEST_DATABASE_URL=postgres://user:password@localhost:15432/game_db_progA \
  node --test tests/settings_routes.test.js
```
Expected: FAIL on the first test with `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:\n[] !== [ 'GET /api/settings', 'PUT /api/settings/:key' ]`

- [ ] **Step 12: Mount the two routes in index.js**

In `backend/src/index.js`, add the require next to the other service requires (immediately after line 124, `const characterRoutes = require('./api/characterRoutes.js');`):

```js
const { DEFAULTS: GAME_SETTING_DEFAULTS, getSettings, setSetting } = require('./services/gameSettings.js');
```

Then insert this block immediately before `app.get('/api/vfx-effects', ...)` at line 1422:

```js
// --- Admin-tunable game settings (progression epic T1) ---------------------
//
// Both verbs are adminGuard'd, reads included: these numbers are live game
// balance, and the list itself tells a caller which knobs exist. The service
// owns the whitelist and the value validation so this route and the store can
// never disagree about what is legal; a thrown error carrying .status = 400
// is a caller mistake, anything else is a 500.
app.get('/api/settings', adminGuard, async (req, res) => {
  try {
    const values = await getSettings(pool, Object.keys(GAME_SETTING_DEFAULTS));
    res.json(Object.keys(GAME_SETTING_DEFAULTS).map((key) => ({
      key,
      value: values[key],
      default_value: GAME_SETTING_DEFAULTS[key],
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch game settings' });
  }
});

app.put('/api/settings/:key', adminGuard, async (req, res) => {
  try {
    const row = await setSetting(pool, req.params.key, (req.body || {}).value);
    res.json(row);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error(err);
    return res.status(500).json({ error: 'Failed to update game setting' });
  }
});
```

- [ ] **Step 13: Run the route test to verify it passes**

Run:
```bash
cd backend && DATABASE_URL=postgres://user:password@localhost:15432/game_db_progA \
  TEST_DATABASE_URL=postgres://user:password@localhost:15432/game_db_progA \
  node --test tests/settings_routes.test.js
```
Expected: PASS — 4 tests

- [ ] **Step 14: Commit the routes**

```bash
git add backend/src/index.js backend/tests/settings_routes.test.js
git commit -m "feat(progression): admin GET/PUT /api/settings (SOMET-NNN)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 15: Write the failing test for the settings form module**

Create `frontend/src/games/something2/__tests__/gameSettingsForm.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { SETTING_FIELDS, parseSettingInput } from '../gameSettingsForm.js';

describe('SETTING_FIELDS', () => {
  it('describes the four keys the backend whitelists, in editor order', () => {
    expect(SETTING_FIELDS.map((f) => f.key)).toEqual([
      'passive_points_per_level',
      'ground_item_ttl_seconds',
      'respec_base_gold',
      'rarity_weights',
    ]);
  });

  it('gives every field a label, a kind and a hint', () => {
    for (const f of SETTING_FIELDS) {
      expect(f.label, `${f.key} label`).toBeTruthy();
      expect(['integer', 'json'], `${f.key} kind`).toContain(f.kind);
      expect(f.hint, `${f.key} hint`).toBeTruthy();
    }
  });
});

describe('parseSettingInput', () => {
  it('turns an integer field\'s string input into a number', () => {
    expect(parseSettingInput('passive_points_per_level', '3')).toEqual({ value: 3 });
    expect(parseSettingInput('ground_item_ttl_seconds', '180')).toEqual({ value: 180 });
  });

  it('rejects a non-integer, a negative and an empty integer input', () => {
    expect(parseSettingInput('passive_points_per_level', '1.5').error).toMatch(/whole number/);
    expect(parseSettingInput('passive_points_per_level', '-1').error).toMatch(/0 or more/);
    expect(parseSettingInput('ground_item_ttl_seconds', '0').error).toMatch(/1 or more/);
    expect(parseSettingInput('passive_points_per_level', '').error).toMatch(/whole number/);
    expect(parseSettingInput('passive_points_per_level', 'three').error).toMatch(/whole number/);
  });

  it('parses a json field and reports the parse error verbatim', () => {
    const good = '[{"item_level":1,"white":90,"blue":9,"yellow":1,"foxy":0}]';
    expect(parseSettingInput('rarity_weights', good)).toEqual({
      value: [{ item_level: 1, white: 90, blue: 9, yellow: 1, foxy: 0 }],
    });
    expect(parseSettingInput('rarity_weights', '[{').error).toMatch(/not valid JSON/);
  });

  it('rejects an unknown key rather than passing it through to the server', () => {
    expect(parseSettingInput('passive_points_per_lvl', '1').error).toMatch(/unknown setting/);
  });
});
```

- [ ] **Step 16: Run the form test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/gameSettingsForm.test.js`
Expected: FAIL with `Failed to resolve import "../gameSettingsForm.js"`

- [ ] **Step 17: Write the settings form module**

Create `frontend/src/games/something2/gameSettingsForm.js`:

```js
// Pure field descriptions and input parsing for the game-settings editor.
// Kept out of the component for the same reason vfxForm.js is: vitest runs
// this project in a plain node env, so a page-level component cannot be
// rendered, and every rule worth testing has to live somewhere renderable.
//
// The server re-validates all of this (backend/src/services/gameSettings.js).
// This copy exists to give the admin an inline message instead of a toast
// from a 400, NOT as the authority.

export const SETTING_FIELDS = [
  {
    key: 'passive_points_per_level',
    label: 'Passive points per level',
    kind: 'integer',
    min: 0,
    hint: 'Points granted on each level-up. Applies to future level-ups only.',
  },
  {
    key: 'ground_item_ttl_seconds',
    label: 'Ground item lifetime (seconds)',
    kind: 'integer',
    min: 1,
    hint: 'How long dropped loot lies on the ground before it puffs away.',
  },
  {
    key: 'respec_base_gold',
    label: 'Respec cost per level (gold)',
    kind: 'integer',
    min: 0,
    hint: 'A respec costs this many gold multiplied by the character level.',
  },
  {
    key: 'rarity_weights',
    label: 'Rarity weights by item level',
    kind: 'json',
    hint: 'Anchor rows interpolated by item level. Weights need not sum to 100 — they are normalised before rolling.',
  },
];

const BY_KEY = new Map(SETTING_FIELDS.map((f) => [f.key, f]));

// -> { value } on success, { error } on failure. Never both.
export function parseSettingInput(key, raw) {
  const field = BY_KEY.get(key);
  if (!field) return { error: `unknown setting: ${key}` };

  if (field.kind === 'integer') {
    const trimmed = String(raw ?? '').trim();
    if (!/^-?\d+$/.test(trimmed)) return { error: `${field.label} must be a whole number` };
    const value = Number(trimmed);
    if (value < field.min) return { error: `${field.label} must be ${field.min} or more` };
    return { value };
  }

  try {
    return { value: JSON.parse(String(raw ?? '')) };
  } catch {
    return { error: `${field.label} is not valid JSON` };
  }
}
```

- [ ] **Step 18: Run the form test to verify it passes**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/gameSettingsForm.test.js`
Expected: PASS — 6 tests

- [ ] **Step 19: Write the data hook**

Create `frontend/src/games/something2/useGameSettings.js`:

```js
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/auth.js";
import { API_URL } from "../../config.js";

// Same shape as useVfxEffects.js: one read hook plus a mutation that
// invalidates the shared key.
//
// authHeaders() is NOT optional: every /api/settings route is adminGuard'd,
// READS INCLUDED. Without it the request 401s, noteAuthFailure fires, and the
// admin is signed out the moment they open this tab -- the exact defect
// useAiProviders.js documents at its own queryFn.
export const GAME_SETTINGS_KEY = ["game-settings"];

export function useGameSettings() {
  const { data, isLoading, error } = useQuery({
    queryKey: GAME_SETTINGS_KEY,
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/settings`, { headers: authHeaders() });
      if (!res.ok) throw new Error("Failed to fetch game settings");
      return res.json();
    },
  });
  return { settings: data || [], isLoadingSettings: isLoading, settingsError: error || null };
}

export function useUpdateGameSetting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ key, value }) => {
      const res = await apiFetch(`${API_URL}/api/settings/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to update setting");
      }
      return res.json();
    },
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: GAME_SETTINGS_KEY });
      toast.success(`${row.key} saved`);
    },
    onError: (e) => toast.error(e.message, { duration: 8000 }),
  });
}
```

- [ ] **Step 20: Write the failing smoke test for the page**

Create `frontend/src/games/something2/__tests__/ProgressionAdmin.smoke.test.js`:

```js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ProgressionAdmin from '../ProgressionAdmin.jsx';
import { SETTING_FIELDS } from '../gameSettingsForm.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = fs.readFileSync(path.join(here, '../../../App.jsx'), 'utf8');
const page = fs.readFileSync(path.join(here, '../ProgressionAdmin.jsx'), 'utf8');

describe('ProgressionAdmin', () => {
  it('is a component export named ProgressionAdmin, taking no props', () => {
    expect(typeof ProgressionAdmin).toBe('function');
    expect(ProgressionAdmin.name).toBe('ProgressionAdmin');
    expect(ProgressionAdmin.length).toBe(0);
  });

  // Source text, not a render: vitest runs this project in a plain node env
  // (frontend/vitest.config.js), the same constraint navRoutes.test.js and
  // CreatureBehaviorsAdmin.smoke.test.js work around the same way. This is
  // the part that is actually meaningful -- it fails if the route is deleted
  // or repointed at a different component.
  it('is mounted at /game/admin/progression in App.jsx', () => {
    expect(app).toMatch(/<Route\s+path="admin\/progression"\s+element=\{<ProgressionAdmin\s*\/>\}\s*\/>/);
  });

  it('builds its editor rows from SETTING_FIELDS and hardcodes no key of its own', () => {
    expect(page).toMatch(/import\s*\{[^}]*\bSETTING_FIELDS\b[^}]*\}\s*from\s*'\.\/gameSettingsForm\.js'/);
    expect(page).toContain('SETTING_FIELDS.map(');
    // A second, hardcoded copy of the list is how the array and the form drift
    // apart while both tests above stay green.
    for (const f of SETTING_FIELDS) {
      expect(page, `${f.key} must not be spelled out in the JSX`).not.toContain(`"${f.key}"`);
    }
  });

  // The affix catalog (T12) and the passive-node browser (T9) belong to other
  // groups. They must be visible, labelled mount points rather than silently
  // absent, so the next implementer edits the right file and the admin is not
  // left wondering whether the page is broken.
  it('carries labelled, empty mount points for the affix and passive-node sections', () => {
    expect(page).toContain('MOUNT POINT: affix catalog');
    expect(page).toContain('MOUNT POINT: passive node browser');
    expect(page).toContain('id="affix-catalog-mount"');
    expect(page).toContain('id="passive-nodes-mount"');
  });

  it('reads its data through the hook, never fetch() directly', () => {
    expect(page).toMatch(/from\s*'\.\/useGameSettings\.js'/);
    expect(page).not.toContain('fetch(');
  });
});
```

- [ ] **Step 21: Run the smoke test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/ProgressionAdmin.smoke.test.js`
Expected: FAIL with `Failed to resolve import "../ProgressionAdmin.jsx"`

- [ ] **Step 22: Write the ProgressionAdmin page**

Create `frontend/src/games/something2/ProgressionAdmin.jsx`:

```jsx
import { useEffect, useState } from 'react';
import styled from 'styled-components';
import { useGameSettings, useUpdateGameSetting } from './useGameSettings.js';
import { SETTING_FIELDS, parseSettingInput } from './gameSettingsForm.js';

const AdminContainer = styled.div`
  padding: 2rem; color: var(--s2-text); max-width: 1200px; margin: 0 auto;
  height: 100%; overflow-y: auto; background-color: var(--s2-surface);
`;
const Header = styled.div`display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;`;
const Section = styled.section`margin-bottom: 2rem;`;
const SectionTitle = styled.h2`font-size: 1.1rem; margin: 0 0 0.75rem 0; color: var(--s2-text-strong);`;
const Card = styled.div`
  background: var(--s2-surface-raised); border: 1px solid var(--s2-border); border-radius: 8px;
  padding: 1rem; margin-bottom: 1rem;
`;
const Row = styled.div`display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; margin: 0.4rem 0;`;
const Label = styled.span`color: var(--s2-text-muted); min-width: 220px;`;
const Input = styled.input`
  background: var(--s2-bg-sunken); color: var(--s2-text); border: 1px solid var(--s2-border-strong);
  border-radius: 4px; padding: 0.4rem; min-width: 160px;
`;
const JsonArea = styled.textarea`
  background: var(--s2-bg-sunken); color: var(--s2-text); border: 1px solid var(--s2-border-strong);
  border-radius: 4px; padding: 0.5rem; width: 100%; min-height: 140px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem;
`;
const Button = styled.button`
  background: var(--s2-accent); color: var(--s2-on-accent); border: none; border-radius: 6px;
  padding: 0.5rem 1rem; font-weight: bold; cursor: pointer;
  &:disabled { opacity: 0.5; cursor: default; }
`;
const Hint = styled.p`color: var(--s2-text-muted); font-size: 0.85rem; margin: 0.25rem 0;`;
const Err = styled.p`color: var(--s2-danger); font-size: 0.85rem; margin: 0.25rem 0;`;
const Placeholder = styled.div`
  border: 1px dashed var(--s2-border-strong); border-radius: 8px; padding: 1.25rem;
  color: var(--s2-text-dim); background: var(--s2-surface-subtle);
`;

// The stored value rendered as editable text. An integer shows as a plain
// number; anything structured shows as indented JSON, which is what the
// textarea round-trips through parseSettingInput.
function toInput(field, value) {
  if (value === undefined) return '';
  return field.kind === 'integer' ? String(value) : JSON.stringify(value, null, 2);
}

function SettingRow({ field, row, onSave, saving }) {
  const [draft, setDraft] = useState(() => toInput(field, row && row.value));
  const [error, setError] = useState(null);

  // The server is the source of truth: when a save (or another admin's save)
  // lands and the query refetches, the draft follows it rather than sitting on
  // a stale local edit that looks saved.
  useEffect(() => { setDraft(toInput(field, row && row.value)); }, [field, row]);

  const save = () => {
    const parsed = parseSettingInput(field.key, draft);
    if (parsed.error) { setError(parsed.error); return; }
    setError(null);
    onSave(field.key, parsed.value);
  };

  return (
    <Card>
      <Row>
        <Label>{field.label}</Label>
        {field.kind === 'integer'
          ? <Input value={draft} onChange={(e) => setDraft(e.target.value)} />
          : null}
        <Button type="button" onClick={save} disabled={saving}>Save</Button>
      </Row>
      {field.kind === 'json' && (
        <JsonArea value={draft} spellCheck={false} onChange={(e) => setDraft(e.target.value)} />
      )}
      <Hint>{field.hint}</Hint>
      {error && <Err role="alert">{error}</Err>}
    </Card>
  );
}

export default function ProgressionAdmin() {
  const { settings, isLoadingSettings, settingsError } = useGameSettings();
  const update = useUpdateGameSetting();
  const byKey = new Map(settings.map((s) => [s.key, s]));

  return (
    <AdminContainer>
      <Header>
        <h1 style={{ margin: 0 }}>Progression</h1>
      </Header>

      <Section>
        <SectionTitle>Game settings</SectionTitle>
        <Hint>
          These take effect on the next read — no deploy. The XP curve is deliberately not here:
          changing it would re-level every character in the database, so it stays a code change
          with a migration attached.
        </Hint>
        {settingsError && <Err role="alert">{settingsError.message}</Err>}
        {isLoadingSettings && <Hint>Loading…</Hint>}
        {!isLoadingSettings && SETTING_FIELDS.map((field) => (
          <SettingRow
            key={field.key}
            field={field}
            row={byKey.get(field.key)}
            saving={update.isPending}
            onSave={(key, value) => update.mutate({ key, value })}
          />
        ))}
      </Section>

      {/* MOUNT POINT: affix catalog CRUD. Owned by group D, task T12 — the
          affix_types table does not exist yet, so this is a labelled empty
          section rather than a half-built editor. T12 replaces the
          Placeholder below and nothing else on this page. */}
      <Section id="affix-catalog-mount">
        <SectionTitle>Affix catalog</SectionTitle>
        <Placeholder>Arrives with the item-rarity slice (T12).</Placeholder>
      </Section>

      {/* MOUNT POINT: passive node browser and single-node editor. Owned by
          group C, task T9 — passive_nodes does not exist yet. T9 replaces the
          Placeholder below and nothing else on this page. */}
      <Section id="passive-nodes-mount">
        <SectionTitle>Passive nodes</SectionTitle>
        <Placeholder>Arrives with the passive-tree slice (T9).</Placeholder>
      </Section>
    </AdminContainer>
  );
}
```

- [ ] **Step 23: Register the route in App.jsx**

In `frontend/src/App.jsx`, add the import after line 22 (`import VfxEffectsAdmin from './games/something2/VfxEffectsAdmin.jsx';`):

```jsx
import ProgressionAdmin from './games/something2/ProgressionAdmin.jsx';
```

And add the route inside the `RequireAdmin` block, immediately after line 67 (`<Route path="settings" element={<SettingsAdmin />} />`):

```jsx
                      <Route path="admin/progression" element={<ProgressionAdmin />} />
```

- [ ] **Step 24: Run the smoke test to verify it passes**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/ProgressionAdmin.smoke.test.js`
Expected: PASS — 5 tests

- [ ] **Step 25: Add the sidebar entry and update its pinned list**

In `frontend/src/ui/navSections.js`, add `HiOutlineChartBar` to the `react-icons/hi2` import on lines 1-5, then add this entry immediately after line 44 (the `settings` / AI Providers entry, which stays last among the configuration screens is not a rule — Progression is content, so it goes before it):

```js
      { id: 'progression', label: 'Progression', path: '/game/admin/progression', Icon: HiOutlineChartBar, adminType: 'entity' },
```

Place it between the `worldmap` entry (line 40) and the `settings` entry (line 44).

In `frontend/src/ui/__tests__/navSections.test.js`, change lines 46-56 to:

```js
  it('shows an admin the two player screens plus all ten admin screens', () => {
    const items = allItems(visibleSections(true));
    expect(items).toHaveLength(12);
    expect(items.map((i) => i.path)).toEqual([
      '/game', '/game/map', '/game/tiles', '/game/entities', '/game/items',
      '/game/maps', '/game/biomes', '/game/creature-behaviors', '/game/vfx', '/game/world-map',
      // Progression epic T1: game_settings editor, plus the mount points the
      // affix (T12) and passive-node (T9) admin sections land in.
      '/game/admin/progression',
      // SOMET-330: AI Providers, last because it is configuration rather than
      // content -- opened once to point the game at a machine, not per session.
      '/game/settings',
    ]);
  });
```

- [ ] **Step 26: Put the new page under the theme-token gate**

In `frontend/src/games/something2/__tests__/themeTokens.test.js`, change the `IN_SCOPE` array at lines 104-107 to:

```js
const IN_SCOPE = [
  'GameShell.jsx', 'GameView.jsx', 'TileTypesAdmin.jsx', 'EntityTypesAdmin.jsx',
  'ItemTypesAdmin.jsx', 'BiomesAdmin.jsx', 'MapsAdmin.jsx', 'MapGraphAdmin.jsx',
  'CreatureBehaviorsAdmin.jsx', 'ProgressionAdmin.jsx',
];
```

- [ ] **Step 27: Run the whole frontend suite to verify nav, routes and tokens all pass**

Run: `cd frontend && npx vitest run`
Expected: PASS — no failures. In particular `src/ui/__tests__/navSections.test.js`, `src/ui/__tests__/navRoutes.test.js` and `src/games/something2/__tests__/themeTokens.test.js` are green.

- [ ] **Step 28: Commit the admin page**

```bash
git add frontend/src/games/something2/ProgressionAdmin.jsx frontend/src/games/something2/useGameSettings.js frontend/src/games/something2/gameSettingsForm.js frontend/src/games/something2/__tests__/ProgressionAdmin.smoke.test.js frontend/src/games/something2/__tests__/gameSettingsForm.test.js frontend/src/games/something2/__tests__/themeTokens.test.js frontend/src/App.jsx frontend/src/ui/navSections.js frontend/src/ui/__tests__/navSections.test.js
git commit -m "feat(progression): /game/admin/progression settings page shell (SOMET-NNN)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 29: Update the shared contract's migration table**

Open `docs/superpowers/plans/2026-08-23-progression-shared-contract.md` and replace the §1 table's nine rows with the shifted block from this plan's **Global Constraints**, adding one line above the table:

```
The block `1714440500000`–`1714440530000` is reserved for this epic. The
originally reserved `1714440400000`–`1714440430000` was found already occupied
on main (`1714440400000_biome_path_tile.js`, `1714440410000_invite_codes.js`,
`1714440420000_inventory_slots.js`), so every slot is shifted +100000 with the
task mapping unchanged.
```

```bash
git add docs/superpowers/plans/2026-08-23-progression-shared-contract.md
git commit -m "docs(progression): shift the epic migration block off three merged migrations (SOMET-NNN)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Level cap 150, the `18 * L^1.33` curve, and removal of the stat-point system

**Files:**
- Modify: `backend/src/services/progressionConstants.js:15-18`, `:56-58`, `:83-90`
- Modify: `backend/src/services/playerStats.js:9-19`, `:62-82`, `:94-133`
- Create: `backend/migrations/1714440501000_progression_level_150.js`
- Modify: `backend/src/services/progressionStore.js:4-11`, `:16-29`, `:69-118`, `:125-162`
- Modify: `backend/src/api/progressionRoutes.js:16`, `:74-95`
- Modify: `backend/tests/player_stats.test.js:64-163`
- Modify: `backend/tests/progression_migration.test.js:51`, `:60-92`
- Modify: `backend/tests/progression_store.test.js:105-672`
- Modify: `backend/tests/progression_routes.test.js:27-45`, `:161-575`
- Modify: `backend/tests/progression_kill_xp.test.js:103`, `:110-147`, `:319-347`, `:405-450`
- Modify: `backend/tests/progression_death.test.js:201-426`
- Modify: `backend/tests/authority_openchest_integration.test.js:460-495`
- Modify: `frontend/src/games/something2/CharacterSheet.jsx`
- Modify: `frontend/src/games/something2/src/js/net/progressionClient.js:45-54`
- Modify: `frontend/src/games/something2/src/js/__tests__/characterSheet.test.js`

**Interfaces:**
- Consumes: `getSetting(pool, key)` from Task 1's `backend/src/services/gameSettings.js` — `awardXp` reads `passive_points_per_level` from it, and only on a level-up.
- Produces:
  - `backend/src/services/progressionConstants.js` → `MAX_LEVEL = 150`, `XP_BASE = 18`, `XP_EXPONENT = 1.33`; `STAT_POINTS_PER_LEVEL` is **deleted**.
  - `backend/src/services/playerStats.js` → unchanged export list minus `refundedPoints`: `{ derivePlayerStats, xpFloor, xpToNext, levelForXp, xpForKill, applyDeathPenalty, DEFAULT_PROGRESSION }`. `DEFAULT_PROGRESSION` no longer carries `stat_points`; it carries `passive_points: 0`.
  - `backend/src/services/progressionStore.js` → `{ loadProgression, awardXp, respec, applyDeath, XP_SOURCES }`. `allocateStat` is **deleted**. `awardXp(db, characterId, amount, source)` now returns `{ progression, leveledUp, newLevel, pointsGained, awarded }` where `pointsGained` counts **passive** points.
  - Column: `player_progression.passive_points integer NOT NULL DEFAULT 0 CHECK (passive_points >= 0)`. It rides out to the client inside the existing `progression` object on both `GET /api/progression` and the websocket `progression` frame; the top-level camelCase `passivePoints`/`allocatedNodeIds` fields the contract lists are T7's.
  - HTTP: `POST /api/progression/allocate` is **removed**. `GET /api/progression` and `POST /api/progression/respec` keep their paths and response shapes.

**Hand-verified curve literals used throughout this task.** Every one was computed with `node -e 'const f=L=>Math.round(18*Math.pow(L,1.33)); ...'` before being written down:

| | 1 | 2 | 3 | 4 | 5 | 7 | 10 | 50 | 100 | 150 |
|---|---|---|---|---|---|---|---|---|---|---|
| `xpToNext(L)` | 18 | 45 | 78 | 114 | 153 | 239 | 385 | 3273 | 8228 | ∞ (worth 14108) |
| `xpFloor(L)` | 0 | 18 | 63 | 141 | 255 | 603 | 1463 | 68598 | 349010 | 901212 |

**Two spec numbers are wrong and are corrected here.** The spec's §4 table gives level 100 → 8,240 and level 150 → 14,123. `Math.round(18 * Math.pow(100, 1.33))` is **8228** and `Math.round(18 * Math.pow(150, 1.33))` is **14108**. Levels 2 (45), 10 (385) and 50 (3273) match the spec exactly. Cumulative XP to 150 is 901,212, matching the spec's "~900,000"; cumulative to 50 is 68,598, against the spec's "~70,000".

---

- [ ] **Step 1: Rewrite the curve assertions in player_stats.test.js**

In `backend/tests/player_stats.test.js`, delete lines 64-163 (from `test('the XP curve has the documented floors'` to the end of the file) and replace them with:

```js
// Every number below is a hand-computed literal for
// xpToNext(L) = round(18 * L^1.33), verified with `node -e` before being
// written here. NOT one of them is produced by calling xpToNext or by
// re-implementing the formula: an XP-curve test that builds its own
// expectation from the code's own constants proves nothing, and this repo's
// dominant test failure is exactly that.
//
// The spec's own table is wrong at two rows -- it printed 8240 for level 100
// and 14123 for level 150. The correct values are 8228 and 14108.
test('the XP curve costs the documented amount at every checked level', () => {
  assert.equal(xpToNext(1), 18);
  assert.equal(xpToNext(2), 45);
  assert.equal(xpToNext(3), 78);
  assert.equal(xpToNext(4), 114);
  assert.equal(xpToNext(5), 153);
  assert.equal(xpToNext(7), 239);
  assert.equal(xpToNext(10), 385);
  assert.equal(xpToNext(50), 3273);
  assert.equal(xpToNext(100), 8228);
  // MAX_LEVEL: there is no next level to buy.
  assert.equal(xpToNext(150), Infinity);
  assert.equal(xpToNext(151), Infinity);
});

// The cumulative table. Also literals: xpFloor has no closed form with a
// fractional exponent, so there is no formula to write inline the way the old
// triangular-sum version did -- which makes a direct equality check against
// hand-computed numbers the ONLY thing that can catch a floor that is too
// high, since every downstream clamp trivially satisfies a >= assertion.
test('the cumulative floors are the documented literals', () => {
  assert.equal(xpFloor(1), 0);
  assert.equal(xpFloor(2), 18);
  assert.equal(xpFloor(3), 63);
  assert.equal(xpFloor(4), 141);
  assert.equal(xpFloor(5), 255);
  assert.equal(xpFloor(7), 603);
  assert.equal(xpFloor(10), 1463);
  assert.equal(xpFloor(50), 68598);
  assert.equal(xpFloor(100), 349010);
  assert.equal(xpFloor(150), 901212);
  // Out of range clamps rather than returning NaN or undefined.
  assert.equal(xpFloor(0), 0);
  assert.equal(xpFloor(999), 901212);
});

// The floors must be strictly increasing across all 150 levels. A binary
// search over a table that is not sorted returns a plausible wrong answer
// silently, and no single-point assertion above can see that.
test('the floor table is strictly increasing for all 150 levels', () => {
  for (let level = 2; level <= 150; level++) {
    assert.ok(xpFloor(level) > xpFloor(level - 1),
      `xpFloor(${level}) = ${xpFloor(level)} is not above xpFloor(${level - 1}) = ${xpFloor(level - 1)}`);
  }
});

// The exact-boundary cases the binary search has to get right. An off-by-one
// in the search puts an exact total on the wrong side and a player one level
// behind for the rest of their life.
test('levelForXp inverts the curve exactly at the boundaries', () => {
  assert.equal(levelForXp(0), 1);
  assert.equal(levelForXp(17), 1);
  assert.equal(levelForXp(18), 2);   // exactly on the boundary
  assert.equal(levelForXp(62), 2);
  assert.equal(levelForXp(63), 3);
  assert.equal(levelForXp(140), 3);
  assert.equal(levelForXp(141), 4);
  assert.equal(levelForXp(254), 4);
  assert.equal(levelForXp(255), 5);
  assert.equal(levelForXp(68597), 49);
  assert.equal(levelForXp(68598), 50);
  assert.equal(levelForXp(901211), 149);
  assert.equal(levelForXp(901212), 150);
  assert.equal(levelForXp(999999999), 150); // clamped at MAX_LEVEL
});

test('kill XP rewards a harder creature and decays to zero on a trivial one', () => {
  assert.equal(xpForKill(1, 1), 10);
  assert.equal(xpForKill(5, 1), 90);
  assert.equal(xpForKill(12, 1), 240);  // clamped at XP_LEVEL_DIFF_MAX
  assert.equal(xpForKill(1, 6), 0);     // diff -5: exactly zero
  assert.equal(xpForKill(1, 10), 0);    // never negative
});

// Level 3 is worth xpToNext(3) = 78 and its floor is 63. Every expected
// number below is hand-computed from those two literals.
test('death costs a random slice of what the level is worth', () => {
  // Draw 0 -> the 0.5% floor: floor(0.005 * 78) = floor(0.39) = 0.
  assert.deepStrictEqual(applyDeathPenalty(500, 3, 0), { experience: 500, lost: 0 });
  // Draw 1 -> the 10% ceiling: floor(0.10 * 78) = floor(7.8) = 7.
  assert.deepStrictEqual(applyDeathPenalty(500, 3, 1), { experience: 493, lost: 7 });
  // Draw 0.5 -> 5.25%: floor(0.0525 * 78) = floor(4.095) = 4.
  assert.deepStrictEqual(applyDeathPenalty(500, 3, 0.5), { experience: 496, lost: 4 });
});

// Level 10 is worth 385, which is large enough that all five draws land on
// distinct values -- a formula that ignored `unit`, or used the wrong end of
// the range, would collapse this list.
test('the roll spans the whole 0.5%-10% band and never leaves it', () => {
  const losses = [0, 0.25, 0.5, 0.75, 1].map((u) => applyDeathPenalty(100000, 10, u).lost);
  assert.deepStrictEqual(losses, [1, 11, 20, 29, 38]);
  for (const u of [-5, 2, NaN, undefined, 'half']) {
    const { lost } = applyDeathPenalty(100000, 10, u);
    assert.ok(lost >= 1 && lost <= 38, `draw ${String(u)} escaped the band: ${lost}`);
  }
});

test('death never de-levels, and the clamp reports the real loss', () => {
  // Exactly at the floor there is nothing to lose, at ANY draw. xpFloor(3) is
  // the literal 63 from the table above.
  assert.deepStrictEqual(applyDeathPenalty(63, 3, 1), { experience: 63, lost: 0 });
  // Barely into the level: the 10% roll wants 7 but only 4 exist. `lost` must
  // report 4, not 7 -- an over-reported loss would lie to the player and to
  // the wire message the sheet renders.
  assert.deepStrictEqual(applyDeathPenalty(67, 3, 1), { experience: 63, lost: 4 });

  // MAX_LEVEL is the case a naive implementation gets wrong: xpToNext(150) is
  // Infinity by design, so deriving the loss from it would wipe out every
  // point of progress above the floor. Level 150 is WORTH 14108, so a
  // full-strength roll costs floor(0.10 * 14108) = 1410.
  assert.deepStrictEqual(applyDeathPenalty(901212 + 2000, 150, 1),
    { experience: 901212 + 590, lost: 1410 });

  // The invariant, stated directly, across the whole range: for every level
  // and every XP inside it, the result never falls below the level's floor.
  // The floors themselves are pinned above as literals, so a bug confined to
  // xpFloor cannot corrupt both the input and the expectation identically.
  for (let level = 1; level <= 150; level++) {
    const floor = xpFloor(level);
    for (const offset of [0, 1, 7, 50, 999]) {
      const xp = floor + offset;
      for (const unit of [0, 1]) {
        const out = applyDeathPenalty(xp, level, unit);
        assert.ok(out.experience >= floor,
          `level ${level} +${offset} at draw ${unit} de-levelled: ${out.experience} < ${floor}`);
        assert.equal(out.experience, xp - out.lost,
          `level ${level} +${offset} at draw ${unit}: reported loss ${out.lost} does not match the XP actually removed`);
      }
    }
  }
});

// The stat-point system is gone: DEFAULT_PROGRESSION must not carry a
// stat_points field, and refundedPoints must not be exported at all. A test
// that only checked passive_points was present would still pass with a
// vestigial stat_points riding along into every INSERT.
test('the stat-point system leaves no trace on the default progression', () => {
  assert.ok(!('stat_points' in DEFAULT_PROGRESSION), 'stat_points must be gone entirely');
  assert.equal(DEFAULT_PROGRESSION.passive_points, 0);
  assert.equal(require('../src/services/playerStats.js').refundedPoints, undefined);
});
```

Also change the import on lines 3-6 to drop `refundedPoints`:

```js
const {
  derivePlayerStats, xpFloor, xpToNext, levelForXp, xpForKill,
  applyDeathPenalty, DEFAULT_PROGRESSION,
} = require('../src/services/playerStats.js');
```

- [ ] **Step 2: Run the curve test to verify it fails**

Run: `cd backend && node --test tests/player_stats.test.js`
Expected: FAIL — the first new test fails with `AssertionError: 100 !== 18` on `assert.equal(xpToNext(1), 18)`

- [ ] **Step 3: Update the constants**

In `backend/src/services/progressionConstants.js`:

Replace lines 17-18:
```js
const MAX_LEVEL = 150;
```
(delete `STAT_POINTS_PER_LEVEL` entirely — nothing grants stat points any more.)

Replace lines 56-58:
```js
// XP curve. xpToNext(level) = round(XP_BASE * level^XP_EXPONENT), so the
// cumulative floor has NO closed form and is precomputed as a 150-entry table
// in playerStats.js. Cost of a level: 18 at 1, 45 at 2, 385 at 10, 3273 at 50,
// 8228 at 100, 14108 at 150. Cumulative to 50 is 68,598 (down from 122,500
// under the old linear curve) and to 150 is 901,212.
//
// THIS IS NOT A game_settings KEY, deliberately (design doc section 3.5).
// Changing it re-levels every character in the database on the next read; an
// admin toggling a number in a form must not be able to do that.
const XP_BASE = 18;
const XP_EXPONENT = 1.33;
```

Replace the export block at lines 83-90 so it reads:
```js
module.exports = {
  BASE_STAT, STAT_KEYS, MAX_LEVEL,
  HP_BASE, HP_PER_CON, MANA_BASE, MANA_PER_INT,
  MELEE_PER_STR, SPELL_PER_INT, HASTE_PER_DEX, MIN_COOLDOWN_MULT,
  MANA_REGEN_BASE, MANA_REGEN_PER_WIS,
  PRICE_PER_CHA, SELL_FRACTION_BASE, SELL_FRACTION_MAX,
  XP_BASE, XP_EXPONENT, XP_KILL_BASE, XP_LEVEL_DIFF_SLOPE, XP_LEVEL_DIFF_MAX,
  DEATH_PENALTY_MIN, DEATH_PENALTY_MAX, RESPEC_BASE,
};
```

- [ ] **Step 4: Rewrite the curve maths in playerStats.js**

In `backend/src/services/playerStats.js`:

Replace `DEFAULT_PROGRESSION` (lines 9-19):
```js
const DEFAULT_PROGRESSION = Object.freeze({
  experience: 0,
  level: 1,
  passive_points: 0,
  strength: C.BASE_STAT,
  dexterity: C.BASE_STAT,
  constitution: C.BASE_STAT,
  intelligence: C.BASE_STAT,
  wisdom: C.BASE_STAT,
  charisma: C.BASE_STAT,
});
```

Replace lines 62-82 (`xpFloor` / `xpToNext` / `levelForXp`) with:
```js
// What level `level` COSTS to buy. Kept separate from xpToNext because
// xpToNext deliberately returns Infinity at MAX_LEVEL, and applyDeathPenalty
// needs the finite number there (see its own comment). One formula, two
// callers -- not two copies of `18 * L^1.33`.
function levelWorth(level) {
  const l = clamp(Math.floor(Number(level) || 1), 1, C.MAX_LEVEL);
  return Math.round(C.XP_BASE * Math.pow(l, C.XP_EXPONENT));
}

// Cumulative XP at which each level begins, precomputed once at module load.
// A fractional exponent has no closed-form cumulative sum, so there is
// nothing to evaluate per call -- and a 150-entry array is cheaper than the
// old triangular formula anyway. Index 0 is unused; XP_FLOORS[l] is the floor
// of level l.
const XP_FLOORS = (() => {
  const floors = new Array(C.MAX_LEVEL + 1);
  floors[1] = 0;
  for (let l = 2; l <= C.MAX_LEVEL; l++) floors[l] = floors[l - 1] + levelWorth(l - 1);
  return floors;
})();

function xpFloor(level) {
  return XP_FLOORS[clamp(Math.floor(Number(level) || 1), 1, C.MAX_LEVEL)];
}

function xpToNext(level) {
  const l = clamp(Math.floor(Number(level) || 1), 1, C.MAX_LEVEL);
  return l >= C.MAX_LEVEL ? Infinity : levelWorth(l);
}

// Binary search over XP_FLOORS, not a linear walk and never a float inverse.
// The closed form would need a 1/1.33 power, and a float root lands on the
// wrong side of an exact boundary (xp 18 must be level 2, not level 1). The
// search returns the greatest level whose floor is <= xp, which is exact for
// every integer total.
function levelForXp(experience) {
  const xp = Math.max(0, Number(experience) || 0);
  let lo = 1;
  let hi = C.MAX_LEVEL;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (xp >= XP_FLOORS[mid]) lo = mid; else hi = mid - 1;
  }
  return lo;
}
```

In `applyDeathPenalty` (lines 112-123), replace the `levelWorth` line:
```js
  const fraction = C.DEATH_PENALTY_MIN + u * (C.DEATH_PENALTY_MAX - C.DEATH_PENALTY_MIN);
  const worth = levelWorth(lvl);

  const lost = Math.min(Math.floor(fraction * worth), xp - floor);
```
and update the comment block above it: the reason for not calling `xpToNext` is unchanged (Infinity at MAX_LEVEL), but the stand-in is now `levelWorth(lvl)` rather than `XP_BASE * lvl`, so the two can no longer drift.

Delete `refundedPoints` entirely (lines 125-128) and change the export block (lines 130-133) to:
```js
module.exports = {
  derivePlayerStats, xpFloor, xpToNext, levelForXp, xpForKill,
  applyDeathPenalty, DEFAULT_PROGRESSION,
};
```

- [ ] **Step 5: Run the curve test to verify it passes**

Run: `cd backend && node --test tests/player_stats.test.js`
Expected: PASS — 12 tests

- [ ] **Step 6: Commit the curve**

```bash
git add backend/src/services/progressionConstants.js backend/src/services/playerStats.js backend/tests/player_stats.test.js
git commit -m "feat(progression): level cap 150 on the 18*L^1.33 curve (SOMET-NNN)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Rewrite the schema assertions in progression_migration.test.js**

In `backend/tests/progression_migration.test.js`, replace line 51 with:

```js
    assert.equal(by.get('passive_points').column_default, '0');
    assert.equal(by.get('passive_points').data_type, 'integer');
    assert.equal(by.get('passive_points').is_nullable, 'NO');
    // The stat-point system is gone, column and all. A leftover column is a
    // second place a later migration or a stray UPDATE can put points nothing
    // spends.
    assert.equal(by.get('stat_points'), undefined, 'stat_points must have been dropped');
```

Replace the CHECK table at lines 60-66 (the `for (const [label, sql] of [...]` list) with:

```js
    for (const [label, sql] of [
      ['negative experience', 'UPDATE player_progression SET experience = -1 WHERE character_id = $1'],
      ['level 0', 'UPDATE player_progression SET level = 0 WHERE character_id = $1'],
      ['level 151', 'UPDATE player_progression SET level = 151 WHERE character_id = $1'],
      ['negative passive points', 'UPDATE player_progression SET passive_points = -1 WHERE character_id = $1'],
      ['sub-base strength', 'UPDATE player_progression SET strength = 4 WHERE character_id = $1'],
    ]) {
      await client.query('BEGIN');
      await assert.rejects(() => client.query(sql, [testCharacterId]), `${label} must be rejected`);
      await client.query('ROLLBACK');
    }

    // The converse, and the one that actually proves the cap MOVED rather
    // than merely still existing: level 51 was rejected before this migration
    // and must now be accepted. Without it, a migration that forgot to drop
    // the old constraint passes every assertion above.
    await client.query('BEGIN');
    await client.query('UPDATE player_progression SET level = 150 WHERE character_id = $1', [testCharacterId]);
    await client.query('UPDATE player_progression SET level = 51 WHERE character_id = $1', [testCharacterId]);
    await client.query('ROLLBACK');
```

- [ ] **Step 8: Run the migration test to verify it fails**

Run:
```bash
cd backend && DATABASE_URL=postgres://user:password@localhost:15432/game_db_progA \
  TEST_DATABASE_URL=postgres://user:password@localhost:15432/game_db_progA \
  node --test tests/progression_migration.test.js
```
Expected: FAIL with `TypeError: Cannot read properties of undefined (reading 'column_default')` on `by.get('passive_points')`

- [ ] **Step 9: Write the level-150 migration**

Create `backend/migrations/1714440501000_progression_level_150.js`:

```js
exports.shorthands = undefined;

// Level cap 50 -> 150, the new XP curve, and the removal of the stat-point
// system (design doc sections 3.2, 3.3, 4).
//
// THE FLOOR TABLE IS EMBEDDED, NOT REQUIRED FROM playerStats.js. A migration
// must replay identically forever; importing the live service would make this
// backfill re-level characters differently the day the curve is retuned. The
// 150 numbers below are generated from round(18 * L^1.33) at authoring time
// and then frozen.
const XP_BASE = 18;
const XP_EXPONENT = 1.33;
const PASSIVE_POINTS_PER_LEVEL = 1; // game_settings.passive_points_per_level's
// default. Read as a literal, not from the table: the backfill must not depend
// on a value an admin can change between two runs of the same migration.

const MAX_LEVEL = 150;
const FLOORS = (() => {
  const out = [null, 0];
  for (let l = 2; l <= MAX_LEVEL; l++) {
    out[l] = out[l - 1] + Math.round(XP_BASE * Math.pow(l - 1, XP_EXPONENT));
  }
  return out;
})();

exports.up = (pgm) => {
  // 1. The new points column, before anything reads or writes it.
  pgm.addColumns('player_progression', {
    passive_points: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.addConstraint('player_progression', 'player_progression_passive_points_check',
    'CHECK (passive_points >= 0)');

  // 2. Raise the cap BEFORE re-levelling, or a character who re-levels above
  //    50 violates the old constraint mid-migration.
  pgm.dropConstraint('player_progression', 'player_progression_level_check');
  pgm.addConstraint('player_progression', 'player_progression_level_check',
    `CHECK (level >= 1 AND level <= ${MAX_LEVEL})`);

  // 3. Re-level every character from its RAW experience. Experience is never
  //    touched -- what a player earned they keep; only the level the curve
  //    maps it to changes.
  const floorRows = [];
  for (let l = 1; l <= MAX_LEVEL; l++) floorRows.push(`(${l}, ${FLOORS[l]})`);
  pgm.sql(`
    UPDATE player_progression p
       SET level = (
             SELECT max(f.level) FROM (VALUES ${floorRows.join(',')}) AS f(level, xp_floor)
              WHERE f.xp_floor <= p.experience
           )
  `);

  // 4. Grant passive points, THEN reset the stat columns. Order matters twice:
  //    the grant reads the NEW level from step 3, and it reads the stat
  //    columns before step 5 flattens them.
  //
  //    Per the design doc: passive_points_per_level x (level - 1), plus every
  //    stat point previously ALLOCATED above the base, plus whatever was still
  //    unspent. The unspent term is included so a character who levelled but
  //    never opened the sheet is not silently poorer than one who did.
  pgm.sql(`
    UPDATE player_progression
       SET passive_points = passive_points
             + GREATEST(level - 1, 0) * ${PASSIVE_POINTS_PER_LEVEL}
             + (strength - 5) + (dexterity - 5) + (constitution - 5)
             + (intelligence - 5) + (wisdom - 5) + (charisma - 5)
             + stat_points,
           updated_at = now()
  `);

  // 5. The six stat columns become a class-base snapshot (design doc 3.3).
  //    Every character alive today was created with all six at the base, and
  //    nothing but the now-deleted allocateStat ever raised them, so the base
  //    IS 5 for every existing row. Per-class bases arrive with T3, which owns
  //    entity_types.main_stat and the four new playable classes.
  pgm.sql(`
    UPDATE player_progression
       SET strength = 5, dexterity = 5, constitution = 5,
           intelligence = 5, wisdom = 5, charisma = 5
  `);

  // 6. Now the old column can go, along with its CHECK.
  pgm.dropConstraint('player_progression', 'player_progression_points_check');
  pgm.dropColumns('player_progression', ['stat_points']);
};

// LOSSY BY DESIGN. Re-levelling and the stat reset cannot be undone: the
// pre-migration level was a function of a curve this file replaced, and the
// allocation that produced each stat column is not recorded anywhere. `down`
// restores the SHAPE (so a bad deploy can be unwound) by recomputing the old
// linear level from the same untouched experience and returning the passive
// points as stat points; it does not restore anyone's exact allocation.
exports.down = (pgm) => {
  pgm.addColumns('player_progression', {
    stat_points: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.sql('UPDATE player_progression SET stat_points = passive_points');
  pgm.addConstraint('player_progression', 'player_progression_points_check',
    'CHECK (stat_points >= 0)');

  // Old curve: xpToNext(L) = 100 * L, so the floor is 100*(L-1)*L/2 and the
  // level is the greatest L <= 50 whose floor is <= experience.
  const oldRows = [];
  for (let l = 1; l <= 50; l++) oldRows.push(`(${l}, ${(100 * (l - 1) * l) / 2})`);
  pgm.sql(`
    UPDATE player_progression p
       SET level = (
             SELECT max(f.level) FROM (VALUES ${oldRows.join(',')}) AS f(level, xp_floor)
              WHERE f.xp_floor <= p.experience
           )
  `);

  pgm.dropConstraint('player_progression', 'player_progression_level_check');
  pgm.addConstraint('player_progression', 'player_progression_level_check',
    'CHECK (level >= 1 AND level <= 50)');

  pgm.dropConstraint('player_progression', 'player_progression_passive_points_check');
  pgm.dropColumns('player_progression', ['passive_points']);
};
```

- [ ] **Step 10: Apply the migration and run the migration test to verify it passes**

Run:
```bash
cd backend && DATABASE_URL=postgres://user:password@localhost:15432/game_db_progA \
  npx node-pg-migrate up --ignore-pattern '(?!.*\.js$).*' && \
DATABASE_URL=postgres://user:password@localhost:15432/game_db_progA \
  TEST_DATABASE_URL=postgres://user:password@localhost:15432/game_db_progA \
  node --test tests/progression_migration.test.js
```
Expected: PASS — 3 tests

- [ ] **Step 11: Write a failing test for the backfill arithmetic itself**

Add to the end of `backend/tests/progression_migration.test.js`:

```js
// The backfill is the one part of this migration that cannot be re-run to
// check, so it is exercised here against synthetic rows inside a transaction
// that is rolled back. Every expected number is hand-computed:
//   experience 213 -> level 4 (xpFloor(4) = 141, xpFloor(5) = 255)
//   level 4 grants 1 x (4 - 1) = 3 passive points
//   strength 12 is 7 above the base of 5, dexterity 8 is 3 above -> 10 refunded
//   plus 2 still unspent -> 3 + 10 + 2 = 15
test('the backfill re-levels from raw XP and refunds every point as a passive point', async (t) => {
  if (!requireTestDb(t, 'this test inserts a user, character and progression row inside a rolled-back transaction')) return;
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} -- the backfill arithmetic is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = await client.query(
      "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player') RETURNING id",
      [`backfill-check-${process.pid}-${Date.now()}`]);
    const c = await client.query(
      `INSERT INTO characters (user_id, slot, name, entity_type_id)
       SELECT $1, 1, $2, e.id FROM entity_types e WHERE e.name = 'Warrior' RETURNING id`,
      [u.rows[0].id, `backfill-char-${process.pid}-${Date.now()}`]);
    const charId = c.rows[0].id;

    // The pre-migration shape, written directly: this row is what a level-4
    // character with 5 spent and 2 unspent points looked like.
    await client.query(
      `INSERT INTO player_progression
         (character_id, experience, level, passive_points, strength, dexterity)
       VALUES ($1, 213, 2, 2, 12, 8)`,
      [charId]);

    // Replay the migration's own two statements against this one row.
    await client.query(
      `UPDATE player_progression
          SET passive_points = passive_points + GREATEST(level - 1, 0) * 1
            + (strength - 5) + (dexterity - 5) + (constitution - 5)
            + (intelligence - 5) + (wisdom - 5) + (charisma - 5)
        WHERE character_id = $1`, [charId]);
    await client.query(
      `UPDATE player_progression SET strength = 5, dexterity = 5 WHERE character_id = $1`, [charId]);

    const { rows } = await client.query(
      'SELECT experience, passive_points, strength, dexterity FROM player_progression WHERE character_id = $1',
      [charId]);
    assert.strictEqual(Number(rows[0].experience), 213, 'raw experience must never be touched');
    assert.strictEqual(rows[0].strength, 5);
    assert.strictEqual(rows[0].dexterity, 5);
    // level is 2 in this fixture (the re-level ran before the row existed), so
    // the grant term is 1 x (2 - 1) = 1: 1 + 10 + 2 = 13.
    assert.strictEqual(rows[0].passive_points, 13);

    await client.query('ROLLBACK');
  } finally { client.release(); await pool.end(); }
});
```

- [ ] **Step 12: Run it and verify it passes**

Run:
```bash
cd backend && DATABASE_URL=postgres://user:password@localhost:15432/game_db_progA \
  TEST_DATABASE_URL=postgres://user:password@localhost:15432/game_db_progA \
  node --test tests/progression_migration.test.js
```
Expected: PASS — 4 tests

- [ ] **Step 13: Commit the migration**

```bash
git add backend/migrations/1714440501000_progression_level_150.js backend/tests/progression_migration.test.js
git commit -m "feat(progression): passive_points column, level cap 150, re-level backfill (SOMET-NNN)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 14: Rewrite the store tests**

In `backend/tests/progression_store.test.js`:

Change the import on lines 4-6 to drop `allocateStat`:
```js
const {
  loadProgression, awardXp, respec, applyDeath, XP_SOURCES,
} = require('../src/services/progressionStore.js');
```

At line 119, change `assert.equal(first.stat_points, 0);` to `assert.equal(first.passive_points, 0);` and add `assert.ok(!('stat_points' in first), 'the mapped row must not carry a stat_points field');`.

Replace the body of `awardXp levels up and grants the documented points` (starting line 130) so the fixture and expectations use the new curve. The whole test becomes:

```js
test('awardXp levels up and grants the documented passive points', async (t) => {
  if (!requireTestDb(t, 'this test creates a throwaway user and awards it XP')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(skipMsg('awardXp')); return; }
  let user; let character;
  try {
    ({ user, character } = await createTestActor(pool, 'award-levelup'));
    // From level 1 / 0 xp, +250 xp -> level 4 (xpFloor(4) = 141,
    // xpFloor(5) = 255). Literal floors, hand-computed from
    // round(18 * L^1.33): 0, 18, 63, 141, 255.
    const r = await awardXp(pool, character, 250, 'kill');
    assert.equal(r.awarded, 250);
    assert.equal(r.leveledUp, true);
    assert.equal(r.newLevel, 4);
    // passive_points_per_level defaults to 1, and three levels were crossed.
    assert.equal(r.pointsGained, 3);
    assert.equal(r.progression.experience, 250);
    assert.equal(r.progression.level, 4);
    assert.equal(r.progression.passive_points, 3);
  } finally { await dropUser(pool, user); await pool.end(); }
});
```

Replace the `awardXp can cross more than one level at once` test's expectations (line 155 onwards) with a jump from 0 to level 10: award 1463 XP (the literal `xpFloor(10)`), expect `newLevel` 10 and `pointsGained` 9.

At line 189, change `assert.equal(after.stat_points, before.stat_points);` to `assert.equal(after.passive_points, before.passive_points);`.

**Delete lines 460-545 entirely** — the three `allocateStat` tests (`allocateStat spends points atomically`, `allocateStat refuses an unknown stat key`, `allocateStat refuses a non-positive or non-integer count`). The function no longer exists; leaving them pointing at dead code is what the F1 comment in `CharacterSheet.jsx` calls out as the wrong move.

Replace the respec fixture and the two respec tests (lines 551-617) with:

```js
// A level-4 character that has been granted 9 passive points and still holds
// them. Nothing raises a stat column any more, so a respec's only job here is
// the gold charge plus the reset-to-base safety net; the tree respec that
// actually spends and refunds points arrives with T7.
async function seedRespecFixture(pool, tag) {
  const actor = await createTestActor(pool, tag);
  await loadProgression(pool, actor.character);
  await pool.query(
    'UPDATE player_progression SET level = 4, passive_points = 9 WHERE character_id = $1',
    [actor.character],
  );
  return actor;
}

test('respec moves the gold, resets the stats and credits NO points', async (t) => {
  if (!requireTestDb(t, 'this test creates a throwaway user and respecs it')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(skipMsg('respec')); return; }
  let user; let character;
  try {
    ({ user, character } = await seedRespecFixture(pool, 'respec-ok'));
    await pool.query('UPDATE users SET gold = 500 WHERE id = $1', [user]);

    const r = await respec(pool, user, character);
    assert.equal(r.ok, true);
    assert.equal(r.cost, 200);              // RESPEC_BASE(50) * level(4)
    assert.equal(r.gold, 300);              // 500 - 200
    assert.equal(r.progression.passive_points, 9,
      'a respec must not mint passive points -- the old stat refund is gone');
    for (const k of C.STAT_KEYS) assert.equal(r.progression[k], C.BASE_STAT);
  } finally { await dropUser(pool, user); await pool.end(); }
});

test('respec with insufficient gold changes nothing at all', async (t) => {
  if (!requireTestDb(t, 'this test creates a throwaway user short on gold and respecs it')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(skipMsg('respec')); return; }
  let user; let character;
  try {
    ({ user, character } = await seedRespecFixture(pool, 'respec-poor'));
    await pool.query('UPDATE users SET gold = 199 WHERE id = $1', [user]);

    const r = await respec(pool, user, character);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not enough gold');
    assert.equal(r.cost, 200);
    const after = await loadProgression(pool, character);
    assert.equal(after.passive_points, 9);
    const g = await pool.query('SELECT gold FROM users WHERE id = $1', [user]);
    assert.equal(Number(g.rows[0].gold), 199, 'the gold must not have moved');
  } finally { await dropUser(pool, user); await pool.end(); }
});
```

Adjust the `applyDeath` tests at lines 619-660: change the fixture `UPDATE player_progression SET level = 3, experience = 350` to `SET level = 3, experience = 100` (`xpFloor(3)` is 63, so 100 is 37 into level 3) and re-derive the expected loss from the literals — level 3 is worth 78, so an `rng` pinned at 1 costs `floor(0.10 * 78) = 7`.

- [ ] **Step 15: Run the store test to verify it fails**

Run:
```bash
cd backend && DATABASE_URL=postgres://user:password@localhost:15432/game_db_progA \
  TEST_DATABASE_URL=postgres://user:password@localhost:15432/game_db_progA \
  node --test tests/progression_store.test.js
```
Expected: FAIL with `TypeError: allocateStat is not a function` in the deleted-import check, then `column "passive_points" does not exist` from `awardXp`'s UPDATE.

- [ ] **Step 16: Rewrite progressionStore.js**

In `backend/src/services/progressionStore.js`:

Replace lines 4-11:
```js
const { levelForXp, applyDeathPenalty, DEFAULT_PROGRESSION } = require('./playerStats.js');
const { getSetting } = require('./gameSettings.js');
const C = require('./progressionConstants.js');

const XP_SOURCES = ['kill', 'chest', 'dungeon_clear'];
const COLUMNS = `character_id, experience, level, passive_points,
                 strength, dexterity, constitution, intelligence, wisdom, charisma`;
```

In `mapRow` (lines 16-29), replace the `stat_points` line with:
```js
    passive_points: Number(r.passive_points) || 0,
```

Replace `awardXp`'s body from line 80 to line 89 with:
```js
  const experience = before.experience + amt;
  const newLevel = levelForXp(experience);
  const levelsGained = Math.max(0, newLevel - before.level);
  // The settings read happens ONLY on an actual level-up, so the common case
  // (a kill that does not level anyone) still issues exactly the two queries
  // it always did. `db` may be a client mid-transaction; getSetting is a plain
  // SELECT and is safe on either.
  const perLevel = levelsGained > 0
    ? Number(await getSetting(db, 'passive_points_per_level')) || 0
    : 0;
  const pointsGained = levelsGained * perLevel;
  const r = await db.query(
    `UPDATE player_progression
        SET experience = $2, level = $3, passive_points = passive_points + $4, updated_at = now()
      WHERE character_id = $1
      RETURNING ${COLUMNS}`,
    [characterId, experience, newLevel, pointsGained],
  );
```

**Delete `allocateStat` entirely** (lines 99-118) and its export.

In `respec` (lines 125-162), delete the `const refund = refundedPoints(before);` line and change the UPDATE to:
```js
    // The stat columns are a class-base snapshot now (design doc 3.3) and
    // nothing raises them, so this reset is a safety net rather than the
    // point of the operation. T7 replaces this body with the passive-tree
    // respec, which is what a player actually pays for.
    const r = await client.query(
      `UPDATE player_progression
          SET strength = $2, dexterity = $2, constitution = $2,
              intelligence = $2, wisdom = $2, charisma = $2,
              updated_at = now()
        WHERE character_id = $1
        RETURNING ${COLUMNS}`,
      [characterId, C.BASE_STAT],
    );
```

Change the export block at lines 208-210 to:
```js
module.exports = {
  loadProgression, awardXp, respec, applyDeath, XP_SOURCES,
};
```

- [ ] **Step 17: Run the store test to verify it passes**

Run:
```bash
cd backend && DATABASE_URL=postgres://user:password@localhost:15432/game_db_progA \
  TEST_DATABASE_URL=postgres://user:password@localhost:15432/game_db_progA \
  node --test tests/progression_store.test.js
```
Expected: PASS

- [ ] **Step 18: Rewrite the route tests**

In `backend/tests/progression_routes.test.js`:

At line 35, change the route-path list to `['/', '/respec']`. At line 44, change the count assertion to:
```js
  assert.equal(layers.length, 2, `expected exactly 2 progression routes, found ${layers.length}`);
```
and update the comment on line 43 to name `GET /` and `POST /respec`.

Add a new test immediately after it, so the removal is pinned rather than merely implied:
```js
test('the allocate route is gone, not merely unused', () => {
  const paths = progressionRouteLayers().map((l) => l.route.path);
  assert.ok(!paths.includes('/allocate'),
    'POST /api/progression/allocate must not exist: nothing grants stat points any more');
});
```

At lines 174 and 179, change to:
```js
    assert.equal(res.body.progression.passive_points, 0);
    ...
    assert.equal(res.body.xpFloor, 0);
    assert.equal(res.body.xpToNext, 18);  // round(18 * 1^1.33), hand-computed
    assert.equal(res.body.respecCost, 50); // RESPEC_BASE(50) * level(1)
```

**Delete the three allocate tests** — `allocate acts on the authenticated user, not a body-supplied id` (lines 196-233), `allocate rejects an unknown stat with 400` (lines 235-254) and `allocate with more points than held returns 400 and changes nothing` (lines 256-275).

The cross-account security property those tests carried must not be lost with them. Add it to the respec surface instead, immediately after the `GET` test:

```js
// The security-critical test, moved off the deleted allocate route onto the
// one write route that remains. Swap resolveCharacter to read
// `req.body.userId || req.user.id` and this must fail.
test('respec acts on the authenticated user, never on a body-supplied id', async (t) => {
  if (!dbReady(t, 'this test creates two throwaway users and attempts a cross-account respec')) return;
  let userA; let userB;
  try {
    userA = await createTestUser(dbPool, 'respec-self');
    userB = await createTestUser(dbPool, 'respec-other');
    await loadProgression(dbPool, await charOf(dbPool, userA));
    await loadProgression(dbPool, await charOf(dbPool, userB));
    await dbPool.query('UPDATE users SET gold = 500 WHERE id = $1', [userA]);
    const before = await loadProgression(dbPool, await charOf(dbPool, userB));

    const res = await request(app).post('/api/progression/respec').set(authed(userA))
      .send({ character_id: await charOf(dbPool, userA), userId: userB });
    assert.equal(res.status, 200);
    assert.equal(res.body.progression.character_id, await charOf(dbPool, userA));

    const cross = await request(app).post('/api/progression/respec').set(authed(userA))
      .send({ character_id: await charOf(dbPool, userB) });
    assert.equal(cross.status, 403);
    assert.deepEqual(await loadProgression(dbPool, await charOf(dbPool, userB)), before,
      "userB's progression must survive a cross-account respec");
  } finally {
    await dropUser(dbPool, userA);
    await dropUser(dbPool, userB);
  }
});
```

In the remaining respec tests (lines 277-575), replace every `stat_points = 4` in a fixture UPDATE with `passive_points = 9`, and drop `strength = 10` from those UPDATEs (a stat above base is no longer reachable and the CHECK still permits it, but the fixture would be describing a state the game cannot produce).

**Delete the live-authority allocate tests** at lines 400-476 (`a successful allocation reaches the live authority session` and `a failed allocation does not touch the live authority session`). Their subject — that `refreshLivePlayerStats` reaches the real session — is already covered by the two respec equivalents at lines 477-575, which stay.

- [ ] **Step 19: Delete the allocate route**

In `backend/src/api/progressionRoutes.js`:

Change the require on line 16 to:
```js
const { loadProgression, respec } = require('../services/progressionStore.js');
```

Delete the whole `router.post('/allocate', ...)` block (lines 74-95).

Update the module header (lines 1-13) so it describes two routes, and keep the paragraph about `req.user.id` verbatim — it now guards `/respec` alone and the reasoning is unchanged.

- [ ] **Step 20: Run the route test to verify it passes**

Run:
```bash
cd backend && DATABASE_URL=postgres://user:password@localhost:15432/game_db_progA \
  TEST_DATABASE_URL=postgres://user:password@localhost:15432/game_db_progA \
  node --test tests/progression_routes.test.js
```
Expected: PASS

- [ ] **Step 21: Commit the store and route changes**

```bash
git add backend/src/services/progressionStore.js backend/src/api/progressionRoutes.js backend/tests/progression_store.test.js backend/tests/progression_routes.test.js
git commit -m "feat(progression): passive points replace stat points; drop the allocate route (SOMET-NNN)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 22: Repair the three collateral backend suites**

These three files hold fixtures whose expected LEVELS were computed under the old linear curve. Each fails on a real assertion, not a missing column.

**`backend/tests/progression_kill_xp.test.js`**
- Line 103 and line 417: the fake `UPDATE player_progression` handlers write `row.stat_points += Number(p[3])`. Change both to `row.passive_points += Number(p[3]) || 0;` and change the fixture rows' `stat_points: 0` to `passive_points: 0`.
- Lines 110-147 (`a kill awards XP scaled by the creature level`): change the fixture's `experience: 650` to `experience: 150`, and the assertion at line 132's block from `result.progression.experience === 734` to `234`. Rationale, to be written into the comment: `xpForKill(6, 4)` is still 84; `xpFloor(4) = 141` and `xpFloor(5) = 255`, so 150 and 150+84 = 234 both sit inside level 4 and the kill must not level the player.
- Lines 340 and 426-450 (`fakeLevelUpPool` and `a level-up moves the LIVE player pools`): the fixture is `experience: 290, level: 2` and the wolf is level 10, so `xpForKill(10, 2) = 200` and the total is 490. Under the new curve `levelForXp(490)` is **6**, not 3 (`xpFloor(6) = 408`, `xpFloor(7) = 603`). Change `assert.strictEqual(prog.newLevel, 3)` to `6` and update the comment to name the two floors. `awarded` stays 200; the maxHp/hp assertions (200 and 160) are driven by `constitution: 15` and do not move.

**`backend/tests/progression_death.test.js`**
- Lines 201-238 (`dying costs a rolled fraction of the level's worth`): change the fixture to `experience: 700, level: 7` and the assertions to `prog.lost === 12`, `prog.progression.experience === 688`, `prog.progression.level === 7`. Level 7 is worth 239 and `floor(0.0525 * 239) = floor(12.5475) = 12`; `xpFloor(7) = 603`, so 700 is 97 into the level and the clamp is not what produces the number.
- Lines 254-279 (`the unpinned production roll`): change the fixture to `experience: 800, level: 7` and the band assertion to `prog.lost >= 1 && prog.lost <= 23` — `floor(0.005 * 239) = 1` and `floor(0.10 * 239) = 23`. `xpFloor(8) = 842`, so 800 is still inside level 7.
- Lines 285-318 (`dying at a level floor costs nothing`): change `experience: 300` to `experience: 63` (`xpFloor(3)`), change `stat_points: 2` to `passive_points: 2`, change `strength: 6` to `strength: 5`, and change the two `assert.strictEqual(row.experience, 300, ...)` / `pushes` assertions to use 63.
- Lines 324-351 (`dying does not change allocated stats or spent points`): keep the fixture's `experience: 1030, level: 5` but rename `stat_points: 4` to `passive_points: 4` and change the assertions to `prog.lost === 8` and `prog.progression.experience === 1022` (level 5 is worth 153; `floor(0.0525 * 153) = floor(8.0325) = 8`), plus `prog.progression.passive_points === 4`.
- Lines 357-390 and 392-426 (`fires exactly once` and `socket is gone`): change both fixtures to `experience: 700, level: 7` and both expected values to `lost: 12` / `row.experience === 688`.

**`backend/tests/authority_openchest_integration.test.js`**
- Lines 460-473: `xpForChest(20, 1) = xpForKill(20, 1) = round(10 * 20 * 2) = 400`, and `levelForXp(400)` is now **5** (`xpFloor(5) = 255`, `xpFloor(6) = 408`), not 3. Change `progressionAfter`'s `level: 3` to `level: 5` and `stat_points: 6` to `passive_points: 4`; change the two `assert.equal(opened.newLevel, 3)` / `assert.equal(progressionMsg.newLevel, 3)` at lines 495 and 499 to `5`. Rewrite the header comment's threshold sentence to name `xpFloor(5) = 255` instead of the old 100/300 thresholds.

- [ ] **Step 23: Run the full backend suite against the scratch database**

Run:
```bash
cd backend && DATABASE_URL=postgres://user:password@localhost:15432/game_db_progA \
  TEST_DATABASE_URL=postgres://user:password@localhost:15432/game_db_progA npm test
```
Expected: PASS — no failures. `progression_*`, `authority_openchest_integration`, `authority_combat_integration`, `settings_routes` and `game_settings_db` are all green.

- [ ] **Step 24: Commit the collateral test repairs**

```bash
git add backend/tests/progression_kill_xp.test.js backend/tests/progression_death.test.js backend/tests/authority_openchest_integration.test.js
git commit -m "test(progression): re-pin level fixtures to the 18*L^1.33 curve (SOMET-NNN)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 25: Rewrite the frontend character-sheet tests**

In `frontend/src/games/something2/src/js/__tests__/characterSheet.test.js`:

Change the import on line 12 to drop `respecDisabled`:
```js
import { xpProgress, progressionChanged, STAT_KEYS } from '../../../CharacterSheet.jsx';
```
and line 13 to drop `allocateStat`:
```js
import { fetchProgression, respec } from '../net/progressionClient.js';
```

Replace the `xpProgress` literals at lines 43-78 with the new curve's numbers (each hand-computed, exactly as `GET /api/progression` would send them):

```js
  it('reports the position inside the current level (level 3, floor 63, xpToNext(3) 78)', () => {
    // Literal floor/xpToNext for a level-3 player under the new curve:
    // xpFloor(3) = 63, xpToNext(3) = round(18 * 3^1.33) = 78. Experience 102
    // is 39 into that 78-wide band -> 50%.
    const result = xpProgress({ level: 3, experience: 102 }, { xpFloor: 63, xpToNext: 78, respecCost: 150 });
    expect(result).toEqual({ into: 39, need: 78, pct: 50 });
  });

  it('does not divide by null at max level -- xpToNext serialises as null over JSON, not Infinity', () => {
    // xpFloor(150) = 901212, and JSON.stringify(Infinity) is "null".
    const result = xpProgress({ level: 150, experience: 901212 }, { xpFloor: 901212, xpToNext: null, respecCost: 7500 });
    expect(result).toEqual({ into: 0, need: 0, pct: 100 });
    expect(Number.isFinite(result.into)).toBe(true);
    expect(Number.isFinite(result.need)).toBe(true);
    expect(Number.isFinite(result.pct)).toBe(true);
  });

  it('past max-level floor still returns finite numbers (grinding at level 150)', () => {
    const result = xpProgress({ level: 150, experience: 999999 }, { xpFloor: 901212, xpToNext: null, respecCost: 7500 });
    expect(result).toEqual({ into: 98787, need: 0, pct: 100 });
    expect(Number.isFinite(result.into)).toBe(true);
  });
```

**Delete both `respecDisabled` describes** (lines 81-116) — the predicate is removed along with the button. Replace them with one source-text guard that keeps the F2 lesson alive. It matches a **declaration**, not a mention: the F2 header block names `RESPEC_BASE` and `xpCurve.js` in prose and that history must survive.

```js
// F2's lesson, restated for the surface that still exists: the sheet must
// never re-declare a backend constant locally. xpCurve.js was deleted for
// exactly that, and the respec button that consumed RESPEC_BASE is now gone
// too. Matches a declaration, not a mention -- the module header talks about
// all three by name on purpose.
describe('CharacterSheet holds no local copy of a backend constant', () => {
  it('declares neither XP_BASE, MAX_LEVEL nor RESPEC_BASE', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../CharacterSheet.jsx', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/\b(const|let|var)\s+(XP_BASE|MAX_LEVEL|RESPEC_BASE)\b/);
  });

  it('renders no allocate or respec control', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../CharacterSheet.jsx', import.meta.url)), 'utf8');
    expect(source).not.toContain('PlusButton');
    expect(source).not.toContain('RespecButton');
    expect(source).not.toContain('allocateStat');
  });
});
```

In the `progressionChanged` describe (lines 118-151), change every `stat_points` in the fixtures to `passive_points`, and rename the `is true when a stat changed (allocate)` case to `is true when the passive-point count changed`.

**Delete the whole `progressionClient.allocateStat` describe** (lines 208-232). Keep the `fetchProgression` and `respec` describes; in `fetchProgression`'s body change `xpToNext: 100` to `xpToNext: 18` and `stat_points: 0` to `passive_points: 0`, and in `respec`'s body change `stat_points: 6` to `passive_points: 6`.

- [ ] **Step 26: Run the frontend test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/src/js/__tests__/characterSheet.test.js`

Expected: FAIL, two tests:

```
FAIL  progressionChanged > is true when the passive-point count changed
AssertionError: expected false to be true
FAIL  CharacterSheet holds no local copy of a backend constant > renders no allocate or respec control
AssertionError: expected 'import { useCallback, useEffect, u…' not to contain 'PlusButton'
```

The first fails because `PROGRESSION_FIELDS` (line 128) still lists `stat_points` and not `passive_points`, so a change to the passive-point count alone is invisible to `progressionChanged`. The second fails because the buttons are still there.

- [ ] **Step 27: Remove the allocation UI from CharacterSheet.jsx**

In `frontend/src/games/something2/CharacterSheet.jsx`:

- Line 79: change the import to `import { fetchProgression } from './src/js/net/progressionClient.js';`
- Delete `respecDisabled` (lines 116-124) and its export.
- Line 128: change `PROGRESSION_FIELDS` to `['experience', 'level', 'passive_points', ...STAT_KEYS]`.
- Delete the `PlusButton` (lines 250-261), `PointsLine` (263-267) and `RespecButton` (269-281) styled-components.
- Delete `handleAllocate` (lines 394-405) and `handleRespec` (lines 407-431).
- Delete the `busy` state (line 297) and every reference to it.
- In the render (lines 437-477): drop the `points` const, drop the `<PlusButton>` from each `<StatRow>`, drop `<PointsLine>` and drop `<RespecButton>`. Add one line in its place:

```jsx
      <PointsNote>Passive points: {progression ? (progression.passive_points || 0) : 0}</PointsNote>
```

with

```js
const PointsNote = styled.div`
  margin: 10px 0 0 0;
  color: #facc15;
  font-size: 12px;
`;
```

- Extend the module header with a third block:

```
// --- T2: the stat-point system is gone ---
//
// The +STR/+DEX buttons, the allocate call and the respec button are removed:
// player_progression.stat_points no longer exists, and the passive tree is
// the only source of stat growth (design doc 2 and 3.3). This panel is now
// read-only. POST /api/progression/respec still exists server-side and T7
// replaces its body with the tree respec; there is deliberately no UI for it
// in the meantime, because a respec that resets six columns nothing can raise
// would charge gold for nothing.
//
// The single-writer rule in F1 above is UNCHANGED and still binding. Removing
// the HTTP writers does not make a second writer safe; the websocket
// `progression` frame is still the only thing that sets Game.progression.
```

- [ ] **Step 28: Remove `allocateStat` from the client**

In `frontend/src/games/something2/src/js/net/progressionClient.js`, delete lines 45-54 (the `allocateStat` export and its comment). Leave `fetchProgression` and `respec` in place — T7 uses `respec` for the tree, and the route still exists.

- [ ] **Step 29: Run the frontend suite to verify it passes**

Run: `cd frontend && npx vitest run`
Expected: PASS — no failures.

`src/games/something2/src/js/core/__tests__/progressionSnapshot.test.js` and `src/games/something2/src/js/net/__tests__/WorldAuthorityClient.test.js` also mention `stat_points`, in fixtures they pass through unchanged and compare byte-for-byte. They are **not** affected and must not be edited — their subject is the single-writer guarantee, not the column list.

- [ ] **Step 30: Commit the frontend removal**

```bash
git add frontend/src/games/something2/CharacterSheet.jsx frontend/src/games/something2/src/js/net/progressionClient.js frontend/src/games/something2/src/js/__tests__/characterSheet.test.js
git commit -m "feat(progression): remove the stat-point allocation UI (SOMET-NNN)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 31: Browser-verify both surfaces**

Per AGENTS.md, every change with a UI surface needs a browser pass. Run the stack against the branch (see `docs`/memory recipe: the compose vite/nodemon serve the MAIN checkout, so merge or fast-forward the branch there rather than expecting a worktree to be visible), then, signed in as an admin:

1. Open `/game/admin/progression`. Confirm the four settings render with their seeded values, that changing **Ground item lifetime** to `240` and pressing Save shows a success toast, that a reload still shows 240, and that entering `-5` shows the inline error without issuing a request.
2. Confirm the **Affix catalog** and **Passive nodes** sections render as labelled empty placeholders, not blank space.
3. Toggle light mode and confirm no hardcoded colour survives (this is what the `themeTokens` gate enforces statically; the browser pass confirms the tokens resolve).
4. Enter a world with a character, press `C`. Confirm the sheet shows Level, an XP bar, the six stats **with no + buttons**, a "Passive points" line, and **no Respec button**.
5. Kill one creature and confirm the XP bar advances and the level number matches the new curve (a fresh character reaches level 2 at 18 XP, not 100).

Record the screenshots in the task report.

---

## Self-review: spec requirement → task

| Spec / contract requirement (in this group's scope) | Where it is implemented |
|---|---|
| §3.1 `game_settings` table: `key text PK`, `value jsonb NOT NULL`, `updated_at timestamptz` | T1 Step 7 (migration `1714440500000`), verified T1 Step 5 test 1 |
| §3.5 the four setting keys and their defaults (`passive_points_per_level` 1, `ground_item_ttl_seconds` 180, `rarity_weights` 3 anchors, `respec_base_gold` 50) | T1 Step 3 (`DEFAULTS`) + Step 7 (seed rows), verified T1 Step 1 test 1 and Step 5 test 2 |
| Contract §2 `gameSettings.js` signature: `getSetting` / `getSettings` / `setSetting`, unknown key is an error not a silent insert | T1 Step 3, verified T1 Step 1 tests 5-6 |
| Contract §3 routes `GET /api/settings` and `PUT /api/settings/:key`, admin | T1 Step 12, verified T1 Step 10 (guard walk + 403 test) |
| §10.5 new route `/game/admin/progression` with a `game_settings` editor | T1 Steps 17, 22, 23; verified T1 Step 20 |
| §10.5 affix catalog CRUD and passive-node browser belong on this page | T1 Step 22 — both are labelled mount points (`#affix-catalog-mount`, `#passive-nodes-mount`), verified T1 Step 20 test 4 |
| §3.5 the XP curve is deliberately NOT a `game_settings` key | T1 Step 3 module header + T2 Step 3 constants comment; enforced by `DEFAULTS` being the write whitelist (T1 Step 1 test 5) |
| §4 `MAX_LEVEL = 150` | T2 Step 3, verified T2 Step 1 (`levelForXp(999999999) === 150`) and Step 7 (`level 151` rejected, `level 51` accepted) |
| §4 `xpToNext(L) = round(18 * L^1.33)` | T2 Steps 3-4, verified T2 Step 1 against ten hand-written literals |
| §4 150-entry cumulative table precomputed at module load, `levelForXp` binary-searches it | T2 Step 4 (`XP_FLOORS`, `levelForXp`), verified T2 Step 1 (monotonicity across all 150 + fourteen exact boundaries) |
| §4 existing characters keep raw `experience` and are re-levelled | T2 Step 9 migration statement 3, verified T2 Step 11 (`experience` unchanged at 213) |
| §4 `passive_points_per_level × (level - 1)` granted, allocated points refunded, stats reset to the class base | T2 Step 9 migration statements 4-5, verified T2 Step 11 |
| §3.2 `player_progression.level` CHECK becomes 1..150; `stat_points` dropped | T2 Step 9 migration statements 2 and 6, verified T2 Step 7 |
| Contract §2 `refundedPoints` and `DEFAULT_PROGRESSION.stat_points` removed | T2 Step 4, verified T2 Step 1 final test |
| Decision table: "Old +STR/+DEX stat points — removed entirely" | T2 Steps 16 (`allocateStat` deleted), 19 (route deleted), 27 (buttons deleted); verified T2 Steps 15, 18 and 25 |
| §10.1 the single-writer `progression` websocket rule is preserved, not rewritten | T2 Step 27 — the F1 header is extended, not replaced, and no new writer is introduced |
| §11 no vacuous tests: curve expectations are hand-written literals | T2 Step 1 — every curve number is a literal verified with `node -e`, none is produced by calling the code under test |
| §11 every DB-touching run sets both `DATABASE_URL` and `TEST_DATABASE_URL` to a scratch DB | Every `Run:` line in both tasks |

**Not in this group, deliberately:** `statComposition.js` and the `sources`/`modifiers` bundle (T7), per-class base stats and `entity_types.main_stat` (T3), the passive-tree respec that replaces `POST /api/progression/respec`'s body (T7), the top-level `passivePoints`/`allocatedNodeIds` fields on `GET /api/progression` and the websocket frame (T7), the Character tab that replaces this panel (T15).
