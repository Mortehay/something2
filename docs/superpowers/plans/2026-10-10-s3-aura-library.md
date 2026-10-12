# S3 Aura Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the creature aura out of `creature_behaviors.aura_*` into a reusable `aura_effects` library. Entities bind to it by name through `entity_types.auras`. Admins edit it in an Aura Effects tab and bind it with an Entities-tab picker. Champion's pack-leader buff must behave exactly as it does today.

**Architecture:**
- One new table, `aura_effects`, holds every §3.2 column, each with a CHECK.
- `entity_types.auras` is a jsonb array of aura names. It has no FK, the same trade-off as `vfx`.
- One SQL fragment, `AURAS_LATERAL`, resolves those names inside the live creature loader `CREATURE_JOINED_SELECT`.
- One pure resolver, `resolveInstanceAuras`, runs inside `addCreatures` and stamps `c.auras` onto every instance.
- `computeAuras` becomes `applyAuras`. It reads `c.auras` and no longer reads `c.behavior.aura*`. Ally side only.
- Only after golden parity is proven are the `aura_*` columns dropped, along with every reader.
- Admin CRUD lives in a new router file. Rename cascades into bindings. Delete is refused while the aura is bound.

**Tech Stack:** Node 20 + Express 4 (CommonJS), raw `pg`, node-pg-migrate 6, `node --test` + supertest. React 19 + styled-components + TanStack Query, vitest (node env, no DOM).

**Spec:** `docs/superpowers/specs/2026-10-10-boss-entities-auras-design.md` (§3.2, §3.4 drop, §4.2 allies side only, §5 Aura Effects tab + Entities picker, §7 S3)

**Plane:** SOMET-604 (parent SOMET-602)

## Global Constraints

- **Worktree:** do all work in its own worktree, `git worktree add ../something2-s3-auras -b feat/s3-aura-library main`. Never checkout, stash or branch in the shared checkout. Its `backend/src/index.js`, `frontend/src/App.jsx`, `frontend/src/ui/navSections.js` and `navSections.test.js` carry another session's uncommitted sprite-batch edits.
- **Scratch DB:** use one per branch, `game_db_s3`. Export both `DATABASE_URL` and `TEST_DATABASE_URL` as literals, never `B="$A"`. Order: migrate, then `seed-catalogs`, then `SPEC=p5-descent seed-map`, then `SPEC=vale-region seed-map` (LAST), then `FORCE=1 seed-passive-tree`.
- **Dev DB:** never run INSERT/UPDATE/DELETE/DDL against `game_db`, whether from a test, a reviewer or by hand. A subagent prompt must repeat this rule.
- **Migrations:** use `1714440680000`–`1714440689999` only. Re-check `ls backend/migrations` for collisions before merge (S1 uses `16700xx`; the untracked `1714440660000` belongs to the other session).
- **`entity_types.auras`:** add it with raw `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. S1 adds the same column, so whichever branch merges first wins and the other's migration still succeeds.
- **Commits:** subject is `type(scope): summary (SOMET-604)`, and the body ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage by explicit path, never `git add -A` (the worktree's `node_modules` symlinks must never be committed).
- **Test results:** trust the exit code: `<cmd>; echo "EXIT=$?"`, never chained with `;` into another reporter. Red means any of `^not ok`, `testTimeoutFailure` or a non-zero exit.
- **Fixtures:** no fixture derives its expected value from the constant under test. Expected numbers are written as literals.
- **Nav edit:** the navSections / App.jsx change is one additive line each, placed next to the `vfx` entry so it does not overlap the other session's `sprites` hunk.

## Review Focus

These are five failure modes a user would hit that no existing test covers. Each is pinned in the task named.

1. **An aura is renamed while entities are bound to it.**
   - Failure: every bound entity silently loses its aura (the name resolves to nothing, one log line).
   - Fix: rename cascades into `entity_types.auras` in the same transaction.
   - Pinned in Task 6 by `aura_effects_api_db.test.js › rename rewrites every binding`.
2. **An aura is deleted while still bound.**
   - Must return 409 and name each referencing entity type.
   - Pinned in Task 6 by `delete while bound is 409 with the entity list`, plus Task 8's hook source guard that surfaces the names.
3. **Two Champions overlap.**
   - Must stay ×1.25, not ×1.5625. Two *different* ally auras must multiply.
   - Pinned in Task 4 by literal-value tests in `authority_creature_auras.test.js`.
4. **`auras = []` versus `NULL`.**
   - An admin who deselects pack_leader from a Champion entity sends `[]`. A later `make seed-catalogs` must not re-bind it. `NULL` means "never authored", and only `NULL` receives the seeder default.
   - Pinned in Task 3 by `seed_auras_db.test.js` and in Task 7 by `entity_auras_api_db.test.js`.
5. **Invalid numbers.**
   - A radius of 0, a negative radius, a radius of 26000 (typo), a multiplier of 0, or `tick_ms` 50 must each be refused at every layer: form (Task 8), API (Task 2 validator via Task 6), DB CHECK (Task 1).
   - Each layer has its own negative test.

*Also pinned:* on a **fresh DB (staging)** the migration runs before `seed-catalogs` creates the 32 Champion entity types, so a migration-only bind binds nothing. Task 3's `bindDefaultAuras` closes this gap, and Task 3's DB test proves it.

## Facts this plan rests on (verified 2026-10-10, read-only)

| Fact | Where |
|---|---|
| Only `Champion` (id 8) has an aura: r 260, ×1.25 dmg, ×1.2 def, ×1.1 spd | live `creature_behaviors` |
| 32 entity types use the Champion behaviour (`Beast Champion` … `Woodland Champion`) | live `entity_types JOIN creature_behaviors` |
| `aura_effects` does not exist; `entity_types` has no `auras` column yet | live `to_regclass`, `information_schema` |
| CHECK `creature_behaviors_aura_check` = `aura_radius >= 0 AND mults > 0` | live `pg_constraint` |
| Element vocabulary is the `elements` table (`arcane, fire, ice, lightning, physical`); `item_types.element` is an FK to it | live `pg_constraint` |
| `computeAuras` | `backend/src/authority/creatures.js:965-997` |
| Consumed once per tick, stored on `c._buff` | `creatures.js:1338-1347` |
| `_buff` use sites: `effectiveMit` defense | `creatures.js:1004-1017`; damage/speed multiply inside the tick loop |
| Exported for tests | `creatures.js:2514-2517` |
| The "aura cap" at `creatures.js:2195` is the PLAYER leech aura (`countHostilesWithin`, SOMET-522), NOT the creature aura. `computeAuras` has no cap. | see Self-Review |
| Live loader = `CREATURE_JOINED_SELECT` (`server.js:367-386`), shared by `activateChunk` (`server.js:1279`), `injectGuardIntoSim` (`server.js:1328`) and the respawn path (`server.js:3546`) | |
| `loadCreatureTypes` (`creatures.js:188-276`) is NOT read by the live sim (its own comment, `creatures.js:225-233`) | |
| Entities are created by `seed-catalogs.js` `seedOneCreatureType` (`scripts/seed-catalogs.js:302-336`), AFTER migrations | |
| Attack Effects model: inline routes `index.js:1797-1960`, hook `useVfxEffects.js`, form `vfxForm.js`, preview `vfxPreview.js`, component `VfxEffectsAdmin.jsx` | |
| `entity_types.vfx` has NO editor in the Entities tab (only `ItemTypesAdmin` binds vfx), so the "dropdown pattern" to copy is the Behavior `<select>` at `EntityTypesAdmin.jsx:1373-1388` | |

### Every reader/writer of `creature_behaviors.aura_*` (all must move or go in Task 5)

**Backend runtime**
- `backend/src/authority/creatures.js:207-215`: `loadCreatureTypes` SELECT `b.aura_*`
- `backend/src/authority/creatures.js:952-997`: `computeAuras` reads `bh.auraRadius/auraDamageMult/auraDefenseMult/auraSpeedMult`
- `backend/src/authority/creatures.js:1361`: comment naming `computeAuras`
- `backend/src/authority/creatures.js:2514-2517`: export `computeAuras`
- `backend/src/authority/server.js:381`: `CREATURE_JOINED_SELECT` `b.aura_*`
- `backend/src/authority/server.js:1270`: comment
- `backend/src/services/creatureBehaviors.js:58-67`: `DEFAULT_BEHAVIOR.aura*`
- `backend/src/services/creatureBehaviors.js:145-148`: `resolveBehavior` maps `aura_*`

**Backend API**
- `backend/src/index.js:2157, 2166-2184`: `behaviorFieldError` aura validation
- `backend/src/index.js:2357-2369`: POST `/api/creature-behaviors` INSERT
- `backend/src/index.js:2406-2414`: PUT UPDATE

**Seeds and scripts**
- `backend/scripts/seed-catalogs.js:126-130, 164-200`: `seedOneBehavior` INSERT/UPSERT `aura_*`
- `backend/seeds/data/creatureBehaviors.js:36-41, 52-53`: Champion row's `aura_*` + header comment

**Comment only**
- `backend/src/services/densityTiers.js:100-116`: names `computeAuras` and `aura_radius 260`

**Frontend**
- `frontend/src/games/something2/behaviorForm.js:30-67`: `NUMERIC` + `NEW_ROW_DEFAULTS`
- `frontend/src/games/something2/CreatureBehaviorsAdmin.jsx:508-547`: four aura inputs

**Tests**
- `backend/tests/authority_creature_auras.test.js` (whole file)
- `backend/tests/creature_aura_resolve.test.js` (whole file)
- `backend/tests/creature_mechanics_wiring.test.js:53-54, 61-94, 229`
- `backend/tests/authority_creatures_integration.test.js:293-299`
- `backend/tests/authority_creatures_combat.test.js:275-280, 367, 383`
- `backend/tests/behaviorFieldError.test.js:98-115`
- `backend/tests/legacyCreatureGoldRung.test.js:60-63`
- `backend/tests/creature_tick_cost.test.js:25-83`
- `backend/tests/creature_behaviors_api_db.test.js:236-267`
- `frontend/src/games/something2/__tests__/behaviorForm.test.js:97-125`

**Not readers (leave alone)**
- `migrations/1714440085000_behavior_auras.js` and `1714440190000_skittish_chase_style.js:45`: historical.
- `auraRadius`/`auraLeech` in `statComposition.js`, `world.js`, `progressionConstants.js`, `passiveNodeForm.js`, `seeds/data/passiveTree.js`, `RenderSystem.js:1076`: the PLAYER passive leech aura.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `backend/migrations/1714440680000_aura_effects.js` | new | Table + CHECKs, seed `pack_leader` from Champion, `entity_types.auras` IF NOT EXISTS, bind Champion entities |
| `backend/migrations/1714440681000_drop_behavior_auras.js` | new | Drop `creature_behaviors.aura_*` + its CHECK; `down` restores both from `pack_leader` |
| `backend/src/services/auraEffects.js` | new | Pure: vocab constants, `auraEffectError`, `resolveAuraDef`, `resolveInstanceAuras` (unknown name → one log), `AURAS_LATERAL` |
| `backend/seeds/data/auraEffects.js` | new | `AURA_EFFECTS` (pack_leader), `BEHAVIOR_DEFAULT_AURAS` |
| `backend/scripts/seed-catalogs.js` | modify | `seedOneAura`, `bindDefaultAuras`; drop `aura_*` from `seedOneBehavior` |
| `backend/src/authority/creatures.js` | modify | `addCreatures` stamps `auras`; `computeAuras` → `applyAuras`; drop `aura_*` from `loadCreatureTypes` |
| `backend/src/authority/server.js` | modify | `CREATURE_JOINED_SELECT` gains `et.auras AS aura_names, au.aura_defs` + `AURAS_LATERAL`; loses `b.aura_*` |
| `backend/src/services/creatureBehaviors.js` | modify | Remove aura fields |
| `backend/src/api/auraEffectsRoutes.js` | new | GET (open, with `used_by`), POST/PUT/DELETE (adminGuard) |
| `backend/src/index.js` | modify | One `require` + one `app.use`; entity POST/PUT accept `auras`; behaviour routes lose `aura_*` |
| `frontend/src/games/something2/auraForm.js` | new | Pure form ↔ payload + validation |
| `frontend/src/games/something2/src/js/core/auraVisual.js` | new | Pure pulse/particle maths, shared with S5's renderer |
| `frontend/src/games/something2/auraPreview.js` | new | Canvas preview built on `auraVisual.js` + `particlesAt` |
| `frontend/src/games/something2/useAuraEffects.js` | new | Query + mutations, key `['auraEffects']`, 409 message |
| `frontend/src/games/something2/AuraEffectsAdmin.jsx` | new | List + form + live preview + Used by |
| `frontend/src/games/something2/entityAuras.js` | new | Pure helpers for the Entities picker |
| `frontend/src/games/something2/EntityTypesAdmin.jsx` | modify | Auras multi-select |
| `frontend/src/games/something2/behaviorForm.js`, `CreatureBehaviorsAdmin.jsx` | modify | Remove aura fields |
| `frontend/src/App.jsx`, `frontend/src/ui/navSections.js` | modify | One route line, one nav line |
| Tests | new/modify | Listed per task |

---

### Task 0: Worktree and scratch database

**Files:** none committed.

- [ ] **Step 1: Create the worktree off `main`**

```bash
cd /home/markunn/worker/coding/jsgame/something2
git worktree add ../something2-s3-auras -b feat/s3-aura-library main
cd ../something2-s3-auras
ln -s ../../something2/backend/node_modules backend/node_modules
ln -s ../../something2/frontend/node_modules frontend/node_modules
git status --short   # expected: empty (the symlinks are ignored or untracked; NEVER stage them)
```

- [ ] **Step 2: Create and fill the scratch DB (read the exit code of each)**

```bash
docker exec something2-db-1 psql -U user -d postgres -c 'CREATE DATABASE game_db_s3;'
export DATABASE_URL=postgres://user:password@localhost:15432/game_db_s3
export TEST_DATABASE_URL=postgres://user:password@localhost:15432/game_db_s3
cd /home/markunn/worker/coding/jsgame/something2-s3-auras/backend
npm run migrate -- up; echo "EXIT=$?"
node scripts/seed-catalogs.js; echo "EXIT=$?"
SPEC=p5-descent node scripts/seed-map.js; echo "EXIT=$?"
SPEC=vale-region node scripts/seed-map.js; echo "EXIT=$?"
FORCE=1 node scripts/seed-passive-tree.js; echo "EXIT=$?"
```

Expected: every `EXIT=0`.

- [ ] **Step 3: Record the baseline on the untouched branch**

```bash
npm test > /tmp/s3-baseline.txt 2>&1; echo "EXIT=$?"
grep -c '^not ok' /tmp/s3-baseline.txt
```

Record the exit code and the `not ok` list in the PR description. Every later "green" is judged against this baseline. The baseline is judged on its FIRST run against a freshly seeded DB.

---

### Task 1: `aura_effects` table, CHECKs, pack_leader seed, `entity_types.auras`, Champion bind

**Files:**
- Create: `backend/migrations/1714440680000_aura_effects.js`
- Create: `backend/tests/migration_aura_effects.test.js`
- Create: `backend/tests/aura_effects_schema_db.test.js`

**Interfaces:**
- Produces: table `aura_effects(id, name UNIQUE, target_side, radius, damage_mult, defense_mult, speed_mult, dot_dps, dot_element→elements(name), tick_ms, shape, color, pulse_ms, particle_count, particle_spread, particle_speed, particle_gravity, particle_lifetime_ms, particle_size, created_at, updated_at)`.
- Produces: column `entity_types.auras jsonb NULL`.
- Produces: row `pack_leader`.

- [ ] **Step 1: Write the failing shape test**

```js
// backend/tests/migration_aura_effects.test.js
const test = require('node:test');
const assert = require('node:assert');

// Records the SQL the migration issues, so the shape is asserted without a
// live DB (same pattern as migration_vfx_effects.test.js). The DB test next to
// this one proves the SQL actually runs.
function fakePgm() {
  const sql = [];
  return { sql: (s) => sql.push(s), calls: sql };
}
const mig = require('../migrations/1714440680000_aura_effects.js');
const upSql = () => { const p = fakePgm(); mig.up(p); return p.calls.join('\n'); };

test('creates aura_effects with every spec §3.2 column', () => {
  const s = upSql();
  for (const col of ['name', 'target_side', 'radius', 'damage_mult', 'defense_mult', 'speed_mult',
    'dot_dps', 'dot_element', 'tick_ms', 'shape', 'color', 'pulse_ms', 'particle_count',
    'particle_spread', 'particle_speed', 'particle_gravity', 'particle_lifetime_ms', 'particle_size']) {
    assert.match(s, new RegExp(`\\b${col}\\b`), `missing column ${col}`);
  }
  assert.match(s, /CREATE TABLE aura_effects/);
});

test('every enum and bound is a CHECK, with the spec vocabulary written literally', () => {
  const s = upSql();
  assert.match(s, /target_side IN \('allies', 'enemies'\)/);
  assert.match(s, /shape IN \('ring', 'disc', 'particles'\)/);
  assert.match(s, /radius > 0 AND radius <= 2000/);
  assert.match(s, /tick_ms BETWEEN 100 AND 5000/);
  assert.match(s, /damage_mult > 0/);
  assert.match(s, /particle_count >= 0 AND particle_count <= 64/);
  assert.match(s, /REFERENCES elements\(name\)/);
  // An allies-side aura with a DoT would damage its own pack.
  assert.match(s, /target_side = 'enemies' OR dot_dps = 0/);
});

