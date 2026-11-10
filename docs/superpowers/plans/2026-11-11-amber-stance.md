# Amber Stance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seal every arriving character (portal, map crossing, login, respawn) in amber: they can't act and can't be harmed until 10 s after their game has finished drawing, 30 s at most, or until they break out once ready. A countdown shows above their head, and the art comes in 10 randomly picked sprite variants.

**Architecture:**
- **One pure module, `backend/src/authority/amber.js`,** owns the seal state on the player object (`p.amber`) and every rule about it. The World and the other authority modules only ask `isSealed(p, now)`.
- **Harm is blocked at its choke points:** `applyDamage`, the harmful effect appliers, knockback, creature target selection, and projectile hits. A sealed player is untargetable, not "hit for zero".
- **The art** is a new `status_visuals` table with a `status` effect kind, drawn through the existing effect-sprite pipeline.
- **The client** reports ready and break, holds its own input while sealed, and draws the overlay: an approved sprite, or a code-drawn fallback.

**Tech Stack:** Node (CommonJS, raw `pg`, node:test), node-pg-migrate, React + canvas client (ESM, vitest).

**Spec:** `docs/superpowers/specs/2026-11-10-amber-stance-design.md`. Read it; it's the authority.

## Global Constraints

- **Triggers:** a portal, crossing to another map, login, and respawn after death. Each of these runs `World.addPlayer` (every cross-world move is a reconnect and join) or `World.resolveDeaths` (same-world respawn).
- **End time:** `endAt = min(startedAt + maxMs, readyAt + afterReadyMs)`.
  - Defaults are `amber_max_seconds` = 30 and `amber_after_ready_seconds` = 10, both `game_settings` keys.
  - Settings are read at sealing time.
- **Early break:** honoured only after ready, and only for the current arrival id. A break, or a ready, carrying another arrival id is ignored. A second ready is ignored too.
- **Protection ends the same tick the amber does.**
- **While sealed:**
  - no movement, attack, skill or special cast, and no world-object use (interact, open chest, travel, teleport cast, buy, sell, bank);
  - chat, inventory, equip, item use from inventory, trade and party all still work;
  - a teleport cast in progress at sealing time is cancelled.
- **Harm blocked while sealed:**
  - all damage from others;
  - harmful statuses: slow, root, stun, silence, fear, charm, shock interrupt, element riders and hit statuses;
  - knockback and shoves;
  - portal and edge triggers don't fire;
  - creatures don't target them and drop them as a target;
  - projectiles pass through without hitting or being used up.
- **Help still lands:** heals and buffs from others still apply.
- **New seal on every trigger,** even while already sealed: new arrival id, new timer, new variant.
- **Variant:**
  - picked by the server at sealing time, uniformly at random from the variants with an approved sprite;
  - `null` when none is approved, in which case the client draws the code fallback.
- **Countdown number:** `ceil(endsInMs / 1000)`. Every client sees the server's number.
- **The end fades out** over ~0.4 s, client-side only. No crack or shatter.
- **Art:**
  - 10 rows, `amber_stance_1` … `amber_stance_10`, in table `status_visuals`, effect kind `status`, Sprite tab group "Status visuals";
  - nothing is auto-approved;
  - the table goes in seed/export, so add it to `backend/seeds/sync/art.json`;
  - the migration freezes its seed (no application requires).
- **Tests never touch the shared dev DB:**
  - DB tests run against a private test DB (`TEST_DATABASE_URL`, a template database on a private container);
  - never `testdb.js`, never the full suite against dev.
- Never `pkill -f` / `pgrep -f`; headless Chrome always `--mute-audio`.

## Review Focus

1. **A damage-over-time or aura tick started before the seal** (a burn applied the moment before a portal, or standing in a boss aura on respawn) must deal 0 to a sealed player. Covered in Task 3 ("dot and aura ticks deal nothing").
2. **A late ready from the previous map** arrives after a new join and must not shorten the new seal. Covered in Task 1 ("stale arrival id ignored") and Task 2 ("ready for an old arrival after rejoin").
3. **Client prediction while sealed:** if the client keeps predicting movement from held keys, the player rubber-bands. The client must send no move input until ready, and the first move input after ready is the break. Covered in Task 5 ("held key during load does not break or move").
4. **A variant that loses its approved sprite** (a re-render) after the server picked it must draw the code fallback, never a broken image. Covered in Task 5 ("unknown or spriteless variant draws fallback").
5. **A druid pet or charmed creature whose owner is sealed** must not despawn or go wild. Sealing hides the owner from hostile targeting only, never from owner lookups. Covered in Task 3 ("sealed owner keeps pet").

