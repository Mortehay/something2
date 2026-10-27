# S2 Extended Boss Sounds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give bosses their own sound. Boss-tier creature rows get four extra audio slots (`spawn`, `presence`, `phase`, `enrage`) that ordinary creatures never list. The authority emits `spawn`/`phase`/`enrage` on the existing creature `sfx` channel. The client plays them at a new `boss` limiter tier that creature chatter cannot evict, and it loops `presence` while the boss is within screen radius (half the viewport diagonal, in world units).

**Architecture:** The subject registry (`audioSubjects.js`) keeps one slot vocabulary per kind. A kind may now answer *which* of those slots one subject carries (`subjectSlotNames`), and existence checks take the slot (`exists(db, keys, slot)`). For `creature`, a boss slot exists only on a `boss_tier` row. Every consumer that validates or enumerates slots passes the slot or reads the per-subject list. On the server, one builder `bossSfx(e, c, x, y)` in `sfxEvents.js` serves all three events. `CreatureSim.addCreatures` emits `spawn` for any boss-tier instance, which covers S9's dungeon bosses for free. `WorldBossManager` emits `phase` on its existing transitions and a new once-per-spawn `enrage`. On the client, `SfxLimiter` gains the `boss` tier, `sfxResolve` maps the three events and their priority, and `AudioEngine.tickNearby` runs a presence loop through the existing world-point loop machinery (`nearbyLoops`), keyed `boss:<id>` and swept against a per-tick screen radius from `Game.update`.

**Tech Stack:** Node 20 CommonJS, Express, `pg`, `node --test`, supertest; React 19 + Vite + vitest; Web Audio.

**Spec:** `docs/superpowers/specs/2026-10-10-boss-entities-auras-design.md` (S2 = §3.6 creature boss slots, §4.3 phase/enrage events, §4.4 client audio, §5 Audio tab + test panel triggers, §7 S2 tests)

**Plane:** SOMET-605 (parent SOMET-602)

## Global Constraints

- One git worktree for this slice: `WT=/home/markunn/worker/coding/jsgame/something2-wt-s2-boss-sounds`, branch `feat/s2-boss-sounds` (it already exists at `a15f754a`, with S1 and S3 merged). Never `checkout`/`stash`/`branch`/`merge` in the shared checkout `/home/markunn/worker/coding/jsgame/something2`. Other sessions use it, and it holds another session's untracked sprite-batch files (`1714440660000_sprite_batch_queue.js` and others) that you must not touch.
- One scratch DB for this branch: `S2_DB=postgres://user:password@localhost:15432/game_db_s2`. Every DB test run sets BOTH variables literally, as `TEST_DATABASE_URL=postgres://user:password@localhost:15432/game_db_s2 DATABASE_URL=postgres://user:password@localhost:15432/game_db_s2`. Do not use `export A=...; B="$A"`, because that once left B empty and faked a 5-test regression. Seed the DB completely (catalogs, `p5-descent`, then `vale-region` LAST, then the passive tree) before you trust any number.
- **Never mutate `game_db`** (the shared dev DB): no INSERT/UPDATE/DELETE/DDL, and no destructive experiments, even "to test a seeder". Every write in this plan goes to `game_db_s2`. Read-only SELECTs against `game_db` are allowed.
- **No migration is expected.** `audio_bindings.slot`, `audio_misses.slot`, `audio_prompts.slot` and `audio_jobs.slot` carry no CHECK on slot names (verified across `backend/migrations/*audio*`). If one turns out to be needed, the allocated range is `1714440690000+`. Re-check it first with `ls backend/migrations | grep 1714440[67]` and `git -C /home/markunn/worker/coding/jsgame/something2 ls-tree --name-only feat/s9-dungeon-bosses backend/migrations/`.
- Commit subject `type(scope): summary (SOMET-605)`, body ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage by explicit path only. Never `git add -A` or `git add .`, because the `node_modules` symlinks are not ignored. Never push.
- Trust the test exit code (`...; echo "exit=$?"`), never the `# fail` line. Also grep for `^not ok` and `testTimeoutFailure`. Never chain the run with `;` into a reporting command that hides its status.
- `backend/tests/openchest*.test.js` is a known-red file (SOMET-615) and is excluded from the pass/fail judgement. Every other red must be in the baseline or it belongs to this slice.
- **Parallel slices in flight:** S9 (`feat/s9-dungeon-bosses`, which touches `worldBoss.js` and spawn placement) and perf (`perf/aura-pass`, which touches `creatures.js` `applyAuras`). Keep `worldBoss.js` edits minimal and additive: new methods and constants, one call line in `tick`, one line in `_checkPhaseTransition`, one key in `getStatus`, one option on `_placeBossCreature`. Do not reformat or reorder existing code. In `creatures.js` touch only `addCreatures` (three lines after the `this.creatures.set(...)` statement) and the `require('./sfxEvents.js')` line.
- Backend tests run from `$WT/backend` with `node --test <file>`, and frontend tests from `$WT/frontend` with `npx vitest run <file>`.
- **Every test must be able to fail.** Expected values are literals written from the fixture (a boss at x=100 with width 96 has centre 148), never values recomputed from the constant or function under test. Every new guard is first shown RED: run it before the implementation step and record the failure line.
- DB test bodies that create rows run inside `withAdvisoryLock(pool, AUDIO_CLIPS_LOCK_KEY, ...)`, and their cleanup runs in a `finally` INSIDE that locked function, not in `t.after`. `t.after` runs outside the lock and can wipe a peer file's rows.

## Review Focus

Five failure modes a user would hit that no current test covers. Each one is pinned by a test in the task that owns it:

1. **An ordinary creature gains a boss slot by a side door.** The Audio tab is fixed, but a game client's miss report, a seed manifest, a stale queued job or a hand-built `POST /admin/bindings` could still create `creature/Slime/presence`. Every door must refuse it. Pinned in Task 1 (`existingSubjects` with slot) and Task 2 (route 400, `recordMisses` 0, `existingBindingSubjects` skip, dispatcher `subjectExists` with slot).
2. **A boss is demoted** (an admin clears Boss tier in the Entities tab). Its boss slots must vanish from the Audio tab and from `GET /admin/slots`, new binds must be refused, and nothing may crash on the bindings it already has (they stay, and come back on re-promotion). Pinned in Task 2.
3. **Creature chatter cuts a boss sound off** (the reason the tier exists), or a boss sound cuts off the player's own swing. `nearby` and `nearest` can never evict `boss`, and `boss` can never evict `own`. Pinned in Task 6 (limiter) and Task 7 (engine, end to end through `playSfxEvents`).
4. **The presence loop leaks.** The boss walks off screen, dies, despawns, or the world changes: the loop must fade, its voice must be freed, and a slow buffer must never start two sources for one boss. Pinned in Task 8.
5. **A boss event fires twice or never.** `enrage` must fire once per spawn however many ticks stay below 10%, a big hit that skips from phase 1 to 3 must emit one `phase`, and a lost-boss re-place (`worldBoss.js` tick, "missing from its world") must not replay `spawn`. Pinned in Task 4 and Task 5.

Also pinned, beyond the five: an ordinary creature's audio prompt context stays byte-identical, so adding the boss fields does not flag ~200 creature prompts as stale (Task 3).

## Research summary (cited)

- Registry: `backend/src/services/audioSubjects.js:64-87` defines `creature` with a static `slots` map (4 slots), static `cues`, `list`, `exists`, and `subjectCues`. `slotKind`/`isKnownSlot` (`:148-156`) are subject-independent. `existingSubjects`/`subjectExists` (`:162-170`) know nothing about slots.
- Every consumer of slots or existence (grep `SUBJECT_KINDS|isKnownSlot|slotKind|subjectExists|existingSubjects`):
  - `audioRoutes.js:46-57` `checkSubject`, used by propose/generate/upload/prompt PUT/prompt write/bindings/jobs (`:186,224,236,267,318,431,466`)
  - `audioRoutes.js:155-164` `GET /admin/subjects`, which sends `slots: def.slots` to the tab
  - `audioRoutes.js:204-214` `GET /admin/prompts/:kind/:key`, which iterates `def.slots`
  - `audioLibrary.js:130-135` `bindClip`
  - `audioLibrary.js:306-315` `subjectSlots`, behind `GET /admin/slots/:kind/:key`
  - `audioLibrary.js:347-357` `recordMisses` (the misses filter)
  - `audioLibrary.js:322-339` `worldAudioBundle`, which ships every global binding with no slot logic, so it needs no change
  - `audioSeed.js:303-316` existence per kind
  - `audioDispatcher.js:557,627` `subjectExists` per job
  - `describe-audio-slots.js:97-106` `allSlots`
  - Frontend: `audioSelection.js:41-73` `audioSlotRows` and `:336-344` `jobsForKnownSubjects`; `audioBatch.js:146-150` `subjectSlotsFor`, called by `SubjectSounds.jsx:70`, which `EntityTypesAdmin.jsx:1272` embeds per creature row
- No box cue exists for the boss slots. The active audio provider's `models_cache` on `game_db` (read-only SELECT) lists `slash, hit, pickup, spell, footstep, ui_click, miss, chest_open, death, waypoint`. The four boss slots therefore get cue `null`: they are upload-only, `POST /admin/jobs` refuses them (`audioRoutes.js:481-486`), and the prompt batch skips them (`describe-audio-slots.js:121`).
- Server events: `sfxEvents.js:74-82` `sfxEvent` and `:125-130` `pushSfxEvent`. A creature sim's `sfx` buffer (`creatures.js:1240`) is drained by `World#drainSfx` (`world.js:1643-1652`), then by `server.js:3382-3419` into `frame.sfx` for every socket in the world. Death is emitted at `creatures.js:1249-1254`.
- Phases: `worldBoss.js:355-359` (`_calculatePhase`: 75/50/25 → phase 2/3/4) and `:362-402` (`_checkPhaseTransition`), called from `tick` at `:503`. `tick` itself runs every `creatureBroadcastEvery * 5` server ticks (`server.js:3429-3437`). The lost-boss re-place is `worldBoss.js:513-520` → `_placeBossCreature` `:590-608`. Lifetime: `BOSS_LIFETIME_MS` `:20`, timeout at `:488-490`.
- Debug handler: `server.js:2764-2770` has the SOMET-614 admin gate (`if (ws.role !== 'admin') return;`). Actions are at `:2783-2880`. The client sends through `Game.js:3581-3589`. Panel buttons are at `WorldBossTestPanel.jsx:539-637`.
- Client: `sfxLimits.js:17` (`['nearby','nearest','own']`), `:99-113` `_evictionTarget`. `AudioEngine.js:218-234` `_triggerSfx` (priority own/nearest at `:226`). The world-point loop machinery is `:417-601` (`tickNearby`, `_startNearbyLoop`, `_startNearbyLoopVoice`, `_sweepNearbyLoops`, `_fadeOutNearbyLoop`). Snapshot is `:661-673`, exposed as `window.__s2audio` in DEV (`Game.js:540`). `sfxResolve.js:24-48` holds the event → chain map.
- Viewport: the canvas backing store is fixed at `GAME_WIDTH x GAME_HEIGHT` = 1280x720 (`constants.js:1-2`, `Game.js:3541-3542`). The camera has no zoom (`Camera.js`). The view is isometric (`iso.js:7-23`), so the screen diagonal is not a world length. Each corner is projected back with `screenToWorld`. Game calls `tickNearby` from `update` at `Game.js:1416-1424`.
- Prompt context: `audioPromptContext.js:28-46` (`loadPromptCatalog` selects only `name, prompt` from `entity_types`) and `:102-108` (creature branch). `subjectDescriber.js` is the **art/image** describer (`:1-4`, used by `artDispatcher.js:11`), not audio, so it gets no change.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `backend/src/services/audioSubjects.js` | Modify | `BOSS_SLOTS`; creature vocabulary + cues extended; slot-aware `exists`; `subjectSlotNames`; helpers `slotNamesFor`, `slotsBySubject`; slot arg on `existingSubjects`/`subjectExists` |
| `backend/src/api/audioRoutes.js` | Modify | `checkSubject` passes the slot; `/admin/subjects` sends `subjectSlots`; `/admin/prompts/:kind/:key` uses `slotNamesFor` |
| `backend/src/services/audioLibrary.js` | Modify | `bindClip` passes the slot; `subjectSlots` uses `slotNamesFor`; `recordMisses` checks per (kind, slot) |
| `backend/src/services/audioSeed.js` | Modify | `existingBindingSubjects(db, bindings)` (per kind+slot), used by `seedAudio` |
| `backend/src/services/audioDispatcher.js` | Modify | `subjectExists(db, kind, key, slot)` at both call sites |
| `backend/scripts/describe-audio-slots.js` | Modify | `allSlots` uses `slotsBySubject`; exported |
| `backend/src/services/audioPromptContext.js` | Modify | Catalog selects `boss_tier, element`; boss rows get `; boss tier: …; element: …`; boss slot meanings |
| `backend/src/authority/sfxEvents.js` | Modify | `BOSS_SFX_EVENTS`, `bossSfx(e, c, x, y)` |
| `backend/src/authority/creatures.js` | Modify | `addCreatures` emits `spawn` for a boss-tier instance unless `quietSpawn` |
| `backend/src/authority/worldBoss.js` | Modify | `_emitBossSfx`, `phase` emit, `_checkEnrage`/`_enrage`, `_liveBoss`, `forcePhase`, `forceEnrage`, `enraged` in status, quiet re-place |
| `backend/src/authority/server.js` | Modify | `debugWorldBoss` actions `phase`, `enrage` (inside the existing admin gate) |
| `backend/tests/audio_boss_slots_db.test.js` | Create | Registry, library, seed, routes: boss slots only on boss rows; demotion |
| `backend/tests/audio_prompt_context.test.js` | Modify | Boss context fields; ordinary context byte-identical |
| `backend/tests/audio_prompt_context_db.test.js` | Modify | Real Ignis row carries tier + element |
| `backend/tests/sfx_events.test.js` | Modify | `bossSfx` shape |
| `backend/tests/boss_sfx_spawn.test.js` | Create | `addCreatures` spawn emission rules |
| `backend/tests/world_boss_sfx.test.js` | Create | phase/enrage emission, once-only, quiet re-place, `forcePhase`/`forceEnrage` |
| `backend/tests/authority_debug_world_boss_gate.test.js` | Modify | New actions covered by the non-admin gate; admin reaches `phase` |
| `frontend/src/games/something2/src/js/audio/sfxLimits.js` | Modify | `boss` tier and its eviction rules |
| `frontend/src/games/something2/src/js/audio/sfxResolve.js` | Modify | Chains for `spawn/phase/enrage`; `sfxPriority(ev, ownActor)` |
| `frontend/src/games/something2/src/js/audio/screenRadius.js` | Create | `screenRadiusWorld(viewW, viewH)` |
| `frontend/src/games/something2/src/js/audio/AudioEngine.js` | Modify | `_triggerSfx` uses `sfxPriority`; `setScreenRadius`; presence loop in `tickNearby`; sweep per emitter type; pan update; snapshot `loops`/`screenRadiusPx` |
| `frontend/src/games/something2/src/js/core/Game.js` | Modify | `update` sets the screen radius before `tickNearby` |
| `frontend/src/games/something2/src/js/audio/__tests__/sfxLimits.test.js` | Modify | Boss-tier eviction |
| `frontend/src/games/something2/src/js/audio/__tests__/sfxResolve.test.js` | Modify | New chains + priority |
| `frontend/src/games/something2/src/js/audio/__tests__/screenRadius.test.js` | Create | Literal radius, iso corner cross-check |
| `frontend/src/games/something2/src/js/audio/__tests__/AudioEngine.test.js` | Modify | Boss one-shots; presence loop lifecycle |
| `frontend/src/games/something2/audioSelection.js` | Modify | `slotEntriesFor(group, key)`; rows + known-jobs filter use it |
| `frontend/src/games/something2/audioBatch.js` | Modify | `subjectSlotsFor(subjects, kind, key)` |
| `frontend/src/games/something2/SubjectSounds.jsx` | Modify | Passes `subjectKey` |
| `frontend/src/games/something2/useMaps.js` | Modify | Entity save invalidates `['audio-subjects']` |
| `frontend/src/games/something2/__tests__/audioSelection.test.js` | Modify | Per-subject slot rows |
| `frontend/src/games/something2/__tests__/audioBatch.test.js` | Modify | `subjectSlotsFor` with key |
| `frontend/src/games/something2/worldBossDebugActions.js` | Create | `BOSS_STAGE_ACTIONS` (phase, enrage) |
| `frontend/src/games/something2/__tests__/worldBossDebugActions.test.js` | Create | Action list contract |
| `frontend/src/games/something2/WorldBossTestPanel.jsx` | Modify | Trigger Phase / Trigger Enrage buttons |

