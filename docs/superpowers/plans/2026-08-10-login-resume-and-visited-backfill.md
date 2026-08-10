# Plan A — Login resume & visited-worlds backfill

Two independent defect fixes found while browser-verifying SOMET-256. Neither
depends on the fast-travel work in Plan B
(`2026-08-10-map-fast-travel.md`), and both should ship before it.

**Goal:** a returning player lands back where they logged out — the right
world, not just the right coordinates — and a character that has played before
sees its history on the World Map.

**Users:** players (both defects are invisible to admins, who keep the world
picker by design and rarely read the player map).

---

## Global constraints

- Migrations are `node-pg-migrate` v6, CommonJS, hand-numbered. The next free
  number is **above `1714440161000`** — a parallel branch has applied
  `1714440150000`–`152000` to the shared dev database and those files exist in
  no branch, so numbering must sort above them to stay ordered after any merge.
- `backend/migrations/` is `require()`d wholesale by both runners; only `.js`
  files are migrations (`MIGRATION_IGNORE_PATTERN` in `src/index.js` and the
  `--ignore-pattern` in both npm scripts must stay in step —
  `migration_ignore_pattern.test.js` enforces this).
- vitest runs in a **node environment**: no component can be rendered. Branching
  must live in pure modules; wiring is held by source-text guards that anchor on
  the **use**, not the name.
- **Never mutate the shared dev database** to make a test pass. Fixtures create
  and delete their own rows.

---

## Defect 1 — auto-join targets the entry world, not the character's last world

### The bug

`autoJoinTarget` (`frontend/src/games/something2/autoJoin.js:33`) calls
`pickEntryWorld(worlds)`, which returns the world flagged `is_entry` and
otherwise a world named `Overworld`. It never looks at the character. So a
player who logs out in Windwatch Pass and returns is auto-joined into the
*entry* world, and `loadSpawn` then restores their last position **within that
world** — not the one they actually left.