---

### Task 1: The amber rules module

**Files:**
- Create: `backend/src/authority/amber.js`
- Test: `backend/tests/amber.test.js`

**Interfaces:**
- Produces:
  - `setAmberConfig({ maxMs: number, afterReadyMs: number, variants: number[] }) -> void`. This is module-level config, replaced whole. The default `{ maxMs: 30000, afterReadyMs: 10000, variants: [] }` applies until it's first called.
  - `getAmberConfig() -> { maxMs, afterReadyMs, variants }`.
  - `seal(p, now, rng = Math.random) -> void`: sets `p.amber = { arrival, startedAt: now, hardEndAt: now + maxMs, endAt: now + maxMs, readyAt: null, variant }`.
    - `arrival` is a module-wide increasing integer, so it never repeats within a process.
    - `variant` is `variants[floor(rng() * variants.length)]`, or `null` if `variants` is empty.
  - `markReady(p, arrival, now) -> boolean`: true when the call was applied.
  - `breakOut(p, arrival, now) -> boolean`: applies only after ready, for the current arrival. Ends the seal by setting `p.amber = null`.
  - `isSealed(p, now) -> boolean`: true while `p.amber` exists and `now < endAt`.
  - `expire(p, now) -> boolean`: clears `p.amber` once `now >= endAt`. Returns true when it cleared.
  - `amberView(p, now) -> { a: arrival, ms: endsInMs, v: variant } | null`: the snapshot shape.

- [ ] **Step 1: Write the failing tests** in `backend/tests/amber.test.js` (node:test, `assert/strict`). Each test calls `setAmberConfig` with explicit values first:
  - `seal starts a 30 s hard cap`: with config 30000/10000, `seal(p, 1000)` gives `isSealed(p, 30999) === true` and `isSealed(p, 31000) === false`.
  - `ready shortens to 10 s after ready`: `seal(p, 0)`, then `markReady(p, p.amber.arrival, 5000)` returns true, `p.amber.endAt === 15000`, and `amberView(p, 6000).ms === 9000`.
  - `ready never extends past the hard cap`: `seal(p, 0)`, then `markReady(p, a, 25000)` gives `endAt === 30000`.
  - `second ready ignored`: the second `markReady` returns false and `endAt` is unchanged.
  - `stale arrival id ignored`: `seal(p, 0)` gives `a1`; `seal(p, 100)` gives `a2 !== a1`; `markReady(p, a1, 200)` returns false and `p.amber.readyAt === null`.
  - `break before ready refused`: `breakOut(p, a, 100)` returns false and `isSealed(p, 100)` is true.
  - `break after ready ends at once`: after `markReady`, `breakOut` returns true, `p.amber === null`, and `isSealed(p, now) === false`.
  - `variant drawn from approved list`:
    - with `variants: [2, 5, 9]` and `rng = () => 0.5`, `p.amber.variant === 5`;
    - with `variants: []`, `variant === null`;
    - with `rng = () => 0.999`, the result is `9`, never out of range.
  - `expire clears once due`: `expire(p, endAt - 1) === false`, then `expire(p, endAt) === true` and `p.amber === null`.
  - `unsealed player`: `isSealed({}, 0) === false` and `amberView({}, 0) === null`.

- [ ] **Step 2: Run them and see them fail.**
  Run `cd backend && node --test tests/amber.test.js`.
  Expected: FAIL, `Cannot find module '../src/authority/amber.js'`.

- [ ] **Step 3: Implement `amber.js`** with the interfaces above. It's pure: no I/O and no requires beyond Node built-ins.

- [ ] **Step 4: Run the tests again.** Same command. Expected: all pass.

- [ ] **Step 5: Commit.**
  `git add backend/src/authority/amber.js backend/tests/amber.test.js && git commit -m "feat(amber): seal rules module"`