## Setup (before Task 1)

- [ ] **Link dependencies into the existing worktree** (the worktree exists, but has no `node_modules`)

```bash
WT=/home/markunn/worker/coding/jsgame/something2-wt-s2-boss-sounds
git -C $WT status --short; git -C $WT log --oneline -1   # expect clean, a15f754a
ln -s /home/markunn/worker/coding/jsgame/something2/backend/node_modules $WT/backend/node_modules
ln -s /home/markunn/worker/coding/jsgame/something2/frontend/node_modules $WT/frontend/node_modules
```

- [ ] **Create and seed the scratch DB** (about 2 min; this is the only DB you write to)

```bash
docker exec something2-db-1 psql -U user -d postgres -c 'CREATE DATABASE game_db_s2;'
cd $WT/backend
DATABASE_URL=postgres://user:password@localhost:15432/game_db_s2 npx node-pg-migrate up --ignore-pattern '(?!.*\.js$).*'
DATABASE_URL=postgres://user:password@localhost:15432/game_db_s2 node scripts/seed-catalogs.js
DATABASE_URL=postgres://user:password@localhost:15432/game_db_s2 SPEC=p5-descent node scripts/seed-map.js
DATABASE_URL=postgres://user:password@localhost:15432/game_db_s2 SPEC=vale-region node scripts/seed-map.js
DATABASE_URL=postgres://user:password@localhost:15432/game_db_s2 FORCE=1 node scripts/seed-passive-tree.js
psql postgres://user:password@localhost:15432/game_db_s2 -Atc "SELECT name, boss_tier, element FROM entity_types WHERE boss_tier IS NOT NULL ORDER BY name"
# expect 4 rows: Abyssor.. world arcane / Glacius.. world ice / Gorgon.. world lightning / Ignis, the Magma Colossus world fire
```

- [ ] **Record a baseline** so pre-existing reds are not blamed on this slice

```bash
cd $WT/backend && TEST_DATABASE_URL=postgres://user:password@localhost:15432/game_db_s2 DATABASE_URL=postgres://user:password@localhost:15432/game_db_s2 npm test > ../../s2-baseline.log 2>&1; echo "exit=$?"
grep -E '^not ok|testTimeoutFailure' ../../s2-baseline.log
cd $WT/frontend && npx vitest run > ../../s2-fe-baseline.log 2>&1; echo "exit=$?"
```

Keep the list of failing files (expect `openchest`, SOMET-615). Later runs on this DB are "second runs". A test that is green on a second run and red on a fresh DB is a state-dependent pair: re-run once on the same DB before you blame the slice.

---

### Task 1: Registry — boss slots exist only on boss-tier creature rows

**Files:**
- Modify: `backend/src/services/audioSubjects.js:49-87` (creature entry), `:148-170` (helpers), `:268-283` (exports)
- Test: `backend/tests/audio_boss_slots_db.test.js` (create; Task 2 extends it)

**Interfaces:**
- Produces: `BOSS_SLOTS = ['spawn','presence','phase','enrage']` (frozen). `SUBJECT_KINDS.creature.slots` gains the four (`'sfx'`). `SUBJECT_KINDS.creature.cues` gains them as `null`. `SUBJECT_KINDS.creature.exists(db, keys, slot?)`. `SUBJECT_KINDS.creature.subjectSlotNames(db, keys?) → { [name]: string[] }`. `existingSubjects(db, kind, keys, slot?)` and `subjectExists(db, kind, key, slot?)`, where an omitted slot keeps today's meaning. `slotNamesFor(db, kind, key) → string[]` and `slotsBySubject(db, kind) → { [key]: string[] }`.
- Rule: the kind-level `slots` map stays the **vocabulary** (so `slotKind('creature','presence') === 'sfx'`). "Does this subject carry this slot" is always answered by an existence check WITH the slot, or by `subjectSlotNames`.

- [ ] **Step 1: Write the failing test.** It reads the seeded rows only (`Ignis, the Magma Colossus` is boss_tier `world` from S1's migration `1714440671000`, and `Slime` is ordinary). It writes nothing.

```js
// backend/tests/audio_boss_slots_db.test.js
// SOMET-605 (S2, spec §3.6): boss slots (spawn/presence/phase/enrage) exist
// only on creature rows with a boss_tier. Every door that can create a
// binding, a miss, a prompt or a job asks the registry WITH the slot, so an
// ordinary creature can never grow one. Reads seeded catalog rows only;
// any rows this file writes are its own and are removed inside the lock.
require('./helpers/auth.js');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const subjects = require('../src/services/audioSubjects');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to touch a real database' : false;
const BOSS = 'Ignis, the Magma Colossus'; // boss_tier 'world' (S1 seed)
const PLAIN = 'Slime'; // ordinary creature

test('registry: boss slots only on boss-tier creatures', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());

  await t.test('vocabulary: every creature slot is an sfx slot, boss ones included', () => {
    for (const s of ['nearby', 'attack', 'hurt', 'death', 'spawn', 'presence', 'phase', 'enrage']) {
      assert.equal(subjects.slotKind('creature', s), 'sfx', s);
    }
    assert.equal(subjects.slotKind('creature', 'music'), null);
  });

  await t.test('subjectSlotNames: a boss carries 8 slots, an ordinary creature exactly the base 4', async () => {
    const by = await subjects.SUBJECT_KINDS.creature.subjectSlotNames(pool, [BOSS, PLAIN, 'no-such-creature']);
    assert.deepEqual(by[PLAIN], ['nearby', 'attack', 'hurt', 'death']);
    assert.deepEqual(by[BOSS], ['nearby', 'attack', 'hurt', 'death', 'spawn', 'presence', 'phase', 'enrage']);
    assert.equal(by['no-such-creature'], undefined);
  });

  await t.test('existingSubjects with a boss slot keeps only boss rows; a base slot keeps both', async () => {
    assert.deepEqual([...await subjects.existingSubjects(pool, 'creature', [BOSS, PLAIN], 'presence')], [BOSS]);
    assert.deepEqual([...await subjects.existingSubjects(pool, 'creature', [BOSS, PLAIN], 'hurt')].sort(), [BOSS, PLAIN].sort());
    // Omitted slot = today's meaning (the subject exists at all).
    assert.deepEqual([...await subjects.existingSubjects(pool, 'creature', [PLAIN])], [PLAIN]);
    assert.equal(await subjects.subjectExists(pool, 'creature', PLAIN, 'enrage'), false);
    assert.equal(await subjects.subjectExists(pool, 'creature', BOSS, 'enrage'), true);
  });

  await t.test('slotNamesFor / slotsBySubject: per subject for creature, the whole vocabulary elsewhere', async () => {
    assert.deepEqual(await subjects.slotNamesFor(pool, 'creature', PLAIN), ['nearby', 'attack', 'hurt', 'death']);
    assert.equal((await subjects.slotNamesFor(pool, 'creature', BOSS)).includes('presence'), true);
    assert.deepEqual(await subjects.slotNamesFor(pool, 'creature', 'no-such-creature'), []);
    assert.deepEqual(await subjects.slotNamesFor(pool, 'attack_type', 'melee'), ['use', 'hit']);
    const all = await subjects.slotsBySubject(pool, 'creature');
    assert.equal(all[PLAIN].includes('presence'), false);
    assert.equal(all[BOSS].includes('presence'), true);
  });

  await t.test('subjectCues: boss slots are upload-only (null) on a boss, absent on an ordinary creature', async () => {
    const cues = await subjects.SUBJECT_KINDS.creature.subjectCues(pool);
    assert.deepEqual(cues[PLAIN], { nearby: null, attack: null, hurt: 'hit', death: 'death' });
    assert.deepEqual(cues[BOSS], {
      nearby: null, attack: null, hurt: 'hit', death: 'death', spawn: null, presence: null, phase: null, enrage: null,
    });
    assert.equal(await subjects.cueFor(pool, 'creature', BOSS, 'presence'), null);
  });
});
```

- [ ] **Step 2: Run it RED.** `cd $WT/backend && TEST_DATABASE_URL=postgres://user:password@localhost:15432/game_db_s2 DATABASE_URL=postgres://user:password@localhost:15432/game_db_s2 node --test tests/audio_boss_slots_db.test.js; echo "exit=$?"`. Expected: `exit=1`, failing first at `slotKind('creature','spawn')` (`null !== 'sfx'`). Record the line.

- [ ] **Step 3: Implement.** In `audioSubjects.js`, add these above `SUBJECT_KINDS`:

```js
// SOMET-605 (spec §3.6): every creature carries the base slots; a row with a
// boss_tier also carries BOSS_SLOTS. The kind's `slots` map below is the
// VOCABULARY (every slot ANY creature can carry, so slotKind stays
// subject-free); whether ONE creature carries a slot is answered by
// exists(db, keys, slot) or subjectSlotNames -- never by `slots` alone.
const CREATURE_BASE_SLOTS = Object.freeze(['nearby', 'attack', 'hurt', 'death']);
const BOSS_SLOTS = Object.freeze(['spawn', 'presence', 'phase', 'enrage']);
const BOSS_SLOT_SET = new Set(BOSS_SLOTS);
```

Replace the `creature` entry with:

```js
  creature: {
    label: 'Creatures',
    slots: {
      nearby: 'sfx', attack: 'sfx', hurt: 'sfx', death: 'sfx',
      spawn: 'sfx', presence: 'sfx', phase: 'sfx', enrage: 'sfx',
    },
    // Fixed: the same cue applies to every creature (spec §4 table). `nearby`
    // and `attack` have no cue on the box today -- upload only. The four boss
    // slots have none either (the box offers slash/hit/pickup/spell/footstep/
    // ui_click/miss/chest_open/death/waypoint), so they are upload only too.
    cues: {
      nearby: null, attack: null, hurt: 'hit', death: 'death',
      spawn: null, presence: null, phase: null, enrage: null,
    },
    list: async (db) => (await db.query(
      'SELECT name FROM entity_types WHERE is_creature ORDER BY name')).rows.map((r) => r.name),
    // `slot` (optional): a boss slot exists only on a boss_tier row. Omitted,
    // this answers "is it a creature at all", exactly as before.
    exists: async (db, keys, slot) => new Set((await db.query(
      `SELECT name FROM entity_types
        WHERE is_creature AND name = ANY($1::text[])
          AND ($2::boolean IS FALSE OR boss_tier IS NOT NULL)`,
      [keys, BOSS_SLOT_SET.has(slot)])).rows.map((r) => r.name)),
    // { [name]: [slot, ...] } for the named creatures (all when keys is null),
    // in vocabulary order. Unknown names are absent.
    subjectSlotNames: async (db, keys = null) => {
      const r = await db.query(
        `SELECT name, boss_tier IS NOT NULL AS boss FROM entity_types
          WHERE is_creature AND ($1::text[] IS NULL OR name = ANY($1::text[]))
          ORDER BY name`, [keys]);
      return Object.fromEntries(r.rows.map((row) => [
        row.name, row.boss ? [...CREATURE_BASE_SLOTS, ...BOSS_SLOTS] : [...CREATURE_BASE_SLOTS],
      ]));
    },
    // subjectCues(db) -> { [name]: { [slot]: cue|null } }, covering exactly
    // the slots THAT creature carries (a boss row gets the boss slots too).
    subjectCues: async (db) => {
      const bySubject = await SUBJECT_KINDS.creature.subjectSlotNames(db);
      const out = {};
      for (const [n, slots] of Object.entries(bySubject)) {
        out[n] = Object.fromEntries(slots.map((s) => [s, SUBJECT_KINDS.creature.cues[s]]));
      }
      return out;
    },
  },
```

Replace `existingSubjects`/`subjectExists` and add the two helpers:

```js
// Does this subject exist in its catalogue (spec §3: unknown keys are
// dropped) -- and, when `slot` is given, does it CARRY that slot (spec §3.6:
// boss slots only on boss rows)? Kinds whose slots do not vary per subject
// ignore `slot`. One query for the whole list.
async function existingSubjects(db, subjectKind, keys, slot) {
  if (!isKnownKind(subjectKind) || !keys.length) return new Set();
  return SUBJECT_KINDS[subjectKind].exists(db, keys, slot);
}

async function subjectExists(db, subjectKind, key, slot) {
  if (typeof key !== 'string' || !key || key.length > MAX_SUBJECT_KEY) return false;
  return (await existingSubjects(db, subjectKind, [key], slot)).has(key);
}

// The slots ONE subject carries, in vocabulary order. Kinds without
// per-subject slots return the whole vocabulary, without checking that the
// key exists -- the same answer GET /admin/prompts and /admin/slots always
// gave, so their behaviour for those kinds is unchanged.
async function slotNamesFor(db, subjectKind, key) {
  if (!isKnownKind(subjectKind)) return [];
  const def = SUBJECT_KINDS[subjectKind];
  if (!def.subjectSlotNames) return Object.keys(def.slots);
  return (await def.subjectSlotNames(db, [key]))[key] || [];
}

// { [key]: [slot, ...] } for every listed subject of a kind.
async function slotsBySubject(db, subjectKind) {
  if (!isKnownKind(subjectKind)) return {};
  const def = SUBJECT_KINDS[subjectKind];
  if (def.subjectSlotNames) return def.subjectSlotNames(db);
  const all = Object.keys(def.slots);
  return Object.fromEntries((await def.list(db)).map((k) => [k, [...all]]));
}
```

Add `BOSS_SLOTS, slotNamesFor, slotsBySubject` to `module.exports`.

- [ ] **Step 4: Run it GREEN** (same command, `exit=0`). Then run the registry neighbours, which must stay green: `node --test tests/audio_subjects_sfx_db.test.js tests/describe_audio_slots_db.test.js` with both env vars.

- [ ] **Step 5: Commit**

```bash
cd $WT && git add backend/src/services/audioSubjects.js backend/tests/audio_boss_slots_db.test.js
git commit -m "feat(audio): boss slots on boss-tier creature rows only (SOMET-605)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Every consumer asks the registry with the slot

**Files:**
- Modify: `backend/src/api/audioRoutes.js:46-57` (`checkSubject`), `:155-164` (`/admin/subjects`), `:201-214` (`/admin/prompts/:kind/:key`)
- Modify: `backend/src/services/audioLibrary.js:8-10` (imports), `:130-135` (`bindClip`), `:306-315` (`subjectSlots`), `:347-357` (`recordMisses`)
- Modify: `backend/src/services/audioSeed.js:303-325`
- Modify: `backend/src/services/audioDispatcher.js:557`, `:627`
- Modify: `backend/scripts/describe-audio-slots.js:97-106`, `:199-201`
- Test: `backend/tests/audio_boss_slots_db.test.js` (extend)

**Interfaces:**
- Consumes: Task 1's `subjectExists(db, kind, key, slot)`, `existingSubjects(..., slot)`, `slotNamesFor`, `slotsBySubject`, `def.subjectSlotNames`.
- Produces: `GET /api/audio/admin/subjects` creature group gains `subjectSlots: { [name]: string[] }` (only kinds that define `subjectSlotNames` send it; the frontend reads its absence as "all slots"). `audioSeed.existingBindingSubjects(db, bindings) → Set<'kind/key/slot'>`. `describe-audio-slots.allSlots(db)` is exported.
- Error text: a known subject asked for a slot it does not carry gets `'<key>' has no '<slot>' slot (boss slots need a boss tier)`, as a 400 from routes and an `AudioInputError` from `bindClip`. An unknown subject keeps `'unknown subject'`, so existing tests that match that text stay green.

- [ ] **Step 1: Extend the test (RED).** Append a second top-level test to `audio_boss_slots_db.test.js`. It creates its own creature row (so it can demote it), one admin user and its own clips, and removes them all in a `finally` inside the lock.

```js
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { withAdvisoryLock, AUDIO_CLIPS_LOCK_KEY } = require('./helpers/advisoryLock.js');
const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');
const assetStore = require('../src/services/assetStore');
const lib = require('../src/services/audioLibrary');
const { existingBindingSubjects } = require('../src/services/audioSeed');
const { allSlots } = require('../scripts/describe-audio-slots');

const OGG = fs.readFileSync(path.join(__dirname, 'fixtures/audio/tone.ogg'));

test('every door refuses a boss slot on an ordinary creature; demotion hides boss slots', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  __setPool(pool);
  assetStore.__setAssetClient({ bucketExists: async () => true, putObject: async () => {}, removeObject: async () => {} });
  const tag = `${process.pid}-${Date.now()}`;
  const TEMP_BOSS = `zz-s2-boss-${tag}`; // our own row, so we may demote it
  const clipIds = [];
  let userId = null;
  try {
    await withAdvisoryLock(pool, AUDIO_CLIPS_LOCK_KEY, async () => {
      try {
        await pool.query(
          `INSERT INTO entity_types (name, is_creature, color, hp, boss_tier, element)
           VALUES ($1, true, '#123456', 100, 'world', 'fire')`, [TEMP_BOSS]);
        const u = (await pool.query(
          "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id, username, role, token_version",
          [`s2-admin-${tag}`])).rows[0];
        userId = u.id;
        const auth = `Bearer ${signToken({ userId: u.id, username: u.username, role: u.role, tokenVersion: u.token_version })}`;
        const storeSfx = async (label) => {
          const c = await lib.storeClip(pool, { buffer: OGG, kind: 'sfx', label, source: 'uploaded', durationMs: 500 });
          clipIds.push(c.id);
          return c;
        };

        // Door 1: POST /admin/bindings (bind-from-library) -> 400 for Slime/presence.
        const clip = await storeSfx(`s2 boss ${tag}`);
        const bad = await request(app).post('/api/audio/admin/bindings').set('Authorization', auth)
          .send({ subject_kind: 'creature', subject_key: PLAIN, slot: 'presence', clip_id: clip.id });
        assert.equal(bad.status, 400);
        assert.match(bad.body.error, /has no 'presence' slot/);
        const ok = await request(app).post('/api/audio/admin/bindings').set('Authorization', auth)
          .send({ subject_kind: 'creature', subject_key: TEMP_BOSS, slot: 'presence', clip_id: clip.id });
        assert.equal(ok.status, 201);

        // Door 2: bindClip directly (generate/upload/queued-job paths all land here).
        await assert.rejects(
          lib.bindClip(pool, { subjectKind: 'creature', subjectKey: PLAIN, slot: 'enrage', clipId: clip.id }),
          (err) => err.status === 400 && /has no 'enrage' slot/.test(err.message));

        // Door 3: a game client's miss report.
        assert.equal(await lib.recordMisses(pool, [{ subject_kind: 'creature', subject_key: PLAIN, slot: 'phase', world: null }]), 0);
        assert.equal(await lib.recordMisses(pool, [{ subject_kind: 'creature', subject_key: TEMP_BOSS, slot: 'phase', world: null }]), 1);

        // Door 4: a seed manifest.
        const seen = await existingBindingSubjects(pool, [
          { subject_kind: 'creature', subject_key: PLAIN, slot: 'spawn' },
          { subject_kind: 'creature', subject_key: PLAIN, slot: 'hurt' },
          { subject_kind: 'creature', subject_key: TEMP_BOSS, slot: 'spawn' },
        ]);
        assert.deepEqual([...seen].sort(), [`creature/${PLAIN}/hurt`, `creature/${TEMP_BOSS}/spawn`].sort());

        // The tab: /admin/subjects sends per-subject slots for creatures only.
        const subj = await request(app).get('/api/audio/admin/subjects').set('Authorization', auth);
        assert.equal(subj.status, 200);
        const creature = subj.body.find((g) => g.kind === 'creature');
        assert.deepEqual(creature.subjectSlots[PLAIN], ['nearby', 'attack', 'hurt', 'death']);
        assert.equal(creature.subjectSlots[TEMP_BOSS].includes('presence'), true);
        assert.equal(subj.body.find((g) => g.kind === 'world').subjectSlots, undefined);
        assert.equal(Object.hasOwn(creature.cues[PLAIN], 'presence'), false);

        // The prompt writer's slot list.
        const every = await allSlots(pool);
        assert.equal(every.some((s) => s.id === `creature/${PLAIN}/presence`), false);
        assert.equal(every.some((s) => s.id === `creature/${TEMP_BOSS}/presence`), true);

        // Demotion: boss slots vanish from /admin/slots and /admin/prompts, binds are refused,
        // the existing binding row stays (re-promotion brings it back), nothing throws.
        await pool.query('UPDATE entity_types SET boss_tier = NULL WHERE name = $1', [TEMP_BOSS]);
        const slots = await request(app).get(`/api/audio/admin/slots/creature/${encodeURIComponent(TEMP_BOSS)}`).set('Authorization', auth);
        assert.equal(slots.status, 200);
        assert.deepEqual(Object.keys(slots.body), ['nearby', 'attack', 'hurt', 'death']);
        const prompts = await request(app).get(`/api/audio/admin/prompts/creature/${encodeURIComponent(TEMP_BOSS)}`).set('Authorization', auth);
        assert.deepEqual(Object.keys(prompts.body), ['nearby', 'attack', 'hurt', 'death']);
        const again = await request(app).post('/api/audio/admin/bindings').set('Authorization', auth)
          .send({ subject_kind: 'creature', subject_key: TEMP_BOSS, slot: 'spawn', clip_id: clip.id });
        assert.equal(again.status, 400);
        const kept = await pool.query("SELECT 1 FROM audio_bindings WHERE subject_key = $1 AND slot = 'presence'", [TEMP_BOSS]);
        assert.equal(kept.rowCount, 1, 'demotion does not delete bindings');
      } finally {
        await pool.query('DELETE FROM audio_misses WHERE subject_key = ANY($1)', [[TEMP_BOSS, PLAIN]]).catch(() => {});
        if (clipIds.length) await pool.query('DELETE FROM audio_clips WHERE id = ANY($1)', [clipIds]);
        await pool.query('DELETE FROM audio_bindings WHERE subject_key = $1', [TEMP_BOSS]);
        await pool.query('DELETE FROM entity_types WHERE name = $1', [TEMP_BOSS]);
        if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
      }
    });
  } finally { await pool.end(); }
});
```

Before you run it, check two things the fixture assumes. (a) `entity_types` accepts that minimal INSERT on the scratch DB: run `\d entity_types` for NOT NULL columns without defaults, and add any it needs. (b) `lib.storeClip`'s argument shape: read `audioLibrary.js` `storeClip`. Adjust the fixture rather than the code. Also check that the `audio_misses` cleanup removes only rows this test created: the `PLAIN` delete is safe because Door 3 asserts `0` accepted for `PLAIN`, so no row was written. If the scratch DB already has a `Slime/phase` miss from elsewhere, narrow the delete to `slot = 'phase' AND subject_key = $TEMP_BOSS`.

- [ ] **Step 2: Run it RED.** Expected: `exit=1`, first at Door 1 (`201 !== 400`, because `checkSubject` ignores the slot). Record the line.

- [ ] **Step 3: Implement the consumers.**

`audioRoutes.js`: import `slotNamesFor` alongside the others, then:

```js
async function checkSubject(pool, kind, key, slot) {
  if (typeof kind !== 'string' || typeof key !== 'string' || typeof slot !== 'string'
    || !key || key.length > MAX_SUBJECT_KEY) {
    return { error: 'subject_kind, subject_key (1-200 chars) and slot must each be a single string' };
  }
  const clipKind = slotKind(kind, slot);
  if (!clipKind) return { error: 'unknown subject or slot' };
  // SOMET-605: the slot is part of the question -- a boss slot exists only
  // on a boss_tier creature. The second query runs only on failure, to tell
  // "no such subject" from "this subject has no such slot".
  if (!(await subjectExists(pool, kind, key, slot))) {
    if (await subjectExists(pool, kind, key)) return { error: `'${key}' has no '${slot}' slot (boss slots need a boss tier)` };
    return { error: 'unknown subject' };
  }
  return { clipKind };
}
```

In `/admin/subjects`, right after `if (def.subjectCues) entry.cues = ...`:

```js
        // SOMET-605: which slots each subject carries, for kinds where that
        // varies (creature: boss slots only on boss rows). Absent = every
        // subject carries every slot in `slots`.
        // eslint-disable-next-line no-await-in-loop
        if (def.subjectSlotNames) entry.subjectSlots = await def.subjectSlotNames(pool);