The data already exists and is computed in three places
(`services/characters.js:50`, `src/index.js:431`, and the player world-map
endpoint's `currentWorldId`). Auto-join ignores all of them.

This defeats the epic's headline requirement: *"login only to saved point where
he logged out."*

### Files

- Modify: `backend/src/services/characters.js:41-66`
- Modify: `frontend/src/games/something2/autoJoin.js`
- Modify: `frontend/src/games/something2/GameShell.jsx`
- Test: `frontend/src/games/something2/__tests__/autoJoin.test.js`
- Test: `backend/tests/characters_service_db.test.js`

### Step 1 — expose the last world id

The LATERAL join already selects `world_id`; it is simply not returned. Add it
to the SELECT list and the mapped object:

```js
            w.name AS last_world_name,
            lw.world_id AS last_world_id
```

```js
    lastWorldName: x.last_world_name,
    lastWorldId: x.last_world_id,
```

Add to `characters_service_db.test.js`: a character with a `world_players` row
returns `lastWorldId` equal to that world; a character that has never played
returns `null`. **Assert the id, not merely truthiness** — returning the wrong
world is the whole failure mode.

### Step 2 — prefer it in the auto-join decision

```js
export function autoJoinTarget({
  isAdmin, isPlaying, alreadyJoined, hasGame, hasCharacter,
  lastWorldId, worlds, mapTiles, mapConfig,
}) {
  if (isAdmin || isPlaying || alreadyJoined) return null;
  if (!hasGame) return null;
  if (!hasCharacter) return null;
  if (!worldAssetsReady(mapTiles, mapConfig)) return null;

  // Where this character actually logged out wins over the entry world.
  // pickEntryWorld is the FIRST-EVER-JOIN case, not the resume case; using it
  // unconditionally is what made "resume where you logged out" restore the
  // right coordinates in the wrong world.
  // Guarded on `worlds` membership: a world deleted since last session must
  // fall back rather than produce a join the server will refuse.
  if (lastWorldId && (worlds || []).some((w) => w.id === lastWorldId)) return lastWorldId;

  const target = pickEntryWorld(worlds);
  return target ? target.id : null;
}
```

### Step 3 — supply it

In `GameShell.jsx`, alongside the `hasCharacter` argument added in SOMET-262:

```js
      lastWorldId: activeCharacter ? activeCharacter.lastWorldId : null,
```

**This is the step that actually ships the fix.** SOMET-262 shipped a
`hasCharacter` guard whose caller never supplied it, so it read `undefined` and
disabled auto-join for every player while the pure-function test stayed green.
Add a source-text guard in `characterGating.test.js` asserting the call site
passes `lastWorldId:`, exactly as was done for `hasCharacter`.

### Step 4 — tests

In `autoJoin.test.js`:

```js
const ready = {
  isAdmin: false, isPlaying: false, alreadyJoined: false, hasGame: true,
  hasCharacter: true, mapTiles: {}, mapConfig: {},
  worlds: [{ id: 'entry', is_entry: true }, { id: 'w9' }],
};
// resumes the last world, NOT the entry world
expect(autoJoinTarget({ ...ready, lastWorldId: 'w9' })).toBe('w9');
// never played -> entry world
expect(autoJoinTarget({ ...ready, lastWorldId: null })).toBe('entry');
// last world deleted since -> fall back, do not join a world that is gone
expect(autoJoinTarget({ ...ready, lastWorldId: 'deleted' })).toBe('entry');
```

The first assertion must distinguish the two ids. A fixture where the entry
world *is* the last world would pass against the unfixed code.

---

## Defect 2 — no backfill, so every pre-existing character has a blank map

### The bug

`1714440160000_character_visited_worlds.js` creates the table empty. Visits are
only recorded from that migration forward, so every character that existed
before SOMET-256 shows "You have not been anywhere yet" permanently, despite
`world_players` already recording exactly which worlds it has been in.

Live evidence: the `admin` account's character has **10 `world_players` rows**
(Catacomb Threshold, Sealed Mausoleum, Old Trailhead, Windwatch Pass and six
more, back to 3 Aug) and **0 visit rows**.

This was missed because verification used a freshly-created character, for
which an empty map is the correct answer.

### Files

- Create: `backend/migrations/1714440162000_backfill_visited_worlds.js`
- Test: `backend/tests/backfill_visited_worlds.test.js`

### Step 1 — the migration

```js
exports.shorthands = undefined;

// A character with a world_players row has, by definition, stood in that world.
// character_visited_worlds was created empty in 1714440160000, so every
// character that predates it shows a blank fog-of-war map forever.
//
// first_seen_at is APPROXIMATE here and knowingly so: world_players.updated_at
// is when the character was LAST there, not first. It is the only evidence that
// survives, nothing currently displays the timestamp, and a wrong-but-ordered
// timestamp beats no row at all. New visits recorded from here on are exact.
exports.up = (pgm) => {
  pgm.sql(`INSERT INTO character_visited_worlds (character_id, world_id, first_seen_at)
           SELECT character_id, world_id, updated_at FROM world_players
           ON CONFLICT (character_id, world_id) DO NOTHING`);
};

// Irreversible by design: down cannot distinguish a backfilled row from one
// earned by playing after the migration ran, and deleting the latter would
// destroy real history. Re-running up is harmless (ON CONFLICT DO NOTHING).
exports.down = () => {};
```

### Step 2 — tests

Structural (no DB), mirroring `seed_test_player.test.js`'s fake-pgm idiom:

- `up` emits an INSERT selecting from `world_players`
- it carries `ON CONFLICT` so a re-run is a no-op
- it does **not** reference `now()` — using the current time would claim every
  character first saw every world at migration time
- `down` emits nothing, and that is deliberate

Behavioural (gated on `TEST_DATABASE_URL`, own fixtures, deleted in `finally`):
create a throwaway user + character, insert two `world_players` rows, run the
migration's SQL, assert both worlds appear in `character_visited_worlds` with
`first_seen_at` equal to the `world_players.updated_at` it came from — not
merely that two rows exist.

### Step 3 — apply and verify

```bash
cd backend && npm run migrate:up -- --no-check-order
```

Then confirm against the real regression case:

```sql
SELECT count(*) FROM character_visited_worlds WHERE character_id = 3;  -- expect 10
```

---

## Included scope

- `lastWorldId` returned by `listCharacters` and used by auto-join
- one-time backfill of `character_visited_worlds` from `world_players`
- tests for both, including the call-site guard for the new auto-join argument

## Excluded scope

- Anything in Plan B: the `allows_fast_travel` column, world classification,
  click-to-travel on the map
- SOMET-265 (no world has `is_entry`). **Related but separate**, and its
  urgency drops once resume works: `is_entry` then only governs a brand-new
  character's very first join. Note the mechanism is not missing — the specs
  declare an entry world and `seed-map.js` applies it, so this is a regression
  to chase in the seed path, not a feature to build.
- Restoring the *position* within the resumed world — already correct and
  verified (close persisted 3434,3150; the next join spawned at 3434,3150).

## Assumptions

- A `world_players` row means the character genuinely entered that world. True
  today: only `persist()` writes it, and only for a player in the world.
- Approximate `first_seen_at` is acceptable because nothing renders it. **If a
  "first discovered" date is ever surfaced, backfilled rows will be wrong** —
  it is recorded here so that is a known limitation, not a future mystery.
- `characters.lastWorldId` is a stable enough contract for the client; it is
  already computed for `lastWorldName`.

## Verification strategy

Both suites, then a browser pass — a green suite is not evidence on this
project, and six defects in SOMET-256 passed both suites while being visibly
broken.

1. `cd backend && npm test`
2. `cd frontend && npx vitest run`
3. Browser, with the stack confirmed serving current code first.

## User-visible acceptance criteria

- A character that logged out in world X and logs back in **is in world X**, at
  its saved position — not in the entry world.
- A character that has never played joins the entry world as before.
- The `admin` character's World Map shows its 10 previously-visited worlds
  instead of the empty state.
- A brand-new character's map still shows the empty state.
- Deleting the world a character last occupied does not strand that character
  on login.

## Known risks & unresolved questions

- **The auto-join effect's dependency array.** It re-runs on
  `[worlds, mapTiles, mapConfig, isAdmin, isPlaying, isGameRoute,
  activeCharacter]`. `lastWorldId` arrives on `activeCharacter`, so it is
  covered — but if that object is ever replaced by a bare id, the effect stops
  seeing changes. Worth a comment at the call site.
- **Backfill volume is unbounded in principle.** ~17 characters and a few dozen
  `world_players` rows today, so a single statement is fine; it would need
  batching only at a scale this project is nowhere near.
- **Open:** should `is_entry` remain the first-join target at all, or should a
  new character start in the world its *class* or the spec nominates? Out of
  scope here; raise if first-join placement matters.