### Task 2: World integration (triggers, lockout, expiry, snapshot, messages, settings)

**Files:**
- Modify: `backend/src/authority/world.js`:
  - `addPlayer` (~501): seal after the player object is built;
  - `resolveDeaths` (~2233): seal after the respawn snap, next to `p.effects.clear()`;
  - `tick` (~728): `expire` each player;
  - `setInput` (~680), `canAttack` (~1248), `attack` (~1341), `castSkill` (~1753), `_castSpecial` (~1039): refuse while sealed;
  - `snapshot` (~2301): add `amber`.
  - New methods: `amberReady(userId, arrival)` and `amberBreak(userId, arrival)`.
- Modify: `backend/src/authority/server.js`:
  - message handlers for `amberReady` and `amberBreak`;
  - refuse world-object use while sealed: `interact`, `openchest`, `travel`, `teleportCast`, `buy`, `sell`, `openbank`, `deposit`, `withdraw`;
  - skip portal and doorway/edge triggers for a sealed player;
  - cancel an in-flight teleport cast when sealing on arrival;
  - refresh the amber config at boot and every 30 s.
- Modify: `backend/src/services/gameSettings.js`: add `amber_max_seconds: 30` and `amber_after_ready_seconds: 10` to `DEFAULTS`, with validation.
- Test: `backend/tests/world_amber.test.js` (no DB), `backend/tests/game_settings.test.js` (new, pure `assertValid`/`DEFAULTS` checks; `game_settings_db.test.js` already exists for the DB side and stays as is).

**Interfaces:**
- Consumes: Task 1's `seal`, `markReady`, `breakOut`, `isSealed`, `expire`, `amberView`, `setAmberConfig`.
- Produces:
  - **Snapshot:** each player gets `amber: { a, ms, v }` while sealed, and the key is omitted otherwise.
  - **Client→server frames:** `{ type: 'amberReady', arrival }` and `{ type: 'amberBreak', arrival }`.
  - **Refusals:** an attack or skill refused while sealed answers through the existing refusal frames with reason `'amber'`.
  - **`refreshAmberConfig(pool) -> Promise<void>`** in server.js. It reads both settings and the approved variants (`SELECT variant FROM status_visuals WHERE status_key = 'amber_stance' AND sprite_image IS NOT NULL ORDER BY variant`), then calls `setAmberConfig({ maxMs: s * 1000, afterReadyMs: r * 1000, variants })`.
    - It tolerates a missing `status_visuals` table (catch and keep `variants: []`), so this task runs before Task 4's migration.

- [ ] **Step 1: Write the failing World tests** in `backend/tests/world_amber.test.js`. Build a bare `World` the way the existing world tests do (see `backend/tests/world_buff_snapshot.test.js`), with fixed `world.now` values.
  - `join seals`: after `addPlayer`, `world.snapshot().players[0].amber.ms === 30000`.
  - `respawn seals`: set `p.hp = 0`, call `resolveDeaths()`, and `p.amber` exists with `startedAt === world.now`.
  - `sealed player does not move`: two `setInput` calls with `dx = 1` plus `tick`, and `p.x` is unchanged.
  - `sealed player cannot attack or cast`:
    - `canAttack(userId) === false`;
    - `attack(...)` yields no swing or projectile;
    - `castSkill(...)` is refused with reason `'amber'`.
  - `expires on tick`: advance `world.now` past `endAt`, `tick`, and the snapshot has no `amber` key. The player can then move.
  - `ready then break`: `amberReady(uid, a)`, then `amberBreak(uid, a)`, and `p.amber === null` in the same call.
  - `break before ready refused`: `amberBreak` before ready leaves the player sealed.
  - `ready for an old arrival after rejoin`: `removePlayer`, then `addPlayer` again (a new arrival), then `amberReady(uid, oldArrival)` returns false, and the new seal's `readyAt` stays null.
  - `snapshot omits amber when not sealed`: `'amber' in snapshotPlayer === false`.

- [ ] **Step 2: Write the failing settings tests:**
  - `assertValid('amber_max_seconds', 30)` passes;
  - `assertValid('amber_max_seconds', 0)` throws (minimum 1);
  - `assertValid('amber_after_ready_seconds', 0)` passes (0 is allowed: ready ends the seal at once);
  - a non-integer or a value over 300 throws for both keys;
  - `DEFAULTS.amber_max_seconds === 30` and `DEFAULTS.amber_after_ready_seconds === 10`.

