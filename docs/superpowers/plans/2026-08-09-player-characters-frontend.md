# Player Characters — Frontend & Delivery Implementation Plan (SOMET-262 … 264)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a character-selection gate in front of the game canvas, give players a read-only fog-of-war world map, and seed a test account so the whole flow can be verified in a browser.

**Architecture:** All branching logic lives in pure modules that vitest can import, because this project's vitest runs in a plain **node** environment with no jsdom and no React Testing Library — components cannot be rendered in a test here. Components stay thin; their wiring is guarded by source-text regression tests, the same technique `authGating.test.js` already uses.

**Tech Stack:** React 19, React Router 7, TanStack Query 5, styled-components 6, Cytoscape 3 via react-cytoscapejs, vitest 3 (node environment).

**Spec:** `docs/superpowers/specs/2026-08-09-player-characters-design.md`
**Prerequisite:** `docs/superpowers/plans/2026-08-09-player-characters-backend.md` must be complete and its Task 11 green.

## Global Constraints

- **Branch:** continues `feat/player-characters`. This plan's Task 9 is the merge gate for the whole epic.
- **vitest runs in a node environment.** No `document`, no `render()`, no `@testing-library/react`. Do not add one as part of this work — putting the logic in a pure module is the established answer here and it is the reason `autoJoin.js` and `mapGraphLayout.js` exist as separate files.
- **`GameShell` must stay a layout route.** Its canvas is deliberately kept mounted across child navigation; making it anything else unmounts the canvas and blanks the running world. `authGating.test.js:70` pins the canvas-bind effect's dependency array for the same reason.
- **`useMatch('/game')` is an END match, not a prefix match.** `authGating.test.js:66` pins this.
- **`@tanstack/react-query` is not a declared dependency.** It resolves today only as a transitive dependency of `@tanstack/react-query-devtools`. Task 1 adds it explicitly; do not add a new hook file without that step.
- **Never run destructive experiments against the shared dev database.**
- **No assertion may be derived from the same constant the code under test reads.**
- **Migration numbers:** this plan claims `1714440093000` and `1714440094000`, following the backend plan's `…091000` and `…092000`.
- **Test commands:** `npx vitest run` from `frontend/`; `npm test` from `backend/`.
- **Commit convention:** `type(scope): summary (SOMET-NNN)` with the `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` trailer.

## File Structure

**Created:**

| file | responsibility |
|---|---|
| `frontend/src/games/something2/characterSession.js` | pure: active-character storage, stale-id resolution, slot arithmetic |
| `frontend/src/games/something2/useCharacters.js` | TanStack hooks: list, classes, create, delete |
| `frontend/src/games/something2/CharacterSelect.jsx` | the list + create form rendered in place of the canvas |
| `frontend/src/games/something2/PlayerWorldMap.jsx` | read-only fog-of-war graph |
| `frontend/src/games/something2/playerWorldMap.js` | pure: turn the endpoint payload into Cytoscape elements |
| `frontend/src/games/something2/__tests__/characterSession.test.js` | |
| `frontend/src/games/something2/__tests__/playerWorldMap.test.js` | |
| `frontend/src/games/something2/__tests__/characterGating.test.js` | source-text guards for the gate and sign-out clearing |
| `backend/migrations/1714440093000_character_visited_worlds.js` | |
| `backend/migrations/1714440094000_seed_test_player.js` | |
| `backend/migrations/test-user-readme.md` | |
| `backend/src/services/visitedWorlds.js` | the single write helper both entry paths call |
| `backend/tests/visited_worlds_db.test.js` | |
| `backend/tests/player_world_map_routes.test.js` | |
| `backend/tests/seed_test_player.test.js` | |

**Modified:**

| file | change |
|---|---|
| `frontend/package.json` | declare `@tanstack/react-query` |
| `frontend/src/games/something2/GameShell.jsx` | the character gate ahead of the canvas |
| `frontend/src/games/something2/src/js/core/Game.js` | thread `characterId` into `initChunked` |
| `frontend/src/games/something2/src/js/net/WorldAuthorityClient.js` | send `character_id` in the join frame |
| `frontend/src/context/AuthContext.jsx` | clear the active character on sign-out |
| `frontend/src/ui/navSections.js` | add the player World Map entry, relabel the admin one |
| `frontend/src/App.jsx` | register `/game/map` outside `RequireAdmin` |
| `backend/src/authority/server.js` | record a visit on join and on transition |
| `backend/src/index.js` | `GET /api/player/world-map` |

---

## Task 1: Character session module and data hooks

**Files:**
- Create: `frontend/src/games/something2/characterSession.js`
- Create: `frontend/src/games/something2/useCharacters.js`
- Create: `frontend/src/games/something2/__tests__/characterSession.test.js`
- Modify: `frontend/package.json`

**Interfaces:**
- Produces:
  - `ACTIVE_CHARACTER_KEY = "something2.activeCharacterId"`
  - `readActiveCharacterId() -> number | null`
  - `writeActiveCharacterId(id) -> void`
  - `clearActiveCharacterId() -> void`
  - `resolveActiveCharacter(storedId, characters) -> character | null`
  - `slotsUsed(characters) -> number`, `canCreate(characters, maxCharacters) -> boolean`
  - `useCharacters()` → `{ characters, maxCharacters, isLoadingCharacters, charactersError }`
  - `usePlayableClasses()` → `{ classes, isLoadingClasses }`
  - `useCreateCharacter()`, `useDeleteCharacter()` — TanStack mutations invalidating `["characters"]`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/something2/__tests__/characterSession.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ACTIVE_CHARACTER_KEY, readActiveCharacterId, writeActiveCharacterId,
  clearActiveCharacterId, resolveActiveCharacter, slotsUsed, canCreate,
} from '../characterSession.js';

// vitest runs in a node environment here, so there is no real localStorage.
// characterSession must degrade to an in-memory store rather than throw — the
// same shape net/auth.js uses for the token.
const store = new Map();
beforeEach(() => {
  store.clear();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  clearActiveCharacterId();
});

const CHARACTERS = [
  { id: 7, slot: 1, name: 'Gorm', className: 'Warrior', level: 4 },
  { id: 9, slot: 2, name: 'Sela', className: 'Mage', level: 1 },
];