```

In `/admin/prompts/:kind/:key`, replace `for (const slot of Object.keys(def.slots)) {` with:

```js
      for (const slot of await slotNamesFor(pool, kind, key)) {
```

`audioLibrary.js`: import `slotNamesFor`. In `bindClip`, replace the `subjectExists` line with:

```js
  if (!(await subjectExists(db, subjectKind, subjectKey, slot))) {
    if (await subjectExists(db, subjectKind, subjectKey)) {
      throw new AudioInputError(`'${subjectKey}' has no '${slot}' slot (boss slots need a boss tier)`);
    }
    throw new AudioInputError('unknown subject');
  }
```

In `subjectSlots`, replace `Object.keys(k.slots)` with `await slotNamesFor(db, subjectKind, subjectKey)`. The `const k = ...` line then becomes unused, so delete it.

In `recordMisses`, replace the per-kind existence block with a per-(kind, slot) one:

```js
  const existing = new Map(); // `${kind}\u0000${slot}` -> Set of keys that carry that slot
  for (const m of shaped) {
    const id = `${m.subject_kind}\u0000${m.slot}`;
    if (existing.has(id)) continue;
    // eslint-disable-next-line no-await-in-loop
    existing.set(id, await existingSubjects(db, m.subject_kind,
      [...new Set(shaped.filter((x) => x.subject_kind === m.subject_kind && x.slot === m.slot).map((x) => x.subject_key))],
      m.slot));
  }
  const ok = shaped.filter((m) => existing.get(`${m.subject_kind}\u0000${m.slot}`).has(m.subject_key));
```

`audioSeed.js`: add and export the helper, and use it in place of the `bySubjectKind`/`existingByKind` block (`:303-316`). The loop's check becomes `if (!known.has(\`${b.subject_kind}/${b.subject_key}/${b.slot}\`))`:

```js
// SOMET-605: which manifest bindings point at a subject that exists AND
// carries that slot (a boss slot needs a boss_tier row). One query per
// (kind, slot) pair rather than per binding.
async function existingBindingSubjects(db, bindings) {
  const groups = new Map();
  for (const b of bindings) {
    const id = `${b.subject_kind}\u0000${b.slot}`;
    if (!groups.has(id)) groups.set(id, { kind: b.subject_kind, slot: b.slot, keys: new Set() });
    groups.get(id).keys.add(b.subject_key);
  }
  const out = new Set();
  for (const g of groups.values()) {
    // eslint-disable-next-line no-await-in-loop
    for (const key of await existingSubjects(db, g.kind, [...g.keys], g.slot)) out.add(`${g.kind}/${key}/${g.slot}`);
  }
  return out;
}
```

`audioDispatcher.js:557` and `:627`: `deps.subjectExists(db, job.subject_kind, job.subject_key, job.slot)`.

`describe-audio-slots.js`: import `slotsBySubject`, then:

```js
async function allSlots(db) {
  const out = [];
  for (const kind of Object.keys(SUBJECT_KINDS)) {
    // eslint-disable-next-line no-await-in-loop
    const bySubject = await slotsBySubject(db, kind); // SOMET-605: per-subject slots (boss rows only get boss slots)
    for (const [key, slots] of Object.entries(bySubject)) {
      for (const slot of slots) out.push({ kind, key, slot, id: `${kind}/${key}/${slot}` });
    }
  }
  return out;
}
```

Add `allSlots` to its `module.exports`.

- [ ] **Step 4: Run it GREEN, then the audio neighbours** (both env vars): `node --test tests/audio_boss_slots_db.test.js tests/audio_library_db.test.js tests/audio_library_routes_db.test.js tests/audio_subjects_sfx_db.test.js tests/audio_seed_db.test.js tests/describe_audio_slots_db.test.js tests/describe_audio_slots.test.js tests/audio_sfx_dedupe_drain_db.test.js; echo "exit=$?"`. All exit 0. A dispatcher test whose fake `subjectExists` asserts an exact argument list needs the 4th argument added to the fake, not removed from the code.

- [ ] **Step 5: Commit**

```bash
cd $WT && git add backend/src/api/audioRoutes.js backend/src/services/audioLibrary.js backend/src/services/audioSeed.js backend/src/services/audioDispatcher.js backend/scripts/describe-audio-slots.js backend/tests/audio_boss_slots_db.test.js
git commit -m "feat(audio): bindings, misses, seed, jobs and prompts check the slot per subject (SOMET-605)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Prompt context — boss rows carry tier and element

**Files:**
- Modify: `backend/src/services/audioPromptContext.js:34` (catalog SELECT), `:84-108` (`tail`, creature branch)
- Test: `backend/tests/audio_prompt_context.test.js` (modify), `backend/tests/audio_prompt_context_db.test.js` (modify)

**Interfaces:**
- Produces: for a creature with `boss_tier`, `buildContext` returns `creature "<name>"; boss tier: <tier>; element: <element><looks><tail>`. For a boss slot, the tail is `; slot: <slot> (<meaning>)`. Ordinary creatures and every other kind are byte-identical to today.

- [ ] **Step 1: Write the failing unit tests.** Add them to `audio_prompt_context.test.js` (read its existing catalog fixture builder first and reuse it; the literal below assumes `entities` is a `Map` of `{ name, prompt }` rows):

```js
test('SOMET-605: a boss creature row carries its tier and element; a boss slot says what it is for', () => {
  const catalog = {
    worlds: new Map(), biomes: new Map(), items: new Map(), skills: new Map(), artDescriptions: new Map(),
    entities: new Map([
      ['zzTitan', { name: 'zzTitan', prompt: 'a molten giant', boss_tier: 'world', element: 'fire' }],
      ['zzSlime', { name: 'zzSlime', prompt: 'a green blob', boss_tier: null, element: null }],
    ]),
  };
  assert.equal(buildContext(catalog, 'creature', 'zzTitan', 'presence'),
    'creature "zzTitan"; boss tier: world; element: fire; looks like: a molten giant; slot: presence (a loop that plays while the boss is on screen)');
  assert.equal(buildContext(catalog, 'creature', 'zzTitan', 'hurt', { cue: 'hit' }),
    'creature "zzTitan"; boss tier: world; element: fire; looks like: a molten giant; slot: hurt; sound cue: hit');
});

test('SOMET-605: an ordinary creature context is byte-identical to before (no stale flood)', () => {
  const catalog = {
    worlds: new Map(), biomes: new Map(), items: new Map(), skills: new Map(), artDescriptions: new Map(),
    entities: new Map([['zzSlime', { name: 'zzSlime', prompt: 'a green blob', boss_tier: null, element: 'fire' }]]),
  };
  // The literal is today's output, written out -- not recomputed.
  assert.equal(buildContext(catalog, 'creature', 'zzSlime', 'hurt', { cue: 'hit' }),
    'creature "zzSlime"; looks like: a green blob; slot: hurt; sound cue: hit');
});
```

Then add to `audio_prompt_context_db.test.js` (real row; this keeps the branch from being reachable only by a fixture):

```js
test('SOMET-605: the real Ignis row reaches the boss branch', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const catalog = await loadPromptCatalog(pool);
    const s = buildContext(catalog, 'creature', 'Ignis, the Magma Colossus', 'spawn');
    assert.match(s, /; boss tier: world; element: fire;/);
    assert.match(s, /slot: spawn \(/);
    assert.doesNotMatch(buildContext(catalog, 'creature', 'Slime', 'hurt', { cue: 'hit' }), /boss tier/);
  } finally { await pool.end(); }
});
```

(Match the file's existing `skip`/`url`/import names.)

- [ ] **Step 2: Run both RED.** Expected: the boss assertion fails (no `boss tier` segment), and the DB test fails at `match`. The ordinary test is green before and after, because it is a regression pin. Prove it can fail: after Step 3, temporarily drop the `e.boss_tier` condition (so every creature gets `; boss tier: null`), watch that test go RED, then restore the condition.

- [ ] **Step 3: Implement.**

```js
    db.query('SELECT name, prompt, boss_tier, element FROM entity_types WHERE is_creature OR point_kind IS NOT NULL'),
```

```js
// SOMET-605: the boss slots are new words to the writer model; say what each
// one is for. Only these four slots get a meaning, so every existing slot's
// tail -- and therefore every stored prompt's source_input -- is unchanged.
const BOSS_SLOT_MEANING = {
  spawn: 'the boss appears',
  presence: 'a loop that plays while the boss is on screen',
  phase: 'the boss enters a new fight phase',
  enrage: 'the boss becomes enraged',
};

function tail(slot, cue) {
  const meaning = Object.hasOwn(BOSS_SLOT_MEANING, slot) ? ` (${BOSS_SLOT_MEANING[slot]})` : '';
  return `; slot: ${slot}${meaning}${cue ? `; sound cue: ${cue}` : ''}`;
}
```

In the creature/world_point branch:

```js
      const label = kind === 'creature' ? 'creature' : 'world point';
      // SOMET-605: boss rows only, so an ordinary creature's string -- and its
      // stored prompt's staleness -- does not move.
      const boss = kind === 'creature' && e.boss_tier
        ? `; boss tier: ${e.boss_tier}${e.element ? `; element: ${e.element}` : ''}` : '';
      return `${label} "${key}"${boss}${looks(catalog, kind, key, stripImageStyling(e.prompt))}${tail(slot, cue)}`;
```

- [ ] **Step 4: Run GREEN**, plus `tests/audio_prompt_writer*.test.js` and `tests/audio_seed_prompts_db.test.js` (both env vars). All exit 0.

- [ ] **Step 5: Commit**

```bash
cd $WT && git add backend/src/services/audioPromptContext.js backend/tests/audio_prompt_context.test.js backend/tests/audio_prompt_context_db.test.js
git commit -m "feat(audio): boss prompt context carries tier, element and boss slot meaning (SOMET-605)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Wire events — `bossSfx` and `spawn` from `addCreatures`

**Files:**
- Modify: `backend/src/authority/sfxEvents.js:115-144`
- Modify: `backend/src/authority/creatures.js:13-15` (require), `:1353` (after the `this.creatures.set(...)` statement in `addCreatures`)
- Test: `backend/tests/sfx_events.test.js` (modify), `backend/tests/boss_sfx_spawn.test.js` (create)

**Interfaces:**
- Produces: `BOSS_SFX_EVENTS = ['spawn','phase','enrage']`. `bossSfx(e, c, x, y) → { e, c: c.type, a: 'c:<id>', x, y } | null` (null for an unknown `e` or no creature; `pushSfxEvent` drops null). An `addCreatures` input with a truthy `bossTier` emits one `spawn` at its box centre, unless the input carries `quietSpawn: true`. A known id (skipped by `addCreatures`) emits nothing.

- [ ] **Step 1: Write the failing tests.**

Append to `sfx_events.test.js`:

```js
test('SOMET-605: bossSfx builds spawn/phase/enrage on the creature channel; anything else is null', () => {
  const { bossSfx } = require('../src/authority/sfxEvents.js');
  assert.deepEqual(bossSfx('phase', { id: 'wb_1', type: 'zzTitan' }, 10.4, 20.6), { e: 'phase', c: 'zzTitan', a: 'c:wb_1', x: 10, y: 21 });
  assert.deepEqual(bossSfx('spawn', { id: 7, type: 'zzTitan' }, 0, 0), { e: 'spawn', c: 'zzTitan', a: 'c:7', x: 0, y: 0 });
  assert.equal(bossSfx('enrage', { id: 7, type: 'zzTitan' }, 1, 1).e, 'enrage');
  assert.equal(bossSfx('death', { id: 7, type: 'zzTitan' }, 1, 1), null, 'death has its own builder');
  assert.equal(bossSfx('phase', null, 1, 1), null);
});
```

Create `boss_sfx_spawn.test.js`:

```js
// backend/tests/boss_sfx_spawn.test.js
// SOMET-605 (S2, spec §4.4): a boss entering a sim announces itself with one
// `spawn` sfx event -- from addCreatures, the one door every boss passes
// (world bosses now, S9's dungeon bosses later), so no spawn path can forget it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { CreatureSim } = require('../src/authority/creatures.js');

const sim = () => new CreatureSim({ isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }, () => 0.05);
const boss = (over = {}) => ({ id: 'wb_1', type: 'zzTitan', x: 100, y: 200, hp: 5000, bossTier: 'world', hitboxSize: 96, ...over });

test('a boss-tier instance emits exactly one spawn event at its box centre', () => {
  const s = sim();
  s.addCreatures([boss()]);
  // x 100 + 96/2 = 148, y 200 + 96/2 = 248 (fixture numbers, not CREATURE_SIZE).
  assert.deepEqual(s.sfx, [{ e: 'spawn', c: 'zzTitan', a: 'c:wb_1', x: 148, y: 248 }]);
});

test('an ordinary creature emits nothing on add', () => {
  const s = sim();
  s.addCreatures([{ id: 'c1', type: 'Slime', x: 0, y: 0, hp: 10 }]);
  assert.deepEqual(s.sfx, []);
});

test('re-adding a known id emits nothing (addCreatures skips it)', () => {
  const s = sim();
  s.addCreatures([boss()]);
  s.sfx = [];
  s.addCreatures([boss()]);
  assert.deepEqual(s.sfx, []);
});

test('quietSpawn suppresses the event (lost-boss re-place)', () => {
  const s = sim();
  s.addCreatures([boss({ quietSpawn: true })]);
  assert.deepEqual(s.sfx, []);
  assert.ok(s.get('wb_1'), 'the boss is still added');
});
```

- [ ] **Step 2: Run both RED.** `node --test tests/sfx_events.test.js tests/boss_sfx_spawn.test.js; echo "exit=$?"`. Expected: `bossSfx is not a function`, and `[] !== [spawn]`.

- [ ] **Step 3: Implement.** In `sfxEvents.js`, above `pushSfxEvent`:

```js
// SOMET-605 (S2, spec §4.3/§4.4): a boss's own announcements, on the same
// creature channel as use/hurt/death. One builder for all three so the boss
// wire vocabulary is written once; the client plays creature/<type>/<e> at
// its `boss` limiter tier. Unknown `e` -> null, which pushSfxEvent drops.
const BOSS_SFX_EVENTS = Object.freeze(['spawn', 'phase', 'enrage']);

function bossSfx(e, c, x, y) {
  if (!c || !BOSS_SFX_EVENTS.includes(e)) return null;
  return sfxEvent(e, { c: c.type, a: `c:${c.id}` }, x, y);
}
```

Export `BOSS_SFX_EVENTS, bossSfx`. In `creatures.js` add `bossSfx` to the `require('./sfxEvents.js')` destructure, and directly after the `});` that closes `this.creatures.set(c.id, {...})` (line 1353) add:

```js
      // SOMET-605: a boss announces itself on arrival. quietSpawn is set by a
      // re-place of a boss that was already in the fight (worldBoss.js tick).
      const added = this.creatures.get(c.id);
      if (added.bossTier && !c.quietSpawn) {
        pushSfxEvent(this.sfx, bossSfx('spawn', added, added.x + added.width / 2, added.y + added.height / 2));
      }
```

- [ ] **Step 4: Run GREEN**, plus `tests/authority_boss_fields.test.js tests/creature_hydration.test.js tests/authority_sfx_frame.test.js tests/world_boss.test.js tests/world_boss_phase.test.js`. All exit 0.

- [ ] **Step 5: Commit**

```bash
cd $WT && git add backend/src/authority/sfxEvents.js backend/src/authority/creatures.js backend/tests/sfx_events.test.js backend/tests/boss_sfx_spawn.test.js
git commit -m "feat(authority): boss spawn sfx event from addCreatures (SOMET-605)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: World boss `phase` / `enrage` events + debug triggers

**Files:**
- Modify: `backend/src/authority/worldBoss.js` (additive only: constants after `:20`; `_checkPhaseTransition` one line inside `if (phaseInfo.phase > currentPhase)`; `tick` one line after `:503`; `getStatus` one key; `_placeBossCreature` option; new methods after `_spawnPhaseMinions`)
- Modify: `backend/src/authority/server.js:2783-2880` (two `else if` branches inside `debugWorldBoss`, after the gate at `:2769`)
- Test: `backend/tests/world_boss_sfx.test.js` (create), `backend/tests/authority_debug_world_boss_gate.test.js` (modify)

**Interfaces:**
- Consumes: Task 4's `bossSfx`, `pushSfxEvent`, `quietSpawn`.
- Produces: `WorldBossManager#forcePhase(worlds, broadcastFn?) → boolean` (advances exactly one phase through the real `_calculatePhase` thresholds; false when no live boss or already phase 4) and `#forceEnrage(worlds, broadcastFn?) → boolean` (false when no live boss or already enraged). `getStatus().enraged: boolean`. Announcement `{type:'announcement', kind:'world_boss_enrage', text, bossName}`. Debug actions `phase` and `enrage` answer `{type:'error', message}` on false.
- Enrage rule (decision D2): once per spawn, when hp/maxHp < 0.10 OR `now - spawnedAt >= bossLifetimeMs - 60 000`. World bosses only. Audio, announcement and an `enraged` flag only; no stat change.

- [ ] **Step 1: Write the failing tests.**

```js
// backend/tests/world_boss_sfx.test.js
// SOMET-605 (S2, spec §4.3/§4.4): the world boss's phase and enrage moments
// reach the creature sfx channel exactly once each, and the test-panel
// triggers drive the same code path the fight does.
const test = require('node:test');
const assert = require('node:assert/strict');
const { WorldBossManager } = require('../src/authority/worldBoss');
const { CreatureSim } = require('../src/authority/creatures');

const bossRow = {
  id: 951, name: 'zzS2 Titan', color: '#ff4757', hp: 10000, max_hp: 10000, defense: 20,
  resistances: {}, faction: 'hostile', gold_min: 0, gold_max: 0, attack_element: 'fire',
  vfx: null, prompt: 'zz', boss_tier: 'world', element: 'fire', hitbox_size: 96, auras: null,
  xp_reward: 0, base_damage: 40, display_width: 96, display_height: 96, behavior_name: null, abilities: null,
};

async function fight({ lifetimeMs = 600000 } = {}) {
  const m = new WorldBossManager({
    bossIntervalMs: 600000, bossLifetimeMs: lifetimeMs, rng: () => 0,
    loadCatalog: async () => ({ bosses: [bossRow], minionsByElement: new Map() }),
  });
  await m.refreshCatalog();
  const sim = new CreatureSim({ isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }, () => 0.05);
  const entry = { worldId: 'w1', row: { name: 'Molten Core', width: 32, height: 32 }, waypoints: new Map(), world: { creatures: sim } };
  const worlds = new Map([['w1', entry]]);
  const now = Date.now();
  m.forceSpawn(now, worlds, {}, () => {});
  sim.sfx = []; // drop the spawn event (Task 4 covers it)
  return { m, sim, worlds, now, boss: sim.get(m.bossCreatureId) };
}
const events = (sim, e) => sim.sfx.filter((x) => x.e === e);

test('a phase transition emits one phase event at the boss centre', async () => {
  const { m, sim, worlds, now, boss } = await fight();
  boss.hp = 7000; // 70% -> phase 2
  m.tick(now + 1, worlds, () => {});
  const ph = events(sim, 'phase');
  assert.equal(ph.length, 1);
  assert.deepEqual(ph[0], { e: 'phase', c: 'zzS2 Titan', a: `c:${boss.id}`, x: Math.round(boss.x + 48), y: Math.round(boss.y + 48) });
  m.tick(now + 2, worlds, () => {});
  assert.equal(events(sim, 'phase').length, 1, 'no repeat while the phase holds');
});

test('a hit that skips from phase 1 to phase 3 emits ONE phase event', async () => {
  const { m, sim, worlds, now, boss } = await fight();
  boss.hp = 4000; // 40%
  m.tick(now + 1, worlds, () => {});
  assert.equal(m.currentBoss.phase, 3);
  assert.equal(events(sim, 'phase').length, 1);
});

test('enrage fires once below 10% HP, not at 11%', async () => {
  const { m, sim, worlds, now, boss } = await fight();
  boss.hp = 1100; // 11%
  m.tick(now + 1, worlds, () => {});
  assert.equal(events(sim, 'enrage').length, 0);
  boss.hp = 900; // 9%
  const frames = [];
  m.tick(now + 2, worlds, (f) => frames.push(f));
  m.tick(now + 3, worlds, () => {});
  assert.equal(events(sim, 'enrage').length, 1, 'once per spawn');
  assert.equal(m.getStatus().enraged, true);
  assert.ok(frames.some((f) => f.kind === 'world_boss_enrage'));
});

test('enrage fires in the last 60 s of the lifetime, not at 70 s left', async () => {
  const { m, sim, worlds, now } = await fight({ lifetimeMs: 600000 });
  m.tick(now + 530000, worlds, () => {}); // 70 s left
  assert.equal(events(sim, 'enrage').length, 0);
  m.tick(now + 545000, worlds, () => {}); // 55 s left
  assert.equal(events(sim, 'enrage').length, 1);
});

test('a lost boss re-placed by tick does not replay spawn', async () => {
  const { m, sim, worlds, now } = await fight();
  sim.remove(m.bossCreatureId);
  m.tick(now + 1, worlds, () => {});
  assert.ok(sim.get(m.bossCreatureId), 're-placed');
  assert.equal(events(sim, 'spawn').length, 0);
});

test('forcePhase advances exactly one phase through the real path, and stops at 4', async () => {
  const { m, sim, worlds } = await fight();
  const frames = [];
  assert.equal(m.forcePhase(worlds, (f) => frames.push(f)), true);
  assert.equal(m.currentBoss.phase, 2);
  assert.ok(frames.some((f) => f.kind === 'world_boss_phase' && f.phase === 2));
  assert.equal(m.forcePhase(worlds), true);
  assert.equal(m.currentBoss.phase, 3);
  assert.equal(m.forcePhase(worlds), true);
  assert.equal(m.currentBoss.phase, 4);
  assert.equal(m.forcePhase(worlds), false);
  assert.equal(events(sim, 'phase').length, 3);
});

test('forceEnrage enrages once; both triggers are false with no live boss', async () => {
  const { m, sim, worlds } = await fight();
  assert.equal(m.forceEnrage(worlds), true);
  assert.equal(m.forceEnrage(worlds), false);
  assert.equal(events(sim, 'enrage').length, 1);
  const idle = new WorldBossManager({ loadCatalog: async () => ({ bosses: [], minionsByElement: new Map() }) });
  assert.equal(idle.forcePhase(worlds), false);
  assert.equal(idle.forceEnrage(worlds), false);
});
```

In `authority_debug_world_boss_gate.test.js`, add `{ action: 'phase' }, { action: 'enrage' }` to `ACTIONS`, and add this test:

```js
test('an admin reaches the phase/enrage triggers (an error frame proves the branch ran)', async () => {
  const h = await boot('admin');
  try {
    await new Promise((r) => setTimeout(r, 100));
    const framesBefore = h.frames.length;
    h.ws.send(JSON.stringify({ type: 'debugWorldBoss', action: 'phase' }));
    h.ws.send(JSON.stringify({ type: 'debugWorldBoss', action: 'enrage' }));
    await waitFor(() => h.frames.slice(framesBefore).filter((f) => f.type === 'error' && /no active world boss/.test(f.message)).length === 2);
  } finally { close(h); }
});
```

`DEBUG_FRAMES` in that file (`:23`) does NOT include `error`, so as it stands the non-admin test could not see a leaked phase/enrage error frame. Add `'error'` to the set, then run the non-admin test on the base code before Step 3 to confirm it is still green there. It must be, because the gate returns before any send, and join-time frames are excluded by `framesBefore`. If an unrelated `error` frame shows up after `framesBefore`, narrow the check to `f.type === 'error' && /world boss/.test(f.message)` rather than dropping it.

- [ ] **Step 2: Run RED.** `node --test tests/world_boss_sfx.test.js tests/authority_debug_world_boss_gate.test.js; echo "exit=$?"`. Expected: no `phase` events (length 0), `forcePhase is not a function`, and the admin test times out. Record the lines.

- [ ] **Step 3: Implement (additive).** Require `pushSfxEvent, bossSfx` from `./sfxEvents.js` in `worldBoss.js`, and add after `BOSS_LIFETIME_MS`:

```js
// SOMET-605 (spec §4.3): enrage at < 10% HP or in the last minute of the
// boss's lifetime. "Near the lifetime limit" is not quantified by the spec;
// 60 s is this slice's reading (plan decision D2).
const ENRAGE_HP_RATIO = 0.10;
const ENRAGE_LEAD_MS = 60 * 1000;
```

In `_checkPhaseTransition`, inside `if (phaseInfo.phase > currentPhase) {`, right after the stat-boost `if/else if` chain and before `if (broadcastFn)`:

```js
      this._emitBossSfx(worldEntry, creature, 'phase'); // SOMET-605
```

In `tick`, directly after `this._checkPhaseTransition(c, entry, broadcastFn);`:

```js
            this._checkEnrage(c, entry, now, broadcastFn); // SOMET-605
```

In `getStatus`'s returned object add `enraged: Boolean(this.currentBoss && this.currentBoss.enraged),`.

`_placeBossCreature(worldEntry, hp)` becomes `_placeBossCreature(worldEntry, hp, { quiet = false } = {})`, with `quietSpawn: quiet` in the `hydrateCreatureRow` instance object. The lost-boss branch in `tick` calls `this._placeBossCreature(entry, this.currentBoss.currentHp, { quiet: true });`.

New methods after `_spawnPhaseMinions`:

```js
  // SOMET-605: put a boss event on the boss's own sim sfx buffer, at its box
  // centre; World#drainSfx carries it into the next frame.
  _emitBossSfx(worldEntry, creature, e) {
    const sim = worldEntry && worldEntry.world && worldEntry.world.creatures;
    if (!sim || !Array.isArray(sim.sfx) || !creature) return false;
    return pushSfxEvent(sim.sfx, bossSfx(e, creature,
      creature.x + (creature.width || 0) / 2, creature.y + (creature.height || 0) / 2));
  }

  _checkEnrage(creature, worldEntry, now, broadcastFn) {
    if (!this.currentBoss || !creature || this.currentBoss.enraged) return false;
    const hpRatio = Math.max(0, creature.hp) / (creature.maxHp || 1);
    const nearTimeout = now - this.spawnedAt >= this.bossLifetimeMs - ENRAGE_LEAD_MS;
    if (hpRatio >= ENRAGE_HP_RATIO && !nearTimeout) return false;
    return this._enrage(creature, worldEntry, broadcastFn);
  }

  _enrage(creature, worldEntry, broadcastFn) {
    this.currentBoss.enraged = true;
    creature.enraged = true;
    this._emitBossSfx(worldEntry, creature, 'enrage');
    if (broadcastFn) {
      broadcastFn({
        type: 'announcement', kind: 'world_boss_enrage',
        text: `[World Boss] ${this.currentBoss.name} is enraged!`, bossName: this.currentBoss.name,
      });
      broadcastFn({ type: 'world_boss_status', status: this.getStatus() });
    }
    return true;
  }

  // The live boss creature and its world entry, or {} when there is none.
  _liveBoss(worlds) {
    if (this.state !== 'active' || !this.currentBoss || !this.activeWorldId || !worlds) return {};
    const entry = worlds.get(this.activeWorldId);
    const sim = entry && entry.world && entry.world.creatures;
    const creature = sim && sim.get ? sim.get(this.bossCreatureId) : null;
    return creature ? { entry, creature } : {};
  }

  // Test panel (spec §5): advance exactly one phase. HP is lowered to the
  // first whole percent _calculatePhase puts in the next phase -- the real
  // thresholds, read rather than copied -- and the normal transition runs.
  forcePhase(worlds, broadcastFn = null) {
    const { entry, creature } = this._liveBoss(worlds);
    if (!creature) return false;
    const before = this.currentBoss.phase || 1;
    const maxHp = creature.maxHp || 1;
    for (let pct = Math.floor((Math.max(0, creature.hp) / maxHp) * 100); pct >= 1; pct -= 1) {
      if (this._calculatePhase(pct / 100).phase > before) {
        creature.hp = Math.floor((maxHp * pct) / 100);
        break;
      }
    }
    this.currentBoss.currentHp = Math.max(0, creature.hp);
    this._checkPhaseTransition(creature, entry, broadcastFn);
    return (this.currentBoss.phase || 1) > before;
  }

  forceEnrage(worlds, broadcastFn = null) {
    const { entry, creature } = this._liveBoss(worlds);
    if (!creature || this.currentBoss.enraged) return false;
    return this._enrage(creature, entry, broadcastFn);
  }
```

Note: `forcePhase` into phase 3 or 4 also spawns minions through the real path. The test fixture has no minion row, so it logs one warning per phase. That is expected.

In `server.js` `debugWorldBoss`, after the `damage` branch:

```js
      } else if (action === 'phase') {
        // SOMET-605: test panel trigger; same transition code as the fight.
        if (!worldBossManager.forcePhase(worlds, broadcastAll)) {
          send(ws, { type: 'error', message: 'no active world boss, or it is already in its last phase' });
        }
      } else if (action === 'enrage') {
        if (!worldBossManager.forceEnrage(worlds, broadcastAll)) {
          send(ws, { type: 'error', message: 'no active world boss, or it is already enraged' });
        }
```

Do not touch the `if (ws.role !== 'admin') return;` gate.

- [ ] **Step 4: Run GREEN**, plus `tests/world_boss.test.js tests/world_boss_phase.test.js tests/world_boss_catalog_db.test.js` (both env vars). All exit 0.

- [ ] **Step 5: Commit**

```bash
cd $WT && git add backend/src/authority/worldBoss.js backend/src/authority/server.js backend/tests/world_boss_sfx.test.js backend/tests/authority_debug_world_boss_gate.test.js
git commit -m "feat(world-boss): phase and enrage sfx events, test-panel triggers (SOMET-605)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Limiter — the `boss` tier

**Files:**
- Modify: `frontend/src/games/something2/src/js/audio/sfxLimits.js:1-21` (header, order), `:38-113` (`admit` comment, `_evictionTarget`)
- Test: `frontend/src/games/something2/src/js/audio/__tests__/sfxLimits.test.js` (modify)

**Interfaces:**
- Produces: `SFX_PRIORITY_ORDER = ['nearby','nearest','boss','own']`. Eviction at capacity:
  - `own`: farthest `nearby`, else farthest `nearest`, else farthest `boss`, all unconditional. Never `own`. (Decision D3: the spec orders `boss < own` but never says own may bump boss.)
  - `boss`: farthest `nearby`, else farthest `nearest`, unconditional. Otherwise only a FARTHER held `boss` (nearer wins, ties refused). Never `own`.
  - `nearest`: unchanged (`nearby` unconditional, else farther `nearest`). Never `boss`/`own`.
  - `nearby`: unchanged (only a farther `nearby`).

- [ ] **Step 1: Write the failing tests.** Append to `sfxLimits.test.js`. Tier names are literals, never read from `SFX_PRIORITY_ORDER`:

```js
describe('SfxLimiter boss tier (SOMET-605)', () => {
  const fill = (l, priority, n, dist = (i) => i * 10) => {
    const ids = [];
    for (let i = 0; i < n; i += 1) ids.push(l.admit({ clipKey: `${priority}${i}`, priority, distance: dist(i) }).voiceId);
    return ids;
  };

  it('boss bumps the farthest nearest voice unconditionally, even when itself farther', () => {
    const { l } = limiter();
    const ids = fill(l, 'nearest', 12);
    const r = l.admit({ clipKey: 'b', priority: 'boss', distance: 5000 });
    expect(r.ok).toBe(true);
    expect(r.evict).toBe(ids[11]);
  });

  it('boss prefers a nearby voice over a farther nearest voice', () => {
    const { l } = limiter();
    fill(l, 'nearest', 11, () => 900);
    const [nearbyId] = fill(l, 'nearby', 1, () => 10);
    const r = l.admit({ clipKey: 'b', priority: 'boss', distance: 500 });
    expect(r.evict).toBe(nearbyId);
  });

  it('boss never evicts own', () => {
    const { l } = limiter();
    fill(l, 'own', 12, () => 9000);
    expect(l.admit({ clipKey: 'b', priority: 'boss', distance: 0 })).toEqual({ ok: false });
  });

  it('boss vs boss: nearer wins the farthest boss slot; a tie is refused', () => {
    const { l } = limiter();
    const ids = fill(l, 'boss', 12, (i) => 100 + i);
    expect(l.admit({ clipKey: 'tie', priority: 'boss', distance: 111 })).toEqual({ ok: false });
    const r = l.admit({ clipKey: 'near', priority: 'boss', distance: 50 });
    expect(r.evict).toBe(ids[11]);
  });

  it('nearest and nearby can never evict a boss voice, however near', () => {
    const { l } = limiter();
    fill(l, 'boss', 12, () => 1500);
    expect(l.admit({ clipKey: 'n', priority: 'nearest', distance: 0 })).toEqual({ ok: false });
    expect(l.admit({ clipKey: 'y', priority: 'nearby', distance: 0 })).toEqual({ ok: false });
  });

  it('own bumps a boss voice only when no nearby or nearest voice is held', () => {
    const { l } = limiter();
    fill(l, 'own', 11);
    const [bossId] = fill(l, 'boss', 1, () => 1);
    const r = l.admit({ clipKey: 'o', priority: 'own', distance: 9999 });
    expect(r.evict).toBe(bossId);
  });

  it('own still bumps nearest before boss', () => {
    const { l } = limiter();
    fill(l, 'boss', 11, () => 9000);
    const [nearestId] = fill(l, 'nearest', 1, () => 1);
    expect(l.admit({ clipKey: 'o', priority: 'own', distance: 0 }).evict).toBe(nearestId);
  });
});
```

- [ ] **Step 2: Run RED.** `cd $WT/frontend && npx vitest run src/games/something2/src/js/audio/__tests__/sfxLimits.test.js; echo "exit=$?"`. Today `boss` is neither top nor bottom, so it falls into the `nearest` branch. Expected RED: "boss bumps the farthest nearest voice unconditionally" (the `nearest` branch requires being nearer), "boss vs boss: nearer wins" (the `nearest` branch never looks at `boss` voices), and "own bumps a boss voice only when..." (`own` only looks at `nearby`/`nearest`). Expected already GREEN, and kept as regression pins: "prefers a nearby voice", "never evicts own", "nearest and nearby can never evict a boss voice", "own still bumps nearest before boss". Record the three failure lines.

- [ ] **Step 3: Implement.** Replace the order constant and helpers, and rewrite `_evictionTarget` per tier. Update the header and `admit` comments to state the four rules above.

```js
export const SFX_PRIORITY_ORDER = ['nearby', 'nearest', 'boss', 'own'];
```

```js
  _evictionTarget(priority, distance) {
    switch (priority) {
      case 'own':
        // Always wins: bump the lowest tier held, farthest first.
        return this._farthestOf('nearby') || this._farthestOf('nearest') || this._farthestOf('boss');
      case 'boss': {
        // SOMET-605 (spec §4.4): creature chatter never keeps a boss quiet;
        // the player's own action is never cut for a boss.
        const low = this._farthestOf('nearby') || this._farthestOf('nearest');
        if (low) return low;
        const other = this._farthestOf('boss');
        return other && distance < other.distance ? other : null;
      }
      case 'nearest': {
        const nearby = this._farthestOf('nearby');
        if (nearby) return nearby;
        const nearest = this._farthestOf('nearest');
        return nearest && distance < nearest.distance ? nearest : null;
      }
      case 'nearby': {
        const nearby = this._farthestOf('nearby');
        return nearby && distance < nearby.distance ? nearby : null;
      }
      default:
        return null;
    }
  }
```

Delete the now-unused `TOP_PRIORITY`, `BOTTOM_PRIORITY`, `isTop` and `isBottom`.

- [ ] **Step 4: Run GREEN.** The whole file passes, including the pre-existing tests (their own/nearest/nearby behaviour is unchanged).

- [ ] **Step 5: Commit**

```bash
cd $WT && git add frontend/src/games/something2/src/js/audio/sfxLimits.js frontend/src/games/something2/src/js/audio/__tests__/sfxLimits.test.js
git commit -m "feat(audio): boss limiter tier between nearest and own (SOMET-605)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Boss one-shots resolve and play at the `boss` tier

**Files:**
- Modify: `frontend/src/games/something2/src/js/audio/sfxResolve.js:24-48`
- Modify: `frontend/src/games/something2/src/js/audio/AudioEngine.js:9` (import), `:226` (priority)
- Test: `.../audio/__tests__/sfxResolve.test.js` (modify), `.../audio/__tests__/AudioEngine.test.js` (modify)

**Interfaces:**
- Produces: `sfxChains({e:'spawn'|'phase'|'enrage', c})` → `[{ keys: ['creature/<c>/<e>'], missKey }]`; no `c` → `[]`. `sfxPriority(ev, ownActor) → 'own'|'boss'|'nearest'`. `own` wins when `ev.a === ownActor`, which a creature event never matches.

- [ ] **Step 1: Write the failing tests.** In `sfxResolve.test.js` (import `sfxPriority` too):

```js
  it('SOMET-605: boss events resolve to creature/<type>/<e>', () => {
    for (const e of ['spawn', 'phase', 'enrage']) {
      expect(sfxChains({ e, c: 'Ignis', a: 'c:wb_1', x: 0, y: 0 }))
        .toEqual([{ keys: [`creature/Ignis/${e}`], missKey: `creature/Ignis/${e}` }]);
    }
    expect(sfxChains({ e: 'phase', x: 0, y: 0 })).toEqual([]);
  });

  it('SOMET-605: sfxPriority -- own beats everything, boss events are boss, the rest nearest', () => {
    expect(sfxPriority({ e: 'use', a: 'p:1' }, 'p:1')).toBe('own');
    expect(sfxPriority({ e: 'phase', c: 'Ignis', a: 'c:wb_1' }, 'p:1')).toBe('boss');
    expect(sfxPriority({ e: 'enrage', c: 'Ignis' }, undefined)).toBe('boss');
    expect(sfxPriority({ e: 'hurt', c: 'Slime' }, 'p:1')).toBe('nearest');
    expect(sfxPriority({ e: 'death', c: 'Ignis' }, 'p:1')).toBe('nearest');
  });
```

In `AudioEngine.test.js` (inside `describe('AudioEngine'`), end to end through `playSfxEvents`:

```js
  it('SOMET-605: a boss phase one-shot holds its voice against creature chatter, and an own swing still lands', async () => {
    const { engine, sources } = engineWith({
      'creature/Ignis/phase': [{ key: 'ignis-phase.ogg', volume: 1, weight: 1 }],
      'creature/slime/hurt': [{ key: 'slime-hurt.ogg', volume: 1, weight: 1 }],
      'item/Iron Sword/use': [{ key: 'sword.ogg', volume: 1, weight: 1 }],
    });
    engine.unlock();
    engine.sfxLimiter.maxVoices = 1;
    const opts = { listener: { x: 0, y: 0 }, ownActor: 'p:1' };
    engine.playSfxEvents([{ e: 'phase', c: 'Ignis', a: 'c:wb_1', x: 900, y: 0 }], opts);
    await flush(); await flush();
    expect(sources.map((s) => s.buffer.tag)).toEqual(['u:ignis-phase.ogg']);
    // A creature hurt right next to the listener must NOT bump the boss voice.
    engine.playSfxEvents([{ e: 'hurt', c: 'slime', x: 0, y: 0 }], opts);
    await flush(); await flush();
    expect(sources.length).toBe(1);
    expect(sources[0].stopped).toBe(false);
    // The player's own swing does bump it (own > boss).
    engine.playSfxEvents([{ e: 'use', k: 'melee', s: 'Iron Sword', a: 'p:1', x: 0, y: 0 }], opts);
    await flush(); await flush();
    expect(sources[0].stopped).toBe(true);
    expect(sources[1].buffer.tag).toBe('u:sword.ogg');
  });
```

- [ ] **Step 2: Run RED.** `npx vitest run src/games/something2/src/js/audio/__tests__/sfxResolve.test.js src/games/something2/src/js/audio/__tests__/AudioEngine.test.js; echo "exit=$?"`. Expected: `sfxPriority is not a function`, and an empty chain for `phase` (no source started).

- [ ] **Step 3: Implement.** In `sfxResolve.js`, add to the switch:

```js
    // SOMET-605: a boss's own moments (backend sfxEvents.bossSfx).
    case 'spawn':
    case 'phase':
    case 'enrage':
      return c ? chain([`creature/${c}/${e}`]) : [];
```

and append:

```js
// SOMET-605 (spec §4.4): which SfxLimiter tier a wire event plays at.
const BOSS_EVENTS = new Set(['spawn', 'phase', 'enrage']);
export function sfxPriority(ev, ownActor) {
  if (ownActor && ev && ev.a === ownActor) return 'own';
  return ev && BOSS_EVENTS.has(ev.e) ? 'boss' : 'nearest';
}
```

In `AudioEngine.js`: `import { sfxChains, sfxPriority } from './sfxResolve.js';` and at `:226` `const priority = sfxPriority(ev, ownActor);`.

- [ ] **Step 4: Run GREEN** (both files, full).

- [ ] **Step 5: Commit**

```bash
cd $WT && git add frontend/src/games/something2/src/js/audio/sfxResolve.js frontend/src/games/something2/src/js/audio/AudioEngine.js frontend/src/games/something2/src/js/audio/__tests__/sfxResolve.test.js frontend/src/games/something2/src/js/audio/__tests__/AudioEngine.test.js
git commit -m "feat(audio): boss spawn/phase/enrage one-shots at the boss tier (SOMET-605)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Presence loop within screen radius

**Files:**
- Create: `frontend/src/games/something2/src/js/audio/screenRadius.js`
- Modify: `frontend/src/games/something2/src/js/audio/AudioEngine.js` (constructor `:100`, `tickNearby` `:417-472`, `_startNearbyLoop` `:497-504`, `_startNearbyLoopVoice` `:524-551`, `_sweepNearbyLoops` `:569-577`, `snapshot` `:661-673`)
- Modify: `frontend/src/games/something2/src/js/core/Game.js:1405-1424` (+ import)
- Test: `.../audio/__tests__/screenRadius.test.js` (create), `.../audio/__tests__/AudioEngine.test.js` (modify)

**Interfaces:**
- Produces: `screenRadiusWorld(viewW, viewH) → number` (world px; 0 for a non-positive size). `AudioEngine#setScreenRadius(px)` (stores a finite positive number, else null, which means no presence). In `tickNearby`, every creature with a truthy `bossTier` within `screenRadiusPx` of the listener gets ONE looping `creature/<type>/presence` source at limiter tier `boss`, emitter id `boss:<id>`, played at clip volume (no distance falloff; decision D4), with its pan updated each tick. It fades out over `FADE_S` when the boss leaves the radius or the creature map. `snapshot().loops` is `[{ id, key, priority, distance }]` and `snapshot().screenRadiusPx` is the radius.
- Unchanged: world-point loops (`pt:` ids) keep their radius (`nearbyScheduler.radiusPx`), falloff and `nearby` tier.

- [ ] **Step 1: Write the failing tests.**

```js
// screenRadius.test.js
import { describe, it, expect } from 'vitest';
import { screenRadiusWorld } from '../screenRadius.js';
import { cursorToWorld } from '../../core/aim.js';

describe('screenRadiusWorld (SOMET-605, spec §4.4)', () => {
  it('1280x720 is ~1064.33 world px', () => {
    // Hand arithmetic: ISO_K = 128 / (2*100) = 0.64. Corner (640, 360):
    // a = 640/0.64 = 1000, b = 2*360/0.64 = 1125, |w| = sqrt((a^2+b^2)/2)
    // = sqrt(1132812.5) = 1064.33.
    expect(screenRadiusWorld(1280, 720)).toBeCloseTo(1064.33, 1);
  });

  it('equals the world distance from the view centre to a canvas corner (independent projection path)', () => {
    const camera = { screenX: 0, screenY: 0 };
    const centre = cursorToWorld(640, 360, camera);
    const corner = cursorToWorld(0, 0, camera);
    expect(screenRadiusWorld(1280, 720)).toBeCloseTo(Math.hypot(corner.x - centre.x, corner.y - centre.y), 6);
  });

  it('is 0 for a zero or missing size', () => {
    expect(screenRadiusWorld(0, 720)).toBe(0);
    expect(screenRadiusWorld(undefined, undefined)).toBe(0);
  });
});
```

In `AudioEngine.test.js`, inside `describe('tickNearby'` (it has `creatureMap`):

```js
    describe('boss presence (SOMET-605)', () => {
      const bindings = { 'creature/Ignis/presence': [{ key: 'ignis-bed.ogg', volume: 0.8, weight: 1, loopable: false }] };
      const ignis = (x) => creatureMap([{ id: 'wb_1', type: 'Ignis', x, y: 0, width: 96, height: 96, bossTier: 'world' }]);

      it('loops presence while the boss is within screen radius, then fades it out on exit', async () => {
        const { engine, sources } = engineWith(bindings);
        engine.unlock();
        engine.setScreenRadius(1000);
        engine.tickNearby(ignis(452), [], { x: 0, y: 0 }, 0); // centre 500 <= 1000
        await flush(); await flush();
        const bed = sources.find((s) => s.buffer && s.buffer.tag === 'u:ignis-bed.ogg');
        expect(bed).toBeTruthy();
        expect(bed.loop).toBe(true); // loops although the clip is not marked loopable
        expect(engine.snapshot().loops).toEqual([{ id: 'boss:wb_1', key: 'ignis-bed.ogg', priority: 'boss', distance: 500 }]);
        engine.tickNearby(ignis(552), [], { x: 0, y: 0 }, 300); // still in: no second source
        await flush(); await flush();
        expect(sources.filter((s) => s.buffer && s.buffer.tag === 'u:ignis-bed.ogg').length).toBe(1);
        engine.tickNearby(ignis(1052), [], { x: 0, y: 0 }, 600); // centre 1100 > 1000
        await flush(); await flush();
        expect(bed.stopped).toBe(true);
        expect(engine.snapshot().loops).toEqual([]);
      });

      it('an ordinary creature never gets a presence loop', async () => {
        const { engine, sources } = engineWith({ 'creature/Slime/presence': [{ key: 'x.ogg', volume: 1, weight: 1 }] });
        engine.unlock();
        engine.setScreenRadius(1000);
        engine.tickNearby(creatureMap([{ id: 1, type: 'Slime', x: 0, y: 0 }]), [], { x: 0, y: 0 }, 0);
        await flush(); await flush();
        expect(sources.length).toBe(0);
      });

      it('the boss leaving the creature map (death/despawn) fades the loop; setWorld stops it outright', async () => {
        const { engine, sources } = engineWith(bindings);
        engine.unlock();
        engine.setScreenRadius(1000);
        engine.tickNearby(ignis(0), [], { x: 0, y: 0 }, 0);
        await flush(); await flush();
        engine.tickNearby(new Map(), [], { x: 0, y: 0 }, 300);
        await flush(); await flush();
        expect(sources[0].stopped).toBe(true);
        engine.tickNearby(ignis(0), [], { x: 0, y: 0 }, 600);
        await flush(); await flush();
        engine.setWorld({ world: 'other', bindings });
        expect(sources[sources.length - 1].stopped).toBe(true);
        expect(engine.snapshot().loops).toEqual([]);
      });

      it('no screen radius yet means no presence', async () => {
        const { engine, sources } = engineWith(bindings);
        engine.unlock();
        engine.tickNearby(ignis(0), [], { x: 0, y: 0 }, 0);
        await flush(); await flush();
        expect(sources.length).toBe(0);
      });

      it('creature nearby chatter cannot evict the presence loop', async () => {
        const { engine, sources } = engineWith({ ...bindings, 'creature/slime/nearby': [{ key: 'slime.ogg', volume: 1, weight: 1 }] });
        engine.unlock();
        engine.setScreenRadius(1000);
        engine.sfxLimiter.maxVoices = 1;
        const both = creatureMap([
          { id: 'wb_1', type: 'Ignis', x: 0, y: 0, width: 96, height: 96, bossTier: 'world' },
          { id: 2, type: 'slime', x: 5, y: 0 },
        ]);
        engine.tickNearby(both, [], { x: 0, y: 0 }, 0);
        await flush(); await flush();
        engine.tickNearby(both, [], { x: 0, y: 0 }, 11000); // past the cadence gap
        await flush(); await flush();
        const bed = sources.find((s) => s.buffer.tag === 'u:ignis-bed.ogg');
        expect(bed.stopped).toBe(false);
        expect(sources.some((s) => s.buffer.tag === 'u:slime.ogg' && s.started)).toBe(false);
      });

      it('a slow buffer spanning several ticks starts exactly one presence source', async () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        const { ctx, sources } = fakeCtx();
        const engine = new AudioEngine({
          ctxFactory: () => ctx, urlFor: (k) => `u:${k}`, rand: () => 0, postMisses: async () => {},
          fetchBytes: async (url) => { await gate; return new TextEncoder().encode(url).buffer; },
        });
        engine.setWorld({ world: 'vale', bindings });
        engine.unlock();
        engine.setScreenRadius(1000);
        for (let t = 0; t <= 1000; t += 250) engine.tickNearby(ignis(0), [], { x: 0, y: 0 }, t);
        release();
        await flush(); await flush(); await flush();
        expect(sources.filter((s) => s.buffer && s.buffer.tag === 'u:ignis-bed.ogg').length).toBe(1);
      });
    });
```

Check two things before you run: (a) `fakeCtx` is module-scoped in that file, so it is usable here; (b) the world-music start on `setWorld` creates no source for these bindings (no `world/*/music` binding), so `sources` holds only sfx. The "nearby chatter" test's expectation is that the slime `nearby` voice is refused at `maxVoices = 1` because `nearby` cannot evict `boss`. If the slime cadence never comes due at t=11000 with `rand: () => 0`, read `nearbyScheduler` `nextAt` and pick a later t. Never weaken the assertion.

- [ ] **Step 2: Run RED.** `npx vitest run src/games/something2/src/js/audio/__tests__/screenRadius.test.js src/games/something2/src/js/audio/__tests__/AudioEngine.test.js; echo "exit=$?"`. Expected: module not found, and `engine.setScreenRadius is not a function`.

- [ ] **Step 3: Implement.**

```js
// frontend/src/games/something2/src/js/audio/screenRadius.js
// SOMET-605 (spec §4.4): "screen radius = half the viewport diagonal, in
// world units". The view is isometric, so a screen length is not a world
// length: each canvas corner is projected back to the world and the farthest
// one wins. Pure; Game.update calls it every frame with the canvas size, so
// a future zoom or resizable backing store only has to change what it passes.
import { screenToWorld } from '../core/iso.js';

export function screenRadiusWorld(viewW, viewH) {
  if (!(viewW > 0) || !(viewH > 0)) return 0;
  let r = 0;
  for (const sx of [-viewW / 2, viewW / 2]) {
    for (const sy of [-viewH / 2, viewH / 2]) {
      const w = screenToWorld(sx, sy);
      r = Math.max(r, Math.hypot(w.x, w.y));
    }
  }
  return r;
}
```

`AudioEngine.js`:

- Constructor: `this.screenRadiusPx = null;`. New method:

```js
  // SOMET-605: Game.update passes screenRadiusWorld(...) every frame; the
  // presence loop uses it. null (never set, or invalid) = no presence.
  setScreenRadius(px) { this.screenRadiusPx = Number.isFinite(px) && px > 0 ? px : null; }
```

- `tickNearby`: in the creature loop, after pushing the cadence emitter, add `if (c.bossTier) presence.push({ id: \`boss:${c.id}\`, type: c.type, x: cx, y: cy });` (declare `const presence = [];` next to `cadenceEmitters`). After the points loop and before the scheduler loop:

```js
    // SOMET-605 (spec §4.4): a boss within screen radius keeps one looping
    // `presence` source at the boss tier. Same loop machinery as a loopable
    // world point (nearbyLoops / nearbyLoopStarting), so the start-race and
    // leak guards those three fix rounds added apply here unchanged.
    const presenceById = new Map();
    const radius = this.screenRadiusPx;
    if (radius) {
      for (const b of presence) {
        const dx = b.x - listener.x;
        const distance = Math.hypot(dx, b.y - listener.y);
        if (distance > radius) continue;
        presenceById.set(b.id, b);
        const live = this.nearbyLoops.get(b.id);
        if (live) {
          live.distance = distance;
          if (live.panner) live.panner.pan.value = Math.max(-1, Math.min(1, dx / SFX_PAN_PX));
          continue;
        }
        if (this.nearbyLoopStarting.has(b.id)) continue;
        const { clips, key } = this._resolve([`creature/${b.type}/presence`]); // records the miss itself
        const clip = key ? pickWeighted(clips, this.rand) : null;
        if (clip) this._startNearbyLoop(b.id, clip, dx, distance, { priority: 'boss', presence: true });
      }
    }
```

  and change the final call to `this._sweepNearbyLoops(pointsById, listener, presenceById);`.

- `_startNearbyLoop(emitterId, clip, dx, distance, { priority = 'nearby', presence = false } = {})`: pass `priority` to `admit`, and pass `{ priority, presence }` on to `_startNearbyLoopVoice`.
- `_startNearbyLoopVoice(emitterId, voiceId, clip, dx, distance, { priority = 'nearby', presence = false } = {})`: `const target = presence ? vol : vol * falloff;` (D4), and store `this.nearbyLoops.set(emitterId, { src, gain, panner, voiceId, key: clip.key, priority, distance });`.
- `_sweepNearbyLoops(pointsById, listener, presenceById = new Map())`:

```js
  _sweepNearbyLoops(pointsById, listener, presenceById = new Map()) {
    const stillNear = (p) => p && Math.hypot((p.x || 0) - listener.x, (p.y || 0) - listener.y) <= this.nearbyScheduler.radiusPx;
    // SOMET-605: a `boss:` emitter stays only while tickNearby found it
    // within screen radius this tick; a point keeps its own radius rule.
    const keep = (id) => (id.startsWith('boss:') ? presenceById.has(id) : stillNear(pointsById.get(id)));
    for (const emitterId of [...this.nearbyLoops.keys()]) {
      if (!keep(emitterId)) this._fadeOutNearbyLoop(emitterId);
    }
    for (const emitterId of [...this.nearbyLoopStarting.keys()]) {
      if (!keep(emitterId)) this._cancelNearbyLoopStart(emitterId);
    }
  }
```

- `snapshot()`: add

```js
      loops: [...this.nearbyLoops].map(([id, l]) => ({ id, key: l.key, priority: l.priority || 'nearby', distance: Math.round(l.distance || 0) })),
      screenRadiusPx: this.screenRadiusPx,
```

`Game.js`: `import { screenRadiusWorld } from '../audio/screenRadius.js';` (put it next to the existing audio imports). In `update`, inside `if (this.audio) {` and before `this.audio.tickNearby(`:

```js
                // SOMET-605: half the viewport diagonal in world units, per
                // tick (spec §4.4); the boss presence loop's in/out edge.
                this.audio.setScreenRadius(screenRadiusWorld(
                    (this.canvas && this.canvas.width) || GAME_WIDTH,
                    (this.canvas && this.canvas.height) || GAME_HEIGHT,
                ));
```

Confirm that `GAME_WIDTH`/`GAME_HEIGHT` are already imported in `Game.js` (they are used at `:1170-1171`).

- [ ] **Step 4: Run GREEN**: the two files, then the whole `src/games/something2/src/js/audio` folder (`npx vitest run src/games/something2/src/js/audio; echo "exit=$?"`). The existing world-point loop tests must stay green unchanged.

- [ ] **Step 5: Commit**

```bash
cd $WT && git add frontend/src/games/something2/src/js/audio/screenRadius.js frontend/src/games/something2/src/js/audio/AudioEngine.js frontend/src/games/something2/src/js/core/Game.js frontend/src/games/something2/src/js/audio/__tests__/screenRadius.test.js frontend/src/games/something2/src/js/audio/__tests__/AudioEngine.test.js
git commit -m "feat(audio): boss presence loop within screen radius (SOMET-605)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Audio tab and Entities Sounds — boss slots only on boss rows

**Files:**
- Modify: `frontend/src/games/something2/audioSelection.js:41-73` (`audioSlotRows`), `:336-344` (`jobsForKnownSubjects`)
- Modify: `frontend/src/games/something2/audioBatch.js:136-150` (`subjectSlotsFor`)
- Modify: `frontend/src/games/something2/SubjectSounds.jsx:70`
- Modify: `frontend/src/games/something2/useMaps.js:164-169` (`useUpdateEntityType` `onSuccess`)
- Test: `__tests__/audioSelection.test.js`, `__tests__/audioBatch.test.js` (modify)

**Interfaces:**
- Consumes: Task 2's `subjectSlots` on the creature group of `GET /admin/subjects`.
- Produces: `slotEntriesFor(group, key) → [slot, clipKind][]` (exported from `audioSelection.js`). When `group.subjectSlots` is present, it filters `group.slots` to that subject's list, and a subject missing from the map gets `[]`. When it is absent, it returns every slot. `subjectSlotsFor(subjects, kind, key?)`: with a `key`, it uses `slotEntriesFor`; without one, it keeps today's behaviour.

- [ ] **Step 1: Write the failing tests.** In `audioSelection.test.js`:

```js
describe('per-subject slots (SOMET-605)', () => {
  const creatureGroup = {
    kind: 'creature', label: 'Creatures',
    slots: { nearby: 'sfx', attack: 'sfx', hurt: 'sfx', death: 'sfx', spawn: 'sfx', presence: 'sfx', phase: 'sfx', enrage: 'sfx' },
    subjects: ['Ignis', 'Slime'],
    subjectSlots: {
      Ignis: ['nearby', 'attack', 'hurt', 'death', 'spawn', 'presence', 'phase', 'enrage'],
      Slime: ['nearby', 'attack', 'hurt', 'death'],
    },
  };

  it('a boss row lists 8 slot rows, an ordinary creature 4', () => {
    const rows = audioSlotRows([creatureGroup]);
    expect(rows.filter((r) => r.key === 'Ignis').map((r) => r.slot)).toEqual(['nearby', 'attack', 'hurt', 'death', 'spawn', 'presence', 'phase', 'enrage']);
    expect(rows.filter((r) => r.key === 'Slime').map((r) => r.slot)).toEqual(['nearby', 'attack', 'hurt', 'death']);
  });

  it('a group without subjectSlots still lists every slot for every subject', () => {
    const rows = audioSlotRows([{ kind: 'world', slots: { music: 'music', ambience: 'ambience' }, subjects: ['Vale'] }]);
    expect(rows.map((r) => r.slot)).toEqual(['music', 'ambience']);
  });

  it('slotEntriesFor: a subject absent from subjectSlots gets nothing', () => {
    expect(slotEntriesFor(creatureGroup, 'Ghost')).toEqual([]);
  });

  it('a job for an ordinary creature boss slot is not a known subject (no retry offered)', () => {
    const jobs = [
      { id: 1, subject_kind: 'creature', subject_key: 'Slime', slot: 'presence', status: 'failed' },
      { id: 2, subject_kind: 'creature', subject_key: 'Ignis', slot: 'presence', status: 'failed' },
    ];
    expect(jobsForKnownSubjects(jobs, [creatureGroup]).map((j) => j.id)).toEqual([2]);
  });
});
```

(Add `slotEntriesFor` to the file's import.) In `audioBatch.test.js`:

```js
  it('SOMET-605: with a key, a creature with subjectSlots gets only its own slots', () => {
    const reg = [{
      kind: 'creature', slots: { hurt: 'sfx', presence: 'sfx' }, subjects: ['Ignis', 'Slime'],
      subjectSlots: { Ignis: ['hurt', 'presence'], Slime: ['hurt'] },
    }];
    expect(subjectSlotsFor(reg, 'creature', 'Slime')).toEqual([{ slot: 'hurt', clipKind: 'sfx' }]);
    expect(subjectSlotsFor(reg, 'creature', 'Ignis').map((s) => s.slot)).toEqual(['hurt', 'presence']);
    expect(subjectSlotsFor(subjects, 'world', 'Vale')).toEqual([
      { slot: 'music', clipKind: 'music' }, { slot: 'ambience', clipKind: 'ambience' },
    ]);
  });
```

- [ ] **Step 2: Run RED.** `npx vitest run src/games/something2/__tests__/audioSelection.test.js src/games/something2/__tests__/audioBatch.test.js; echo "exit=$?"`. Expected: `slotEntriesFor` is not exported, and Slime gets 8 rows.

- [ ] **Step 3: Implement.** In `audioSelection.js`:

```js
// SOMET-605 (spec §3.6): the slots ONE subject carries. A group whose kind
// varies slots per subject (creature: boss slots only on boss rows) sends
// `subjectSlots`; without it every subject carries every slot.
export function slotEntriesFor(group, key) {
  const entries = Object.entries((group && group.slots) || {});
  const names = group && group.subjectSlots ? group.subjectSlots[key] : undefined;
  if (!group || !group.subjectSlots) return entries;
  return names ? entries.filter(([s]) => names.includes(s)) : [];
}
```

In `audioSlotRows`, delete `const slots = Object.entries(group.slots || {});` and iterate `for (const [slot, clipKind] of slotEntriesFor(group, key))` inside the key loop. In `jobsForKnownSubjects`, store the group itself (`known.set(g.kind, g)`) and test with `Boolean(g) && (g.subjects || []).includes(j.subject_key) && slotEntriesFor(g, j.subject_key).some(([s]) => s === j.slot)`. Keep the Set for subjects if the list is large: `new Set(g.subjects)` cached alongside.

In `audioBatch.js`:

```js
import { slotEntriesFor } from './audioSelection.js';

export function subjectSlotsFor(subjectsResponse, kind, key) {
  const group = (subjectsResponse || []).find((g) => g.kind === kind);
  if (!group) return [];
  const entries = key === undefined ? Object.entries(group.slots || {}) : slotEntriesFor(group, key);
  return entries.map(([slot, clipKind]) => ({ slot, clipKind }));
}
```

(First check that `audioSelection.js` does not import `audioBatch.js`; if it does, move `slotEntriesFor` into `audioBatch.js` and import it the other way, to avoid a cycle.)

`SubjectSounds.jsx:70`: `const slots = subjectSlotsFor(subjects, kind, subjectKey);`.

`useMaps.js` `useUpdateEntityType` `onSuccess`: add

```js
      // SOMET-605: Boss tier decides which audio slots a creature carries;
      // the Audio tab and the entity's Sounds section read them from here.
      queryClient.invalidateQueries({ queryKey: ['audio-subjects'] });
```

(This is `useAudioAdmin.js` `SUBJECTS_KEY`. It is a literal here to avoid importing the audio hooks into `useMaps.js`. Confirm the key string matches `useAudioAdmin.js:13`.)

- [ ] **Step 4: Run GREEN**, then the whole admin folder: `npx vitest run src/games/something2/__tests__; echo "exit=$?"`.

- [ ] **Step 5: Commit**

```bash
cd $WT && git add frontend/src/games/something2/audioSelection.js frontend/src/games/something2/audioBatch.js frontend/src/games/something2/SubjectSounds.jsx frontend/src/games/something2/useMaps.js frontend/src/games/something2/__tests__/audioSelection.test.js frontend/src/games/something2/__tests__/audioBatch.test.js
git commit -m "feat(admin): Audio tab and entity Sounds list boss slots on boss rows only (SOMET-605)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Test panel — Trigger Phase / Trigger Enrage

**Files:**
- Create: `frontend/src/games/something2/worldBossDebugActions.js`
- Modify: `frontend/src/games/something2/WorldBossTestPanel.jsx:573-617` (Combat section `ButtonGrid`)
- Test: `frontend/src/games/something2/__tests__/worldBossDebugActions.test.js` (create)

**Interfaces:**
- Consumes: Task 5's `debugWorldBoss` actions `phase`, `enrage` (admin-gated server side; the panel itself is already admin-gated by `worldBossPanelGate.js`).
- Produces: `BOSS_STAGE_ACTIONS = [{ action: 'phase', label: 'Trigger Next Phase' }, { action: 'enrage', label: 'Trigger Enrage' }]` (frozen).

- [ ] **Step 1: Write the failing test.**

```js
import { describe, it, expect } from 'vitest';
import { BOSS_STAGE_ACTIONS } from '../worldBossDebugActions.js';

describe('BOSS_STAGE_ACTIONS (SOMET-605)', () => {
  it('offers exactly the two server actions, in order, each with a label', () => {
    expect(BOSS_STAGE_ACTIONS.map((a) => a.action)).toEqual(['phase', 'enrage']);
    for (const a of BOSS_STAGE_ACTIONS) expect(typeof a.label).toBe('string');
    expect(Object.isFrozen(BOSS_STAGE_ACTIONS)).toBe(true);
  });
});
```

The action strings are the wire contract with `server.js` (Task 5). The test pins them literally.

- [ ] **Step 2: Run RED** (module not found).

- [ ] **Step 3: Implement.**

```js
// frontend/src/games/something2/worldBossDebugActions.js
// SOMET-605 (spec §5): the World Boss test panel's stage triggers. `action`
// is the debugWorldBoss wire value server.js handles (admin only).
export const BOSS_STAGE_ACTIONS = Object.freeze([
  Object.freeze({ action: 'phase', label: 'Trigger Next Phase' }),
  Object.freeze({ action: 'enrage', label: 'Trigger Enrage' }),
]);
```

In `WorldBossTestPanel.jsx`, import it and add these inside the Combat `ButtonGrid`, right after the "Deal 3,000 Damage" button:

```jsx
                  {BOSS_STAGE_ACTIONS.map((a) => (
                    <ActionBtn
                      key={a.action}
                      $bg="rgba(255, 99, 72, 0.15)"
                      $border="rgba(255, 99, 72, 0.45)"
                      $color="#ff6348"
                      onClick={() => sendAction(a.action)}
                    >
                      {a.label}
                    </ActionBtn>
                  ))}
```

- [ ] **Step 4: Run GREEN**, plus `__tests__/WorldBossTestPanel.smoke.test.js` and `__tests__/worldBossPanelGate.test.js`.

- [ ] **Step 5: Commit**

```bash
cd $WT && git add frontend/src/games/something2/worldBossDebugActions.js frontend/src/games/something2/WorldBossTestPanel.jsx frontend/src/games/something2/__tests__/worldBossDebugActions.test.js
git commit -m "feat(admin): world boss test panel triggers phase and enrage (SOMET-605)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Full suites + browser and audio verification on an isolated instance

**Files:**
- Create (NOT committed, delete afterwards): `frontend/vite.verify.config.mjs`
- No source changes. A defect found here goes back to its owning task as a RED test first.

**Interfaces:** consumes everything above.

- [ ] **Step 1: Full backend suite on the scratch DB.** Compare it against `s2-baseline.log`.

```bash
cd $WT/backend && TEST_DATABASE_URL=postgres://user:password@localhost:15432/game_db_s2 DATABASE_URL=postgres://user:password@localhost:15432/game_db_s2 npm test > ../../s2-final.log 2>&1; echo "exit=$?"
grep -E '^not ok|testTimeoutFailure' ../../s2-final.log
```

Expected: no `not ok` line that is not also in the baseline (`openchest`, SOMET-615, excluded). Watch `describe_audio_slots_db`, `audio_subjects_sfx_db`, `audio_prompt_context_db`, `audio_seed_db` and `authority_sfx_frame`.

- [ ] **Step 2: Full frontend suite**

```bash
cd $WT/frontend && npx vitest run; echo "exit=$?"
```

Expected: `exit=0`, or only failures that are also in `s2-fe-baseline.log`.

- [ ] **Step 3: Start the isolated backend** on port 13104 with the scratch DB. Check that the ports are free first, and kill only by PID file.

```bash
ss -ltn | grep -E ':13104 |:15274 ' && echo "PORT BUSY - pick another" || true
cd $WT/backend
set -a; . /home/markunn/worker/coding/jsgame/something2/.env; set +a
export PORT=13104 DATABASE_URL=postgres://user:password@localhost:15432/game_db_s2
export REDIS_URL=$(echo "$REDIS_URL" | sed 's/redis:6379/localhost:16379/')
nohup node src/index.js > ../../s2-backend.log 2>&1 & echo $! > ../../s2-backend.pid
sleep 5; curl -s localhost:13104/api/health
```

Set up the admin on the scratch DB only. Never run `admin-password-rotate`.

```bash
cd /home/markunn/worker/coding/jsgame/something2/backend && DATABASE_URL=postgres://user:password@localhost:15432/game_db_s2 node scripts/set-admin-password.js
node -e "console.log(require('dotenv').parse(require('fs').readFileSync('/home/markunn/worker/coding/jsgame/something2/.env')).ADMIN_PASSWORD)"
```

- [ ] **Step 4: Bind test clips to Ignis's boss slots** (scratch DB, via the real upload route, which also exercises Task 2's door). Use a distinct label per slot so the bundle tells them apart:

```bash
ADMIN_USER=$(node -e "console.log(require('dotenv').parse(require('fs').readFileSync('/home/markunn/worker/coding/jsgame/something2/.env')).ADMIN_USERNAME)")
ADMIN_PASS=$(node -e "console.log(require('dotenv').parse(require('fs').readFileSync('/home/markunn/worker/coding/jsgame/something2/.env')).ADMIN_PASSWORD)")
TOKEN=$(curl -s localhost:13104/api/auth/login -H 'Content-Type: application/json' -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
BOSS='Ignis, the Magma Colossus'
for SLOT in spawn presence phase enrage; do
  curl -s -o /dev/null -w "$SLOT %{http_code}\n" -X POST "localhost:13104/api/audio/admin/upload?subject_kind=creature&subject_key=$(node -pe "encodeURIComponent('$BOSS')")&slot=$SLOT&label=s2-verify-$SLOT" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: audio/ogg' --data-binary @$WT/backend/tests/fixtures/audio/tone.ogg
done   # expect 4 x 201
curl -s -o /dev/null -w "slime-presence %{http_code}\n" -X POST "localhost:13104/api/audio/admin/upload?subject_kind=creature&subject_key=Slime&slot=presence" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: audio/ogg' --data-binary @$WT/backend/tests/fixtures/audio/tone.ogg   # expect 400
```

Read the login response shape first (`/api/auth/login`). If the token field is not `token`, adjust the extraction. `tone.ogg` is short, which is fine because presence loops it regardless.

- [ ] **Step 5: Start the isolated frontend.** Create `$WT/frontend/vite.verify.config.mjs` (do not commit). It uses `watch: null` because the host's inotify limit is exhausted, so restart vite after any code change.

```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  cacheDir: '/tmp/s2-boss-sounds-vite-cache',
  server: {
    port: 15274, strictPort: true, watch: null,
    proxy: {
      '/api': { target: 'http://localhost:13104', changeOrigin: true },
      '/authority': { target: 'http://localhost:13104', ws: true, changeOrigin: true },
    },
  },
});
```

```bash
cd $WT/frontend && nohup node node_modules/.bin/vite --config vite.verify.config.mjs > ../../s2-vite.log 2>&1 & echo $! > ../../s2-vite.pid
sleep 4
curl -s http://localhost:15274/src/games/something2/src/js/audio/AudioEngine.js | grep -c "boss:"           # expect >= 1 (fresh bundle)
curl -s http://localhost:15274/src/games/something2/src/js/audio/sfxLimits.js | grep -c "'boss'"           # expect >= 1
curl -s http://localhost:15274/src/games/something2/WorldBossTestPanel.jsx | grep -c "BOSS_STAGE_ACTIONS"  # expect >= 1
```

- [ ] **Step 6: Install the audio hooks before the game builds its AudioEngine.** In Chrome DevTools MCP, open `http://127.0.0.1:15274/game-something2` with `isolatedContext`. If `new_page`/`navigate_page` accepts an `initScript`, pass the script below; otherwise run it with `evaluate_script` after the page loads and BEFORE clicking Play. AudioEngine is created in `initChunked`, which runs from the Play click (`Game.js:537-553`), and the Play click is the user gesture that resumes the AudioContext. (Headless Chrome outside MCP needs `--autoplay-policy=no-user-gesture-required` instead.)

```js
(() => {
  window.__s2 = { frames: [], bundle: null, starts: [], fetched: [] };
  const parse = JSON.parse;
  JSON.parse = function (...a) {
    const v = parse.apply(this, a);
    try {
      if (v && Array.isArray(v.sfx)) for (const ev of v.sfx) if (['spawn', 'phase', 'enrage'].includes(ev.e)) window.__s2.frames.push({ t: Date.now(), ...ev });
      if (v && v.bindings && v.world) window.__s2.bundle = v;
    } catch {}
    return v;
  };
  const start = AudioBufferSourceNode.prototype.start;
  const stop = AudioBufferSourceNode.prototype.stop;
  AudioBufferSourceNode.prototype.start = function (...a) {
    window.__s2.starts.push({ t: Date.now(), op: 'start', loop: this.loop, dur: this.buffer && this.buffer.duration });
    return start.apply(this, a);
  };
  AudioBufferSourceNode.prototype.stop = function (...a) {
    window.__s2.starts.push({ t: Date.now(), op: 'stop', loop: this.loop, when: a[0] });
    return stop.apply(this, a);
  };
  const f = window.fetch;
  window.fetch = function (u, ...r) { if (String(u).includes('/audio/')) window.__s2.fetched.push({ t: Date.now(), u: String(u) }); return f.call(this, u, ...r); };
})();
```

- [ ] **Step 7: Drive it.** Log in as the admin, pick `Vale Crossing` (it has the arena), and then:
  1. Click Play, then `evaluate_script` `await document.exitFullscreen().catch(() => {})`. The game auto-enters fullscreen, which hides windowed-layout defects. Confirm `window.__s2audio().state === 'running'`.
  2. **Audio tab** (admin): filter kind = Creatures, search `Ignis`. Expect 8 rows (`spawn/presence/phase/enrage` show `1 clip`). Search `Slime`: expect exactly 4 rows. Screenshot both. In the Entities tab, open Ignis: its Sounds section lists 8 slots, and Slime's lists 4.
  3. **Spawn.** Open the World Boss test panel, click **Spawn Ignis (Fire)**, then **Teleport to World Boss**. Expect `__s2.frames` to contain `{e:'spawn', c:'Ignis, the Magma Colossus'}`. (If you teleported after the spawn frame, you were not in the world yet. In that case use **Despawn**, teleport to the arena world first, then spawn. The spawn one-shot is then audible within 1600 px.) Expect `__s2.fetched` to contain the `s2-verify-spawn` clip's storage key (map the key through `__s2.bundle.bindings['creature/Ignis, the Magma Colossus/spawn']`).
  4. **Presence starts.** Next to the boss, `__s2audio().loops` holds `{ id: 'boss:<id>', priority: 'boss', distance < screenRadiusPx }`, `screenRadiusPx ≈ 1064`, and `__s2.starts` has a `start` with `loop: true`.
  5. **Presence stops at the screen edge.** Walk away. Dispatch movement keys with `evaluate_script` (for example `window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS' }))`, then a `keyup` after about 8 s). While walking, poll `__s2audio().loops` every 250 ms and record `[distance, present]` pairs. Pass: present while distance ≤ ~1064, absent on the first sample after it, and a `stop` with `loop: true` in `__s2.starts` whose `when` is about 2 s ahead (the fade). Walk back: the loop restarts (a new `start`, `loop: true`). The view is isometric, so world +y is not screen down. If `s` moves you toward the boss, use another key.
  6. **Phase.** Click **Trigger Next Phase**. Expect a `world_boss_phase` announcement on screen, `{e:'phase'}` in `__s2.frames`, and a non-loop `start` in `__s2.starts` right after it. Click it 3 more times: the 4th answers with an error toast/console line (`already in its last phase`).
  7. **Enrage.** Click **Trigger Enrage**. Expect a `world_boss_enrage` announcement, `{e:'enrage'}` in `__s2.frames`, and a non-loop `start`. A second click gets the error reply.
  8. **Death.** Click **Slay Boss**. Within one tick `__s2audio().loops` no longer has the `boss:` entry (it faded with a `stop`).
  9. **Demotion.** In the Entities tab, set a test boss's Boss tier to none and save. Use a boss you can restore, and record its original value. The Audio tab (no reload) drops its 4 boss rows. Restore the tier afterwards.
  10. **Console:** `list_console_messages` shows no `[audio] sfx event failed`, `nearby event failed` or `ReferenceError`.

  Record the evidence: screenshots (Audio tab Ignis vs Slime, panel with the new buttons, announcement), plus the JSON of `__s2.frames`, the `__s2.starts` excerpt and the distance/present samples from item 5.

- [ ] **Step 8: Tear down** (by PID file. Never `pkill -f "node src/index.js"`)

```bash
kill $(cat ../../s2-backend.pid) $(cat ../../s2-vite.pid); rm -f $WT/frontend/vite.verify.config.mjs
cd $WT && git status --short   # must show no stray files (no vite.verify config, no node_modules symlink staged)
git -C /home/markunn/worker/coding/jsgame/something2 ls-remote --heads origin feat/s2-boss-sounds   # must print nothing: never pushed
```

- [ ] **Step 9: Record the evidence** (backend and frontend exit codes, the baseline diff, the Step 7 artifacts) in a SOMET-605 Plane comment, and move the item to To Review. Re-check for migration collisions on current main: `git -C /home/markunn/worker/coding/jsgame/something2 ls-tree --name-only main backend/migrations/ | grep 1714440[67]` must show no file from this branch (S2 adds none).

---

## Self-Review

**Spec coverage (S2):**

| Spec item | Where |
|---|---|
| §3.6 creature (all): `nearby, attack, hurt, death`; boss_tier rows: + `spawn, presence, phase, enrage`; ordinary creatures never list boss slots | Task 1 (registry), Task 2 (every consumer), Task 9 (tab + entity Sounds) |
| §4.3 boss events `phase`, `enrage` on the existing creature event channel | Task 4 (`bossSfx` on the creature `sfx` channel, `spawn`), Task 5 (`phase`/`enrage`) |
| §4.4 screen radius = half the viewport diagonal in world units, per tick | Task 8 (`screenRadiusWorld`, `Game.update` → `setScreenRadius`) |
| §4.4 tiers `nearby < nearest < boss < own`; boss evicts nearby then nearest, never own | Task 6 |
| §4.4 `presence` loops while in screen radius, fades out on exit; `spawn/phase/enrage` one-shots at `boss` | Task 8, Task 7 |
| §5 Audio tab: boss slots on boss creature rows; prompt context includes element, tier | Task 9, Task 3 |
| §5 World Boss test panel: trigger phase / enrage | Task 5 (server), Task 10 (panel) |
| §7 S2: limiter eviction rules for `boss`; registry lists boss slots only for boss-tier rows | Task 6; Task 1 + Task 2 |
| §7 browser: exit fullscreen, fresh bundle, trigger via test panel, presence loop starting/stopping at screen edge | Task 11 |

**Decisions the spec did not make (flag for the spec owner):**

- **D1 Boss slots are upload-only.** The box has no cue for any of the four (`models_cache` lists slash/hit/pickup/spell/footstep/ui_click/miss/chest_open/death/waypoint). The cues are `null`, so `POST /admin/jobs` refuses them and `make audio-describe` skips them. S8 ("sounds for bosses") cannot *generate* them until the box gains cues, or until someone rules on a mapping (for example `spawn→spell`, `enrage→death`). Mapping is a one-line change in the `creature.cues` map.
- **D2 Enrage.** "Near the lifetime limit" is read as the last 60 s. Enrage is once per spawn, for world bosses only (only they have a lifetime). It carries audio, an announcement and an `enraged` status flag, with no stat change. A gameplay effect belongs to S6/S7 or the tuning follow-up.
- **D3 `own` may evict `boss`.** It does so last, after `nearby` and `nearest`, which follows from the `boss < own` order. `boss` vs `boss` competes on distance.
- **D4 Presence gain.** The loop plays at clip volume with no distance falloff ("the boss is on screen" bed). Pan tracks the boss each tick. Gain is not re-automated, because the fade-in ramp owns it.
- **D5 `spawn` is emitted by `addCreatures`**, for every boss tier. S9's dungeon bosses get a spawn sound on placement and respawn with no extra code. A lost-boss re-place passes `quietSpawn`.
- **D6 Demotion keeps bindings.** Clearing Boss tier hides the boss slots and refuses new binds, but leaves `audio_bindings` rows in place, and `worldAudioBundle` still ships them. They are harmless, because the client only plays boss slots for `bossTier` creatures, and re-promotion restores them.
- **D7 Phase thresholds unchanged.** `phase` fires on S1's live transitions (75/50/25 → 2/3/4, `worldBoss.js:355-359`). Spec §4.3 says 66%/33%. That change replaces the minion trigger and belongs to the skills slice, not S2.

**Placeholder scan:** no TBD/TODO, and no "similar to Task N". Every code step carries real code. Three steps ask the implementer to confirm a fixture assumption against the real file (`entity_types` NOT NULL columns, `storeClip` shape, login token field) before running. Those are verification steps, not gaps.

**Type consistency:** `BOSS_SLOTS` / `subjectSlotNames` / `slotNamesFor` / `slotsBySubject` (Task 1) are consumed in Task 2. `subjectSlots` on the wire (Task 2) is consumed by `slotEntriesFor` (Task 9). `bossSfx` (Task 4) is consumed by `worldBoss._emitBossSfx` (Task 5). The wire `e` values `spawn|phase|enrage` (Task 4) match `sfxChains`/`sfxPriority` (Task 7) and the browser hooks (Task 11). The tier string `'boss'` is set by `sfxPriority` (Task 7) and by `_startNearbyLoop` (Task 8), and handled in `_evictionTarget` (Task 6). The debug actions `phase|enrage` (Task 5) match `BOSS_STAGE_ACTIONS` (Task 10).