- [ ] **Step 3: Run the tests and see them fail.**
  Run `cd backend && node --test tests/world_amber.test.js tests/game_settings.test.js`. Expected: FAIL.

- [ ] **Step 4: Implement the World and settings changes.**
  - Seal in `addPlayer` and in `resolveDeaths`. Don't seal in the Blood Rebirth `revive` branch: that isn't a death.
  - In `tick`, call `expire` for every player before processing inputs.

- [ ] **Step 5: Implement the server.js changes:**
  - Find the message `switch` that handles `attack` and `interact`. Add `amberReady` and `amberBreak`, each calling the World method with `Number(msg.arrival)`.
  - Guard each listed world-object handler with `isSealed(p, world.now)`, returning a refusal and no state change. Use the handler's existing refusal frame.
  - Skip the portal and doorway trigger checks in the tick for a sealed player, in the code that sends `transition` around ~4045.
  - Cancel teleport casting through the existing cancel path (`teleportCast.js`).
  - Call `refreshAmberConfig(pool)` once before the authority starts accepting joins, then on a 30 s `setInterval` cleared with the server's other timers.

- [ ] **Step 6: Run the new tests and the neighbours.**
  Run `cd backend && node --test tests/world_amber.test.js tests/game_settings.test.js tests/world_buff_snapshot.test.js tests/authority_damage.test.js`.
  Expected: all pass.

- [ ] **Step 7: Commit.**
  `git commit -m "feat(amber): seal on join and respawn, lock actions, ready/break frames, settings"`

### Task 3: Harm guards (untargetable everywhere)

**Files:**
- Modify: `backend/src/authority/damage.js`: `applyDamage` and `applyDamageWithEffects` return 0 and change nothing (no hp, no provoke, no shield) when `target.userId != null && isSealed(target, now)`.
- Modify: `backend/src/authority/effects.js`: the harmful appliers return without effect on a sealed player.
  - The appliers are `applyStun`, `applySlow`, `applyRoot`, `applySilence`, `applyFear`, `applyCharm`, `applyShockInterrupt`, `applyElementEffect`, `stampRider` and `applyHitStatuses`.
  - `tickEffects` DoT damage goes through `applyDamage`, so it's covered there. Verify that in a test.
- Modify: `backend/src/authority/knockback.js`: `shoveAwayFrom` doesn't move a sealed player.
- Modify: `backend/src/authority/world.js`: `canHurtPlayer(attackerId, targetId)` returns false when the target is sealed. This covers player melee, `_skillHitPlayers`, traps and waves.
- Modify: `backend/src/authority/creatures.js`: in `CreatureSim.tick`, build `hostileTargets = players.filter((p) => !isSealed(p, now))` once per tick.
  - Use it in the aggro loop (~2691), skill area, shelter, line and chain loops (~3170–3390), hazards (`_tickHazards`), `chargeAuraDots`, and the aura-debuff stamping (~2241).
  - A creature whose `_target` is a sealed player drops it.
  - Pet, charm-owner and guard-rescue lookups keep the full `players` list.
- Modify: `backend/src/authority/projectiles.js`: the player hit loops (~427 detonate, ~588 step) skip a sealed player. The projectile flies on with its pierce unchanged.
- Test: `backend/tests/amber_harm.test.js`.

**Interfaces:**
- Consumes: `isSealed(p, now)` from Task 1. A test seals a player with `seal(p, now)` directly.
- Produces: nothing new. Behaviour only.