describe('active character storage', () => {
  it('round-trips an id as a number', () => {
    writeActiveCharacterId(9);
    expect(readActiveCharacterId()).toBe(9);
  });

  it('uses the documented storage key', () => {
    writeActiveCharacterId(9);
    expect(store.get(ACTIVE_CHARACTER_KEY)).toBe('9');
  });

  it('reads null when nothing is stored', () => {
    expect(readActiveCharacterId()).toBe(null);
  });

  it('reads null for a non-numeric stored value rather than passing it on', () => {
    store.set(ACTIVE_CHARACTER_KEY, 'not-a-number');
    expect(readActiveCharacterId()).toBe(null);
  });

  it('clears', () => {
    writeActiveCharacterId(9);
    clearActiveCharacterId();
    expect(readActiveCharacterId()).toBe(null);
  });
});

describe('resolveActiveCharacter', () => {
  it('returns the matching character', () => {
    expect(resolveActiveCharacter(9, CHARACTERS).name).toBe('Sela');
  });

  it('returns null for an id that is not in the list', () => {
    // A character deleted from another device. This must land on the list, not
    // on a join that the server will reject.
    expect(resolveActiveCharacter(999, CHARACTERS)).toBe(null);
  });

  it('returns null when nothing is stored', () => {
    expect(resolveActiveCharacter(null, CHARACTERS)).toBe(null);
  });

  it('returns null while the list is still loading', () => {
    // undefined means "not fetched yet" — resolving to null here would flash
    // the picker for one frame before the canvas.
    expect(resolveActiveCharacter(9, undefined)).toBe(null);
  });
});