test('entity_types.auras is added IF NOT EXISTS (S1 adds the same column)', () => {
  assert.match(upSql(), /ALTER TABLE entity_types ADD COLUMN IF NOT EXISTS auras jsonb/);
});

test('pack_leader is copied from Champion and bound to every Champion entity', () => {
  const s = upSql();
  assert.match(s, /FROM creature_behaviors WHERE name = 'Champion' AND aura_radius > 0/);
  assert.match(s, /'pack_leader'/);
  assert.match(s, /b\.name = 'Champion'/);
  assert.match(s, /NOT \(COALESCE\(e\.auras, '\[\]'::jsonb\) \? 'pack_leader'\)/);
});

test('down drops the table but never the shared auras column', () => {
  const p = fakePgm(); mig.down(p); const s = p.calls.join('\n');
  assert.match(s, /DROP TABLE IF EXISTS aura_effects/);
  // S1 owns entity_types.auras too; dropping it here would destroy S1's data.
  assert.doesNotMatch(s, /DROP COLUMN[\s\S]*auras/);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd backend && node --test tests/migration_aura_effects.test.js; echo "EXIT=$?"`

Expected: FAIL with `Cannot find module '../migrations/1714440680000_aura_effects.js'`, `EXIT=1`.

- [ ] **Step 3: Write the migration**

```js
// backend/migrations/1714440680000_aura_effects.js
exports.shorthands = undefined;

// SOMET-604 (S3). The aura LIBRARY. Until now an aura was four columns on
// creature_behaviors (1714440085000), one per behaviour, ally-only. This table
// lets any entity carry any number of auras by NAME (entity_types.auras, jsonb,
// no FK -- the same trade-off as vfx: an unknown name is a no-op + one log).
//
// Every enum and bound is a CHECK. The API (services/auraEffects.js) and the
// form (auraForm.js) repeat the same rules on purpose: the DB is the backstop,
// the API names the problem, the form names it before a round trip.
//
// radius <= 2000: the aura pass is O(sources x creatures). A typo'd 26000
// would buff a whole world; 2000 is ~8x Champion's 260.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE aura_effects (
      id serial PRIMARY KEY,
      name text NOT NULL UNIQUE,
      target_side text NOT NULL DEFAULT 'allies',
      radius real NOT NULL,
      damage_mult real NOT NULL DEFAULT 1,
      defense_mult real NOT NULL DEFAULT 1,
      speed_mult real NOT NULL DEFAULT 1,
      dot_dps real NOT NULL DEFAULT 0,
      dot_element text NOT NULL DEFAULT 'physical'
        REFERENCES elements(name) ON UPDATE CASCADE ON DELETE RESTRICT,
      tick_ms integer NOT NULL DEFAULT 1000,
      shape text NOT NULL DEFAULT 'ring',
      color text NOT NULL DEFAULT '#d4a017',
      pulse_ms integer NOT NULL DEFAULT 1200,
      particle_count integer NOT NULL DEFAULT 0,
      particle_spread real NOT NULL DEFAULT 6.283,
      particle_speed real NOT NULL DEFAULT 100,
      particle_gravity real NOT NULL DEFAULT 0,
      particle_lifetime_ms integer NOT NULL DEFAULT 300,
      particle_size real NOT NULL DEFAULT 2,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT aura_effects_name_check CHECK (length(btrim(name)) > 0 AND length(name) <= 200),
      CONSTRAINT aura_effects_side_check CHECK (target_side IN ('allies', 'enemies')),
      CONSTRAINT aura_effects_radius_check CHECK (radius > 0 AND radius <= 2000),
      CONSTRAINT aura_effects_mult_check CHECK (damage_mult > 0 AND defense_mult > 0 AND speed_mult > 0),
      CONSTRAINT aura_effects_dot_check CHECK (dot_dps >= 0),
      CONSTRAINT aura_effects_dot_side_check CHECK (target_side = 'enemies' OR dot_dps = 0),
      CONSTRAINT aura_effects_tick_check CHECK (tick_ms BETWEEN 100 AND 5000),
      CONSTRAINT aura_effects_shape_check CHECK (shape IN ('ring', 'disc', 'particles')),
      CONSTRAINT aura_effects_color_check CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
      CONSTRAINT aura_effects_pulse_check CHECK (pulse_ms >= 0 AND pulse_ms <= 10000),
      CONSTRAINT aura_effects_particle_count_check CHECK (particle_count >= 0 AND particle_count <= 64),
      CONSTRAINT aura_effects_particle_lifetime_check CHECK (particle_lifetime_ms > 0),
      CONSTRAINT aura_effects_particle_size_check CHECK (particle_size >= 0)
    )
  `);

  // S1 adds the same column on its own branch. IF NOT EXISTS makes the two
  // migrations commute.
  pgm.sql('ALTER TABLE entity_types ADD COLUMN IF NOT EXISTS auras jsonb');

  // pack_leader = Champion's CURRENT values (an admin may have retuned them),
  // read from the row rather than retyped. The second INSERT is the floor for a
  // DB where Champion was deleted or had its aura switched off: the library
  // must still hold pack_leader, because the seeder binds it by name.
  pgm.sql(`
    INSERT INTO aura_effects (name, target_side, radius, damage_mult, defense_mult, speed_mult)
    SELECT 'pack_leader', 'allies', aura_radius, aura_damage_mult, aura_defense_mult, aura_speed_mult
      FROM creature_behaviors WHERE name = 'Champion' AND aura_radius > 0
    ON CONFLICT (name) DO NOTHING
  `);
  pgm.sql(`
    INSERT INTO aura_effects (name, target_side, radius, damage_mult, defense_mult, speed_mult)
    VALUES ('pack_leader', 'allies', 260, 1.25, 1.2, 1.1)
    ON CONFLICT (name) DO NOTHING
  `);

  // Bind it to every entity whose behaviour is a LIVE Champion aura. Appends
  // rather than overwrites, so an S1-authored binding survives.
  pgm.sql(`
    UPDATE entity_types e
       SET auras = COALESCE(e.auras, '[]'::jsonb) || '["pack_leader"]'::jsonb
      FROM creature_behaviors b
     WHERE b.id = e.behavior_id AND b.name = 'Champion' AND b.aura_radius > 0
       AND NOT (COALESCE(e.auras, '[]'::jsonb) ? 'pack_leader')
  `);
};

exports.down = (pgm) => {
  // entity_types.auras is deliberately left in place: S1 owns it too, and the
  // drop would destroy S1's bindings. Only this slice's own table goes.
  pgm.sql("UPDATE entity_types SET auras = auras - 'pack_leader' WHERE auras ? 'pack_leader'");
  pgm.sql('DROP TABLE IF EXISTS aura_effects');
};
```

- [ ] **Step 4: Run the shape test and see it pass**

Run: `cd backend && node --test tests/migration_aura_effects.test.js; echo "EXIT=$?"`

Expected: PASS, `EXIT=0`.

- [ ] **Step 5: Write the failing DB test (scratch DB only)**

```js
// backend/tests/aura_effects_schema_db.test.js
// Real-DB guards for 1714440680000. Gated on TEST_DATABASE_URL (never the dev
// DB). READ-ONLY except for statements wrapped in a transaction that is
// always ROLLED BACK -- nothing here persists.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to touch a real database' : false;

async function rejects(pool, sql, params, constraint) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await assert.rejects(c.query(sql, params), (e) => e.constraint === constraint || e.code === '23503',
      `expected ${constraint}`);
  } finally { await c.query('ROLLBACK'); c.release(); }
}

test('aura_effects schema', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url, max: 2 });
  t.after(() => pool.end());

  await t.test('pack_leader holds Champion\'s 2026-10-10 values', async () => {
    const r = await pool.query("SELECT * FROM aura_effects WHERE name = 'pack_leader'");
    assert.strictEqual(r.rowCount, 1);
    const a = r.rows[0];
    assert.strictEqual(a.target_side, 'allies');
    assert.strictEqual(a.radius, 260);
    assert.strictEqual(a.damage_mult, 1.25);
    assert.ok(Math.abs(a.defense_mult - 1.2) < 1e-6);   // real column: 1.2 is not exact in float4
    assert.ok(Math.abs(a.speed_mult - 1.1) < 1e-6);
    assert.strictEqual(a.dot_dps, 0);
  });

  const ins = `INSERT INTO aura_effects (name, target_side, radius, damage_mult, tick_ms, dot_dps, dot_element, shape, color)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`;
  const ok = ['zzAura', 'allies', 100, 1, 1000, 0, 'physical', 'ring', '#aabbcc'];
  const bad = (i, v) => { const p = [...ok]; p[i] = v; return p; };

  await t.test('radius 0, negative and 26000 are refused', async () => {
    await rejects(pool, ins, bad(2, 0), 'aura_effects_radius_check');
    await rejects(pool, ins, bad(2, -5), 'aura_effects_radius_check');
    await rejects(pool, ins, bad(2, 26000), 'aura_effects_radius_check');
  });
  await t.test('a zero multiplier is refused', async () => {
    await rejects(pool, ins, bad(3, 0), 'aura_effects_mult_check');
  });
  await t.test('tick_ms outside 100..5000 is refused', async () => {
    await rejects(pool, ins, bad(4, 50), 'aura_effects_tick_check');
    await rejects(pool, ins, bad(4, 6000), 'aura_effects_tick_check');
  });
  await t.test('an allies aura with a DoT is refused', async () => {
    await rejects(pool, ins, bad(5, 4), 'aura_effects_dot_side_check');
  });
  await t.test('an unknown element is refused by the FK', async () => {
    const p = bad(1, 'enemies'); p[6] = 'plasma';
    await rejects(pool, ins, p, 'aura_effects_dot_element_fkey');
  });
  await t.test('unknown shape / side / colour are refused', async () => {
    await rejects(pool, ins, bad(7, 'cone'), 'aura_effects_shape_check');
    await rejects(pool, ins, bad(1, 'neutral'), 'aura_effects_side_check');
    await rejects(pool, ins, bad(8, 'gold'), 'aura_effects_color_check');
  });
  await t.test('the valid row itself is accepted (proves the negatives are not vacuous)', async () => {
    const c = await pool.connect();
    try { await c.query('BEGIN'); await c.query(ins, ok); } finally { await c.query('ROLLBACK'); c.release(); }
  });
});
```

- [ ] **Step 6: Run it against the not-yet-migrated scratch DB and see it fail**

Run: `cd backend && node --test tests/aura_effects_schema_db.test.js; echo "EXIT=$?"`

Expected: FAIL with `relation "aura_effects" does not exist`.

- [ ] **Step 7: Apply the migration to the scratch DB and re-run**

```bash
npm run migrate -- up; echo "EXIT=$?"
node --test tests/aura_effects_schema_db.test.js; echo "EXIT=$?"
```

Expected: both `EXIT=0`.

The Champion-bind assertion needs entity rows, which the seeder creates after the migration. Task 3 owns it, so it is not asserted here.

- [ ] **Step 8: Commit**

```bash
git add backend/migrations/1714440680000_aura_effects.js backend/tests/migration_aura_effects.test.js backend/tests/aura_effects_schema_db.test.js
git commit -m "feat(auras): aura_effects library table and pack_leader seed (SOMET-604)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Pure aura service: vocabulary, validator, resolvers, loader fragment

**Files:**
- Create: `backend/src/services/auraEffects.js`
- Create: `backend/tests/aura_effects_service.test.js`

**Interfaces (Produces):**
- `AURA_SIDES = ['allies','enemies']`, `AURA_SHAPES = ['ring','disc','particles']`, `AURA_LIMITS = { maxRadius: 2000, minTickMs: 100, maxTickMs: 5000, maxPulseMs: 10000, maxParticles: 64, maxNameLen: 200 }`
- `auraEffectError(body) → string|null`
- `resolveAuraDef(row) → { name, targetSide, radius, damageMult, defenseMult, speedMult, dotDps, dotElement, tickMs } | null`
- `resolveInstanceAuras(c, warn = console.warn) → AuraDef[]`
- `__resetAuraWarnings()`
- `AURAS_LATERAL` (SQL string; the entity alias is `et`)

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/aura_effects_service.test.js
const test = require('node:test');
const assert = require('node:assert');
const {
  AURA_SIDES, AURA_SHAPES, auraEffectError, resolveAuraDef, resolveInstanceAuras,
  __resetAuraWarnings, AURAS_LATERAL,
} = require('../src/services/auraEffects.js');

const VALID = { name: 'pack_leader', target_side: 'allies', radius: 260, damage_mult: 1.25,
  defense_mult: 1.2, speed_mult: 1.1, dot_dps: 0, dot_element: 'physical', tick_ms: 1000,
  shape: 'ring', color: '#d4a017', pulse_ms: 1200, particle_count: 0, particle_lifetime_ms: 300, particle_size: 2 };

test('vocabulary matches the migration CHECKs, written literally', () => {
  assert.deepStrictEqual(AURA_SIDES, ['allies', 'enemies']);
  assert.deepStrictEqual(AURA_SHAPES, ['ring', 'disc', 'particles']);
});

test('a valid body passes (so every rejection below is meaningful)', () => {
  assert.strictEqual(auraEffectError(VALID), null);
});

for (const [field, value, re] of [
  ['name', '  ', /name is required/],
  ['radius', 0, /radius must be greater than 0 and at most 2000/],
  ['radius', -1, /radius/],
  ['radius', 26000, /radius/],
  ['radius', '260px', /radius/],
  ['damage_mult', 0, /damage_mult must be greater than 0/],
  ['speed_mult', -0.5, /speed_mult/],
  ['tick_ms', 50, /tick_ms must be a whole number between 100 and 5000/],
  ['tick_ms', 250.5, /tick_ms/],
  ['target_side', 'neutral', /target_side must be one of allies, enemies/],
  ['shape', 'cone', /shape must be one of ring, disc, particles/],
  ['color', 'gold', /color must be a #rrggbb hex colour/],
  ['particle_count', 65, /particle_count must be a whole number between 0 and 64/],
  ['pulse_ms', -1, /pulse_ms/],
  ['dot_dps', -2, /dot_dps must be 0 or greater/],
]) {
  test(`rejects ${field}=${JSON.stringify(value)}`, () => {
    assert.match(auraEffectError({ ...VALID, [field]: value }) || '', re);
  });
}

test('an allies aura may not carry a DoT', () => {
  assert.match(auraEffectError({ ...VALID, dot_dps: 3 }), /only an enemies aura can deal damage over time/);
  assert.strictEqual(auraEffectError({ ...VALID, target_side: 'enemies', dot_dps: 3 }), null);
});

test('resolveAuraDef maps a json_build_object row to camelCase', () => {
  assert.deepStrictEqual(resolveAuraDef({ name: 'pack_leader', target_side: 'allies', radius: 260,
    damage_mult: 1.25, defense_mult: 1.2, speed_mult: 1.1, dot_dps: 0, dot_element: 'physical', tick_ms: 1000 }),
  { name: 'pack_leader', targetSide: 'allies', radius: 260, damageMult: 1.25, defenseMult: 1.2,
    speedMult: 1.1, dotDps: 0, dotElement: 'physical', tickMs: 1000 });
});

test('resolveAuraDef drops a row that would be inert or poisonous', () => {
  assert.strictEqual(resolveAuraDef({ name: 'x', target_side: 'allies', radius: 0 }), null);
  assert.strictEqual(resolveAuraDef({ name: 'x', target_side: 'sideways', radius: 10 }), null);
  // NULL multiplier must NOT become Number(null) = 0 (a follower that deals nothing).
  assert.strictEqual(resolveAuraDef({ name: 'x', target_side: 'allies', radius: 10, damage_mult: null }).damageMult, 1);
});

test('loader row: unknown bound name is skipped and logged ONCE per name', () => {
  __resetAuraWarnings();
  const logs = [];
  const warn = (m) => logs.push(m);
  const row = { type: 'Beast Champion', aura_names: ['pack_leader', 'ghost_aura'],
    aura_defs: [{ name: 'pack_leader', target_side: 'allies', radius: 260, damage_mult: 1.25,
      defense_mult: 1.2, speed_mult: 1.1 }] };
  const a = resolveInstanceAuras(row, warn);
  resolveInstanceAuras({ ...row, type: 'Cave Champion' }, warn);
  assert.deepStrictEqual(a.map((d) => d.name), ['pack_leader']);
  assert.strictEqual(logs.length, 1, 'one log line per unknown name, not one per creature');
  assert.match(logs[0], /ghost_aura/);
});

test('NULL and [] both resolve to no auras, without logging', () => {
  __resetAuraWarnings();
  const logs = [];
  assert.deepStrictEqual(resolveInstanceAuras({ aura_names: null, aura_defs: [] }, (m) => logs.push(m)), []);
  assert.deepStrictEqual(resolveInstanceAuras({ aura_names: [], aura_defs: [] }, (m) => logs.push(m)), []);
  assert.deepStrictEqual(resolveInstanceAuras({}, (m) => logs.push(m)), []);
  assert.strictEqual(logs.length, 0);
});

test('an already-resolved fixture array is copied, not shared', () => {
  const src = [{ name: 'a', targetSide: 'allies', radius: 10, damageMult: 2, defenseMult: 1, speedMult: 1 }];
  const out = resolveInstanceAuras({ auras: src });
  assert.notStrictEqual(out[0], src[0]);
  assert.strictEqual(out[0].damageMult, 2);
});

test('AURAS_LATERAL resolves names through the jsonb ? operator and orders by name', () => {
  assert.match(AURAS_LATERAL, /LEFT JOIN LATERAL/);
  assert.match(AURAS_LATERAL, /FROM aura_effects ae/);
  assert.match(AURAS_LATERAL, /et\.auras \? ae\.name/);
  assert.match(AURAS_LATERAL, /ORDER BY ae\.name/);
  assert.match(AURAS_LATERAL, /AS aura_defs/);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd backend && node --test tests/aura_effects_service.test.js; echo "EXIT=$?"`

Expected: FAIL with `Cannot find module '../src/services/auraEffects.js'`.

- [ ] **Step 3: Write the service**

```js
// backend/src/services/auraEffects.js
// SOMET-604 (S3). Everything about an aura that is not a database or a tick:
// the vocabulary, the API validator, the row -> runtime resolver, and the ONE
// SQL fragment the live creature loader uses to resolve entity_types.auras.
//
// The vocabulary repeats the CHECKs in 1714440680000_aura_effects.js on
// purpose (DB = backstop, this = a readable 400). frontend auraForm.js is
// tested AGAINST this module so the three copies cannot drift.
const AURA_SIDES = ['allies', 'enemies'];
const AURA_SHAPES = ['ring', 'disc', 'particles'];
const AURA_LIMITS = Object.freeze({
  maxRadius: 2000, minTickMs: 100, maxTickMs: 5000, maxPulseMs: 10000, maxParticles: 64, maxNameLen: 200,
});
const HEX = /^#[0-9a-fA-F]{6}$/;

// A real number or a numeric string -- NOT Number(): Number('') / Number(null)
// are 0 and Number('260px') is NaN, and a blank field must not become a radius 0.
function asNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}
const isInt = (n) => Number.isInteger(n);

function auraEffectError(b) {
  if (!b || typeof b !== 'object') return 'body must be an object';
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return 'name is required';
  if (name.length > AURA_LIMITS.maxNameLen) return `name must be ${AURA_LIMITS.maxNameLen} characters or fewer`;
  if (!AURA_SIDES.includes(b.target_side)) return `target_side must be one of ${AURA_SIDES.join(', ')}`;
  const r = asNum(b.radius);
  if (!(r > 0 && r <= AURA_LIMITS.maxRadius)) return `radius must be greater than 0 and at most ${AURA_LIMITS.maxRadius}`;
  for (const f of ['damage_mult', 'defense_mult', 'speed_mult']) {
    if (b[f] != null && !(asNum(b[f]) > 0)) return `${f} must be greater than 0`;
  }
  if (b.dot_dps != null && !(asNum(b.dot_dps) >= 0)) return 'dot_dps must be 0 or greater';
  if (b.target_side === 'allies' && asNum(b.dot_dps ?? 0) > 0) {
    return 'only an enemies aura can deal damage over time';
  }
  if (b.tick_ms != null) {
    const t = asNum(b.tick_ms);
    if (!isInt(t) || t < AURA_LIMITS.minTickMs || t > AURA_LIMITS.maxTickMs) {
      return `tick_ms must be a whole number between ${AURA_LIMITS.minTickMs} and ${AURA_LIMITS.maxTickMs}`;
    }
  }
  if (b.shape != null && !AURA_SHAPES.includes(b.shape)) return `shape must be one of ${AURA_SHAPES.join(', ')}`;
  if (b.color != null && !HEX.test(b.color)) return 'color must be a #rrggbb hex colour';
  if (b.pulse_ms != null) {
    const p = asNum(b.pulse_ms);
    if (!isInt(p) || p < 0 || p > AURA_LIMITS.maxPulseMs) return `pulse_ms must be a whole number between 0 and ${AURA_LIMITS.maxPulseMs}`;
  }
  if (b.particle_count != null) {
    const n = asNum(b.particle_count);
    if (!isInt(n) || n < 0 || n > AURA_LIMITS.maxParticles) return `particle_count must be a whole number between 0 and ${AURA_LIMITS.maxParticles}`;
  }
  if (b.particle_lifetime_ms != null && !(asNum(b.particle_lifetime_ms) > 0)) return 'particle_lifetime_ms must be greater than 0';
  if (b.particle_size != null && !(asNum(b.particle_size) >= 0)) return 'particle_size must be 0 or greater';
  for (const f of ['particle_spread', 'particle_speed', 'particle_gravity']) {
    if (b[f] != null && !Number.isFinite(asNum(b[f]))) return `${f} must be a number`;
  }
  return null;
}

// Mult fallback is 1, never 0: same trap creatureBehaviors.js documents.
function num(v, fallback) {
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// One json_build_object row from AURAS_LATERAL -> the runtime shape, or null
// for a row that cannot do anything sane (no name, unknown side, radius <= 0).
function resolveAuraDef(row) {
  if (!row || typeof row.name !== 'string' || !row.name) return null;
  if (!AURA_SIDES.includes(row.target_side)) return null;
  const radius = num(row.radius, 0);
  if (!(radius > 0)) return null;
  return {
    name: row.name,
    targetSide: row.target_side,
    radius,
    damageMult: num(row.damage_mult, 1),
    defenseMult: num(row.defense_mult, 1),
    speedMult: num(row.speed_mult, 1),
    dotDps: num(row.dot_dps, 0),
    dotElement: typeof row.dot_element === 'string' ? row.dot_element : 'physical',
    tickMs: num(row.tick_ms, 1000),
  };
}

// Unknown-name warnings are once per NAME per process: 32 Champions binding a
// deleted aura must produce one line, not 32 per chunk load.
const warnedUnknown = new Set();
function __resetAuraWarnings() { warnedUnknown.clear(); }

// The single place an instance's auras are decided (addCreatures calls it),
// mirroring resolveInstanceBehavior's priority:
//  1. a loader row (aura_defs present) -- the live path, CREATURE_JOINED_SELECT;
//  2. an already-resolved camelCase `auras` array (test fixtures; S1's hydration);
//  3. nothing -> [].
function resolveInstanceAuras(c, warn = console.warn) {
  if (Array.isArray(c.aura_defs)) {
    const defs = c.aura_defs.map(resolveAuraDef).filter(Boolean);
    const known = new Set(defs.map((d) => d.name));
    const names = Array.isArray(c.aura_names) ? c.aura_names : [];
    for (const n of names) {
      if (typeof n === 'string' && !known.has(n) && !warnedUnknown.has(n)) {
        warnedUnknown.add(n);
        warn(`[auras] entity type "${c.type}" binds unknown aura "${n}" -- ignored`);
      }
    }
    return defs;
  }
  if (Array.isArray(c.auras)) {
    return c.auras
      .filter((a) => a && typeof a === 'object' && AURA_SIDES.includes(a.targetSide) && a.radius > 0)
      .map((a) => ({ damageMult: 1, defenseMult: 1, speedMult: 1, dotDps: 0, dotElement: 'physical', tickMs: 1000, ...a }));
  }
  return [];
}

// Appended to CREATURE_JOINED_SELECT after ABILITIES_LATERAL. `et` is the
// entity_types alias there. jsonb `?` = "array contains this string", so a
// NULL or [] auras column matches nothing and yields '[]'. The dot_* fields
// ride along now so S4 adds no second loader.
const AURAS_LATERAL = `
         LEFT JOIN LATERAL (
           SELECT COALESCE(json_agg(json_build_object(
                    'name', ae.name, 'target_side', ae.target_side, 'radius', ae.radius,
                    'damage_mult', ae.damage_mult, 'defense_mult', ae.defense_mult,
                    'speed_mult', ae.speed_mult, 'dot_dps', ae.dot_dps,
                    'dot_element', ae.dot_element, 'tick_ms', ae.tick_ms
                  ) ORDER BY ae.name), '[]'::json) AS aura_defs
             FROM aura_effects ae
            WHERE jsonb_typeof(et.auras) = 'array' AND et.auras ? ae.name
         ) au ON true`;

module.exports = {
  AURA_SIDES, AURA_SHAPES, AURA_LIMITS,
  auraEffectError, resolveAuraDef, resolveInstanceAuras, __resetAuraWarnings, AURAS_LATERAL,
};
```

- [ ] **Step 4: Run it and see it pass**

Run: `cd backend && node --test tests/aura_effects_service.test.js; echo "EXIT=$?"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/auraEffects.js backend/tests/aura_effects_service.test.js
git commit -m "feat(auras): aura validator, resolver and loader fragment (SOMET-604)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Seeder: library floor + default bindings (fresh DB / staging parity)

**Files:**
- Create: `backend/seeds/data/auraEffects.js`
- Modify: `backend/scripts/seed-catalogs.js` (add `seedOneAura`, `bindDefaultAuras`; call both in `seedCatalogs` after the creature-type loop at `:538-540`; export both at `:582`)
- Create: `backend/tests/seed_auras_db.test.js`

**Interfaces:**
- Produces: `seedOneAura(pool, a) → rowCount`
- Produces: `bindDefaultAuras(pool) → number` (rows bound)
- Produces: `AURA_EFFECTS`, `BEHAVIOR_DEFAULT_AURAS = { Champion: ['pack_leader'] }`

- [ ] **Step 1: Write the failing DB test**

```js
// backend/tests/seed_auras_db.test.js
// Proves a FRESH database (staging) ends up with the Champion aura even though
// migration 1714440680000 ran before seed-catalogs created any Champion entity,
// and that an admin's explicit [] survives a reseed. Scratch DB only. Mutates
// ONE row ('Beast Champion'.auras), captured first and restored in t.after.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { bindDefaultAuras, seedCatalogs } = require('../scripts/seed-catalogs.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to touch a real database' : false;

test('seeded auras', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url, max: 2 });
  t.after(() => pool.end());
  const before = await pool.query("SELECT auras FROM entity_types WHERE name = 'Beast Champion'");
  assert.strictEqual(before.rowCount, 1, 'scratch DB must be seeded (Task 0)');
  t.after(() => pool.query("UPDATE entity_types SET auras = $1::jsonb WHERE name = 'Beast Champion'",
    [before.rows[0].auras == null ? null : JSON.stringify(before.rows[0].auras)]));

  await t.test('every Champion-behaviour entity carries pack_leader after a seed', async () => {
    await seedCatalogs(pool);
    const r = await pool.query(`
      SELECT count(*)::int AS n,
             count(*) FILTER (WHERE e.auras ? 'pack_leader')::int AS bound
        FROM entity_types e JOIN creature_behaviors b ON b.id = e.behavior_id
       WHERE b.name = 'Champion'`);
    assert.ok(r.rows[0].n >= 32, `expected the 32 seeded Champions, got ${r.rows[0].n}`);
    assert.strictEqual(r.rows[0].bound, r.rows[0].n);
  });

  await t.test('NULL is re-bound by a reseed', async () => {
    await pool.query("UPDATE entity_types SET auras = NULL WHERE name = 'Beast Champion'");
    await bindDefaultAuras(pool);
    const r = await pool.query("SELECT auras FROM entity_types WHERE name = 'Beast Champion'");
    assert.deepStrictEqual(r.rows[0].auras, ['pack_leader']);
  });

  await t.test('an admin\'s explicit [] survives a reseed', async () => {
    await pool.query("UPDATE entity_types SET auras = '[]'::jsonb WHERE name = 'Beast Champion'");
    await bindDefaultAuras(pool);
    const r = await pool.query("SELECT auras FROM entity_types WHERE name = 'Beast Champion'");
    assert.deepStrictEqual(r.rows[0].auras, [], 'reseed must not undo a deliberate removal');
  });

  await t.test('a non-Champion entity is never bound', async () => {
    const r = await pool.query(`
      SELECT count(*)::int AS n FROM entity_types e LEFT JOIN creature_behaviors b ON b.id = e.behavior_id
       WHERE e.auras ? 'pack_leader' AND b.name IS DISTINCT FROM 'Champion'`);
    assert.strictEqual(r.rows[0].n, 0);
  });

  await t.test('the library row is restored on a DB that lost it', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("UPDATE entity_types SET auras = NULL WHERE auras ? 'pack_leader'");
      await c.query("DELETE FROM aura_effects WHERE name = 'pack_leader'");
      const { seedOneAura } = require('../scripts/seed-catalogs.js');
      const { AURA_EFFECTS } = require('../seeds/data/auraEffects.js');
      for (const a of AURA_EFFECTS) await seedOneAura(c, a);
      const r = await c.query("SELECT radius, damage_mult FROM aura_effects WHERE name = 'pack_leader'");
      assert.strictEqual(r.rows[0].radius, 260);
      assert.strictEqual(r.rows[0].damage_mult, 1.25);
    } finally { await c.query('ROLLBACK'); c.release(); }
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd backend && node --test tests/seed_auras_db.test.js; echo "EXIT=$?"`

Expected: FAIL. The first assertion shows `bound` 0 versus `n` 32, because on the scratch DB the migration ran before the seeder created the Champions. (If the `bindDefaultAuras` import fails first, that error is also an acceptable FAIL.)

- [ ] **Step 3: Implement the seed data and seeder**

```js
// backend/seeds/data/auraEffects.js
// SOMET-604 (S3). The aura library floor seed-catalogs restores, and the
// behaviour -> default aura bindings it applies to entities whose auras are
// NULL ("never authored"). [] is an admin's explicit "no auras" and is never
// touched. Values are Champion's as of 2026-10-10 (1714440085000).
const AURA_EFFECTS = [
  { name: 'pack_leader', target_side: 'allies', radius: 260, damage_mult: 1.25, defense_mult: 1.2,
    speed_mult: 1.1, shape: 'ring', color: '#d4a017', pulse_ms: 1200 },
];
const BEHAVIOR_DEFAULT_AURAS = { Champion: ['pack_leader'] };
module.exports = { AURA_EFFECTS, BEHAVIOR_DEFAULT_AURAS };
```

In `backend/scripts/seed-catalogs.js`:
- add `const { AURA_EFFECTS, BEHAVIOR_DEFAULT_AURAS } = require('../seeds/data/auraEffects.js');` next to the `CREATURE_BEHAVIORS` require at `:19`;
- add the two functions above `seedCatalogs`;
- call `for (const a of AURA_EFFECTS) await seedOneAura(pool, a);` **before** the creature-type loop;
- call `const aurasBound = await bindDefaultAuras(pool);` **after** it, and log it;
- add both to `module.exports`.

```js
// DO NOTHING: an admin retuning pack_leader in the Aura Effects tab must not be
// reset by a reseed (same posture as seedOneCreatureType).
async function seedOneAura(db, a) {
  const r = await db.query(
    `INSERT INTO aura_effects (name, target_side, radius, damage_mult, defense_mult, speed_mult, shape, color, pulse_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (name) DO NOTHING`,
    [a.name, a.target_side, a.radius, a.damage_mult ?? 1, a.defense_mult ?? 1, a.speed_mult ?? 1,
     a.shape ?? 'ring', a.color ?? '#d4a017', a.pulse_ms ?? 1200],
  );
  return r.rowCount;
}