- [ ] **Step 1: Write the failing tests** in `backend/tests/amber_harm.test.js`. Every test pairs a sealed player with an unsealed control player in the same spot, so a passing test can't come from the attack simply missing:
  - `applyDamage on sealed deals nothing`: the return is 0 and hp is unchanged; the control loses hp.
  - `dot and aura ticks deal nothing`:
    - apply a burn DoT to both, then seal one; after `tickEffects` for 2 s, the sealed hp is unchanged and the control's dropped;
    - put a creature aura debuff on both through `chargeAuraDots`; the same holds.
  - `harmful statuses do not land`: after `applyStun`, `applySlow` and `applyCharm`, the sealed player shows no active key, and the control shows each one.
  - `heals and buffs still land`: a heal raises the sealed player's hp; a buff from a party member is applied.
  - `knockback does not move sealed`: after `shoveAwayFrom`, the sealed position is unchanged and the control moved.
  - `creature ignores sealed in aggro`: a hostile creature within aggro radius of only the sealed player has no target after one `tick`. Once the player is unsealed, it targets them on the next tick.
  - `creature drops a sealed target`: a creature with `_target` set to the player, after sealing and one tick, has `_target == null`.
  - `boss area skill skips sealed`: an area skill covering both damages only the control, and there's no impact entry for the sealed player.
  - `projectile passes through`: a creature projectile aimed through the sealed player at the control damages only the control.
  - `pvp skips sealed`: `canHurtPlayer(a, sealedB) === false`, while a player melee swing hits the control.
  - `sealed owner keeps pet`: a druid pet or charmed creature whose owner is sealed still exists after `tick`, with its owner unchanged.

- [ ] **Step 2: Run them and see them fail.**
  Run `cd backend && node --test tests/amber_harm.test.js`. Expected: FAIL.

- [ ] **Step 3: Implement the guards listed under Files.**
  - Audit every `hp -=` / `hp =` write in `backend/src/authority/`.
  - Any write that can lower another player's hp without going through `applyDamage` gets the same guard.
  - List each one in the task report, including the self-cost writes you left alone because sealed players can't cast.

- [ ] **Step 4: Run the harm tests and the existing authority tests.**
  Run `cd backend && node --test tests/amber_harm.test.js tests/authority_damage.test.js tests/world_amber.test.js`, plus every `tests/*creature*`, `tests/*projectile*` and `tests/*knockback*` file (use `ls`).
  Expected: all pass, with no change to existing assertions.

- [ ] **Step 5: Commit.**
  `git commit -m "feat(amber): sealed players are untargetable and unharmed"`

### Task 4: Status visuals table, effect kind, Sprite tab rows, seed/export

**Files:**
- Create: `backend/migrations/1714440885000_status_visuals.js`.
  - Table `status_visuals(status_key text, variant int, sprite_image text NULL, sprite_frames int NOT NULL DEFAULT 1, sprite_additive boolean NOT NULL DEFAULT false, sprite_fps int NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (status_key, variant))`.
  - Frozen seed: `('amber_stance', 1..10)`.
  - Widen the `effect_sprite_jobs` subject_kind CHECK and the `sprite_prompt_optins` CHECK to include `'status'`. Copy how `1714440883000_buff_visuals.js` and `1714440884000_buff_prompt_optins.js` do it.
  - `down` reverses all of it.
  - Before committing, check that no other branch already uses `1714440885000` (`ls backend/migrations`, `git log --all --oneline -- backend/migrations | head`).
- Create: `backend/src/services/statusVisuals.js`:
  - `listStatusVisuals(pool) -> Promise<Array<{ key: string, status_key: string, variant: number, sprite_image, sprite_frames, sprite_additive, sprite_fps }>>`;
  - `key` is `` `${status_key}_${variant}` `` (`amber_stance_3`), the subject key the Sprite tab uses.
- Create: `backend/src/api/statusVisualsRoutes.js`: public `GET /api/status-visuals` returns `listStatusVisuals`. Mount it next to `/api/buff-visuals` in `backend/src/index.js`.
- Modify:
  - `backend/src/services/effectKinds.js`: add `status: { table: 'status_visuals', keyCol: <composite; see step 3>, updatedAt: true, boxKind: 'shell' if the box lists it, else 'aura', spriteCols: LOOPING_SPRITE_COLS }`;
  - `backend/src/services/effectCatalog.js`: a "Status visuals" group with the 10 rows;
  - `backend/src/services/spritePrompts.js`: the amber prompt and its per-variant variations (shade, cracks, smoke density);
  - `backend/src/services/seedSync/registry.js`, `backend/src/services/boardSeedGroups.js` and `backend/src/services/seedSync/coverage.js`: add the `status_visuals` slice to the Art group;
  - `backend/seeds/sync/art.json`: add the checked-in slice;
  - `backend/seeds/sync/status_visuals.json`: create it, mirroring `buff_visuals.json`.