describe('slot arithmetic', () => {
  it('counts characters, not the highest slot', () => {
    expect(slotsUsed([{ slot: 3 }, { slot: 8 }])).toBe(2);
  });

  it('allows creation below the cap', () => {
    expect(canCreate(CHARACTERS, 8)).toBe(true);
  });

  it('refuses creation at the cap', () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({ id: i, slot: i + 1 }));
    expect(canCreate(eight, 8)).toBe(false);
  });

  it('refuses creation while the list is unknown', () => {
    expect(canCreate(undefined, 8)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/characterSession.test.js`
Expected: FAIL — cannot resolve `../characterSession.js`.

- [ ] **Step 3: Write the module**

Create `frontend/src/games/something2/characterSession.js`:

```js
// Which character this browser is playing, and the pure rules around it.
//
// Separate from the components for the reason autoJoin.js is separate: vitest
// runs in a node environment in this project, so nothing under games/something2
// can be rendered in a test. The branching lives here where it can be asserted.

export const ACTIVE_CHARACTER_KEY = "something2.activeCharacterId";

// Mirrors net/auth.js's approach: an in-memory copy so a session keeps working
// where localStorage is unavailable (private-mode quotas, sandboxed iframes),
// with storage as the source of truth across a reload.
let memoryId = null;

function storage() {
  try {
    return typeof globalThis !== "undefined" && globalThis.localStorage
      ? globalThis.localStorage
      : null;
  } catch {
    return null;
  }
}

export function readActiveCharacterId() {
  const s = storage();
  let raw = memoryId;
  if (raw == null && s) {
    try { raw = s.getItem(ACTIVE_CHARACTER_KEY); } catch { raw = null; }
  }
  if (raw == null) return null;
  const id = Number(raw);
  if (!Number.isInteger(id)) return null;
  memoryId = id;
  return id;
}

export function writeActiveCharacterId(id) {
  memoryId = Number(id);
  const s = storage();
  if (s) {
    try { s.setItem(ACTIVE_CHARACTER_KEY, String(id)); } catch { /* memory still holds it */ }
  }
}

export function clearActiveCharacterId() {
  memoryId = null;
  const s = storage();
  if (s) {
    try { s.removeItem(ACTIVE_CHARACTER_KEY); } catch { /* best-effort */ }
  }
}

// The stored id resolved against the account's real characters, or null.
//
// Returning null for an id that is not in the list is the important case: a
// character deleted from another device leaves a stored id that would otherwise
// produce a join the server rejects, which surfaces as an error the player has
// to dismiss instead of simply landing on the picker.
//
// `characters` undefined means the list has not loaded yet. Returning null then
// would flash the picker for a frame before the canvas, so callers must treat
// "still loading" as a third state rather than as "no character".
export function resolveActiveCharacter(storedId, characters) {
  if (!Array.isArray(characters)) return null;
  if (storedId == null) return null;
  return characters.find((c) => c.id === storedId) || null;
}

export function slotsUsed(characters) {
  return Array.isArray(characters) ? characters.length : 0;
}

export function canCreate(characters, maxCharacters) {
  if (!Array.isArray(characters)) return false;
  return characters.length < maxCharacters;
}
```

Create `frontend/src/games/something2/useCharacters.js` following `useWorlds.js` exactly — same `API_URL` derivation, same `apiFetch`/`authHeaders` imports, same toast-on-error shape, same `invalidateQueries` on mutation success. Query keys: `["characters"]` and `["playableClasses"]`.

Then add the missing declaration to `frontend/package.json` dependencies, in alphabetical position:

```json
    "@tanstack/react-query": "^5.100.6",
```

- [ ] **Step 4: Run the test**

```bash
cd frontend && npx vitest run src/games/something2/__tests__/characterSession.test.js && npm install --package-lock-only
```
Expected: all thirteen assertions PASS; the lockfile shows `@tanstack/react-query` as a direct dependency.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/characterSession.js frontend/src/games/something2/useCharacters.js frontend/src/games/something2/__tests__/characterSession.test.js frontend/package.json frontend/package-lock.json
git commit -m "feat(characters): character session module and data hooks (SOMET-262)"
```

---

## Task 2: Thread the character id into the join frame

**Files:**
- Modify: `frontend/src/games/something2/src/js/net/WorldAuthorityClient.js:49,58`
- Modify: `frontend/src/games/something2/src/js/core/Game.js:215,288`
- Test: `frontend/src/games/something2/__tests__/characterGating.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `Game.initChunked({ ..., characterId })`; the socket's join frame carries `character_id`.

### Why this comes before the UI

The backend now refuses a join without a `character_id`. Landing the wire change first means the next task's UI has something that works to hand a character to.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/something2/__tests__/characterGating.test.js`:

```js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-text regression tests, matching ui/__tests__/authGating.test.js.
// vitest runs in a plain node environment in this project, so none of these
// modules can be rendered or socket-tested here. Each assertion corresponds to
// a specific way the wiring can go inert while every other test still passes.
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, rel), 'utf8');

describe('the join frame carries a character id', () => {
  it('WorldAuthorityClient sends character_id, not just world_id', () => {
    const source = read('../src/js/net/WorldAuthorityClient.js');
    expect(source).toMatch(/type:\s*['"]join['"][\s\S]{0,120}character_id/);
  });

  it('Game.initChunked accepts and forwards a characterId', () => {
    const source = read('../src/js/core/Game.js');
    expect(source).toMatch(/characterId/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/characterGating.test.js`
Expected: both FAIL.

- [ ] **Step 3: Thread it through**

Read `WorldAuthorityClient.js:40-70` and `Game.js:210-300` first. Then:

- `WorldAuthorityClient.connect` takes the character id (constructor option or connect argument — follow whichever the surrounding code already uses for `world_id`) and sends `{ type: 'join', world_id: this.worldId, character_id: this.characterId }`.
- `Game.initChunked({ worldId, chunkSize, tileTypes, vfxEffects, entityTypes, spawnX, spawnY, characterId })` passes `characterId` down to the client.
- If `characterId` is null or undefined, **throw** rather than connecting. A silent connect produces a server-side rejection that reaches the player as a bare "unknown character" toast with nothing actionable in it.

- [ ] **Step 4: Run the test**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/characterGating.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/net/WorldAuthorityClient.js frontend/src/games/something2/src/js/core/Game.js frontend/src/games/something2/__tests__/characterGating.test.js
git commit -m "feat(characters): send character_id in the authority join frame (SOMET-262)"
```

---

## Task 3: The character-select gate

**Files:**
- Create: `frontend/src/games/something2/CharacterSelect.jsx`
- Modify: `frontend/src/games/something2/GameShell.jsx`
- Modify: `frontend/src/games/something2/autoJoin.js`
- Test: `frontend/src/games/something2/__tests__/characterGating.test.js` (extend)

**Interfaces:**
- Consumes: Task 1's `characterSession.js` and `useCharacters.js`; Task 2's `initChunked({ characterId })`.
- Produces: `CharacterSelect` rendered in place of the canvas when no character is active; a "Change character" action on the shell's outlet context.

### What the gate must do

1. While `characters` is still loading, render nothing (not the picker) — otherwise the picker flashes for a frame on every reload.
2. With no active character, render `CharacterSelect`.
3. With an active character, the existing canvas path runs unchanged, and `enterWorld` passes `characterId`.
4. Auto-join must not fire until a character is active. `autoJoin.js:33` gains `hasCharacter` and returns null without it.

- [ ] **Step 1: Write the failing test**

Extend `frontend/src/games/something2/__tests__/characterGating.test.js`:

```js
describe('GameShell gates the canvas behind a character', () => {
  const source = read('../GameShell.jsx');

  it('renders CharacterSelect when no character is active', () => {
    expect(source).toMatch(/CharacterSelect/);
  });

  it('passes the active character id into initChunked via enterWorld', () => {
    expect(source).toMatch(/characterId/);
  });

  it('still uses an END match on /game', () => {
    // Pinned by ui/__tests__/authGating.test.js too; repeated here because this
    // task edits the same component and the two files are read independently.
    expect(source).toMatch(/useMatch\('\/game'\)/);
    expect(source).not.toMatch(/useMatch\('\/game\/\*'\)/);
  });

  it('keeps the canvas mounted rather than unmounting it behind the picker', () => {
    // The canvas element must still be rendered unconditionally with a display
    // toggle. Replacing it with `{active && <canvas/>}` would recreate the
    // RenderSystem's captured element on every character switch.
    expect(source).toMatch(/display:\s*isGameRoute && isPlaying \? 'block' : 'none'/);
  });
});

describe('auto-join waits for a character', () => {
  it('autoJoinTarget refuses without one', async () => {
    const { autoJoinTarget } = await import('../autoJoin.js');
    const ready = {
      isAdmin: false, isPlaying: false, alreadyJoined: false, hasGame: true,
      worlds: [{ id: 'w1', is_entry: true }], mapTiles: {}, mapConfig: {},
    };
    expect(autoJoinTarget({ ...ready, hasCharacter: true })).toBe('w1');
    expect(autoJoinTarget({ ...ready, hasCharacter: false })).toBe(null);
  });
});

describe('signing out clears the active character', () => {
  it('AuthContext.signOut calls clearActiveCharacterId', () => {
    // Without this, the next account to sign in on this browser inherits a
    // stale id and is bounced by the server's ownership check.
    const source = read('../../../context/AuthContext.jsx');
    expect(source).toMatch(/clearActiveCharacterId/);
    expect(source).toMatch(/signOut[\s\S]{0,200}clearActiveCharacterId\(\)/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/characterGating.test.js`
Expected: the four new blocks FAIL.

- [ ] **Step 3: Build the gate**

**`autoJoin.js`** — add the guard, keeping the existing comment block:

```js
export function autoJoinTarget({ isAdmin, isPlaying, alreadyJoined, hasGame, hasCharacter, worlds, mapTiles, mapConfig }) {
  if (isAdmin || isPlaying || alreadyJoined) return null;
  if (!hasGame) return null;
  // A join without a character is refused by the authority (SOMET-260), so
  // firing before one is chosen produces a guaranteed error toast rather than
  // a race that sometimes works.
  if (!hasCharacter) return null;
  if (!worldAssetsReady(mapTiles, mapConfig)) return null;
  const target = pickEntryWorld(worlds);
  return target ? target.id : null;
}
```

**`AuthContext.jsx`** — import `clearActiveCharacterId` and call it inside `signOut`, next to `clearToken()`.

**`CharacterSelect.jsx`** — a styled-components list matching the project's existing admin panels. It renders: one row per character (name, class, level, last world, Play, Delete), a slot counter, and a create form (text input + one radio per class). Delete asks for confirmation. Create is disabled with a visible explanation at the cap, using `canCreate`. Errors from the mutations toast via the hooks' `onError`, as `useWorlds.js` does.

**`GameShell.jsx`** — add, near the other hooks:

```jsx
  const { characters, maxCharacters, isLoadingCharacters } = useCharacters();
  const [activeCharacterId, setActiveCharacterId] = useState(() => readActiveCharacterId());
  const activeCharacter = resolveActiveCharacter(activeCharacterId, characters);

  // A stored id whose character no longer exists (deleted from another device)
  // resolves to null: drop the stale id rather than letting it reach a join the
  // server will reject.
  useEffect(() => {
    if (!isLoadingCharacters && activeCharacterId != null && !activeCharacter) {
      clearActiveCharacterId();
      setActiveCharacterId(null);
    }
  }, [isLoadingCharacters, activeCharacterId, activeCharacter]);

  const playCharacter = (id) => { writeActiveCharacterId(id); setActiveCharacterId(id); };
  const changeCharacter = () => {
    exitToMenu();
    gameRef.current?.disconnect?.();
    clearActiveCharacterId();
    setActiveCharacterId(null);
    autoJoinedRef.current = false;
  };
```

`enterWorld` passes `characterId: activeCharacter?.id` into `initChunked`, and returns early if there is none. The auto-join effect passes `hasCharacter: !!activeCharacter` and adds `activeCharacter` to its dependency array.

In the JSX, render the picker **beside** the canvas rather than instead of it — the canvas element stays mounted with its existing `display` toggle, which is what keeps `RenderSystem`'s captured element valid:

```jsx
          {isGameRoute && !isPlaying && !isLoadingCharacters && !activeCharacter && (
            <CharacterSelect
              characters={characters}
              maxCharacters={maxCharacters}
              onPlay={playCharacter}
            />
          )}
```

Add `changeCharacter` and `activeCharacter` to the `<Outlet context={{...}}>` object so `GameView`'s HUD can offer the switch.

- [ ] **Step 4: Run the frontend suite**

Run: `cd frontend && npx vitest run`
Expected: all tests PASS, including `ui/__tests__/authGating.test.js` and `navRoutes.test.js` unchanged.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/CharacterSelect.jsx frontend/src/games/something2/GameShell.jsx frontend/src/games/something2/autoJoin.js frontend/src/context/AuthContext.jsx frontend/src/games/something2/__tests__/characterGating.test.js
git commit -m "feat(characters): character-select gate ahead of the game canvas (SOMET-262)"
```

---

## Task 4: Record which worlds a character has visited

**Files:**
- Create: `backend/migrations/1714440093000_character_visited_worlds.js`
- Create: `backend/src/services/visitedWorlds.js`
- Modify: `backend/src/authority/server.js` (join handler; transition handler)
- Test: `backend/tests/visited_worlds_db.test.js`

**Interfaces:**
- Produces:
  - table `character_visited_worlds(character_id, world_id, first_seen_at)`, PK `(character_id, world_id)`
  - `recordVisit(pool, characterId, worldId) -> Promise<void>`
  - `listVisited(pool, characterId) -> Promise<Array<{worldId}>>`

### The trap this task exists to avoid

There are **two** paths by which a character enters a world: the `join` handler and the server-pushed `transition`. A visit recorded only on join looks correct in every test and is dead for half of real play — a player who walks through a portal never records the destination. This is precisely how the creature-behaviours epic shipped an inert loader. Both call sites go through one helper, and the test asserts both.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/visited_worlds_db.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { recordVisit, listVisited } = require('../src/services/visitedWorlds');
const { createCharacter, listPlayableClasses } = require('../src/services/characters');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

test('both entry paths record a visit', () => {
  // Source-text guard, deliberately, and it is the most important assertion in
  // this file. A visit recorded on join but not on transition passes every
  // behavioural test written against join, and is dead the moment a player
  // walks through a portal.
  const src = fs.readFileSync(path.join(__dirname, '../src/authority/server.js'), 'utf8');
  const calls = src.match(/recordVisit\(/g) || [];
  assert.ok(calls.length >= 2,
    `expected recordVisit at both the join and transition call sites, found ${calls.length}`);

  const joinStart = src.indexOf('async join(ws, msg)');
  const joinEnd = src.indexOf('\n    },', joinStart);
  assert.match(src.slice(joinStart, joinEnd), /recordVisit\(/, 'join must record a visit');

  // The transition planner is what pushes a player into another world; find it
  // by the frame it sends rather than by a line number.
  const transitionIdx = src.indexOf("type: 'transition'");
  assert.ok(transitionIdx !== -1, 'could not locate the transition frame');
  const around = src.slice(Math.max(0, transitionIdx - 2000), transitionIdx + 2000);
  assert.match(around, /recordVisit\(/, 'the transition path must record a visit too');
});

test('character_visited_worlds', { skip: !url ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());

  const classes = await listPlayableClasses(pool);
  const warrior = classes.find((c) => c.name === 'Warrior');
  const worlds = (await pool.query('SELECT id FROM worlds ORDER BY name LIMIT 2')).rows;

  async function withCharacter(fn) {
    await pool.query(
      "INSERT INTO users (username, password_hash, role) VALUES ('zzVisit', 'x', 'player') ON CONFLICT (username) DO NOTHING");
    const userId = (await pool.query("SELECT id FROM users WHERE username = 'zzVisit'")).rows[0].id;
    const c = await createCharacter(pool, userId, 'zzVisitChar', warrior.id);
    try { return await fn(c.id); }
    finally { await pool.query("DELETE FROM users WHERE username = 'zzVisit'"); }
  }

  await t.test('a fresh character has visited nothing', async () => {
    await withCharacter(async (id) => {
      assert.deepEqual(await listVisited(pool, id), []);
    });
  });

  await t.test('recording is idempotent and keeps the first timestamp', async () => {
    await withCharacter(async (id) => {
      await recordVisit(pool, id, worlds[0].id);
      const first = (await pool.query(
        'SELECT first_seen_at FROM character_visited_worlds WHERE character_id = $1', [id])).rows[0].first_seen_at;
      await recordVisit(pool, id, worlds[0].id);
      const rows = await pool.query(
        'SELECT first_seen_at FROM character_visited_worlds WHERE character_id = $1', [id]);
      assert.equal(rows.rows.length, 1);
      assert.deepEqual(rows.rows[0].first_seen_at, first, 'a re-visit must not move first_seen_at');
    });
  });

  await t.test('visits are per character, not per account', async () => {
    await withCharacter(async (id) => {
      await recordVisit(pool, id, worlds[0].id);
      const other = await createCharacter(
        pool,
        (await pool.query("SELECT id FROM users WHERE username = 'zzVisit'")).rows[0].id,
        'zzVisitChar2', warrior.id);
      assert.deepEqual(await listVisited(pool, other.id), []);
    });
  });

  await t.test('deleting the character cascades its visits', async () => {
    let captured;
    await withCharacter(async (id) => { captured = id; await recordVisit(pool, id, worlds[0].id); });
    const r = await pool.query(
      'SELECT count(*)::int AS n FROM character_visited_worlds WHERE character_id = $1', [captured]);
    assert.equal(r.rows[0].n, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/visited_worlds_db.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`backend/migrations/1714440093000_character_visited_worlds.js`:

```js
exports.shorthands = undefined;

// Fog of war (SOMET-263). The player's World Map shows only the worlds THIS
// character has entered, plus anonymous stubs for their directly-linked
// neighbours -- so the graph reveals the shape of what has been explored
// without spoiling what lies past the next door.
//
// Per character, not per account: two characters on one account explore
// independently, which is the whole point of having eight of them.
exports.up = (pgm) => {
  pgm.createTable('character_visited_worlds', {
    character_id: { type: 'integer', notNull: true, references: 'characters', onDelete: 'CASCADE' },
    world_id: { type: 'uuid', notNull: true, references: 'worlds', onDelete: 'CASCADE' },
    first_seen_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  }, {
    constraints: { primaryKey: ['character_id', 'world_id'] },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('character_visited_worlds');
};
```

`backend/src/services/visitedWorlds.js`:

```js
// ONE helper, called from BOTH places a character can enter a world: the join
// handler and the transition handler. Two copies of this INSERT is how a
// feature ends up wired into one path and dead in the other -- the shape that
// shipped an inert creature-behaviour loader. visited_worlds_db.test.js asserts
// both call sites exist.

// DO NOTHING, not DO UPDATE: first_seen_at means first, and a re-visit must not
// move it.
async function recordVisit(pool, characterId, worldId) {
  await pool.query(
    `INSERT INTO character_visited_worlds (character_id, world_id)
     VALUES ($1, $2) ON CONFLICT (character_id, world_id) DO NOTHING`,
    [characterId, worldId],
  );
}

async function listVisited(pool, characterId) {
  const r = await pool.query(
    'SELECT world_id FROM character_visited_worlds WHERE character_id = $1',
    [characterId],
  );
  return r.rows.map((x) => ({ worldId: x.world_id }));
}

module.exports = { recordVisit, listVisited };
```

Then call `recordVisit(pool, character.id, entry.worldId)` in the `join` handler (after the join succeeds, fire-and-forget with a `.catch(() => {})` — a failed bookkeeping write must never break a join), and call it again where the server sends `{ type: 'transition', ... }`, for the destination world id.

- [ ] **Step 4: Run the test**

Run: `cd backend && npm run migrate:up && node --test tests/visited_worlds_db.test.js`
Expected: PASS, including the two-call-site source guard.

- [ ] **Step 5: Commit**

```bash
git add backend/migrations/1714440093000_character_visited_worlds.js backend/src/services/visitedWorlds.js backend/src/authority/server.js backend/tests/visited_worlds_db.test.js
git commit -m "feat(worldmap): record visited worlds on both join and transition (SOMET-263)"
```

---

## Task 5: The player world-map endpoint

**Files:**
- Modify: `backend/src/index.js`
- Test: `backend/tests/player_world_map_routes.test.js`

**Interfaces:**
- Consumes: `listVisited` (Task 4); `ownedCharacter` (backend plan Task 5).
- Produces: `GET /api/player/world-map?character_id=` → `{ worlds, links, unvisited, currentWorldId }`.

### The payload

```jsonc
{
  "worlds": [
    { "id": "…", "name": "Overworld", "graph_x": 0, "graph_y": 0, "is_entry": true,
      "level_min": 1, "level_max": 3 }
  ],
  // Links whose BOTH ends are visited. Compass links carry an edge; portals
  // carry "PORTAL".
  "links": [{ "from": "…", "to": "…", "edge": "N" }],
  // Directly-linked neighbours of a visited world that have NOT been visited.
  // Id only — no name, no level band, no coordinates. Withholding the name at
  // the API is the point: hiding it in the component would still ship it to
  // the browser.
  "unvisited": [{ "id": "…", "from": "…" }],
  "currentWorldId": "…"
}
```

- [ ] **Step 1: Write the failing test**

Create `backend/tests/player_world_map_routes.test.js`, copying the supertest harness from `backend/tests/progression_routes.test.js`. Cases:

```
- unauthenticated                                  -> 401
- authed, character_id belonging to another user   -> 403
- authed, missing character_id                     -> 400
- fresh character, no visits                       -> worlds: [], unvisited: []
- one visited world                                -> that world present, WITH its name
- a linked neighbour that has not been visited     -> present in `unvisited`
- that neighbour's NAME is absent from the whole response body
      (assert on JSON.stringify(body), so a name nested anywhere fails)
- a world two hops away, not linked to any visited world -> absent entirely
- a link with one unvisited end                    -> not in `links`
```

The name-absence assertion must be written against the serialised body, not against `body.unvisited[0].name` — the failure being guarded is a name leaking through some *other* field.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/player_world_map_routes.test.js`
Expected: FAIL — 404.

- [ ] **Step 3: Add the route**

In `backend/src/index.js`, following the surrounding route style:

```js
const { listVisited } = require('./services/visitedWorlds');
const { ownedCharacter } = require('./services/characters');

// The player's fog-of-war map. Read-only, and deliberately NOT the same payload
// the admin World Map tab reads: an unvisited neighbour is returned as a bare
// id so the graph can draw an anonymous stub. Withholding the name here rather
// than in the component is the point — a component-side filter still ships the
// name to the browser, where anyone can read it.
app.get('/api/player/world-map', authGuard, async (req, res) => {
  try {
    const character = await ownedCharacter(pool, req.user.id, req.query.character_id);
    if (!character) return res.status(req.query.character_id ? 403 : 400)
      .json({ error: req.query.character_id ? 'forbidden' : 'character_id required' });

    const visited = (await listVisited(pool, character.id)).map((v) => v.worldId);
    if (visited.length === 0) {
      return res.json({ worlds: [], links: [], unvisited: [], currentWorldId: null });
    }

    const worlds = (await pool.query(
      `SELECT id, name, graph_x, graph_y, is_entry, level_min, level_max
         FROM worlds WHERE id = ANY($1::uuid[]) ORDER BY name`,
      [visited])).rows;

    const edges = (await pool.query(
      `SELECT from_world_id, to_world_id, edge
         FROM map_links WHERE from_world_id = ANY($1::uuid[])`,
      [visited])).rows;

    const seen = new Set(visited);
    const links = [];
    const unvisited = new Map();
    for (const e of edges) {
      if (seen.has(e.to_world_id)) {
        links.push({ from: e.from_world_id, to: e.to_world_id, edge: e.edge });
      } else if (!unvisited.has(e.to_world_id)) {
        unvisited.set(e.to_world_id, { id: e.to_world_id, from: e.from_world_id });
      }
    }

    const cur = await pool.query(
      'SELECT world_id FROM world_players WHERE character_id = $1 ORDER BY updated_at DESC LIMIT 1',
      [character.id]);

    res.json({
      worlds, links, unvisited: [...unvisited.values()],
      currentWorldId: cur.rows.length ? cur.rows[0].world_id : null,
    });
  } catch (err) {
    console.error('player world map failed:', err);
    res.status(500).json({ error: 'failed to load world map' });
  }
});
```

- [ ] **Step 4: Run the test**

Run: `cd backend && node --test tests/player_world_map_routes.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/index.js backend/tests/player_world_map_routes.test.js
git commit -m "feat(worldmap): fog-of-war endpoint for the player world map (SOMET-263)"
```

---

## Task 6: The player world map view

**Files:**
- Create: `frontend/src/games/something2/playerWorldMap.js`
- Create: `frontend/src/games/something2/PlayerWorldMap.jsx`
- Create: `frontend/src/games/something2/__tests__/playerWorldMap.test.js`
- Modify: `frontend/src/ui/navSections.js`, `frontend/src/App.jsx`

**Interfaces:**
- Consumes: Task 5's endpoint; `seedPositions` from `mapGraphLayout.js`.
- Produces: `toCytoscapeElements(payload) -> Array<element>`; the `/game/map` route; the player-visible nav entry.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/something2/__tests__/playerWorldMap.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { toCytoscapeElements } from '../playerWorldMap.js';

// Cytoscape cannot be mounted here (vitest runs in a node environment), so the
// payload -> elements transform lives in its own module, exactly as
// mapGraphLayout.js does for the admin graph.
const PAYLOAD = {
  worlds: [
    { id: 'a', name: 'Overworld', graph_x: 0, graph_y: 0, is_entry: true, level_min: 1, level_max: 3 },
    { id: 'b', name: 'Deep Forest', graph_x: 1, graph_y: 0, is_entry: false, level_min: 3, level_max: 6 },
  ],
  links: [{ from: 'a', to: 'b', edge: 'E' }],
  unvisited: [{ id: 'c', from: 'b' }],
  currentWorldId: 'b',
};

describe('toCytoscapeElements', () => {
  const els = toCytoscapeElements(PAYLOAD);
  const nodes = els.filter((e) => !e.data.source);
  const edges = els.filter((e) => e.data.source);

  it('renders a node per visited world plus one per unvisited stub', () => {
    expect(nodes.map((n) => n.data.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('labels visited worlds with their name', () => {
    expect(nodes.find((n) => n.data.id === 'a').data.label).toBe('Overworld');
  });

  it('never labels an unvisited stub with a name', () => {
    const stub = nodes.find((n) => n.data.id === 'c');
    expect(stub.data.unvisited).toBe(true);
    expect(stub.data.label).toBe('?');
  });

  it('marks the current world', () => {
    expect(nodes.find((n) => n.data.id === 'b').data.current).toBe(true);
    expect(nodes.find((n) => n.data.id === 'a').data.current).toBe(false);
  });

  it('draws an edge to the unvisited stub so the player knows a door exists', () => {
    expect(edges.some((e) => e.data.source === 'b' && e.data.target === 'c')).toBe(true);
  });

  it('produces no elements at all for an empty payload', () => {
    expect(toCytoscapeElements({ worlds: [], links: [], unvisited: [], currentWorldId: null })).toEqual([]);
  });

  it('tolerates a missing payload while the query is in flight', () => {
    expect(toCytoscapeElements(undefined)).toEqual([]);
  });
});

describe('the player map is read-only by construction', () => {
  it('imports no edgehandles and registers no edit handler', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.join(here, '../PlayerWorldMap.jsx'), 'utf8');
    // Absence assertions, not the presence of a readOnly flag: a flag can be
    // true and still have an unguarded branch behind it.
    expect(source).not.toMatch(/edgehandles/);
    expect(source).not.toMatch(/useCreateWorld|useDeleteWorld|useUpdateWorld/);
    expect(source).not.toMatch(/grabbable:\s*true/);
    expect(source).not.toMatch(/\bdragfree\b|\bposition\b\s*:/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/playerWorldMap.test.js`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`playerWorldMap.js` — pure. Nodes from `worlds` (label = name, `unvisited: false`, `current: id === currentWorldId`) plus one per `unvisited` entry (label `'?'`, `unvisited: true`, `current: false`). Edges from `links`, plus one `from → id` edge per unvisited stub. Positions come from `seedPositions` when `graph_x`/`graph_y` are absent; use the stored coordinates when present, exactly as the admin graph does. Return `[]` for a missing or empty payload.

`PlayerWorldMap.jsx` — `CytoscapeComponent` with `elements={toCytoscapeElements(data)}`, `userZoomingEnabled`, `userPanningEnabled`, and `autoungrabify: true`. Node style keys off `data(unvisited)` and `data(current)`. Data comes from a TanStack query on `["playerWorldMap", characterId]` calling the Task 5 endpoint. Read the theme-token conventions in `MapGraphAdmin.jsx` and use the same `--s2-*` variables rather than literal colours.

`navSections.js` — add to the first (non-admin) section:

```js
        { id: 'playermap', label: 'World Map', path: '/game/map', Icon: HiOutlineGlobeAlt },
```

and relabel the admin one at line 31 to `'World Map Editor'`. Leave its path and id alone — the id is referenced elsewhere.

`App.jsx` — register the route as a **sibling of the `RequireAdmin` block**, inside the `game` layout route:

```jsx
                    <Route path="game" element={<GameShell />}>
                      <Route index element={<GameView />} />
                      <Route path="map" element={<PlayerWorldMap />} />
                      <Route element={<RequireAdmin />}>
```

- [ ] **Step 4: Run the frontend suite**

Run: `cd frontend && npx vitest run`
Expected: PASS. `navRoutes.test.js` will exercise the new entry — its "every nav path has a route" and "every route under RequireAdmin has a nav entry" checks both still hold, because `/game/map` is registered outside the guarded block and has a nav entry.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/playerWorldMap.js frontend/src/games/something2/PlayerWorldMap.jsx frontend/src/games/something2/__tests__/playerWorldMap.test.js frontend/src/ui/navSections.js frontend/src/App.jsx
git commit -m "feat(worldmap): read-only fog-of-war world map for players (SOMET-263)"
```

---

## Task 7: The seeded test player

**Files:**
- Create: `backend/migrations/1714440094000_seed_test_player.js`
- Create: `backend/migrations/test-user-readme.md`
- Test: `backend/tests/seed_test_player.test.js`

**Interfaces:**
- Consumes: `characters` (backend plan Task 3); the `Warrior` class (backend plan Task 1).
- Produces: user `testplayer` with one slot-1 Warrior, **only** when `SEED_TEST_USER=1`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/seed_test_player.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

// No-DB structural test. The property that matters is that the migration is
// INERT without the flag: a password committed to this repository must not be
// able to become a live login on an environment that never opted in. Asserting
// that by running the migration twice against a database would only prove it
// for the database at hand; asserting it structurally proves it for all of them.
function fakePgm() {
  const order = [];
  return {
    order,
    sql: (s) => order.push({ op: 'sql', s }),
    func: (s) => ({ __func: s }),
  };
}

const mig = require('../migrations/1714440094000_seed_test_player.js');

test('without SEED_TEST_USER the migration does nothing at all', () => {
  const prev = process.env.SEED_TEST_USER;
  delete process.env.SEED_TEST_USER;
  try {
    const pgm = fakePgm();
    mig.up(pgm);
    assert.deepEqual(pgm.order, [], 'the migration must be a complete no-op without the flag');
  } finally {
    if (prev !== undefined) process.env.SEED_TEST_USER = prev;
  }
});

test('with SEED_TEST_USER it creates the account and one Warrior', () => {
  const prev = process.env.SEED_TEST_USER;
  process.env.SEED_TEST_USER = '1';
  try {
    const pgm = fakePgm();
    mig.up(pgm);
    const sql = pgm.order.map((c) => c.s).join('\n');
    assert.match(sql, /INSERT INTO users/i);
    assert.match(sql, /'testplayer'/);
    assert.match(sql, /'player'/, 'the seeded account must be a player, never an admin');
    assert.doesNotMatch(sql, /'admin'/, 'this migration must never create an admin');
    assert.match(sql, /INSERT INTO characters/i);
    assert.match(sql, /'Warrior'/);
    assert.match(sql, /ON CONFLICT/i, 're-running the migration must be idempotent');
    assert.doesNotMatch(sql, /SEED_TEST_USER/, 'the flag must gate the emit, not be emitted into SQL');
  } finally {
    if (prev === undefined) delete process.env.SEED_TEST_USER;
    else process.env.SEED_TEST_USER = prev;
  }
});

test('the password is a bcrypt hash, not a literal', () => {
  const prev = process.env.SEED_TEST_USER;
  process.env.SEED_TEST_USER = '1';
  try {
    const pgm = fakePgm();
    mig.up(pgm);
    const sql = pgm.order.map((c) => c.s).join('\n');
    assert.match(sql, /\$2[aby]\$12\$/, 'must store a 12-round bcrypt hash, matching 1714440025000');
  } finally {
    if (prev === undefined) delete process.env.SEED_TEST_USER;
    else process.env.SEED_TEST_USER = prev;
  }
});

test('down removes the account', () => {
  const pgm = fakePgm();
  mig.down(pgm);
  const sql = pgm.order.map((c) => c.s).join('\n');
  assert.match(sql, /DELETE FROM users/i);
  assert.match(sql, /'testplayer'/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/seed_test_player.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the migration and the readme**

`backend/migrations/1714440094000_seed_test_player.js`:

```js
exports.shorthands = undefined;

// A player account for manual testing, with credentials documented in
// test-user-readme.md alongside this file.
//
// GATED, AND THE GATE IS THE POINT. The password below is committed to the
// repository. On any environment that does not set SEED_TEST_USER=1 this
// migration emits nothing at all, so a published password can never be a live
// login. This is the same shape as the admin seed in 1714440025000, which
// creates nothing when ADMIN_USERNAME/ADMIN_PASSWORD are unset -- no default
// credentials, ever.
//
// The account gets ONE character rather than none, so the login-resume path is
// testable the moment the migration runs, and seven free slots so creation and
// deletion are testable too.
const USERNAME = 'testplayer';
const PASSWORD = 'testplayer-dev-only';

exports.up = (pgm) => {
  if (process.env.SEED_TEST_USER !== '1') return;

  const bcrypt = require('bcryptjs');
  const hash = bcrypt.hashSync(PASSWORD, 12);

  pgm.sql(`INSERT INTO users (username, password_hash, role)
           VALUES ('${USERNAME}', '${hash}', 'player')
           ON CONFLICT (username) DO NOTHING`);

  // Guarded by the joins: if the Warrior class is somehow missing, this inserts
  // nothing rather than failing the migration on a NULL foreign key.
  pgm.sql(`INSERT INTO characters (user_id, slot, name, entity_type_id)
           SELECT u.id, 1, 'Testwarrior', e.id
             FROM users u, entity_types e
            WHERE u.username = '${USERNAME}' AND e.name = 'Warrior'
           ON CONFLICT (user_id, slot) DO NOTHING`);
};

exports.down = (pgm) => {
  // The character and all its state cascade away with the account.
  pgm.sql(`DELETE FROM users WHERE username = '${USERNAME}'`);
};

exports.USERNAME = USERNAME;
```

`backend/migrations/test-user-readme.md`:

```markdown
# Test player account

`1714440094000_seed_test_player.js` can seed a player account for manual
testing. **It does nothing unless you opt in.**

| | |
|---|---|
| username | `testplayer` |
| password | `testplayer-dev-only` |
| role | `player` (never admin) |
| characters | one slot-1 Warrior named `Testwarrior`; seven slots free |

## Enabling it

Add to the repo-root `.env`, then run the migrations:

```
SEED_TEST_USER=1
```

```bash
cd backend && npm run migrate:up
```

## Why it is gated

The password above is committed to this repository, so anyone who can read the
repo knows it. The `SEED_TEST_USER` check means the account cannot exist on an
environment that has not explicitly asked for it — a deployment that never sets
the flag has no such user, and there is no way to log in as one.

**Do not set `SEED_TEST_USER=1` anywhere that is reachable from the internet.**

This mirrors how the admin account already works: `1714440025000_users.js`
creates an admin only when `ADMIN_USERNAME` and `ADMIN_PASSWORD` are both set,
and ships no default credentials.

## Removing it

```bash
cd backend && npx node-pg-migrate down 1
```

or delete the row directly — the character and all its state cascade away with
the account.
```

- [ ] **Step 4: Run the test and apply the migration**

```bash
cd backend && node --test tests/seed_test_player.test.js
SEED_TEST_USER=1 npm run migrate:up
psql "$DATABASE_URL" -c "SELECT u.username, c.name, c.slot FROM users u JOIN characters c ON c.user_id = u.id WHERE u.username = 'testplayer';"
```
Expected: four tests PASS; the query returns `testplayer | Testwarrior | 1`.

- [ ] **Step 5: Commit**

```bash
git add backend/migrations/1714440094000_seed_test_player.js backend/migrations/test-user-readme.md backend/tests/seed_test_player.test.js
git commit -m "feat(characters): env-gated seeded test player and its readme (SOMET-264)"
```

---

## Task 8: Both suites green

**Files:**
- Modify: whatever the suites reveal.

- [ ] **Step 1: Run both**

```bash
cd backend && npm test 2>&1 | tail -20
cd ../frontend && npx vitest run 2>&1 | tail -20
```

- [ ] **Step 2: Fix fixtures, not assertions**

`navRoutes.test.js` and `authGating.test.js` are the two most likely to fail, and both are guarding real properties — if either fails, the change under it is wrong, not the test.

- [ ] **Step 3: Record the counts and commit**

```bash
git add -A
git commit -m "test(characters): suite green across backend and frontend (SOMET-264)"
```

---

## Task 9: Browser verification — the merge gate

**Files:** none. This task produces evidence, and it is what allows the branch to merge.

A green suite is not evidence here. This project has repeatedly shipped defects past a fully green suite: an inert stamina bar, ammo that could not be fired, walls rendering as flat background. Every one was caught in a browser and none by a test.

- [ ] **Step 1: Confirm the stack is serving fresh code**

Start the compose stack and confirm **both** the Vite bundle and the backend reflect this branch before trusting anything below. A stale bundle or a backend still running pre-branch code has faked a clean pass on this project before. Hard-reload with cache disabled; check that `/api/characters` responds at all (it did not exist before this branch).

- [ ] **Step 2: Log in as the test player and create a Mage**

Register or log in as `testplayer` / `testplayer-dev-only`. The character list must show `Testwarrior` and `1/8`. Create a Mage.

**Confirm the Mage's inventory holds an `apprentice staff` and an `arcane-ward` — not the Warrior's sword.** This is the assertion that proves the class loadout is wired rather than merely present in a table.

- [ ] **Step 3: Confirm login resumes at the exact position**

Play the Mage, walk to a distinct, memorable position, note the coordinates, hard-refresh. The character must resume at **that** position, not at the world centre or the entry spawn.

- [ ] **Step 4: Confirm the fog-of-war map**

Open World Map. It must show only worlds this character has entered, plus anonymous `?` stubs. Walk through a portal, return to the map: the destination must now be named. Open the map with the Warrior — its visited set must be different.

- [ ] **Step 5: Confirm the player cannot reach admin surfaces**

Navigate directly to `/game/maps`, `/game/entities` and `/game/world-map`. Each must redirect. The sidebar must show exactly **Game View** and **World Map**.

- [ ] **Step 6: Confirm the slot cap end to end**

Create characters up to 8. The create control must disable itself with a visible explanation. Delete one; creation must become possible again and reuse the freed slot.

- [ ] **Step 7: Confirm character switching**

Use "Change character" from the HUD, pick the Warrior, confirm its own position, inventory and level — and that gold is the **same** number both characters see.

- [ ] **Step 8: Record the evidence and merge**

Attach screenshots to SOMET-264 and move each of SOMET-257 … 264 through the Plane lifecycle. Then merge `feat/player-characters` to `main`.

**If any step above fails, the epic is not done.** Record the defect with steps, expected and actual, and return the relevant ticket to Changes Requested rather than merging around it.

---

## Self-review notes

Spec coverage: §6 → Tasks 1–3. §7.1 → Task 4. §7.2 → Task 5. §7.3 → Task 6. §8 → Task 6. §9 → Task 7. §10 frontend tests → Tasks 1, 3, 6. §10 browser verification → Task 9.

Type consistency: `resolveActiveCharacter(storedId, characters)` has that argument order in Task 1's module, Task 1's test and Task 3's `GameShell` snippet. `toCytoscapeElements(payload)` takes the whole endpoint payload in Tasks 5 and 6. `recordVisit(pool, characterId, worldId)` has that arity in Task 4's service, test and both call sites. `canCreate(characters, maxCharacters)` matches between module and test.

Deliberate gaps: Task 5's route test and Task 6's component body are specified as enumerated cases plus a described shape rather than finished code, because both must copy an existing harness (`progression_routes.test.js`) or an existing theming convention (`MapGraphAdmin.jsx`) that would be reproduced wrongly from a summary. Every case and every constraint is named; none is left to taste.

One thing this plan does **not** do: it never renders a component in a test, because this project's vitest has no DOM. Task 9 is therefore not optional polish — it is the only place `CharacterSelect` and `PlayerWorldMap` are executed at all.