// Runs AFTER the creature types exist: migration 1714440680000 binds Champions
// on an existing DB, but on a fresh one (staging) it runs before any Champion
// entity is created and binds nothing. `auras IS NULL` only -- [] is an
// admin's deliberate removal and must survive every reseed.
async function bindDefaultAuras(db) {
  let n = 0;
  for (const [behaviorName, auras] of Object.entries(BEHAVIOR_DEFAULT_AURAS)) {
    const r = await db.query(
      `UPDATE entity_types e SET auras = $2::jsonb
         FROM creature_behaviors b
        WHERE b.id = e.behavior_id AND b.name = $1 AND e.auras IS NULL`,
      [behaviorName, JSON.stringify(auras)],
    );
    n += r.rowCount;
  }
  return n;
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `cd backend && node --test tests/seed_auras_db.test.js; echo "EXIT=$?"`

Expected: PASS.

- [ ] **Step 5: Run the neighbouring seed suite to check for regressions**

Run: `cd backend && node --test tests/seed_catalogs_db.test.js tests/entity_types_seed.test.js; echo "EXIT=$?"`

Expected: `EXIT=0`.

- [ ] **Step 6: Commit**

```bash
git add backend/seeds/data/auraEffects.js backend/scripts/seed-catalogs.js backend/tests/seed_auras_db.test.js
git commit -m "feat(auras): seed aura library and bind default auras after creatures (SOMET-604)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `applyAuras` reads entity auras; golden parity; invoked-from-tick

**Precondition:** `git diff main -- backend/src/authority/creatures.js backend/src/services/creatureBehaviors.js` must be EMPTY. The golden fixture has to be recorded on unchanged sim code.

**Files:**
- Create: `backend/tests/helpers/championAuraTrace.js`
- Create: `backend/tests/fixtures/champion_aura_golden.json` (recorded, then never regenerated)
- Create: `backend/tests/champion_aura_golden.test.js`
- Modify: `backend/src/authority/creatures.js` (import `resolveInstanceAuras`; `addCreatures` at `:1179-1215` stamps `auras: resolveInstanceAuras(c)`; replace `computeAuras` `:952-997` with `applyAuras`; tick call `:1342`; export `:2514-2517`)
- Modify: `backend/src/authority/server.js:367-386` (`CREATURE_JOINED_SELECT` gains `et.auras AS aura_names, au.aura_defs` and `${AURAS_LATERAL}`; `b.aura_*` stays until Task 5)
- Rewrite: `backend/tests/authority_creature_auras.test.js` (new input shape, same literal expectations)
- Modify: `backend/tests/creature_mechanics_wiring.test.js:61-94` (loader row carries `aura_names`/`aura_defs`)
- Modify: `backend/tests/authority_creatures_integration.test.js` (SELECT guard for `aura_names`/`aura_defs`/`aura_effects`)
- Create: `backend/tests/aura_loader_db.test.js`

**Interfaces:**
- Consumes: `resolveInstanceAuras`, `AURAS_LATERAL` from Task 2.
- Produces: `applyAuras(creatures) → Map<creatureId, {damageMult, defenseMult, speedMult}>` (exported). S4 adds `players`.
- Produces: instance field `c.auras: AuraDef[]`.

- [ ] **Step 1: Write the trace helper with BOTH binders**

```js
// backend/tests/helpers/championAuraTrace.js
// Golden-trace parity for S3 (SOMET-604), modelled on creatureTrace.js. One
// scenario, two ways of saying "this creature is a Champion pack leader":
//   legacyBind -- pre-S3: aura on the BEHAVIOUR (creature_behaviors.aura_*)
//   entityBind -- S3: aura on the ENTITY (entity_types.auras -> aura_effects)
// The fixture is recorded ONCE with legacyBind on unchanged code. After S3,
// entityBind must reproduce it exactly, and legacyBind must NOT (the old
// source is dead).
const { CreatureSim } = require('../../src/authority/creatures.js');

const CHAMPION = { radius: 260, damage: 1.25, defense: 1.2, speed: 1.1 }; // literals, 1714440085000

function legacyBind(row) {
  return { ...row, behavior: { auraRadius: CHAMPION.radius, auraDamageMult: CHAMPION.damage,
    auraDefenseMult: CHAMPION.defense, auraSpeedMult: CHAMPION.speed, chaseStyle: 'hold', aggroRadius: 0 } };
}
function entityBind(row) {
  return { ...row, behavior: { chaseStyle: 'hold', aggroRadius: 0 },
    auras: [{ name: 'pack_leader', targetSide: 'allies', radius: CHAMPION.radius,
      damageMult: CHAMPION.damage, defenseMult: CHAMPION.defense, speedMult: CHAMPION.speed }] };
}

function stubMap() { return { isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }; }

// Two Champions 100px apart (overlapping auras), a follower inside BOTH, one
// inside only L2, one outside both, a guard-faction creature inside both (must
// never be buffed), and a player the in-range followers chase and hit, so the
// damage AND speed buffs reach the trace through hp and position.
function scenario(bind) {
  const sim = new CreatureSim(stubMap(), () => 0.5);
  sim.addCreatures([
    bind({ id: 'L1', type: 'Beast Champion', x: 300, y: 300, hp: 80, damage: 5, faction: 'hostile' }),
    bind({ id: 'L2', type: 'Beast Champion', x: 400, y: 300, hp: 80, damage: 5, faction: 'hostile' }),
    { id: 'both', type: 'Wolf', x: 350, y: 380, hp: 40, damage: 5, faction: 'hostile' },
    { id: 'oneL2', type: 'Wolf', x: 620, y: 300, hp: 40, damage: 5, faction: 'hostile' },
    { id: 'out', type: 'Wolf', x: 300, y: 700, hp: 40, damage: 5, faction: 'hostile' },
    { id: 'guard', type: 'Village Guard', x: 360, y: 320, hp: 60, damage: 5, faction: 'guard',
      home_x: 360, home_y: 320 },
  ]);
  const player = { userId: 'u1', x: 470, y: 450, width: 48, height: 48, hp: 400, mit: null };
  return { sim, players: [player] };
}

const r4 = (n) => Number(Number(n).toFixed(4));
function runChampionTrace(bind, ticks = 80, dt = 0.05) {
  const { sim, players } = scenario(bind);
  const active = new Set(['0,0', '0,1', '1,0', '1,1']);
  const trace = [];
  for (let i = 0; i < ticks; i++) {
    sim.tick(dt, active, players, i * dt);
    trace.push({
      creatures: sim.all().map((c) => ({
        id: c.id, x: r4(c.x), y: r4(c.y), hp: r4(c.hp), mode: c.mode,
        buff: [r4(c._buff.damageMult), r4(c._buff.defenseMult), r4(c._buff.speedMult)],
      })),
      playerHp: r4(players[0].hp),
    });
  }
  return trace;
}

module.exports = { runChampionTrace, legacyBind, entityBind };
```

- [ ] **Step 2: Record the fixture on UNCHANGED code and inspect it**

```bash
cd backend
node -e "const {runChampionTrace,legacyBind}=require('./tests/helpers/championAuraTrace.js');require('fs').writeFileSync('tests/fixtures/champion_aura_golden.json',JSON.stringify(runChampionTrace(legacyBind))+'\n')"
node -e "const g=require('./tests/fixtures/champion_aura_golden.json');const t=g[0].creatures;console.log(JSON.stringify(t.map(c=>[c.id,c.buff])),g.at(-1).playerHp)"
```

Expected, as literals (if the output differs, the scenario is wrong; fix the positions, NOT the expectation):
- `both` → `[1.25,1.2,1.1]` (inside both: max, not product)
- `oneL2` → `[1.25,1.2,1.1]`
- `out` → `[1,1,1]`
- `guard` → `[1,1,1]`
- `L1`/`L2` → `[1.25,1.2,1.1]` (each inside the OTHER's aura, never its own)
- final `playerHp < 400` (the followers landed hits)

If `oneL2` reads `[1,1,1]`, move it closer to L2 (centre distance < 260) and re-record. Record that adjustment in the commit message.

- [ ] **Step 3: Write the failing golden + literal tests**

```js
// backend/tests/champion_aura_golden.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runChampionTrace, legacyBind, entityBind } = require('./helpers/championAuraTrace.js');

// Recorded with legacyBind on pre-S3 code. NEVER regenerate after Task 4 Step 2:
// a fixture that adjusts itself to new behaviour can no longer catch a regression.
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'champion_aura_golden.json'), 'utf8'));