- Test:
  - `backend/tests/status_visuals.test.js` (pure: kind registry, catalog group, prompt);
  - `backend/tests/status_visuals_api_db.test.js` (private DB);
  - `backend/tests/migration_status_visuals_db.test.js` (private DB);
  - the existing `backend/tests/seed_sync_checked_in_files.test.js` must pass.

**Interfaces:**
- Consumes: the effect-sprite pipeline's kind registry (`kindOf`, `alwaysLoops`) and the approve path that writes `spriteCols`.
- Produces:
  - rows with subject key `amber_stance_<n>`;
  - the `/api/status-visuals` response, used by Task 5;
  - the approved-variant query in Task 2 reads this table.

- [ ] **Step 1: Write the failing tests:**
  - `kindOf('status').table === 'status_visuals'` and `alwaysLoops('status') === true`;
  - the catalog has a group named `"Status visuals"` with exactly the keys `amber_stance_1`…`amber_stance_10`, and that group is selected by select-all;
  - the prompt for `amber_stance_3` mentions amber, a figure-sized translucent block and smoke at the base, and differs from `amber_stance_4`'s prompt;
  - DB: after migrating up, 10 rows exist with `sprite_image IS NULL`, and `effect_sprite_jobs` accepts `subject_kind = 'status'`; `down` then `up` round-trips;
  - DB: `GET /api/status-visuals` returns 10 entries ordered by variant;
  - an approve for `amber_stance_2` writes the sprite columns on `(amber_stance, 2)` only;
  - seed sync: `seed_sync_checked_in_files.test.js` passes with the new slice.
    - Snapshot and restore any rows you write with `backend/tests/helpers/rowSnapshot.js`.

- [ ] **Step 2: Run them and see them fail.**
  Run `cd backend && TEST_DATABASE_URL=<private template db> node --test tests/status_visuals*.test.js tests/migration_status_visuals_db.test.js tests/seed_sync_checked_in_files.test.js`.
  Expected: FAIL.

- [ ] **Step 3: Implement.** `effectKinds` assumes a single key column.
  - **Ruling:** keep one key column by adding a generated column `subject_key text GENERATED ALWAYS AS (status_key || '_' || variant) STORED UNIQUE` to `status_visuals`, and use `keyCol: 'subject_key'`. Every existing key lookup stays unchanged.
  - Check the box kinds with `GET http://192.168.0.218:8001/api/kinds`, or whatever kind listing the box client already uses (`backend/src/services/` box client). Read-only. Use `shell` if it's listed, otherwise `aura`, and record which one in the report.

- [ ] **Step 4: Run the tests again.** Same command. Expected: PASS.

- [ ] **Step 5: Commit.**
  `git commit -m "feat(amber): status_visuals table, status effect kind, Sprite tab rows, seed/export"`

### Task 5: Client: ready, break, input hold, overlay, countdown, fade

**Files:**
- Create: `frontend/src/games/something2/src/js/core/amber.js`. Pure functions:
  - `countdownText(ms) -> string`: `String(Math.ceil(ms / 1000))`;
  - `fadeAlpha(msSinceEnd) -> number`: 1 → 0 linearly over `AMBER_FADE_MS = 400`;
  - `amberSheetFor(variant, statusVisualsByKey) -> sheet | null`: `null` when the variant is null, unknown, or has no `sprite_image`;
  - `shouldBreak({ amber, ready, input }) -> boolean`: true only when sealed, ready has been sent for the current arrival, and the input is a move, an attack, a skill key or a ground click.
- Modify: `frontend/src/games/something2/src/js/net/WorldAuthorityClient.js`: add `sendAmberReady(arrival)` and `sendAmberBreak(arrival)`.
- Modify: `frontend/src/games/something2/src/js/core/Game.js`:
  - track the own player's `amber` from each state frame;
  - send ready once per arrival, when the readiness condition first holds;
  - while sealed, send no move or attack input and don't predict movement;
  - when sealed and ready, the first move, attack, skill or ground-click input sends `amberBreak` instead of acting;
  - load `/api/status-visuals` the way `useBuffVisuals` and `setBuffVisuals` load buff visuals.