test('entity-bound pack_leader reproduces the pre-S3 Champion trace exactly', () => {
  assert.deepStrictEqual(runChampionTrace(entityBind), golden);
});

test('the behaviour columns no longer drive auras (the old source is dead)', () => {
  assert.notDeepStrictEqual(runChampionTrace(legacyBind), golden,
    'a behaviour-carried aura still buffs -- something still reads behavior.aura*');
});
```

- [ ] **Step 4: Run it and see it fail**

Run: `cd backend && node --test tests/champion_aura_golden.test.js; echo "EXIT=$?"`

Expected: FAIL on BOTH tests. entityBind's `auras` is unread (followers unbuffed, so the trace differs), and legacyBind still matches.

- [ ] **Step 5: Implement `applyAuras` + `addCreatures` + loader**

In `creatures.js`:
- add `const { resolveInstanceAuras } = require('../services/auraEffects.js');`;
- in the `addCreatures` object literal after `behavior: resolveInstanceBehavior(c),` add `auras: resolveInstanceAuras(c),`;
- replace `computeAuras` (`:952-997`) with:

```js
// Ally-side auras (SOMET-253 Task 5, moved to the aura library by SOMET-604).
// Recomputed from scratch every tick and never persisted: a source's death
// removes its buff on the next tick with no cleanup path.
//
// STACKING (spec §3.2):
//   - the SAME aura from several sources -> strongest value per stat (Math.max).
//     Two overlapping Champions stay x1.25, never x1.5625.
//   - DIFFERENT auras -> multiply.
// A source never buffs itself. Enemy-side auras are S4 and are ignored here.
//
// O(sources x creatures); radius is CHECK-bounded to 2000 (1714440680000).
function applyAuras(creatures) {
  const buffs = new Map();
  const sources = [];
  for (const c of creatures) {
    if (!(c.hp > 0) || !Array.isArray(c.auras)) continue;
    for (const a of c.auras) if (a.targetSide === 'allies' && a.radius > 0) sources.push({ c, a });
  }
  if (sources.length === 0) return buffs;
  const perTarget = new Map(); // id -> Map(auraName -> {damageMult, defenseMult, speedMult})
  for (const { c: src, a } of sources) {
    const sc = center(src);
    const r2 = a.radius * a.radius;
    for (const other of creatures) {
      if (other === src || other.hp <= 0) continue;
      if (other.faction !== src.faction) continue;
      const oc = center(other);
      if (dist2(sc.x, sc.y, oc.x, oc.y) > r2) continue;
      let byName = perTarget.get(other.id);
      if (!byName) { byName = new Map(); perTarget.set(other.id, byName); }
      const cur = byName.get(a.name);
      if (!cur) {
        byName.set(a.name, { damageMult: a.damageMult, defenseMult: a.defenseMult, speedMult: a.speedMult });
      } else {
        // Math.max within one aura name -- this line IS the non-stacking rule.
        cur.damageMult = Math.max(cur.damageMult, a.damageMult);
        cur.defenseMult = Math.max(cur.defenseMult, a.defenseMult);
        cur.speedMult = Math.max(cur.speedMult, a.speedMult);
      }
    }
  }
  for (const [id, byName] of perTarget) {
    let d = 1; let f = 1; let s = 1;
    for (const v of byName.values()) { d *= v.damageMult; f *= v.defenseMult; s *= v.speedMult; }
    buffs.set(id, { damageMult: d, defenseMult: f, speedMult: s });
  }
  return buffs;
}
```

- tick (`:1342`): `const buffs = applyAuras(all);`. Update the comment at `:1361` to name `applyAuras`.
- export (`:2514-2517`): replace `computeAuras` with `applyAuras` and update the comment.

In `server.js` `CREATURE_JOINED_SELECT`:
- add `const { AURAS_LATERAL } = require('../services/auraEffects.js');` at the top;
- after `et.vfx,` add the line `et.auras AS aura_names, au.aura_defs,`;
- change the last line to `LEFT JOIN creature_behaviors b ON b.id = et.behavior_id${ABILITIES_LATERAL}${AURAS_LATERAL}`.
- Keep the rationale in `//` comments OUTSIDE the template literal (`server.js:1260-1266` explains why).

- [ ] **Step 6: Run the golden test and see it pass**

Run: `cd backend && node --test tests/champion_aura_golden.test.js; echo "EXIT=$?"`

Expected: PASS (both).

- [ ] **Step 7: Prove the gate is not vacuous (deliberately broken variant)**

Temporarily change `cur.damageMult = Math.max(cur.damageMult, a.damageMult);` to `cur.damageMult *= a.damageMult;`, then run the golden test.

Expected: FAIL (`both`'s buff becomes 1.5625).

Revert, re-run, and expect PASS. Paste both outputs into the PR. Do not commit the broken variant.

- [ ] **Step 8: Rewrite `authority_creature_auras.test.js` to the new shape (literal expectations kept)**

Replace the file's `auraBehavior()` helper and every `behavior: auraBehavior({...})`/`auraRadius:` fixture with `auras: [aura({...})]`, where:

```js
function aura(over = {}) {
  return { name: 'pack_leader', targetSide: 'allies', radius: 0, damageMult: 1, defenseMult: 1, speedMult: 1, ...over };
}
```

Replace `computeAuras` with `applyAuras` throughout. Keep every existing assertion literal (1.25 / 1.2 / 1.1, "two overlapping … 1.25 not 1.5625", self, other faction, out of range, no mutation, vanishes after death). Add these tests:

```js
test('two DIFFERENT ally auras multiply', () => {
  const a = { id: 'A', x: 100, y: 100, width: 48, height: 48, hp: 50, faction: 'hostile',
    auras: [aura({ name: 'pack_leader', radius: 300, damageMult: 1.25 })] };
  const b = { id: 'B', x: 160, y: 100, width: 48, height: 48, hp: 50, faction: 'hostile',
    auras: [aura({ name: 'war_drum', radius: 300, damageMult: 1.2 })] };
  const f = { id: 'F', x: 130, y: 100, width: 48, height: 48, hp: 50, faction: 'hostile' };
  assert.equal(applyAuras([a, b, f]).get('F').damageMult, 1.5); // 1.25 * 1.2, written literally
});

test('an enemies-side aura buffs no ally in S3', () => {
  const src = { id: 'S', x: 100, y: 100, width: 48, height: 48, hp: 50, faction: 'hostile',
    auras: [aura({ targetSide: 'enemies', radius: 300, damageMult: 0.5 })] };
  const f = { id: 'F', x: 150, y: 100, width: 48, height: 48, hp: 50, faction: 'hostile' };
  assert.equal(applyAuras([src, f]).has('F'), false);
});

test('applyAuras is invoked from tick(): an entity-bound aura scales a live hit, and [] does not', () => {
  for (const [auras, expected] of [[[aura({ radius: 300, damageMult: 1.25 })], 100 - 5 * 1.25], [[], 95]]) {
    const s = new CreatureSim(stubMap(), rng);
    s.addCreatures([
      { id: 'L', type: 'T', x: 100, y: 100, hp: 100, faction: 'hostile',
        behavior: behavior({ chaseStyle: 'hold', aggroRadius: 0 }), auras },
      { id: 'F', type: 'T', x: 100, y: 100, hp: 100, faction: 'hostile', damage: 5 },
    ]);
    const p = player('u1', 120, 100);
    s.tick(0.05, new Set(['0,0', '0,1', '1,0', '1,1']), [p], 0);
    assert.equal(p.hp, expected);
  }
});
```

Also delete `auraRadius/auraDamageMult/auraDefenseMult/auraSpeedMult` from this file's `behavior()` helper.

- [ ] **Step 9: Update the loader-shaped wiring test**

In `creature_mechanics_wiring.test.js` `loaderCreatureRow` (`:36-58`), add:

```js
    aura_names: over.auraNames ?? null,
    aura_defs: over.auraDefs ?? [],
```

Rewrite the mechanic-1 test (`:71-95`): the leader row gets `auraNames: ['zzPack'], auraDefs: [{ name: 'zzPack', target_side: 'allies', radius: 300, damage_mult: 1.4, defense_mult: 1, speed_mult: 1 }]` instead of the four `aura*` overrides. Keep `assert.equal(player.hp, 1000 - 10 * 1.4, ...)`. Update the message to "the LEADER row's aura_defs damage_mult (1.4)".

- [ ] **Step 10: Update the SELECT guard in `authority_creatures_integration.test.js`**

Directly after the `aura_radius` loop (`:293-299`), insert:

```js
  // SOMET-604: the aura library. Missing any of these and every entity-bound
  // aura is inert in the running game while every unit test stays green.
  assert.match(sel, /et\.auras\s+AS\s+aura_names/i, 'the world_creatures load must SELECT et.auras AS aura_names');
  assert.match(sel, /\bau\.aura_defs\b/, 'the world_creatures load must SELECT au.aura_defs');
  assert.match(sel, /FROM aura_effects ae/, 'the aura lateral join must be part of THIS query');
```

- [ ] **Step 11: Write the DB test that runs the real SQL**

```js
// backend/tests/aura_loader_db.test.js
// The SELECT guard above checks TEXT. This proves the composed SQL parses and
// that the lateral resolves a real Champion's binding. Read-only, scratch DB.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { CREATURE_JOINED_SELECT } = require('../src/authority/server.js');
const { AURAS_LATERAL } = require('../src/services/auraEffects.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL' : false;

test('aura loader against a real database', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url, max: 1 });
  t.after(() => pool.end());
  await t.test('the composed creature SELECT parses and runs', async () => {
    const r = await pool.query(`${CREATURE_JOINED_SELECT} WHERE false`);
    const cols = r.fields.map((f) => f.name);
    assert.ok(cols.includes('aura_names') && cols.includes('aura_defs'), cols.join(','));
  });
  await t.test('a seeded Champion resolves pack_leader with its real radius', async () => {
    const r = await pool.query(
      `SELECT au.aura_defs FROM entity_types et ${AURAS_LATERAL} WHERE et.name = 'Beast Champion'`);
    assert.strictEqual(r.rows[0].aura_defs.length, 1);
    assert.strictEqual(r.rows[0].aura_defs[0].name, 'pack_leader');
    assert.strictEqual(r.rows[0].aura_defs[0].radius, 260);
  });
  await t.test('an unbound creature resolves to []', async () => {
    const r = await pool.query(`SELECT au.aura_defs FROM entity_types et ${AURAS_LATERAL} WHERE et.name = 'Wolf'`);
    assert.deepStrictEqual(r.rows[0].aura_defs, []);
  });
});
```

- [ ] **Step 12: Run the whole aura/creature group**

Run:

```bash
cd backend && node --test tests/champion_aura_golden.test.js tests/authority_creature_auras.test.js tests/creature_mechanics_wiring.test.js tests/authority_creatures_integration.test.js tests/creature_behavior_golden.test.js tests/aura_loader_db.test.js tests/creature_tick_cost.test.js; echo "EXIT=$?"
```

Expected: `EXIT=0`.

`creature_tick_cost.test.js` still passes here, because its leaders still carry `aura_*` and resolveBehavior still maps them. It will FAIL in Task 5 and is fixed there.

**Note:** with `aura_*` still in `resolveBehavior`, an instance carries BOTH `behavior.auraRadius` and `auras` during Task 4. `applyAuras` reads only `auras`, which the legacy-dead test proves.

- [ ] **Step 13: Commit**

```bash
git add backend/src/authority/creatures.js backend/src/authority/server.js backend/tests/helpers/championAuraTrace.js backend/tests/fixtures/champion_aura_golden.json backend/tests/champion_aura_golden.test.js backend/tests/authority_creature_auras.test.js backend/tests/creature_mechanics_wiring.test.js backend/tests/authority_creatures_integration.test.js backend/tests/aura_loader_db.test.js
git commit -m "feat(auras): applyAuras reads entity-bound auras via one loader, golden parity (SOMET-604)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Drop `creature_behaviors.aura_*`, remove every reader, source guard, Creature Behaviors tab

**Files:**
- Create: `backend/migrations/1714440681000_drop_behavior_auras.js`
- Create: `backend/tests/no_behavior_aura_readers.test.js`
- Modify, backend: every file in "Every reader/writer" above (backend runtime, API, seeds, comments).
- Modify, tests: `backend/tests/creature_aura_resolve.test.js` (delete the file; its subject no longer exists), `behaviorFieldError.test.js`, `legacyCreatureGoldRung.test.js`, `creature_tick_cost.test.js`, `creature_behaviors_api_db.test.js`, `authority_creatures_integration.test.js`, `authority_creatures_combat.test.js`, `creature_mechanics_wiring.test.js:229`.
- Modify, frontend: `behaviorForm.js`, `CreatureBehaviorsAdmin.jsx`, `__tests__/behaviorForm.test.js`.

**Interfaces:**
- Consumes: Task 4's `applyAuras`/`c.auras` (the only consumer left).
- Produces: `creature_behaviors` without `aura_*`, and `DEFAULT_BEHAVIOR` without `aura*`.

- [ ] **Step 1: Write the failing source guard**

```js
// backend/tests/no_behavior_aura_readers.test.js
// SOMET-604: the aura moved to aura_effects/entity_types.auras. Any surviving
// reader of creature_behaviors.aura_* is either dead code or (worse) a second
// source of truth. Scans REAL files (never a copy) across backend runtime,
// scripts, seeds and frontend. Migrations are history and are excluded.
//
// NOT scanned for bare `auraRadius`: that is also the PLAYER leech-aura rule
// key (statComposition.js, world.js, passiveTree.js). The behaviour half of
// that name is pinned directly through DEFAULT_BEHAVIOR/resolveBehavior below.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SCAN = ['backend/src', 'backend/scripts', 'backend/seeds/data', 'frontend/src'];
const BANNED = /\baura_(radius|damage_mult|defense_mult|speed_mult)\b|\baura(DamageMult|DefenseMult|SpeedMult)\b/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['node_modules', '__tests__', 'dist'].includes(e.name)) walk(p, out); }
    else if (/\.(js|jsx|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = SCAN.flatMap((d) => walk(path.join(ROOT, d)));

test('the scan actually covers the files that used to read aura_* (anti-vacuity)', () => {
  for (const f of ['backend/src/authority/creatures.js', 'backend/src/authority/server.js',
    'backend/src/services/creatureBehaviors.js', 'backend/src/index.js',
    'backend/scripts/seed-catalogs.js', 'frontend/src/games/something2/behaviorForm.js']) {
    assert.ok(files.includes(path.join(ROOT, f)), `scan misses ${f}`);
  }
  assert.ok(BANNED.test('b.aura_radius') && BANNED.test('auraDamageMult'), 'pattern cannot fire');
});

test('nothing outside migrations names creature_behaviors.aura_* or its camelCase mapping', () => {
  const hits = [];
  for (const f of files) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (BANNED.test(line)) hits.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepStrictEqual(hits, []);
});

test('the behaviour resolver no longer carries an aura', () => {
  const { DEFAULT_BEHAVIOR, resolveBehavior } = require('../src/services/creatureBehaviors.js');
  assert.strictEqual('auraRadius' in DEFAULT_BEHAVIOR, false);
  assert.strictEqual('auraRadius' in resolveBehavior({ behavior_name: 'Champion', aura_radius: 260 }), false);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd backend && node --test tests/no_behavior_aura_readers.test.js; echo "EXIT=$?"`

Expected: FAIL. The hits list names `creatures.js:215`, `server.js:381`, `creatureBehaviors.js:65-67,146-148`, `index.js:2182,2357,...`, `seed-catalogs.js`, `creatureBehaviors.js` (seed), `densityTiers.js`, `behaviorForm.js`, `CreatureBehaviorsAdmin.jsx`.

- [ ] **Step 3: Write the drop migration**

```js
// backend/migrations/1714440681000_drop_behavior_auras.js
exports.shorthands = undefined;

// SOMET-604 (S3). The behaviour aura is now aura_effects + entity_types.auras
// (1714440680000), proven equivalent by champion_aura_golden.test.js. Dropping
// the four columns removes the second source of truth.
exports.up = (pgm) => {
  pgm.sql('ALTER TABLE creature_behaviors DROP CONSTRAINT IF EXISTS creature_behaviors_aura_check');
  pgm.sql(`ALTER TABLE creature_behaviors
             DROP COLUMN IF EXISTS aura_radius, DROP COLUMN IF EXISTS aura_damage_mult,
             DROP COLUMN IF EXISTS aura_defense_mult, DROP COLUMN IF EXISTS aura_speed_mult`);
};

// Restores the columns with their original defaults and CHECK, and copies
// pack_leader back onto Champion, so a rollback runs the pre-S3 code unchanged.
exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE creature_behaviors
             ADD COLUMN aura_radius real NOT NULL DEFAULT 0,
             ADD COLUMN aura_damage_mult real NOT NULL DEFAULT 1,
             ADD COLUMN aura_defense_mult real NOT NULL DEFAULT 1,
             ADD COLUMN aura_speed_mult real NOT NULL DEFAULT 1`);
  pgm.sql(`ALTER TABLE creature_behaviors ADD CONSTRAINT creature_behaviors_aura_check
             CHECK (aura_radius >= 0 AND aura_damage_mult > 0 AND aura_defense_mult > 0 AND aura_speed_mult > 0)`);
  pgm.sql(`UPDATE creature_behaviors b
              SET aura_radius = a.radius, aura_damage_mult = a.damage_mult,
                  aura_defense_mult = a.defense_mult, aura_speed_mult = a.speed_mult
             FROM aura_effects a WHERE a.name = 'pack_leader' AND b.name = 'Champion'`);
};
```

- [ ] **Step 4: Remove every reader (exact edits)**

**`services/creatureBehaviors.js`**
- Delete `:58-67` (comment + four `aura*` keys) from `DEFAULT_BEHAVIOR`.
- Delete `:145-148` from `resolveBehavior`.

**`authority/creatures.js:207-215`**
- Delete the line `b.aura_radius, b.aura_damage_mult, b.aura_defense_mult, b.aura_speed_mult,`.
- Delete the sentence "b.aura_* columns have no such collision and stay unaliased, same as aggro_radius/leash_radius/etc above." from the comment.

**`authority/server.js`**
- `:381`: delete the `b.aura_*` line from `CREATURE_JOINED_SELECT`.
- `:1270-1271`: delete the `b.aura_*` sentence.

**`index.js`**
- `behaviorFieldError` `:2157`: in the comment, drop "/the aura fields below".
- `:2166-2184`: delete the aura block. Keep the gold checks and reword the comment to "per-rung gold".
- POST `:2353-2369`: remove the four columns and params. Renumber to `(name, aggro_radius, leash_radius, chase_style, preferred_range, move_speed_mult, damage_override, gold_min, gold_max) VALUES ($1..$9)`, with params `..., b.damage_override ?? null, b.gold_min ?? 0, b.gold_max ?? 0`.
- PUT `:2403-2414`: `gold_min = $8, gold_max = $9 ... WHERE id = $10`, with params to match.

**`scripts/seed-catalogs.js`**
- `seedOneBehavior`: drop `aura_*` from the column list, VALUES, `ON CONFLICT SET` and params. Renumber `$8/$9` to gold.
- Delete the aura sentences from the comments at `:126-130` and `:164-170`.

**`seeds/data/creatureBehaviors.js`**
- Delete `aura_radius: 260, aura_damage_mult: 1.25, aura_defense_mult: 1.2, aura_speed_mult: 1.1,` from Champion (keep `gold_min: 10, gold_max: 30`).
- Reword header `:36-41` to: "gold_min/gold_max are SOMET-253 Task 4 additions … Champion's pack-leader aura moved to seeds/data/auraEffects.js (SOMET-604)".

**`services/densityTiers.js:100-116`**
- `computeAuras` → `applyAuras`.
- "using the Champion behaviour (aura_radius 260, …)" → "using Champion entities (pack_leader, radius 260, …)".
- "the only one with aura_radius > 0" → "the only entities bound to an aura".

**Frontend `behaviorForm.js`**
- Remove the four from `NUMERIC` and `NEW_ROW_DEFAULTS`.
- Rewrite the `:30-35` and `:52-58` comments without the column names.

**Frontend `CreatureBehaviorsAdmin.jsx:508-547`**
- Replace both aura `FormRow`s with: `<Hint>Pack-leader auras moved to Entities → Auras (library: Aura Effects tab).</Hint>`

- [ ] **Step 5: Fix the dependent tests (exact edits)**

**`behaviorFieldError.test.js:98-115`**
- Delete the aura tests.
- Add:

```js
test('aura fields are no longer behaviour fields (SOMET-604): they are ignored, not validated', () => {
  assert.equal(behaviorFieldError({ ...VALID, aura_radius: -1 }), null);
});
```

**`legacyCreatureGoldRung.test.js:60-63`**
- Delete the four `aura_*` lines.

**`creature_tick_cost.test.js`**
- Leaders: replace the four `aura_*` keys with `aura_names: ['pack_leader'], aura_defs: [{ name: 'pack_leader', target_side: 'allies', radius: 260, damage_mult: 1.25, defense_mult: 1.2, speed_mult: 1.1 }],`.
- Fixture check `:82-83`: `.filter((c) => c.auras.length > 0).length`.
- Rewrite comment `:25-41` to explain that the aura now comes from `aura_defs` (the loader's lateral), not the behaviour row.

**`creature_behaviors_api_db.test.js:236-267`**
- Remove the `aura_*` body fields and their three assertions.
- Add: `assert.strictEqual('aura_radius' in res.body, false, 'the column is gone');`

**`authority_creatures_integration.test.js:293-299`**
- Replace the `aura_*` loop with:

```js
  for (const col of ['aura_radius', 'aura_damage_mult', 'aura_defense_mult', 'aura_speed_mult']) {
    assert.ok(!new RegExp(`\\bb\\.${col}\\b`).test(sel), `b.${col} was dropped by 1714440681000 and must not be selected`);
  }
```

**`authority_creatures_combat.test.js`**
- `:275-280`: same inversion, for `loadCreatureTypes`' `sql`.
- `:367, 383`: delete `auraRadius: 0, auraDamageMult: 1, auraDefenseMult: 1, auraSpeedMult: 1,`.

**`creature_mechanics_wiring.test.js`**
- `:53-54`: delete the `aura_*` keys from `loaderCreatureRow` (the `aura_names`/`aura_defs` keys from Task 4 stay).
- `:229`: delete them from `loaderTypeRow`.

**`creature_aura_resolve.test.js`**
- `git rm` it. Its whole subject (`resolveBehavior` mapping `aura_*`) is gone, and `no_behavior_aura_readers.test.js` now pins the absence.

**Frontend `__tests__/behaviorForm.test.js:97-125`**
- Delete the aura expectations.
- Add:

```js
  it('no longer carries aura fields (moved to the aura library, SOMET-604)', () => {
    const form = behaviorToForm({});
    for (const k of ['aura_radius', 'aura_damage_mult', 'aura_defense_mult', 'aura_speed_mult']) {
      expect(k in form).toBe(false);
    }
  });
```

- [ ] **Step 6: Migrate the scratch DB, then run the guard and every touched test**

```bash
cd backend && npm run migrate -- up; echo "EXIT=$?"
node --test tests/no_behavior_aura_readers.test.js tests/champion_aura_golden.test.js tests/authority_creature_auras.test.js tests/behaviorFieldError.test.js tests/legacyCreatureGoldRung.test.js tests/creature_tick_cost.test.js tests/creature_behaviors_api_db.test.js tests/authority_creatures_integration.test.js tests/authority_creatures_combat.test.js tests/creature_mechanics_wiring.test.js tests/seed_auras_db.test.js tests/seed_catalogs_db.test.js tests/creature_behaviors_invariants.test.js; echo "EXIT=$?"
cd ../frontend && npx vitest run src/games/something2/__tests__/behaviorForm.test.js; echo "EXIT=$?"
```

Expected: all `EXIT=0`. `champion_aura_golden` is still green, which proves the drop changed nothing.

- [ ] **Step 7: DB-level absence check**

Run:

```bash
cd backend && node -e "const {Pool}=require('pg');const p=new Pool({connectionString:process.env.TEST_DATABASE_URL});p.query(\"SELECT column_name FROM information_schema.columns WHERE table_name='creature_behaviors' AND column_name LIKE 'aura%'\").then(r=>{console.log(r.rows);p.end()})"
```

Expected: `[]`.

- [ ] **Step 8: Prove `down` round-trips on the scratch DB**

```bash
npm run migrate -- down; echo "EXIT=$?"
node -e "const {Pool}=require('pg');const p=new Pool({connectionString:process.env.TEST_DATABASE_URL});p.query(\"SELECT aura_radius,aura_damage_mult FROM creature_behaviors WHERE name='Champion'\").then(r=>{console.log(r.rows);p.end()})"
```

Expected: `[ { aura_radius: 260, aura_damage_mult: 1.25 } ]`.

```bash
npm run migrate -- up; echo "EXIT=$?"
```

- [ ] **Step 9: Commit**

```bash
git add backend/migrations/1714440681000_drop_behavior_auras.js backend/tests/no_behavior_aura_readers.test.js backend/src/services/creatureBehaviors.js backend/src/authority/creatures.js backend/src/authority/server.js backend/src/index.js backend/scripts/seed-catalogs.js backend/seeds/data/creatureBehaviors.js backend/src/services/densityTiers.js backend/tests/behaviorFieldError.test.js backend/tests/legacyCreatureGoldRung.test.js backend/tests/creature_tick_cost.test.js backend/tests/creature_behaviors_api_db.test.js backend/tests/authority_creatures_integration.test.js backend/tests/authority_creatures_combat.test.js backend/tests/creature_mechanics_wiring.test.js frontend/src/games/something2/behaviorForm.js frontend/src/games/something2/CreatureBehaviorsAdmin.jsx frontend/src/games/something2/__tests__/behaviorForm.test.js
git rm backend/tests/creature_aura_resolve.test.js
git commit -m "refactor(auras): drop creature_behaviors.aura_* and every reader (SOMET-604)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Admin API `/api/aura-effects` (Used by, cascade rename, 409 delete)

**Path decision:** `/api/aura-effects`, not `/api/admin/auras`. This matches `/api/vfx-effects`, whose GET is open (the S5 client will fetch the library on join) and whose writes go through adminGuard.

**Files:**
- Create: `backend/src/api/auraEffectsRoutes.js`
- Modify: `backend/src/index.js`. Add one `require` next to `passiveNodesRoutes` (`:157`) and one `app.use('/api/aura-effects', auraEffectsRoutes(guardPool));` next to `:534`. Both are additive lines away from the other session's hunks at `:158-162` and `:542-546`.
- Create: `backend/tests/aura_effects_api_db.test.js`

**Interfaces:**
- Consumes: `auraEffectError` (Task 2), `requireAdmin` (`auth/middleware.js:71`).
- Produces:
  - `GET /` → `200 [{...row, used_by: [{id,name}]}]` ordered by name
  - `POST /` → `201 row` | `400 {error}` | `409 {error}` (duplicate name)
  - `PUT /:id` → `200 {...row, renamedBindings: n}` | `400` | `404` | `409`
  - `DELETE /:id` → `204` | `404` | `409 {error, referencing_entity_types: [{id,name}]}`

- [ ] **Step 1: Write the failing real-HTTP, real-DB test**

```js
// backend/tests/aura_effects_api_db.test.js
// Modelled on passive_nodes_admin_routes.test.js: real pg Pool via __setPool,
// disposable users, gated on TEST_DATABASE_URL. Creates only zz-prefixed auras
// and one zz-prefixed entity type, all deleted in t.after.
require('./helpers/auth.js');
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { Pool } = require('pg');
const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to mutate a real database' : false;
const tag = `${process.pid}${Date.now()}`;
const A = `zzAura${tag}`;
const B = `zzAuraRenamed${tag}`;
const E = `zzAuraEntity${tag}`;
const body = (over = {}) => ({ name: A, target_side: 'allies', radius: 120, damage_mult: 1.3, ...over });

async function makeUser(pool, role) {
  const r = await pool.query('INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3) RETURNING id, token_version',
    [`aura-${role}-${tag}-${Math.random().toString(36).slice(2)}`, 'x', role]);
  return { id: r.rows[0].id, role, tokenVersion: r.rows[0].token_version };
}
const bearer = (u) => `Bearer ${signToken({ userId: u.id, username: 'x', role: u.role, tokenVersion: u.tokenVersion })}`;

test('aura effects admin API', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url, max: 4 });
  __setPool(pool);
  const admin = await makeUser(pool, 'admin');
  const player = await makeUser(pool, 'player');
  t.after(async () => {
    await pool.query('DELETE FROM entity_types WHERE name = $1', [E]).catch(() => {});
    await pool.query('DELETE FROM aura_effects WHERE name = ANY($1)', [[A, B]]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [[admin.id, player.id]]).catch(() => {});
    await pool.end();
  });
  const as = (u) => ['Authorization', bearer(u)];
  let id;

  await t.test('GET is open and lists pack_leader with its Champion users', async () => {
    const r = await request(app).get('/api/aura-effects');
    assert.strictEqual(r.status, 200);
    const pl = r.body.find((a) => a.name === 'pack_leader');
    assert.ok(pl, 'pack_leader missing');
    assert.ok(pl.used_by.length >= 32, `expected the 32 Champions, got ${pl.used_by.length}`);
    assert.ok(pl.used_by.some((e) => e.name === 'Beast Champion'));
  });
  await t.test('writes are admin-only', async () => {
    assert.strictEqual((await request(app).post('/api/aura-effects').send(body())).status, 401);
    assert.strictEqual((await request(app).post('/api/aura-effects').set(...as(player)).send(body())).status, 403);
  });
  await t.test('validation runs before the DB (400 with a readable message)', async () => {
    for (const [over, re] of [[{ radius: 0 }, /radius/], [{ radius: -3 }, /radius/], [{ radius: 26000 }, /radius/],
      [{ damage_mult: 0 }, /damage_mult/], [{ tick_ms: 50 }, /tick_ms/], [{ dot_dps: 5 }, /enemies/]]) {
      const r = await request(app).post('/api/aura-effects').set(...as(admin)).send(body(over));
      assert.strictEqual(r.status, 400, JSON.stringify(over));
      assert.match(r.body.error, re);
    }
  });
  await t.test('create, then duplicate name is 409', async () => {
    const r = await request(app).post('/api/aura-effects').set(...as(admin)).send(body());
    assert.strictEqual(r.status, 201);
    id = r.body.id;
    assert.strictEqual(r.body.radius, 120);
    assert.strictEqual((await request(app).post('/api/aura-effects').set(...as(admin)).send(body())).status, 409);
  });
  await t.test('an unknown dot_element is a 400, not a raw FK 500', async () => {
    const r = await request(app).post('/api/aura-effects').set(...as(admin))
      .send(body({ name: `${A}x`, target_side: 'enemies', dot_dps: 2, dot_element: 'plasma' }));
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /dot_element/);
  });
  await t.test('delete while bound is 409 with the entity list', async () => {
    await pool.query(`INSERT INTO entity_types (name, color, is_creature, auras) VALUES ($1, '#123456', true, $2::jsonb)`,
      [E, JSON.stringify([A])]);
    const r = await request(app).delete(`/api/aura-effects/${id}`).set(...as(admin));
    assert.strictEqual(r.status, 409);
    assert.deepStrictEqual(r.body.referencing_entity_types.map((e) => e.name), [E]);
    const still = await pool.query('SELECT 1 FROM aura_effects WHERE id = $1', [id]);
    assert.strictEqual(still.rowCount, 1, 'a refused delete must not delete');
  });
  await t.test('rename rewrites every binding in the same transaction', async () => {
    const r = await request(app).put(`/api/aura-effects/${id}`).set(...as(admin)).send(body({ name: B }));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.renamedBindings, 1);
    const e = await pool.query('SELECT auras FROM entity_types WHERE name = $1', [E]);
    assert.deepStrictEqual(e.rows[0].auras, [B]);
  });
  await t.test('a retune (no rename) touches no binding', async () => {
    const r = await request(app).put(`/api/aura-effects/${id}`).set(...as(admin)).send(body({ name: B, radius: 150 }));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.radius, 150);
    assert.strictEqual(r.body.renamedBindings, 0);
  });
  await t.test('once unbound, delete succeeds', async () => {
    await pool.query("UPDATE entity_types SET auras = '[]'::jsonb WHERE name = $1", [E]);
    assert.strictEqual((await request(app).delete(`/api/aura-effects/${id}`).set(...as(admin))).status, 204);
    assert.strictEqual((await request(app).delete(`/api/aura-effects/${id}`).set(...as(admin))).status, 404);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd backend && node --test tests/aura_effects_api_db.test.js; echo "EXIT=$?"`

Expected: FAIL with GET returning `404` (route not mounted).

- [ ] **Step 3: Implement the router**

```js
// backend/src/api/auraEffectsRoutes.js
// SOMET-604 (S3). Aura library CRUD. Modelled on the vfx-effects routes
// (index.js:1797-1960) with one deliberate difference: a RENAME cascades into
// entity_types.auras in the same transaction (the SOMET-228 entity-rename
// pattern, index.js:982-1013) instead of 409ing -- a typo'd aura name must be
// fixable. DELETE is still refused while bound (spec §5).
const express = require('express');
const { requireAdmin } = require('../auth/middleware.js');
const { auraEffectError } = require('../services/auraEffects.js');

const COLS = ['name', 'target_side', 'radius', 'damage_mult', 'defense_mult', 'speed_mult', 'dot_dps',
  'dot_element', 'tick_ms', 'shape', 'color', 'pulse_ms', 'particle_count', 'particle_spread',
  'particle_speed', 'particle_gravity', 'particle_lifetime_ms', 'particle_size'];
const DEFAULTS = { damage_mult: 1, defense_mult: 1, speed_mult: 1, dot_dps: 0, dot_element: 'physical',
  tick_ms: 1000, shape: 'ring', color: '#d4a017', pulse_ms: 1200, particle_count: 0, particle_spread: 6.283,
  particle_speed: 100, particle_gravity: 0, particle_lifetime_ms: 300, particle_size: 2 };

function values(b) {
  return COLS.map((c) => (c === 'name' ? String(b.name).trim()
    : c === 'target_side' || c === 'shape' || c === 'color' || c === 'dot_element'
      ? (b[c] ?? DEFAULTS[c]) : Number(b[c] ?? DEFAULTS[c])));
}
function dbError(res, err, fallback) {
  if (err.code === '23505') return res.status(409).json({ error: 'An aura with that name already exists' });
  if (err.code === '23503') return res.status(400).json({ error: 'dot_element must name a known element' });
  if (err.code === '23514') return res.status(400).json({ error: `rejected by ${err.constraint}` });
  console.error(err);
  return res.status(500).json({ error: fallback });
}
const USED_BY = `COALESCE((SELECT json_agg(json_build_object('id', e.id, 'name', e.name) ORDER BY e.name)
                   FROM entity_types e WHERE e.auras ? ae.name), '[]'::json) AS used_by`;

module.exports = function auraEffectsRoutes(pool) {
  const router = express.Router();
  const guard = requireAdmin(pool);

  // Open, like /api/vfx-effects: S5's client draws auras from this library.
  router.get('/', async (req, res) => {
    try {
      const r = await pool.query(`SELECT ae.*, ${USED_BY} FROM aura_effects ae ORDER BY ae.name`);
      res.json(r.rows);
    } catch (err) { dbError(res, err, 'Failed to fetch auras'); }
  });

  router.post('/', guard, async (req, res) => {
    const bad = auraEffectError(req.body);
    if (bad) return res.status(400).json({ error: bad });
    try {
      const r = await pool.query(
        `INSERT INTO aura_effects (${COLS.join(', ')}) VALUES (${COLS.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
        values(req.body));
      res.status(201).json({ ...r.rows[0], used_by: [] });
    } catch (err) { dbError(res, err, 'Failed to create aura'); }
  });

  router.put('/:id', guard, async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'id must be an integer' });
    const bad = auraEffectError(req.body);
    if (bad) return res.status(400).json({ error: bad });
    let client = null;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const cur = await client.query('SELECT name FROM aura_effects WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (cur.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Aura not found' }); }
      const oldName = cur.rows[0].name;
      const newName = String(req.body.name).trim();
      const v = values(req.body);
      const r = await client.query(
        `UPDATE aura_effects SET ${COLS.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = now()
          WHERE id = $${COLS.length + 1} RETURNING *`, [...v, req.params.id]);
      let renamedBindings = 0;
      if (oldName !== newName) {
        // Rewrite the ONE matching element, keep order (index.js:982 pattern).
        const u = await client.query(
          `UPDATE entity_types SET auras = (
             SELECT jsonb_agg(CASE WHEN elem.value = $1 THEN $2 ELSE elem.value END ORDER BY elem.ord)
               FROM jsonb_array_elements_text(auras) WITH ORDINALITY AS elem(value, ord))
            WHERE auras ? $1`, [oldName, newName]);
        renamedBindings = u.rowCount;
      }
      await client.query('COMMIT');
      res.json({ ...r.rows[0], renamedBindings });
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => {});
      dbError(res, err, 'Failed to update aura');
    } finally { client?.release(); }
  });

  router.delete('/:id', guard, async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'id must be an integer' });
    try {
      const cur = await pool.query('SELECT name FROM aura_effects WHERE id = $1', [req.params.id]);
      if (cur.rowCount === 0) return res.status(404).json({ error: 'Aura not found' });
      const name = cur.rows[0].name;
      const refs = await pool.query('SELECT id, name FROM entity_types WHERE auras ? $1 ORDER BY name', [name]);
      if (refs.rowCount > 0) {
        return res.status(409).json({
          error: `Cannot delete '${name}': still bound by ${refs.rowCount} entity type(s)`,
          referencing_entity_types: refs.rows.map((e) => ({ id: e.id, name: e.name })),
        });
      }
      await pool.query('DELETE FROM aura_effects WHERE id = $1', [req.params.id]);
      res.status(204).end();
    } catch (err) { dbError(res, err, 'Failed to delete aura'); }
  });

  return router;
};
```

In `index.js`, add `const auraEffectsRoutes = require('./api/auraEffectsRoutes.js');` after the `passiveNodesRoutes` require at `:157`, and `app.use('/api/aura-effects', auraEffectsRoutes(guardPool));` after `:534`.

**Known gap:** the 409 check and the DELETE are not one transaction. A bind that lands between them would orphan its name. That case is harmless (unknown name → no-op + one log) and matches the vfx route.

- [ ] **Step 4: Run it and see it pass**

Run: `cd backend && node --test tests/aura_effects_api_db.test.js; echo "EXIT=$?"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/api/auraEffectsRoutes.js backend/src/index.js backend/tests/aura_effects_api_db.test.js
git commit -m "feat(auras): aura library admin API with used-by, cascade rename, guarded delete (SOMET-604)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Entity binding API (`entity_types.auras` on POST/PUT)

**Files:**
- Modify: `backend/src/index.js`. `entityTypeFieldError` (`:751`) gets a shape check. The POST (`:803-855`) and PUT (`:865-1105`) routes check that each name exists and write `auras`.
- Create: `backend/tests/entity_auras_api_db.test.js`
- Modify: `backend/tests/entityTypes.test.js` (mock route: the param is written, and the id stays last)

**Interfaces:**
- Body `auras`: `null` | `string[]` (unique, non-empty strings).
- Omitted → column unchanged (PUT). `null` → NULL. `[]` → `[]`. Unknown name → `400 unknown aura "x"`.

- [ ] **Step 1: Write the failing DB test**

```js
// backend/tests/entity_auras_api_db.test.js
require('./helpers/auth.js');
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { Pool } = require('pg');
const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL' : false;
const E = `zzAuraBind${process.pid}${Date.now()}`;

test('entity_types.auras binding', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url, max: 4 });
  __setPool(pool);
  const u = (await pool.query("INSERT INTO users (username, password_hash, role) VALUES ($1,'x','admin') RETURNING id, token_version",
    [`auraadm-${E}`])).rows[0];
  const auth = ['Authorization', `Bearer ${signToken({ userId: u.id, username: 'x', role: 'admin', tokenVersion: u.token_version })}`];
  t.after(async () => {
    await pool.query('DELETE FROM entity_types WHERE name = $1', [E]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = $1', [u.id]).catch(() => {});
    await pool.end();
  });
  const base = { name: E, color: '#112233', is_creature: true, hp: 10, max_hp: 10 };
  let id;

  await t.test('POST stores a known aura', async () => {
    const r = await request(app).post('/api/entity-types').set(...auth).send({ ...base, auras: ['pack_leader'] });
    assert.strictEqual(r.status, 201);
    id = r.body.id;
    assert.deepStrictEqual(r.body.auras, ['pack_leader']);
  });
  await t.test('an unknown name is a 400 naming it', async () => {
    const r = await request(app).put(`/api/entity-types/${id}`).set(...auth).send({ ...base, auras: ['ghost_aura'] });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /unknown aura "ghost_aura"/);
  });
  await t.test('bad shapes are 400s', async () => {
    for (const bad of ['pack_leader', [''], [3], ['pack_leader', 'pack_leader']]) {
      const r = await request(app).put(`/api/entity-types/${id}`).set(...auth).send({ ...base, auras: bad });
      assert.strictEqual(r.status, 400, JSON.stringify(bad));
    }
  });
  await t.test('omitting auras leaves the binding alone', async () => {
    const r = await request(app).put(`/api/entity-types/${id}`).set(...auth).send({ ...base, hp: 12 });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.auras, ['pack_leader']);
  });
  await t.test('[] is stored as [] (an explicit removal), not NULL', async () => {
    const r = await request(app).put(`/api/entity-types/${id}`).set(...auth).send({ ...base, auras: [] });
    assert.deepStrictEqual(r.body.auras, []);
  });
  await t.test('null clears to NULL (never authored)', async () => {
    const r = await request(app).put(`/api/entity-types/${id}`).set(...auth).send({ ...base, auras: null });
    assert.strictEqual(r.body.auras, null);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd backend && node --test tests/entity_auras_api_db.test.js; echo "EXIT=$?"`

Expected: FAIL. POST returns 201 but `r.body.auras` is `null` (not written).

- [ ] **Step 3: Implement**

In `entityTypeFieldError`, before `return null;`:

```js
  // SOMET-604: entity_types.auras is a list of aura_effects NAMES (no FK).
  // undefined = not sent (PUT leaves it alone), null = never authored, [] = none.
  if (body.auras !== undefined && body.auras !== null) {
    if (!Array.isArray(body.auras)) return 'auras must be an array of aura names or null';
    if (body.auras.some((n) => typeof n !== 'string' || n.trim() === '')) return 'each aura must be a non-empty name';
    if (new Set(body.auras).size !== body.auras.length) return 'auras must not repeat a name';
  }
```

Add a helper next to `entityTypeFieldError`:

```js
// The dropdown is the first defence; this is the second, for scripts and stale
// tabs. Runs on the caller's db handle so PUT checks inside its transaction.
async function unknownAuraError(db, auras) {
  if (!Array.isArray(auras) || auras.length === 0) return null;
  const r = await db.query('SELECT name FROM aura_effects WHERE name = ANY($1::text[])', [auras]);
  const known = new Set(r.rows.map((x) => x.name));
  const missing = auras.find((n) => !known.has(n));
  return missing ? `unknown aura "${missing}"` : null;
}
```

**POST:**
- After `pinModalityErr`, add `const auraErr = await unknownAuraError(pool, req.body.auras); if (auraErr) return res.status(400).json({ error: auraErr });`.
- Append `auras` as column 30 with value `$30::jsonb`, param `req.body.auras == null ? null : JSON.stringify(req.body.auras)`.

**PUT:**
- After the `pinModalityErr` block, add the same check via `client` (`ROLLBACK` before the 400).
- Add `const aurasProvided = 'auras' in req.body;`.
- In the UPDATE, after the `point_kind` line, add `auras = CASE WHEN $33::boolean THEN $34::jsonb ELSE entity_types.auras END,`. Change `WHERE id = $35`. Insert `aurasProvided, req.body.auras == null ? null : JSON.stringify(req.body.auras)` before `id` in the params, so `id` stays last (`entityTypes.test.js` pins that).

- [ ] **Step 4: Add the mock-level guard to `entityTypes.test.js`**

```js
test('PUT /api/entity-types/:id writes auras when sent, keeping id last', async () => {
  let captured;
  __setPool(putMock('Wolf', (s, p) => {
    if (/FROM aura_effects/.test(s)) return { rows: [{ name: 'pack_leader' }] };
    captured = { s, p }; return { rows: [{ id: 7 }] };
  }));
  const r = await request(app).put('/api/entity-types/7').set(...AUTH).send({ name: 'Wolf', color: '#000000', auras: ['pack_leader'] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(paramFor(captured.s, captured.p, 'auras'), '["pack_leader"]');
  assert.strictEqual(captured.p[captured.p.length - 1], '7');
});
```

- [ ] **Step 5: Run and see it pass**

Run: `cd backend && node --test tests/entity_auras_api_db.test.js tests/entityTypes.test.js tests/entity_types_aggression_fields.test.js; echo "EXIT=$?"`

Expected: `EXIT=0`.

- [ ] **Step 6: Commit**

```bash
git add backend/src/index.js backend/tests/entity_auras_api_db.test.js backend/tests/entityTypes.test.js
git commit -m "feat(auras): bind auras to entity types via the entity API (SOMET-604)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Aura Effects tab (list, form, live preview, Used by, nav)

**Files:**
- Create: `frontend/src/games/something2/auraForm.js`
- Create: `frontend/src/games/something2/src/js/core/auraVisual.js`
- Create: `frontend/src/games/something2/auraPreview.js`
- Create: `frontend/src/games/something2/useAuraEffects.js`
- Create: `frontend/src/games/something2/AuraEffectsAdmin.jsx`
- Create: `frontend/src/games/something2/__tests__/auraForm.test.js`
- Create: `frontend/src/games/something2/__tests__/auraVisual.test.js`
- Create: `frontend/src/games/something2/__tests__/AuraEffectsAdmin.smoke.test.js`
- Modify: `frontend/src/App.jsx` (one import, one `<Route path="auras" …/>` directly after the `vfx` route at `:70`)
- Modify: `frontend/src/ui/navSections.js` (one line after the `vfx` entry at `:38`)
- Modify: `frontend/src/ui/__tests__/navSections.test.js` (count + path list)

**Interfaces:**
- `auraForm.js`: `AURA_SIDES`, `AURA_SHAPES`, `AURA_LIMITS`, `emptyAuraForm()`, `auraToForm(row)`, `auraFormToPayload(form)`, `validateAuraForm(form) → string|null`.
- `auraVisual.js`: `auraPulse(def, ms) → { scale, alpha }`; `auraParticleFx(def, ms) → fx` for `particlesAt`.
- `useAuraEffects.js`: `AURA_QUERY_KEY = ['auraEffects']`, `useAuraEffectsAdmin()`, `useCreateAuraEffect`, `useUpdateAuraEffect`, `useDeleteAuraEffect`.

- [ ] **Step 1: Write the failing form test (asserted against the BACKEND module)**

```js
// frontend/src/games/something2/__tests__/auraForm.test.js
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { AURA_SIDES, AURA_SHAPES, AURA_LIMITS, emptyAuraForm, auraToForm, auraFormToPayload, validateAuraForm } from '../auraForm.js';

const backend = createRequire(import.meta.url)('../../../../../backend/src/services/auraEffects.js');

describe('aura form', () => {
  it('uses the exact vocabulary and limits the API enforces', () => {
    expect(AURA_SIDES).toEqual(backend.AURA_SIDES);
    expect(AURA_SHAPES).toEqual(backend.AURA_SHAPES);
    expect(AURA_LIMITS).toEqual({ ...backend.AURA_LIMITS });
  });
  it('a new form is valid once named, and defaults to a neutral allies ring', () => {
    const f = { ...emptyAuraForm(), name: 'x', radius: '200' };
    expect(validateAuraForm(f)).toBeNull();
    const p = auraFormToPayload(f);
    expect(p).toMatchObject({ target_side: 'allies', radius: 200, damage_mult: 1, defense_mult: 1, speed_mult: 1, dot_dps: 0, shape: 'ring' });
    expect(backend.auraEffectError(p)).toBeNull();
  });
  it.each([
    [{ radius: '0' }, /Radius/], [{ radius: '-5' }, /Radius/], [{ radius: '' }, /Radius/],
    [{ radius: '26000' }, /Radius/], [{ damage_mult: '0' }, /Damage/], [{ tick_ms: '50' }, /Tick/],
    [{ dot_dps: '3' }, /enemies/], [{ particle_count: '65' }, /Particles/], [{ color: 'gold' }, /Colour/],
  ])('rejects %j before a round trip', (over, re) => {
    expect(validateAuraForm({ ...emptyAuraForm(), name: 'x', radius: '200', ...over })).toMatch(re);
  });
  it('round-trips a stored row, including a genuine 0 dps and pulse 0', () => {
    const row = { id: 1, name: 'pack_leader', target_side: 'allies', radius: 260, damage_mult: 1.25, defense_mult: 1.2,
      speed_mult: 1.1, dot_dps: 0, dot_element: 'physical', tick_ms: 1000, shape: 'ring', color: '#d4a017', pulse_ms: 0,
      particle_count: 0, particle_spread: 6.283, particle_speed: 100, particle_gravity: 0, particle_lifetime_ms: 300, particle_size: 2 };
    const p = auraFormToPayload(auraToForm(row));
    expect(p.radius).toBe(260);
    expect(p.damage_mult).toBe(1.25);
    expect(p.pulse_ms).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/auraForm.test.js; echo "EXIT=$?"`

Expected: FAIL (`Failed to resolve import "../auraForm.js"`).

- [ ] **Step 3: Implement `auraForm.js`**

```js
// Form <-> payload for the Aura Effects admin (SOMET-604). Pure, so it is
// testable under vitest's node env. Vocabulary and limits are asserted equal
// to backend/src/services/auraEffects.js by auraForm.test.js.
export const AURA_SIDES = ['allies', 'enemies'];
export const AURA_SHAPES = ['ring', 'disc', 'particles'];
export const AURA_LIMITS = { maxRadius: 2000, minTickMs: 100, maxTickMs: 5000, maxPulseMs: 10000, maxParticles: 64, maxNameLen: 200 };
export const AURA_ELEMENTS = ['physical', 'fire', 'ice', 'lightning', 'arcane'];

const FIELDS = {
  target_side: 'allies', radius: '200', damage_mult: '1', defense_mult: '1', speed_mult: '1',
  dot_dps: '0', dot_element: 'physical', tick_ms: '1000', shape: 'ring', color: '#d4a017', pulse_ms: '1200',
  particle_count: '0', particle_spread: '6.283', particle_speed: '100', particle_gravity: '0',
  particle_lifetime_ms: '300', particle_size: '2',
};
const TEXT = new Set(['target_side', 'dot_element', 'shape', 'color']);

export function emptyAuraForm() { return { name: '', ...FIELDS }; }
export function auraToForm(r) {
  const f = { name: r.name ?? '' };
  for (const [k, d] of Object.entries(FIELDS)) f[k] = TEXT.has(k) ? (r[k] ?? d) : String(r[k] ?? d);
  return f;
}
// Blank stays NaN (and is then rejected) -- never silently 0.
const n = (v) => (typeof v === 'string' && v.trim() === '' ? NaN : Number(v));
export function auraFormToPayload(f) {
  const p = { name: String(f.name || '').trim() };
  for (const k of Object.keys(FIELDS)) p[k] = TEXT.has(k) ? f[k] : n(f[k]);
  return p;
}
export function validateAuraForm(f) {
  const p = auraFormToPayload(f);
  if (!p.name) return 'Name is required';
  if (!(p.radius > 0 && p.radius <= AURA_LIMITS.maxRadius)) return `Radius must be greater than 0 and at most ${AURA_LIMITS.maxRadius}`;
  if (!(p.damage_mult > 0)) return 'Damage multiplier must be greater than 0';
  if (!(p.defense_mult > 0)) return 'Defense multiplier must be greater than 0';
  if (!(p.speed_mult > 0)) return 'Speed multiplier must be greater than 0';
  if (!(p.dot_dps >= 0)) return 'DoT per second must be 0 or greater';
  if (p.target_side === 'allies' && p.dot_dps > 0) return 'Only an enemies aura can deal damage over time';
  if (!Number.isInteger(p.tick_ms) || p.tick_ms < AURA_LIMITS.minTickMs || p.tick_ms > AURA_LIMITS.maxTickMs) {
    return `Tick must be a whole number of ms between ${AURA_LIMITS.minTickMs} and ${AURA_LIMITS.maxTickMs}`;
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(p.color)) return 'Colour must be #rrggbb';
  if (!Number.isInteger(p.pulse_ms) || p.pulse_ms < 0 || p.pulse_ms > AURA_LIMITS.maxPulseMs) return `Pulse must be 0..${AURA_LIMITS.maxPulseMs} ms`;
  if (!Number.isInteger(p.particle_count) || p.particle_count < 0 || p.particle_count > AURA_LIMITS.maxParticles) {
    return `Particles must be a whole number between 0 and ${AURA_LIMITS.maxParticles}`;
  }
  if (!(p.particle_lifetime_ms > 0)) return 'Particle life must be greater than 0';
  if (!(p.particle_size >= 0)) return 'Particle size must be 0 or greater';
  return null;
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/auraForm.test.js; echo "EXIT=$?"`

Expected: PASS.

- [ ] **Step 5: Write the failing visual-maths test, then implement `auraVisual.js`**

```js
// frontend/src/games/something2/__tests__/auraVisual.test.js
import { describe, it, expect } from 'vitest';
import { auraPulse, auraParticleFx } from '../src/js/core/auraVisual.js';

describe('aura pulse', () => {
  it('pulse_ms 0 is a steady aura', () => {
    expect(auraPulse({ pulse_ms: 0 }, 123)).toEqual({ scale: 1, alpha: 0.35 });
  });
  it('breathes between 0.9 and 1.0 of the radius over one period', () => {
    const def = { pulse_ms: 1000 };
    expect(auraPulse(def, 0).scale).toBeCloseTo(0.9, 6);
    expect(auraPulse(def, 500).scale).toBeCloseTo(1.0, 6);
    expect(auraPulse(def, 1000).scale).toBeCloseTo(0.9, 6);
  });
  it('particle fx loops over the particle lifetime and is deterministic', () => {
    const def = { particle_lifetime_ms: 400 };
    expect(auraParticleFx(def, 900)).toEqual(auraParticleFx(def, 900));
    expect(auraParticleFx(def, 900).t).toBeCloseTo(0.25, 6); // (900 % 400) / 400
  });
});
```

```js
// frontend/src/games/something2/src/js/core/auraVisual.js
// SOMET-604. Pure aura visual maths. The admin preview uses it now; S5's
// in-game renderer MUST import the same functions, so the author tunes
// against what the game draws (the vfxPreview rule).
export function auraPulse(def, ms) {
  const period = Number(def.pulse_ms) || 0;
  if (period <= 0) return { scale: 1, alpha: 0.35 };
  const phase = (ms % period) / period;                 // 0..1
  const wave = 0.5 - 0.5 * Math.cos(phase * 2 * Math.PI); // 0 at 0 and 1, 1 at 0.5
  return { scale: 0.9 + 0.1 * wave, alpha: 0.25 + 0.2 * wave };
}
export function auraParticleFx(def, ms) {
  const life = Number(def.particle_lifetime_ms) || 300;
  return { fx: { def, x: 0, y: 0, nx: 1, ny: 0, startedAt: Math.floor(ms / life) * life }, t: (ms % life) / life };
}
```

Run: `cd frontend && npx vitest run src/games/something2/__tests__/auraVisual.test.js; echo "EXIT=$?"`

Expected: FAIL before the file exists, PASS after.

- [ ] **Step 6: Write the failing smoke/source test**

```js
// frontend/src/games/something2/__tests__/AuraEffectsAdmin.smoke.test.js
// vitest runs in node (no DOM). These are wiring guards for what would otherwise
// go inert silently, in the style of VfxEffectsAdmin.smoke.test.js.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAV_SECTIONS } from '../../../ui/navSections.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, rel), 'utf8');
const admin = read('../AuraEffectsAdmin.jsx');
const hooks = read('../useAuraEffects.js');
const preview = read('../auraPreview.js');

describe('Aura Effects screen', () => {
  it('uses all four hooks', () => {
    for (const h of ['useAuraEffectsAdmin()', 'useCreateAuraEffect', 'useUpdateAuraEffect', 'useDeleteAuraEffect']) expect(admin).toContain(h);
  });
  it('has the four spec sections', () => {
    for (const s of ['Target', 'Modifiers', 'Damage over time', 'Visual']) expect(admin).toContain(`>${s}<`);
  });
  it('shows Used by from the API field', () => {
    expect(admin).toMatch(/used_by/);
    expect(admin).toContain('Used by');
  });
  it('the preview is live and uses the shared maths', () => {
    expect(preview).toMatch(/from '\.\/src\/js\/core\/auraVisual\.js'/);
    expect(preview).toMatch(/particlesAt\(/);
    expect(admin).toMatch(/drawAuraPreview\(/);
    expect(admin).toMatch(/\}, \[form\]\)/);
  });
  it('surfaces the 409 binding names and hits the right endpoint', () => {
    expect(hooks).toMatch(/AURA_QUERY_KEY = \["auraEffects"\]/);
    expect(hooks).toMatch(/\/api\/aura-effects/);
    expect(hooks).toMatch(/referencing_entity_types/);
    expect(hooks).toMatch(/still bound by/);
  });
  it('is registered in the sidebar next to Attack Effects', () => {
    const admin = NAV_SECTIONS.find((s) => s.title === 'Admin').items;
    const i = admin.findIndex((x) => x.id === 'vfx');
    expect(admin[i + 1]).toMatchObject({ id: 'auras', label: 'Aura Effects', path: '/game/auras', adminType: 'entity' });
    expect(read('../../../App.jsx')).toMatch(/<Route path="auras" element={<AuraEffectsAdmin \/>} \/>/);
  });
});
```

Run: `cd frontend && npx vitest run src/games/something2/__tests__/AuraEffectsAdmin.smoke.test.js; echo "EXIT=$?"`

Expected: FAIL (`ENOENT … AuraEffectsAdmin.jsx`).

- [ ] **Step 7: Implement hook, preview, component, route, nav**

**`useAuraEffects.js`**
- Copy the structure of `useVfxEffects.js:1-94` with these substitutions:
  - `AURA_QUERY_KEY = ["auraEffects"]`
  - URL `${API_URL}/api/aura-effects`
  - toast nouns "Aura …"
- `orphanMessage` reads only `referencing_entity_types`:

```js
function orphanMessage(body, fallback) {
  const entities = body.referencing_entity_types || [];
  if (entities.length === 0) return body.error || fallback;
  return `${body.error || fallback} — still bound by: ${entities.map((r) => r.name).join(", ")}`;
}
```

- After a successful update, `onSuccess` also invalidates `['entityTypes']` (the query key `useEntityTypes` uses in `useMaps.js`; verify with `grep -n "queryKey" frontend/src/games/something2/useMaps.js`). A cascade rename changes entity rows.
- On an update whose response has `renamedBindings > 0`, toast `"Aura renamed — N entity binding(s) updated"`.

**`auraPreview.js`**

```js
// Live preview for the Aura Effects admin (SOMET-604). Pulse maths come from
// core/auraVisual.js and particles from core/vfx.js's particlesAt -- the same
// functions S5's renderer must use. Flat screen space, not iso: a legibility
// aid, not a world simulation. The aura is drawn at a fixed preview scale with
// a 48px creature box for size reference.
import { particlesAt } from './src/js/core/vfx.js';
import { auraPulse, auraParticleFx } from './src/js/core/auraVisual.js';

export function drawAuraPreview(ctx, w, h, def, elapsedMs) {
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2; const cy = h / 2;
  const maxR = Math.min(w, h) * 0.45;
  const scaleWorld = maxR / Math.max(Number(def.radius) || 1, 48);
  const { scale, alpha } = auraPulse(def, elapsedMs);
  const r = (Number(def.radius) || 0) * scaleWorld * scale;
  ctx.save();
  ctx.strokeStyle = def.color || '#d4a017';
  ctx.fillStyle = def.color || '#d4a017';
  if (def.shape === 'disc') {
    ctx.globalAlpha = alpha * 0.6;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  } else if (def.shape === 'ring') {
    ctx.globalAlpha = Math.min(1, alpha * 2); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  }
  const count = Math.floor(Number(def.particle_count) || 0);
  if (count > 0 || def.shape === 'particles') {
    const pdef = { ...def, particle_count: count || 16 };
    const { fx, t } = auraParticleFx(pdef, elapsedMs);
    const size = Math.max(1, Number(def.particle_size) || 2);
    for (const p of particlesAt(fx, t)) {
      ctx.globalAlpha = p.alpha;
      ctx.fillRect(cx + p.dx * scaleWorld - size / 2, cy + p.dy * scaleWorld - size / 2, size, size);
    }
  }
  ctx.globalAlpha = 1; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1; // s2-theme-exempt(#ffffff): reference box on the dark preview canvas
  const box = 48 * scaleWorld; ctx.strokeRect(cx - box / 2, cy - box / 2, box, box);
  ctx.restore();
}
```

**`AuraEffectsAdmin.jsx`**
- Copy `VfxEffectsAdmin.jsx`'s styled components, `Preview` (with `drawAuraPreview` and `auraFormToPayload`, re-armed on `[form]`) and page shell (search box; filter by `target_side` instead of shape).
- The `AuraCard` form has four labelled sections, each heading a `<SectionTitle>` element whose text is exactly `Target`, `Modifiers`, `Damage over time`, `Visual`:
  - **Target:** Name; Side `<Select>` over `AURA_SIDES`; Radius.
  - **Modifiers:** Damage ×, Defense ×, Speed ×. Add the hint "allies: >1 buffs; enemies: <1 weakens (enemy side is live from S4)".
  - **Damage over time:** DPS, Element `<Select>` over `AURA_ELEMENTS`, Tick ms. Disabled when side is `allies`, with the hint "enemies only".
  - **Visual:** Shape `<Select>` over `AURA_SHAPES`, Colour (`type="color"`), Pulse ms, Particles, Spread, Speed, Gravity, Life ms, Size.
- Under the form: `Used by (N): name, name…` from `aura.used_by`, or "Not bound to any entity".
- Delete is disabled when `used_by.length > 0` and carries the `title` "Unbind it from these entities first". The server 409 still guards stale data.
- Save runs `validateAuraForm` first and shows the error in `<Err role="alert">` (same as `VfxEffectsAdmin.jsx:79-88`).
- Page description: "Auras are fields around an entity. Bind them in Entities → Auras. Renaming an aura updates every binding; deleting one that is still bound is refused."

**`App.jsx`**
- `import AuraEffectsAdmin from './games/something2/AuraEffectsAdmin.jsx';` after the `VfxEffectsAdmin` import (`:25`).
- `<Route path="auras" element={<AuraEffectsAdmin />} />` after `:70`.

**`navSections.js`**, after the `vfx` line (`:38`):

```js
      // SOMET-604: the aura library, beside Attack Effects (both are effect
      // libraries an entity binds by name). Bound in the Entities tab.
      { id: 'auras', label: 'Aura Effects', path: '/game/auras', Icon: HiOutlineSparkles, adminType: 'entity' },
```

**`navSections.test.js`**
- Count `16 → 17`. Title wording `fourteen → fifteen`.
- Insert `'/game/auras',` after `'/game/vfx',`.
- If the other session's sprites change merged first, the count is `18`/`sixteen` and the list carries both. Resolve by keeping both entries.

- [ ] **Step 8: Run all frontend aura + nav tests**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/auraForm.test.js src/games/something2/__tests__/auraVisual.test.js src/games/something2/__tests__/AuraEffectsAdmin.smoke.test.js src/ui/__tests__/navSections.test.js src/ui/__tests__/navRoutes.test.js; echo "EXIT=$?"`

Expected: `EXIT=0`.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/games/something2/auraForm.js frontend/src/games/something2/src/js/core/auraVisual.js frontend/src/games/something2/auraPreview.js frontend/src/games/something2/useAuraEffects.js frontend/src/games/something2/AuraEffectsAdmin.jsx frontend/src/games/something2/__tests__/auraForm.test.js frontend/src/games/something2/__tests__/auraVisual.test.js frontend/src/games/something2/__tests__/AuraEffectsAdmin.smoke.test.js frontend/src/App.jsx frontend/src/ui/navSections.js frontend/src/ui/__tests__/navSections.test.js
git commit -m "feat(auras): Aura Effects admin tab with live preview and used-by (SOMET-604)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Entities tab: Auras multi-select

**Files:**
- Create: `frontend/src/games/something2/entityAuras.js`
- Create: `frontend/src/games/something2/__tests__/entityAuras.test.js`
- Modify: `frontend/src/games/something2/EntityTypesAdmin.jsx`:
  - import `useAuraEffectsAdmin` + helpers;
  - `formData` init `:940-969` and the edit/new branches `:972-1059` gain `auras`;
  - the picker goes inside the `formData.is_creature` block after Attack Element (`:1389-1400`);
  - `handleSubmit` `:1071-1105` sends `auras`.

**Interfaces:**
- `toggleAura(list, name) → string[]`: null-safe, order-preserving.
- `missingAuras(list, library) → string[]`
- `aurasForPayload(form) → null | string[]`

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/games/something2/__tests__/entityAuras.test.js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toggleAura, missingAuras, aurasForPayload } from '../entityAuras.js';

describe('entity aura picker helpers', () => {
  it('toggling onto a never-authored (null) list starts a list', () => {
    expect(toggleAura(null, 'pack_leader')).toEqual(['pack_leader']);
  });
  it('toggling the last aura off leaves [] (an explicit removal), never null', () => {
    expect(toggleAura(['pack_leader'], 'pack_leader')).toEqual([]);
  });
  it('preserves order and never duplicates', () => {
    expect(toggleAura(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
    expect(toggleAura(['a', 'b'], 'a')).toEqual(['b']);
  });
  it('names a bound aura that no longer exists in the library', () => {
    expect(missingAuras(['pack_leader', 'ghost'], [{ name: 'pack_leader' }])).toEqual(['ghost']);
    expect(missingAuras(null, [])).toEqual([]);
  });
  it('payload keeps null as null and [] as []', () => {
    expect(aurasForPayload({ auras: null })).toBeNull();
    expect(aurasForPayload({ auras: [] })).toEqual([]);
  });
});

describe('EntityTypesAdmin wiring', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../EntityTypesAdmin.jsx'), 'utf8');
  it('binds auras from the LIBRARY (checkboxes over fetched names), never free text', () => {
    expect(src).toMatch(/useAuraEffectsAdmin\(\)/);
    expect(src).toMatch(/toggleAura\(/);
    expect(src).not.toMatch(/<input[^>]*value=\{formData\.auras/);
  });
  it('carries the stored value into the edit form (null survives as null)', () => {
    expect(src).toMatch(/auras: editingEntity\.auras \?\? null/);
  });
  it('submits auras', () => {
    expect(src).toMatch(/auras: aurasForPayload\(formData\)/);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/entityAuras.test.js; echo "EXIT=$?"`

Expected: FAIL (`Failed to resolve import "../entityAuras.js"`).

- [ ] **Step 3: Implement**

```js
// frontend/src/games/something2/entityAuras.js
// SOMET-604. entity_types.auras: null = never authored (the seeder may bind a
// behaviour default), [] = deliberately none (never re-bound by a reseed).
export function toggleAura(list, name) {
  const cur = Array.isArray(list) ? list : [];
  return cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name];
}
export function missingAuras(list, library) {
  if (!Array.isArray(list)) return [];
  const known = new Set((library || []).map((a) => a.name));
  return list.filter((n) => !known.has(n));
}
export function aurasForPayload(form) {
  return Array.isArray(form.auras) ? [...form.auras] : null;
}
```

In `EntityTypesAdmin.jsx`:
- Import `{ useAuraEffectsAdmin } from './useAuraEffects.js'` and the helpers. Call `const { auras: auraLibrary } = useAuraEffectsAdmin();`, renaming the hook's return to `{ auras, isLoadingAuras }` in Task 8 if needed.
- Add `auras: null` to the initial state and the new-entity branch, and `auras: editingEntity.auras ?? null,` to the edit branch.
- In `handleSubmit`'s `body`, add `auras: aurasForPayload(formData),`.
- Inside the `formData.is_creature` block, after the Behavior/Attack Element row, add:

```jsx
<FormGroup>
  <label>Auras <Hint>— from the Aura Effects tab; none checked = no aura</Hint></label>
  {auraLibrary.map(a => (
    <label key={a.id} style={{ display: 'inline-flex', gap: 4, marginRight: 12 }}>
      <input type="checkbox" checked={(formData.auras || []).includes(a.name)}
        onChange={() => setFormData({ ...formData, auras: toggleAura(formData.auras, a.name) })} />
      {a.name} <small>({a.target_side}, r {a.radius})</small>
    </label>
  ))}
  {missingAuras(formData.auras, auraLibrary).map(n => (
    <p key={n} role="alert" style={{ color: 'var(--s2-danger)' }}>
      Bound to "{n}", which is not in the aura library — it does nothing.
      <button type="button" onClick={() => setFormData({ ...formData, auras: toggleAura(formData.auras, n) })}>Remove</button>
    </p>
  ))}
</FormGroup>
```

Use the file's existing `Hint`/`FormGroup` styled components. If `Hint` is not defined in this file, use `<small style={{ color: 'var(--s2-text-muted)' }}>`.

Careful with the ~~form-snapshot~~ trap (memory: form snapshot reverts approved asset). `syncApprovedAsset` only touches image/sprite/render_mode, so `auras` is unaffected. No change is needed there.

- [ ] **Step 4: Run and see it pass, then run the neighbouring entity tests**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/entityAuras.test.js src/games/something2/__tests__/entityAssetSync.test.js src/games/something2/__tests__/entityFilters.test.js; echo "EXIT=$?"`

Expected: `EXIT=0`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/entityAuras.js frontend/src/games/something2/__tests__/entityAuras.test.js frontend/src/games/something2/EntityTypesAdmin.jsx
git commit -m "feat(auras): Auras picker in the Entities tab (SOMET-604)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Browser verification + full suites (DoD)

**Files:** none (evidence goes into the PR and the Plane comment).

- [ ] **Step 1: Run the branch against the scratch DB**

The dev stack serves the SHARED checkout, so it cannot show this branch. Follow the recipe from memory `features-disarm-their-own-guards`:
- Start a backend from the worktree on `:13102` against `game_db_s3`, with `JWT_SECRET` and `SPRITE_GEN_SHARED_SECRET` copied from `.env`, launched via `setsid nohup`.
- Start `npx vite --config ./vite.pin.config.mjs` with `VITE_API_URL=http://localhost:13102`.
- Register an admin on the scratch DB through the UI (register-to-login). Do not promote a dev-DB user.

- [ ] **Step 2: Verify the Aura Effects tab (Chrome DevTools MCP, isolatedContext)**

Exit fullscreen if the game entered it. Confirm a fresh bundle: `curl` the `AuraEffectsAdmin.jsx` module from the pin vite and grep it for `Damage over time`.

At `/game/auras`, check:
- the sidebar shows "Aura Effects" directly under "Attack Effects";
- `pack_leader` is listed with **Used by (32)**;
- the preview ring pulses;
- changing the colour changes the preview within a frame;
- radius `0` shows the form error and sends no network request (check the Network panel);
- creating `zz_test_drum` (allies, r 150, dmg 1.2) succeeds;
- deleting `pack_leader` is disabled, and a forced DELETE via `evaluate_script` fetch returns 409 listing Champions;
- renaming `zz_test_drum` → `zz_test_drum2` while it is bound to one entity updates that entity's checkbox label after reload.

Take a screenshot of each.

- [ ] **Step 3: Verify the Entities tab**

Open `Beast Champion`:
- the Auras section shows `pack_leader` checked;
- uncheck it and save, then reload: it stays unchecked and the API row shows `auras: []`;
- run `node scripts/seed-catalogs.js` against the scratch DB and reload: it is STILL unchecked;
- re-check it and save.

Open `Creature Behaviors → Champion`: there are no aura inputs, and the hint points to Entities.

- [ ] **Step 4: Verify the buff in game**

Join a world on the scratch DB where Champions spawn. Find a Champion pack with Shift+M (dev minimap). Let one follower hit the character and record the damage number. Kill the Champion, let the same follower hit again, and confirm the hit is smaller by the ×1.25 factor (±level variance; compare two hits from the same follower).

If spawning is impractical, record why, and rely on `aura_loader_db` + `creature_mechanics_wiring` as the live-path proof. Say so explicitly in the PR rather than claiming a browser check.

- [ ] **Step 5: Full suites (read the EXIT code)**

```bash
cd /home/markunn/worker/coding/jsgame/something2-s3-auras/backend
npm test > /tmp/s3-final.txt 2>&1; echo "EXIT=$?"
grep -E '^not ok|testTimeoutFailure' /tmp/s3-final.txt
cd ../frontend && npx vitest run; echo "EXIT=$?"
```

Expected: both `EXIT=0`, and grep prints nothing. Any red that was also red in `/tmp/s3-baseline.txt` (Task 0 Step 3) is pre-existing and must be listed by name in the PR, not hidden.

- [ ] **Step 6: Clean up the browser-test rows on the scratch DB**

Delete `zz_test_drum*` and restore `Beast Champion`'s auras to `["pack_leader"]`. This is scratch DB only. Leave the DB itself in place for review.

- [ ] **Step 7: Push and open the PR only when the user asks** (memory: subagents pushed without authorization)

Before merge, check for migration collisions: `ls backend/migrations | grep -E '17144406[89]|1714440670'`. If S1 merged first, also confirm:
- S1's `entity_types.auras` migration and `1714440680000` both apply (IF NOT EXISTS);
- S1's `addCreatures` `auras:` line is replaced by `auras: resolveInstanceAuras(c)` (see Self-Review risk 2).

---

## Self-Review

**Spec coverage.**
- §3.2 table, every column, every CHECK: Task 1 (DB) and Task 2 (API).
- Stacking (same aura → max, different → multiply): Task 4.
- Enemy floors: S4, out of scope.
- `pack_leader` seeded from Champion's live values and bound to Champion entities: Task 1 (existing DB) and Task 3 (fresh DB).
- §3.4 `aura_*` dropped: Task 5.
- §4.2 allies side, distance compared squared (`dist2`): Task 4.
- §5 Aura Effects tab (list + form with Target/Modifiers/DoT/Visual + live preview + Used by + delete blocked while bound): Tasks 6 and 8.
- Entities Auras multi-select: Tasks 7 and 9.
- §7 S3:
  - golden-trace parity, RED first, plus a broken-variant proof: Task 4 Steps 4 and 7;
  - source guard that nothing reads `aura_*`: Task 5;
  - invoked-from-tick test: Task 4 Step 8.
- Browser verification: Task 10.

**Placeholder scan.** Every step that changes code shows the code or an exact line-level edit. Two places reference copying an existing file's structure (`useAuraEffects.js` from `useVfxEffects.js`, the component shell from `VfxEffectsAdmin.jsx`). Each lists the exact substitutions, and both are pinned by the Task 8 smoke test.

**Type consistency.**
- `resolveInstanceAuras` returns `{name,targetSide,radius,damageMult,defenseMult,speedMult,dotDps,dotElement,tickMs}`.
- `applyAuras` reads `targetSide/radius/damageMult/defenseMult/speedMult`.
- The fixtures in Tasks 4 and 5 use the same keys.
- The loader keys `aura_names`/`aura_defs` match between `server.js`, `auraEffects.js` and the wiring test.

**Risks and spec ambiguities the spec did not anticipate.**
1. **"Existing aura cap (`creatures.js:2195`) kept" points at the wrong cap.** That comment belongs to the PLAYER Sanguine leech aura (`countHostilesWithin`, SOMET-522). `computeAuras` has no cap; its cost is bounded only by leader count (`densityTiers.js:100-116` measured 200 leaders ≈ 25.8 ms/tick). This plan adds `radius <= 2000` as a DB/API bound, but no source cap. S4 must decide whether enemy-side auras on players need a per-player cap, since the cited one does not apply.
2. **S1 collision on `addCreatures` and on the entity PUT statement.**
   - The spec says S1's `addCreatures` "keeps … `auras`". If S1 stores the NAMES there, S3's `c.auras` (resolved defs) conflicts. `resolveInstanceAuras` deliberately ignores string entries in `auras` and resolves only from `aura_defs`, so at worst S1's names are inert, not wrong. Whoever merges second must keep exactly one `auras: resolveInstanceAuras(c)` line.
   - S1 also edits the same `UPDATE entity_types` parameter list (`index.js:1025-1066`). A textual conflict is certain; `id` must stay last.
   - S1's "one hydration function" will absorb `CREATURE_JOINED_SELECT`. The `AURAS_LATERAL` fragment must move with it.
3. **The migration-only bind is a no-op on a fresh DB.** Entity types are created by `seed-catalogs` after all migrations. Without Task 3's `bindDefaultAuras`, staging would ship with no Champion aura and every test green on the dev DB. The spec's "migration … binds it to every entity whose behaviour is Champion" is necessary but not sufficient.
4. **Admin edits reach live creatures only on the next chunk load.** Defs are resolved once per instance at load, the same as behaviours today. The VFX tab is "live without a deploy" because the client refetches, but a retuned radius here does NOT change creatures already in memory. Document this in the tab description. If the user expects instant effect, a library cache with invalidation is a follow-up.
5. **`target_side` stacking for enemy debuffs.** "Strongest value per stat (Math.max)" is right for buffs (>1). For an enemies aura with mult < 1, the "strongest" is `Math.min`. S4 must not reuse `applyAuras`' `Math.max` for the enemy side. S3 ignores the enemy side entirely, which Task 4 pins.
6. **DoT on an allies aura** is meaningless (it would damage the pack). This plan adds CHECK `target_side = 'enemies' OR dot_dps = 0`; the spec does not say this.
7. **`dot_element` vocabulary.**
   - The spec says "same as `item_types.element`", which is an FK to `elements` (5 values incl. `arcane`). This plan uses the same FK, NOT NULL, default `physical`.
   - Note that `entity_types.attack_element` and `creature_abilities.element` are CHECKs over only 4 values with no `arcane`. S1's `element` column must pick one of these two vocabularies, and the spec does not say which.
8. **Delete check-then-act gap.** The 409 check and the DELETE are separate statements, as in the vfx route. A concurrent bind in between orphans one name. The result is a no-op plus one log line, and the Entities tab shows it as "not in the library — Remove".
9. **The navSections test conflicts with the other session's uncommitted `sprites` entry** (both bump the item count). Resolve by keeping both entries; the count becomes 18.