- **Readiness condition:** every one of these holds:
  - the join was answered;
  - the first `state` frame has arrived;
  - the chunk streamer reports the chunks around the player loaded;
  - asset preload is done;
  - one frame has been drawn after all of the above.
  The implementer finds the existing signals for each and names them in the report.
- Modify: `frontend/src/games/something2/src/js/systems/RenderSystem.js`:
  - after drawing a player's body, draw the amber overlay: the approved sheet, or the code fallback (a rounded translucent amber block with 3–5 drifting smoke puffs at the base);
  - draw the countdown above the head, above the name or hp bar;
  - keep the fade going for 400 ms after `amber` disappears from that player's snapshot;
  - no per-frame allocations: cache the sheet per variant, as the buff sheets do.
- Test:
  - `frontend/src/games/something2/src/js/core/__tests__/amber.test.js`;
  - `frontend/src/games/something2/src/js/core/__tests__/gameAmber.test.js` (Game input gating, with a fake client).

**Interfaces:**
- Consumes:
  - the snapshot `amber: { a, ms, v }` and the frames `amberReady` / `amberBreak` from Task 2;
  - the `/api/status-visuals` entries `{ key, variant, sprite_image, sprite_frames, sprite_additive, sprite_fps }` from Task 4.
- Produces: nothing for later tasks.

- [ ] **Step 1: Write the failing tests:**
  - `countdownText(9001) === '10'`, `countdownText(1) === '1'`, `countdownText(0) === '0'`;
  - `fadeAlpha(0) === 1`, `fadeAlpha(200) === 0.5`, `fadeAlpha(400) === 0`, `fadeAlpha(1000) === 0`;
  - `unknown or spriteless variant draws fallback`: `amberSheetFor` returns null for `v: null`, for a `v` that isn't in the list, and for a row with `sprite_image: null`;
  - `held key during load does not break or move`: with the Game sealed and not ready, a held move key sends no `input` frame and no `amberBreak`, and the predicted position is unchanged;
  - `first input after ready breaks once`: after ready is sent, a move key press sends exactly one `amberBreak` with the current arrival. No `input` frame is sent until the next state frame without `amber`.
  - `ready sent once per arrival`: two state frames with the same arrival send one `amberReady`; a new arrival id sends a second one;
  - `interaction keys do not break`: opening the inventory or chat while sealed sends no `amberBreak`.

- [ ] **Step 2: Run them and see them fail.**
  Run `cd frontend && npx vitest run src/games/something2/src/js/core/__tests__/amber.test.js src/games/something2/src/js/core/__tests__/gameAmber.test.js`.
  Expected: FAIL.

- [ ] **Step 3: Implement** the Files list above.

- [ ] **Step 4: Run the tests again.** Same command, plus `npx vitest run src/games/something2/src/js/core/__tests__/buffAuras.test.js`. Expected: PASS.

- [ ] **Step 5: Commit.**
  `git commit -m "feat(amber): client ready/break, input hold, amber overlay with countdown and fade"`

### Task 6: Live check on a private stack, and queue the art

**Files:** none. Verification only. Record the evidence in the ledger.

- [ ] **Step 1: Bring up a private stack.**
  - A private Postgres and MinIO, backend on 13201, vite on 15273, and muted headless Chrome on 29222. Follow the memory note "dev-run-browser-verify".
  - Don't use the shared dev DB.
- [ ] **Step 2: Check one client.**
  - On login, a code-drawn amber block and a countdown starting near 30 appear.
  - After loading, the countdown drops to ≤10.
  - A move key breaks the seal and the amber fades.
  - Take screenshots of each.
- [ ] **Step 3: Check two clients.**
  - Client B walks through a portal next to client A, a hostile creature and an attack-ready client A.
  - B takes no damage while sealed, A sees B's countdown, and the creature only engages after B's seal ends.
- [ ] **Step 4: Check respawn.** Kill B (admin hp tool on the private stack). B respawns sealed.
- [ ] **Step 5: Leave the art for the owner.**
  - Report that the 10 `amber_stance_*` rows are in the Sprite tab under "Status visuals", ready to queue.
  - Queuing them on the real box and approving them is the owner's call.
  - Don't queue box jobs from this task.
