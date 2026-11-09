# Sprite Tab: Effects as Rows + Prompt Regeneration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The 21 batch-1 effects become rows of the main Sprite table (one Queue, one estimate, one preview/approve), and a "Regenerate prompt" option lets the box's big text model rewrite creature, hero-appearance and effect prompts before drawing. A regenerated creature draws a fresh concept that is kept and reused, and the approved art is never replaced.

**Architecture:**
- Prompts are versions in `art_prompt_descriptions`, the table the art console already uses.
  - Kinds: `entity`, `character_appearance`, and new `vfx` / `aura`.
  - A new `origin = 'sprite'` marks a version written from the Sprite tab. The sprite lane uses an entity/appearance description only when that subject has EVER had a version with origin 'sprite' (it was opted in from the Sprite tab); once opted in, it follows the subject's ACTIVE description whichever tool wrote it (owner: one shared description, same mechanism as the art console's regenerate). This is how the 17 creatures that already have art-console descriptions (never touched from the Sprite tab) keep today's prompt. [Controller ruling 2026-11-09, overrides the planner's 'active version must have origin sprite'.]
- Rows queued with `needs_prompt` get their prompt written by a **prompt phase** inside each dispatcher (`spriteDispatcher` and `effectDispatcher`). All pending prompts are written before any image. Busy and card-held answers are waited out with the art drain's held-wait rule; past the limit the row fails with "text model busy".
- `sprite_sets.regenerate_concept` makes `submit()` draw a fresh concept from `base_prompt` instead of uploading approved art. The kept-concept store records it as `regenerated` with its prompt. Later jobs prefer it, and the drop-on-art-mismatch rule exempts it.
- The UI merges the `/effects` list into the creature subjects as rows of shape `effect`. One Queue click splits into `POST /jobs` and `POST /effects/jobs`. `EffectSpritesSection` is deleted.

**Tech Stack:** Node/Express (CommonJS, raw `pg`, node-pg-migrate), `node --test`; React + TanStack Query + vitest (node env, `renderToString`); GPU box `/api/text` via `textProvider.complete`.

**Spec:** `docs/superpowers/specs/2026-11-09-sprite-tab-effects-and-prompt-regen-design.md` (owner-approved, incl. the §2.4 owner decisions). Style reference: `docs/superpowers/plans/2026-11-09-effect-sprites.md`.

## Global Constraints

- **Workspace:** work in your own git worktree (`superpowers:using-git-worktrees`). Never `checkout`/`stash`/`branch` in the shared checkout at the repo root; other sessions use it.
- **DB tests** run only on a private DB: `cd backend && DATABASE_URL=<private container url> node scripts/testdb.js run --keep -- tests/<file>`. **If `TEST_DATABASE_URL` is unset, tests hit the SHARED dev DB.** Never run destructive SQL against the shared dev DB. Put this sentence in every subagent prompt.
- **Never `pkill -f` / `pgrep -f`.** Kill only a PID you have checked (`ss -ltnpH "sport = :PORT"` + `/proc/PID/cwd`).
- **No GPU or text-model traffic** (`/api/text`, `/api/vfx`, `/api/jobs` POST, `/sdapi`, generate_core) except in Task 10. Tests use a fake `describer`, fake `fetchImpl` or fake box. Read-only GETs (`/api/jobs`, `/api/model-gateway`) are fine. Never touch the GPU box at 192.168.0.218.
- **Browser checks:** muted headless Chrome only (`--mute-audio`), on a free CDP port (check `ss` first).
- **Creature behaviour is unchanged unless Regenerate or a Sprite-tab edit was used.** With neither, a sprite row's `base_prompt` is `entity_types.prompt || name` (or `appearancePrompt`), and `submit()` takes today's kept-concept → approved-art → `generateConcept` path. In particular, the 17 creatures with existing active `entity` descriptions (origin NULL) keep today's sprite prompt.
- **Effect prompts are subject only.** No style, background or scene words reach `/api/vfx` (spec §3, §4).
- **Approved art is never replaced** by a regenerated concept (owner decision §2.4). `entity_types.image` and `character_appearances.image` are never written by this work.
- **Migrations:** the latest on origin/main today is `1714440880000_effect_sprites.js`, so the next free number is `1714440881000`. Run `git fetch && git ls-tree --name-only origin/main backend/migrations/ | sed 's#.*/##' | sort -n | tail -3` before creating the migration, and again right before merge. Don't edit a migration while any dev backend is up: nodemon auto-applies it.
- **Placeholder ETA** constants are labelled `// PLACEHOLDER` in code and "(estimate, not yet measured)" in the UI until Task 10 replaces them.
- **Commit message attribution line:** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Re-queue with Regenerate on a row that is already queued** (possibly a rescued row still holding a box job). `enqueue`'s UPDATE path (spriteJobQueue.js 128-163) today never touches `base_prompt`. It must also take `base_prompt`, `needs_prompt` and `regenerate_concept`, and detach the box job, or the re-queue silently draws the old prompt. Test: Task 4.
2. **Stop or Halt pressed while the prompt phase waits on a busy text model.** The row stays `queued` with `needs_prompt`. It is never failed, never claimed, and never drawn with the stale prompt. Test: Task 4 (sprite) and Task 5 (effect).
3. **The box restarted and no longer has the regenerated concept.** Today the unavailable branch removes the kept concept and uploads the approved art, which is a silent revert. Instead, re-upload the regenerated concept's stored bytes. If those bytes are gone, draw a fresh concept from `base_prompt`. Never fall back to the approved art. Test: Task 4.
4. **A prompt edit that is blank or over 400 characters.** `artPromptDescriptions.replace` silently slices at `MAX_TEXT` (400). The Sprite tab must answer 400 with `prompt must be 1-400 characters`, never store a truncated prompt. Test: Task 3 (store) and Task 6 (route).
5. **An effects-only selection mixing a bolt, a burst and an aura, with Loop or One-shot picked.** Bursts stay one-shot and auras keep looping. No request ever carries `loop: true` for a burst (the box answers 422). Test: Task 7 (payload) and Task 5 (server refusal / aura forcing).

---

### Task 1: Schema and storage fields

**Files:**
- Create: `backend/migrations/1714440881000_sprite_prompt_regen.js`. Re-check the number per Global Constraints.
- Modify:
  - `backend/src/services/spriteConcepts.js:15-31` (`upsertKept`);
  - `backend/src/services/artPromptDescriptions.js`: `getActive` (14-23), `listAll` (28-37), `listActive` (44-53) and `replace` (61-93).
- Test:
  - `backend/tests/migration_sprite_prompt_regen_db.test.js` (new);
  - `backend/tests/sprite_concepts_db.test.js`;
  - `backend/tests/art_prompt_descriptions_db.test.js`;
  - `backend/tests/seed_sync_coverage_db.test.js` (existing, must stay green).

**Interfaces:**
- Migration `up`:
  - `sprite_sets`: `regenerate_concept boolean NOT NULL DEFAULT false`, `needs_prompt boolean NOT NULL DEFAULT false`;
  - `effect_sprite_jobs`: `needs_prompt boolean NOT NULL DEFAULT false`;
  - `sprite_concepts`:
    - `regenerated boolean NOT NULL DEFAULT false`: the concept was drawn from a regenerated or Sprite-tab prompt, not from the approved art;
    - `prompt text NULL`: the `base_prompt` it was drawn from;
  - `art_prompt_descriptions`: `origin text NULL` with CHECK `origin IS NULL OR origin = 'sprite'`;
  - `down` drops all six columns.
- `upsertKept(db, { entityTypeId, variant, conceptKey, boxConceptPath, providerId, boxOrigin, regenerated = false, prompt = null })`. ON CONFLICT also sets `regenerated` and `prompt` from EXCLUDED. `getKept` already does `SELECT *`.
- `replace(db, kind, key, { text, length, model, sourcePrompt, origin = null })`:
  - throws `Error('origin must be null or "sprite"')` for any other origin;
  - the INSERT stores `origin`.
- `getActive`, `listAll` and `listActive` also select `origin`.
- Coverage: the three machine-local tables are already in `coverage.js` `EXCLUDED` (lines 18, 19, 21), so their new columns need nothing. `art_prompt_descriptions.origin` is exported automatically: `registry.js` reads its columns from `information_schema`.

- [ ] **Step 1: Write the failing tests:**
  - `migration_sprite_prompt_regen_db.test.js`:
    - `new flags default to false on sprite_sets, effect_sprite_jobs and sprite_concepts; sprite_concepts.prompt is null`;
    - `art_prompt_descriptions.origin accepts NULL and 'sprite' and rejects 'art'` (expect pg code `23514`).
  - `sprite_concepts_db.test.js`: `upsertKept stores regenerated + prompt; a later plain upsert of the same subject clears them` (`getKept` after each).
  - `art_prompt_descriptions_db.test.js`:
    - `replace stores origin 'sprite'; without origin it is NULL; getActive and listActive return it`;
    - `replace refuses an unknown origin and writes nothing` (`listAll` length unchanged).
- [ ] **Step 2: Run them and see them fail.** `cd backend && DATABASE_URL=<private> node scripts/testdb.js run --keep -- tests/migration_sprite_prompt_regen_db.test.js tests/sprite_concepts_db.test.js tests/art_prompt_descriptions_db.test.js`. Expected: the new cases FAIL (column does not exist).
- [ ] **Step 3: Implement** the migration, then `spriteConcepts.js` and `artPromptDescriptions.js`.
- [ ] **Step 4: Run them again,** plus `tests/seed_sync_coverage_db.test.js tests/sprite_concepts_migration.test.js`. Expected: all PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(sprites): schema for prompt regeneration: needs_prompt, regenerate_concept, regenerated concepts, description origin"`

---

### Task 2: Describer `effect` contract

**Files:**
- Modify: `backend/src/services/subjectDescriber.js`:
  - `budgetFor` (37-42);
  - add `EFFECT_RULES` beside `TILE_RULES` (102-112);
  - `CONTRACTS` (114-186);
  - `clean` (377-392);
  - exports (416-419).
- Test: `backend/tests/subjectDescriber.test.js`.

**Interfaces:**
- `EFFECT_LENGTHS = { short: { words: 20, tokens: 90 }, medium: { words: 40, tokens: 160 }, long: { words: 40, tokens: 160 } }`. `budgetFor` uses it for kind `vfx` or `aura`.
- One `EFFECT_CONTRACT` object, registered as both `CONTRACTS.vfx` and `CONTRACTS.aura` (same reference). `buildMessages` looks contracts up by `subject.kind`, and `vfx`/`aura` are the storage kinds (spec §5 Storage).
  - `role`: describes ONE animated visual effect for a game effect strip.
  - `rules` (`EFFECT_RULES`) state, one line each:
    - ONE noun phrase giving the effect's shape, motion, colours and materials;
    - no style or medium words (pixel art, sprite, game asset);
    - no background or scene words (ground, floor, sky, background, scene);
    - no negations ("no", "not", "without");
    - no sentences or preamble;
    - keep every colour the current prompt states.
  - `examples`: exactly 4 made-up subjects, one per box kind. Each question ends `; Type: aura|projectile|burst|beam`, plus `; current prompt: <name words>, <colour>`. No name may be a batch-1 effect (SOMET-682: exemplars get copied verbatim). The wording is left to the builder (spec §7).
- The describer subject for an effect (built in Task 3): `{ kind: 'vfx'|'aura', key: name, name, basePrompt: defaultPrompt(name, color), row: { type: <box kind> } }`. `subjectContext` already prints `Type:` from `row.type`.
- `clean(text, length, subject)` for kind `vfx`/`aura` also runs `stripEffectStyle(text) → string`:
  - It removes style and medium words (`pixel art`, `pixel`, `sprite`, `sprite sheet/strip`, `8-bit`, `16-bit`, `game asset`, `transparent`).
  - It removes a background/scene phrase with its preposition (`on|against|over [a|the] [word] background|backdrop|ground|floor|sky`), and a bare `background`, `backdrop`, `scene` or `landscape`.
  - Then it tidies doubled commas and spaces and trims trailing `,`.
  - Colour words stay (`black smoke` is kept).
  - Export `stripEffectStyle` and `EFFECT_LENGTHS`.

- [ ] **Step 1: Write the failing tests** (`subjectDescriber.test.js`):

```js
const { BATCH_1 } = require('../src/services/effectSprites.js');
const fx = (kind, type, over = {}) => ({ kind, key: 'x_fx', name: 'x_fx', basePrompt: 'x fx, gold', row: { type }, ...over });
test('an effect has its own contract: shape, motion, colour; no style, scene or negation words', () => {
  assert.equal(CONTRACTS.vfx, CONTRACTS.aura);
  const sys = buildMessages(fx('vfx', 'projectile'), 'medium')[0].content;
  for (const w of [/shape/i, /motion/i, /colou?r/i, /pixel art/i, /background/i, /negation|"no"/i]) assert.match(sys, w);
  assert.match(sys, /At most 40 words/);
});
test('effect exemplars are made up: one per box kind, none a batch-1 effect', () => {
  const qs = CONTRACTS.vfx.examples.map(([q]) => q);
  assert.deepEqual(qs.map((q) => /Type: (\w+)/.exec(q)[1]).sort(), ['aura', 'beam', 'burst', 'projectile']);
  for (const q of qs) for (const s of BATCH_1) {
    assert.ok(!q.includes(s.name) && !q.toLowerCase().includes(s.name.replace(/_/g, ' ')), `${q} copies ${s.name}`);
  }
});
test('clean strips style and background words from an effect and keeps colour words', () => {
  assert.equal(clean('pixel art swirling green flame ring on a black background', 'medium', fx('aura', 'aura')), 'swirling green flame ring');
  assert.equal(clean('crackling violet orb, sprite, over dark ground', 'medium', fx('vfx', 'projectile')), 'crackling violet orb');
  assert.equal(clean('black smoke tendrils curling outward', 'medium', fx('vfx', 'burst')), 'black smoke tendrils curling outward');
});
test('an effect prompt names its type and template', () => {
  const user = buildMessages(fx('vfx', 'projectile', { basePrompt: 'bolt fire, orange' }), 'medium')[1].content;
  assert.match(user, /Type: projectile/); assert.match(user, /Current prompt: bolt fire, orange/);
});
test('an entity is still cleaned as before (no effect stripping)', () => {
  assert.equal(clean('stone golem standing on the ground', 'medium', { kind: 'entity', name: 'Golem' }), 'stone golem standing on the ground');
});
```

  Check that last expectation against today's `stripScenery`. If today's entity output differs, assert today's output (the point is "unchanged"), not this literal.
- [ ] **Step 2: Run and see them fail.** `cd backend && node --test tests/subjectDescriber.test.js`. Expected: the new cases FAIL (`CONTRACTS.vfx` undefined).
- [ ] **Step 3: Implement** the contract, budget, `stripEffectStyle` and the `clean` branch.
- [ ] **Step 4: Run again.** Expected: PASS, including the existing `every registered subject kind has its own contract`.
- [ ] **Step 5: Commit.** `git commit -m "feat(describer): effect contract for vfx/aura with made-up exemplars; clean strips style and background words"`

---

### Task 3: Sprite prompt store + prompt-phase helper

**Files:**
- Create:
  - `backend/src/services/spritePrompts.js` (DB);
  - `backend/src/services/promptPhase.js` (pure + timers).
- Modify: `backend/src/services/artDispatcher.js:637`. `MAX_HELD_WAITS` becomes `require('./promptPhase.js').maxHeldWaits`, so there is one held-wait rule.
- Test: `backend/tests/prompt_phase.test.js` (new, unit), `backend/tests/sprite_prompts_db.test.js` (new, private DB), `backend/tests/art_dispatcher_db.test.js` (must stay green).

**Interfaces:**
- Consumes:
  - Task 1's `replace(..., { origin })`, `listActive`, `getActive` and `clear`;
  - Task 2's effect contract;
  - `remoteImageProvider.isCardHeld` / `cardHeldWaitMs` (670-696);
  - `effectSprites.subjectOf` / `defaultPrompt`;
  - `catalogSubjects.registryFor(kind).list(db)` (entity key = name, character_appearance key = `Class:variant`).
- `promptPhase.js`:
  - `maxHeldWaits() → number` = `parseInt(process.env.ART_MAX_HELD_WAITS || '3', 10)`.
  - `busyWaitMs(message: string, attempt: number) → number`:
    - `cardHeldWaitMs(message)` when `isCardHeld(message)`;
    - else `min(5000 * 2^attempt, 60000)`. `ART_SWITCH_WAIT_MS` overrides the 5000 (same env var as the art drain).
  - `runPromptWithWaits(write: () => Promise<T>, { sleep, shouldStop = () => false, maxWaits = maxHeldWaits() }) → Promise<{ ok: true, value: T } | { ok: false, busy: boolean, stopped?: true, error: string }>`. A throw is "busy" when `err.busy === true || isCardHeld(err.message)`.
    - busy: `sleep(busyWaitMs(...))` then retry, at most `maxWaits` waits;
    - past the limit: `{ ok:false, busy:true, error: \`text model busy after ${maxWaits} waits: ${msg}\` }`;
    - `shouldStop()` true before a retry: `{ ok:false, busy:true, stopped:true, error }`;
    - not busy: `{ ok:false, busy:false, error: msg }` at once.
  - `PROMPT_ETA = Object.freeze({ switchSeconds: 120, perPromptSeconds: 20, placeholder: true })`, with the comment `// PLACEHOLDER: not measured. Task 10 replaces it with the live run's text-model switch and per-prompt seconds.`
  - `promptPhaseSeconds(n, eta = PROMPT_ETA) → number`: 0 when n ≤ 0, else `eta.switchSeconds + n * eta.perPromptSeconds`.
- `spritePrompts.js`:
  - `PROMPT_KINDS = ['entity', 'character_appearance', 'vfx', 'aura']`.
  - `describerSubject(db, kind, key) → subject | null`:
    - entity/appearance: the registry's own list item (same `basePrompt` the art console uses);
    - vfx/aura: the Task 2 shape with `color` read from `vfx_effects` / `aura_effects` by name;
    - null when the subject is not in this DB.
  - `spritePromptsFor(db, kind, templates: Map<key, string>) → Map<key, { prompt, source: 'template'|'sprite', descriptionId: number|null }>`, with one `listActive` call:
    - `entity` / `character_appearance`: the active text only when its `origin === 'sprite'`;
    - `vfx` / `aura`: any active text (only the Sprite tab writes those kinds);
    - otherwise the template.
  - `regeneratePrompt(db, kind, key, { describer = subjectDescriber } = {}) → { text, model }`:
    - unknown kind → `{status:400}`; missing subject → `{status:404}`;
    - `describer.describeSubject(db, subject, { length: 'medium', boxOnly: true })`;
    - then `replace(..., { text, length:'medium', model, sourcePrompt: subject.basePrompt, origin:'sprite' })`;
    - describer errors propagate unchanged, `busy` included.
  - `savePrompt(db, kind, key, text) → row`:
    - trims;
    - `1..MAX_TEXT` characters, else throws `{status:400, message:'prompt must be 1-400 characters'}`. Never truncates.
    - Saves with `model: null`, `origin: 'sprite'` and `sourcePrompt` from the subject.
  - `revertPrompt(db, kind, key) → { cleared: boolean, reason?: 'none'|'not-sprite' }`:
    - for entity/appearance, an active version whose origin is not `'sprite'` is NOT cleared (`reason:'not-sprite'`);
    - otherwise `clear()`.
  - `promptSubjectOf(spriteRow) → { kind, key }`: `appearance_variant == null` gives `entity`, else `character_appearance`; `key = row.creature`. `optionsForAppearance` already sets the subject to `Class:variant`.

- [ ] **Step 1: Write the failing tests:**
  - `prompt_phase.test.js` (fake `sleep` records ms; fake `write` scripted):
    - `a busy answer is waited out and retried; succeeds after two waits` → `ok`, 2 sleeps;
    - `a held card waits the time the box names`: message `'Not enough free VRAM: llm-server holds the card; it unloads after 2 idle minutes'`, `ART_CARD_HELD_WAIT_MS` unset → first sleep `130000`;
    - `past the limit: "text model busy", write called maxWaits+1 times` (`maxWaits: 3` → 4 calls; error matches `/^text model busy after 3 waits/`);
    - `a non-busy error fails at once, no sleep`;
    - `stop during a wait ends stopped, no further write`;
    - `promptPhaseSeconds: 0 for none; 120 + 3 × 20 = 180 for three; PROMPT_ETA.placeholder is true`.
  - `sprite_prompts_db.test.js` (fake describer `{ describeSubject: async (_db, s) => ({ text: \`new ${s.kind}\`, model: 'stub' }) }`, private fixtures `sx_sp_*`):
    - `an entity with an art-console description keeps its template sprite prompt` (origin NULL → `source:'template'`);
    - `a Sprite-tab description becomes the entity's sprite prompt; revert returns the template`;
    - `an art-console version written after a Sprite-tab one returns the sprite lane to the template`;
    - `an effect uses its active vfx/aura description, else the template default`;
    - `regeneratePrompt writes a new active version with origin sprite and keeps the old one` (`listAll` length 2, older `active:false`);
    - `regeneratePrompt gives the describer the effect subject` (`kind:'vfx'`, `row.type:'projectile'`, `basePrompt:'bolt fire, orange'` for a `bolt_fire` row coloured `#ff7a1a`);
    - `savePrompt refuses blank and 401-char text with "prompt must be 1-400 characters" and writes nothing`;
    - `revertPrompt leaves an art-console description alone (not-sprite)`;
    - `regeneratePrompt for an unknown subject is a 404`.
- [ ] **Step 2: Run them and see them fail.**
  - `cd backend && node --test tests/prompt_phase.test.js`
  - `cd backend && DATABASE_URL=<private> node scripts/testdb.js run --keep -- tests/sprite_prompts_db.test.js`

  Expected: FAIL, module not found.
- [ ] **Step 3: Implement** both modules and the `artDispatcher.js` import.
- [ ] **Step 4: Run them again,** plus `tests/art_dispatcher_db.test.js tests/art_dispatcher_wiring.test.js` on the private DB. Expected: all PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(sprites): Sprite-tab prompt versions and a shared prompt phase with held-card waits"`

---

### Task 4: Creature queue + dispatcher: overrides, prompt phase, regenerated concept

**Files:**
- Modify:
  - `backend/src/services/spriteJobQueue.js`:
    - `enqueue` (27-197): target prompt override, flags, UPDATE path;
    - `claim` (199-210);
    - new `nextPromptRow` / `promptWritten`;
    - exports (594).
  - `backend/src/services/spriteDispatcher.js`:
    - `createDispatcher` params (226-241);
    - `submit` (543-647);
    - `drain` (1153-1220).
- Test: `backend/tests/sprite_job_queue_db.test.js`, `backend/tests/sprite_dispatcher.test.js` (fakes: extend `fakeQueue` / `fakeConcepts` at lines 25-80).

**Interfaces:**
- Consumes: Task 1's `upsertKept({ regenerated, prompt })`; Task 3's `runPromptWithWaits`, `regeneratePrompt` and `promptSubjectOf`.
- `enqueue(db, targets: Array<{ entityId, variant, prompt?: string, promptSource?: 'template'|'sprite' }>, { ...today, regenerate = false })`. Per creature/appearance row (prop rows ignore all three and stay as today):
  - `base_prompt = t.prompt ?? o.prompt`;
  - `needs_prompt = regenerate`;
  - `regenerate_concept = regenerate || (t.promptSource === 'sprite' && !(kept && kept.regenerated && kept.prompt === base_prompt))`. `kept` comes from one `sprite_concepts` query for the targets. So an edited or per-row-regenerated prompt draws a fresh concept on the next Queue, and an unchanged one reuses it.
  - The UPDATE path (128-163) also sets `base_prompt`, `needs_prompt` and `regenerate_concept`, and adds all three to the `box_job_id` detach `CASE`. The INSERT (165-194) writes them.
- `claim` adds `AND NOT needs_prompt`.
- `nextPromptRow(db) → row|null`: the oldest `status='queued' AND needs_prompt AND entity_type_id IS NOT NULL`.
- `promptWritten(db, id, prompt) → row|null`: `SET base_prompt=$2, needs_prompt=false, updated_at=now() WHERE id=$1 AND status='queued' AND needs_prompt`.
- `createDispatcher({ ..., prompts = spritePrompts, describer = subjectDescriber, sleep = wait })`.
- Prompt phase in `drain`: before every `queue.claim`, `await promptPhase(current)`. Loop over `nextPromptRow`:
  1. Set `current.current = { id, creature, phase: 'prompt', ... }`.
  2. Call `runPromptWithWaits(() => prompts.regeneratePrompt(db, kind, key, { describer }), { sleep, shouldStop: () => current.stopping || current.halting })`.
  3. Outcomes:
     - `ok`: `promptWritten(id, value.text)`, then `current.promptsWritten += 1`;
     - `stopped`: return and leave the row as is;
     - otherwise `queue.fail(db, id, new Error(error))` and `current.failed += 1`.
  4. `start()` initialises `promptsWritten: 0`.
- `submit()`:
  - `regeneratedLane = row.regenerate_concept === true || (kept && kept.regenerated === true)`, captured before `kept` can be nulled.
  - When `row.regenerate_concept`, skip `getKept` and the art upload. Call `generateConcept(provider, { prompt: row.base_prompt })`.
  - A kept concept with `regenerated` skips the art-bytes mismatch check (548-555).
  - Regenerated kept concept not reusable (other origin, `conceptAvailable` false, or its 4xx refusal path):
    - `box.uploadImage(provider, keptBytes)` when its stored object is readable, otherwise `generateConcept({ prompt: row.base_prompt })`;
    - never `creatureArt(row)`;
    - no `KEPT_CONCEPT_NOTE` when the re-upload succeeds.
  - After the sheet job is accepted, `upsertKept(..., { regenerated: regeneratedLane, prompt: regeneratedLane ? (row.regenerate_concept ? row.base_prompt : kept.prompt) : null })`.
  - Non-regenerated rows are byte-for-byte today's path.

- [ ] **Step 1: Write the failing tests:**
  - `sprite_job_queue_db.test.js`:
    - `enqueue without regenerate keeps today's prompt: an art-console entity description never reaches base_prompt` (Global Constraint: the 17 creatures);
    - `enqueue with regenerate flags creature and appearance rows needs_prompt + regenerate_concept; a prop gets neither`;
    - `a per-target prompt override becomes base_prompt`;
    - `a Sprite-tab prompt that differs from the regenerated concept's prompt sets regenerate_concept; the same prompt does not`;
    - `re-queuing a queued row with regenerate updates base_prompt and both flags and detaches its box job` (Review Focus 1: the row's `box_job_id` is NULL and `dropped_box_job_id` names the old one);
    - `claim never takes a row whose prompt is pending`;
    - `promptWritten sets base_prompt and clears needs_prompt only on a queued row` (a `running` row → null).
  - `sprite_dispatcher.test.js` (fake `prompts.regeneratePrompt` records calls; `fakeQueue` gains `promptRows`, `nextPromptRow` and `promptWritten`; an event log orders `prompt:<id>` / `concept` / `upload` / `create`):
    - `every pending prompt is written before the first concept or upload` (2 needs_prompt rows → log starts `prompt:1, prompt:2`);
    - `regenerate_concept skips the approved art: generateConcept gets base_prompt, uploadImage is never called`;
    - `the regenerated concept is kept with regenerated:true and its prompt` (`concepts.log.upserts[0]`);
    - `a later normal job reuses a regenerated concept that is not the approved art's bytes` (no upload, no generateConcept, `concept_image` = the kept path);
    - `a regenerated concept missing on the box is re-uploaded from its stored bytes, never replaced by the approved art` (Review Focus 3: `uploads[0].png === KEPT_PNG`, upsert `regenerated:true`, no note);
    - `a regenerated concept whose stored bytes are gone draws a fresh concept from base_prompt` (`calls.concept[0].prompt === row.base_prompt`, `uploads` empty);
    - `text model busy past the limit fails that row "text model busy" and draws nothing for it` (`ART_MAX_HELD_WAITS=1`, fake sleep);
    - `Stop during a prompt wait leaves the row queued with its prompt pending` (Review Focus 2: no fail, no claim, no `promptWritten`);
    - the existing `a kept concept that is not the current art is replaced by the art (SOMET-660)` stays green unchanged.
- [ ] **Step 2: Run them and see them fail.**
  - `cd backend && node --test tests/sprite_dispatcher.test.js`
  - `cd backend && DATABASE_URL=<private> node scripts/testdb.js run --keep -- tests/sprite_job_queue_db.test.js`

  Expected: the new cases FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again,** plus `tests/sprite_dispatcher_incremental.test.js tests/sprite_concepts_db.test.js tests/sprite_force_api_db.test.js tests/sprite_reuse_base_db.test.js` (private DB). Expected: all PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(sprites): prompt phase before drawing; regenerate draws and keeps a fresh concept, approved art untouched"`

---

### Task 5: Effect queue + dispatcher: overrides and prompt phase

**Files:**
- Modify:
  - `backend/src/services/effectSprites.js`: `BATCH_1` (9-14), new validators, exports;
  - `backend/src/services/effectSpriteJobs.js`: `enqueue` (25-50), `claimNext` (52-60), new `nextPromptJob` / `promptWritten`, exports;
  - `backend/src/services/effectDispatcher.js`: `createEffectDispatcher` (29), `kick` (90-112).
- Test:
  - `backend/tests/effect_sprites.test.js`;
  - `backend/tests/effect_sprite_jobs_db.test.js`;
  - `backend/tests/effect_dispatcher_db.test.js`.

**Interfaces:**
- `BATCH_1`:
  - bolts and beams default to **8** frames (was 4); auras stay 8 and bursts 6 (spec §2.2, §8);
  - groups become the spec's labels: `Auras`, `Bolts`, `Impacts`, `Beams`;
  - every other field is unchanged.
- `MAX_EFFECT_FRAMES = 64`.
- `effectTargetError(subject, { frames, loop }) → string | null`:
  - `'frames must be an integer from 1 to 64'`;
  - `'loop must be true or false'`;
  - `\`${name} is a burst and always plays once\`` for a burst with `loop === true`;
  - absent fields are fine.
- `effectJobShape(subject, { frames, loop }) → { frames, loop }`:
  - frames: the override, else the default;
  - loop: an aura is always `true` (a `false` is forced to `true`), a burst always `false`, otherwise the override or the default.
- `enqueue(db, targets: Array<{ subject_kind, name, prompt, frames?, loop?, needsPrompt? }>)`: inserts `effectJobShape(...)` values and `needs_prompt = needsPrompt === true`. Redraw repeats a job by passing its stored `frames`/`loop`.
- `claimNext` adds `AND NOT needs_prompt`.
- `nextPromptJob(db) → row|null` (oldest queued with `needs_prompt`).
- `promptWritten(db, id, prompt)` sets `prompt` and `needs_prompt=false` when still queued.
- `createEffectDispatcher({ ..., prompts = spritePrompts, describer = subjectDescriber })`:
  - `kick` runs the prompt phase (same loop as Task 4, with `regeneratePrompt(db, job.subject_kind, job.subject_name, ...)`) before loading the sprite provider and before every `claimNext`;
  - busy past the limit → `jobs.fail(id, 'text model busy ...')`;
  - stopped is not a case here: the effect dispatcher has no Stop.

- [ ] **Step 1: Write the failing tests:**
  - `effect_sprites.test.js`:
    - update `batch 1 is exactly the spec table` to the new groups and frames: bolts/beams 8, auras 8, bursts 6;
    - `every strip still fits the vfxSprite limits at 64 frames` (`64 * size <= 8192` for every entry);
    - `effectTargetError: frames 1-64 integers, loop boolean, a burst refuses loop:true` (cases: 0, 65, 2.5, `'8'`, `loop:'yes'`, `spark_hit` + `loop:true`);
    - `effectJobShape: an aura always loops, a burst never, a bolt takes the override` (`pack_leader` + `loop:false` → `true`; `bolt_fire` + `{frames:12, loop:false}` → `{12, false}`).
  - `effect_sprite_jobs_db.test.js`:
    - `enqueue stores frames/loop overrides and needs_prompt; boxRequestFor sends the stored values`;
    - `claimNext skips a job whose prompt is pending`.
  - `effect_dispatcher_db.test.js` (fake `prompts`; fake box records `createVfxJob` bodies):
    - `prompt phase writes every pending effect prompt before the first box job`;
    - `a written prompt is what the box receives` (`body.prompt === 'new vfx'`);
    - `text model busy past the limit fails the job "text model busy" and creates no box job`.
- [ ] **Step 2: Run them and see them fail.**
  - `cd backend && node --test tests/effect_sprites.test.js`
  - `cd backend && DATABASE_URL=<private> node scripts/testdb.js run --keep -- tests/effect_sprite_jobs_db.test.js tests/effect_dispatcher_db.test.js`

  Expected: the new cases FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again,** plus `tests/effect_sprite_routes_db.test.js` (its `GET /` default-frames expectation may need the new 8). Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(effects): per-job frames/loop overrides (burst one-shot, aura loop), 8-frame bolts/beams, prompt phase"`

---

### Task 6: Routes: per-row prompt actions, regenerate on Queue, prompt ETA

**Files:**
- Create: `backend/src/api/spritePromptRoutes.js`.
- Modify:
  - `backend/src/index.js:656`: mount `app.use('/api/sprite-admin/prompts', spritePromptRoutes(guardPool, adminGuard))` on the line before the `/api/sprite-admin` mount (657);
  - `backend/src/api/spriteBatchRoutes.js`:
    - `remainingSeconds`/`computeBoxQueue`/`GET /box-queue` (170-212);
    - `GET /subjects` (325-463);
    - `queueRequestFrom` (477-572);
    - `POST /jobs` (614-648) and the force path (1035);
  - `backend/src/api/effectSpriteRoutes.js`: `GET /` (53-80), `POST /jobs` (82-108).
- Test:
  - `backend/tests/sprite_prompt_routes_db.test.js` (new);
  - `backend/tests/sprite_batch_api.test.js`;
  - `backend/tests/sprite_batch_subjects_db.test.js`;
  - `backend/tests/effect_sprite_routes_db.test.js`.

**Interfaces:**
- `spritePromptRoutes(pool, adminGuard, { describer } = {}) → Router`, everything behind `adminGuard`. `:kind` ∈ `PROMPT_KINDS`, else 400 `unknown prompt kind`; `:key` is URL-decoded. For an `entity` that is neither creature nor playable, the answer is 400 `prompt regeneration is for creatures, heroes and effects` (spec §3: props excluded).
  - `POST /:kind/:key/regenerate` → `200 { kind, key, prompt, source: 'sprite', model }`. One attempt, no waiting:
    - `err.busy` → 409 `{ error: 'text model busy: <msg>' }`;
    - other describer error → 502 `{ error }`;
    - unknown subject → 404.
  - `PUT /:kind/:key` with `{ text }` → `201 { prompt, source: 'sprite' }`. `savePrompt`'s 400 passes through.
  - `DELETE /:kind/:key` → `200 { prompt: <template>, source: 'template' }`;
    - `reason:'none'` → 404 `no Sprite-tab prompt to revert`;
    - `reason:'not-sprite'` → 409 `the active description was written by the art console; revert it there`.
- `GET /api/sprite-admin/subjects`: each row gains:
  - `sprite_prompt`, `sprite_prompt_source` (from `spritePromptsFor`, one call per kind);
  - `prompt_kind`, `prompt_key` (null for props);
  - `needs_prompt`, `regenerate_concept`;
  - `kept_concept_regenerated` (`kc.regenerated`).

  The existing `prompt` field is unchanged.
- `queueRequestFrom`:
  - `regenerate` must be absent or boolean, else 400 `regenerate must be true or false`;
  - targets gain `prompt` / `promptSource` from `spritePromptsFor`;
  - `options.regenerate`.

  `POST /jobs` and `POST /jobs/force` pass it to `enqueue`.
- `GET /box-queue`: every answer (cached, computed and `none`) gains `prompt_eta: { switch_seconds, per_prompt_seconds, placeholder }` from `PROMPT_ETA`.
- `effectSpriteRoutes`:
  - `GET /`:
    - subjects gain `default_frames`, `default_loop`, `prompt`, `prompt_source` (via `spritePromptsFor` over the templates), `prompt_kind` (= `subject_kind`) and `prompt_key` (= `name`);
    - `job` gains `loop`, `needs_prompt` and `updated_at`.
  - `POST /jobs`:
    - targets may carry `frames` / `loop` (`effectTargetError` → 400 with its text);
    - body `regenerate` (boolean, else 400) → `needsPrompt`;
    - an omitted `prompt` uses the active description, else the template default.

- [ ] **Step 1: Write the failing tests:**
  - `sprite_prompt_routes_db.test.js` (fake describer; a `busy` variant throws `Object.assign(new Error('text service answered 503'), { busy: true })`):
    - `POST regenerate writes a Sprite-tab version and answers the new prompt` (`listAll` +1, origin `sprite`);
    - `a busy text model answers 409 "text model busy" and writes nothing`;
    - `PUT saves an edit as a new version; DELETE reverts to the template`;
    - `PUT refuses a 401-char prompt with 400 and stores nothing` (Review Focus 4);
    - `DELETE refuses an art-console description (409) and leaves it active`;
    - `unknown kind 400, unknown subject 404, a prop entity 400`;
    - `routes are admin-only` (a rejecting guard → 401/403).
  - `sprite_batch_api.test.js`:
    - `POST /jobs refuses a non-boolean regenerate (400)`;
    - `GET /box-queue carries prompt_eta flagged placeholder` (also on the unreachable/`none` path).
  - `sprite_batch_subjects_db.test.js`:
    - `GET /subjects shows the sprite prompt and its source: template for an art-console description, sprite for a Sprite-tab one`;
    - `POST /jobs with regenerate:true queues needs_prompt rows whose base_prompt is the current sprite prompt`.
  - `effect_sprite_routes_db.test.js`:
    - `GET / gives default frames/loop (bolt_fire 8 loop, spark_hit 6 one-shot) and the active prompt with its source`;
    - `POST /jobs stores frames/loop overrides; a burst with loop:true is 400; an aura with loop:false is stored looping`;
    - `POST /jobs with regenerate:true queues needs_prompt jobs and kicks once`.
- [ ] **Step 2: Run them and see them fail.**
  - `cd backend && node --test tests/sprite_batch_api.test.js`
  - `cd backend && DATABASE_URL=<private> node scripts/testdb.js run --keep -- tests/sprite_prompt_routes_db.test.js tests/sprite_batch_subjects_db.test.js tests/effect_sprite_routes_db.test.js`

  Expected: the new cases FAIL.
- [ ] **Step 3: Implement** the router, the mount and the route changes.
- [ ] **Step 4: Run them again,** plus `tests/sprite_force_api_db.test.js tests/sprite_batch_approve_api.test.js`. Expected: all PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(sprites): per-row prompt regenerate/edit/revert routes; Queue regenerate flag; effect frames/loop; prompt ETA"`

---

### Task 7: Sprite tab: effect rows, selection gating, Regenerate prompt, prompt cell

**Files:**
- Create:
  - `frontend/src/games/something2/SpritePromptCell.jsx`;
  - `frontend/src/games/something2/EffectStripPreview.jsx`: `EffectStripPreview` + `effectBackground`, moved verbatim from `EffectSpritesSection.jsx:52-110`, with an added `onRedraw` prop.
- Delete:
  - `frontend/src/games/something2/EffectSpritesSection.jsx`;
  - `frontend/src/games/something2/__tests__/effectSpritesSection.render.test.js`.
- Modify:
  - `frontend/src/games/something2/spriteSelection.js`:
    - `spriteShape` (5-7), `filterSpriteSubjects` (57-75), `jobStateLabel` (415-418), `nextConceptCaption` (364-367);
    - `selectionKinds` / `queuePayload` (443-478);
    - export `selectionBoxSeconds` (512);
  - `frontend/src/games/something2/effectSprites.js`: add `effectRows`;
  - `frontend/src/games/something2/useSpriteConsole.js`:
    - `mutation` (96-116): send a body for PUT, i.e. for every method but DELETE;
    - `queueJobsBody` (122-124): add `regenerate`;
    - `useQueueEffects` (194): pass `regenerate`;
    - new prompt hooks;
  - `frontend/src/games/something2/SpriteConsoleAdmin.jsx`:
    - `SpriteTable` (225-286);
    - container state, merge, queue, approve and preview (316-470);
    - shape filter (521-527);
    - control bar (548-633);
    - remove the `EffectSpritesSection` import (7) and render (687).
- Test:
  - `frontend/src/games/something2/__tests__/spriteSelection.test.js`;
  - `frontend/src/games/something2/__tests__/effectSprites.test.js`;
  - `frontend/src/games/something2/__tests__/spriteConsoleTable.render.test.js`;
  - `frontend/src/games/something2/__tests__/SpriteConsoleAdmin.smoke.test.js` (must stay green).

**Interfaces:**
- Consumes: Task 6's response fields and routes; `useEffectSprites`, `useApproveEffect` and `useQueueEffects`; `effectSelectionEta`, `previewSprite` and `effectStatusLabel` from `effectSprites.js`; `etaLabel` and `durationLabel`.
- `effectRows(effectsResponse) → row[]`. One row per subject, with:
  - `id: \`fx:${subject_kind}|${name}\``, `effect: true`, and `name`, `group`, `kind`, `subject_kind`, `blend`;
  - `job_state: job?.status ?? null`, `job_id: job?.id ?? null`, `job_updated_at: job?.updated_at ?? null`;
  - `needs_prompt`, `frames: job?.frames ?? default_frames`, `loop: job?.loop ?? default_loop`, and `default_frames`, `default_loop`;
  - `sprite`, `sprite_prompt: prompt`, `sprite_prompt_source: prompt_source`, `prompt_kind`, `prompt_key`, `last_error: job?.error`;
  - `effect_subject` (the raw item, for the preview).
- `spriteShape(row)` returns `'effect'` when `row.effect === true`. The shape filter gains `<option value="effect">Effects</option>`.
- `selectionKinds(rows)` adds `effects`, `effectsOnly` and `mixedEffects` (effects with creatures or props).
- `selectionControls(rows) → { facings: {disabled, title}, cell: {disabled, title}, creatureActions: boolean, effectFrames: boolean, effectLoop: { shown, locked, value: boolean|null, title } }`, from spec §2.2:
  - **effects only:**
    - facings and cell are `disabled:true` with `title:'effects have one direction'`;
    - `creatureActions:false`, `effectFrames:true`, `effectLoop.shown:true`;
    - loop `locked` when every selected effect is a burst or an aura. `value` is `false` for all bursts, `true` for all auras, `null` for a mix. `title` is `'bursts always play once'`, `'auras always loop'` or `'bursts always play once; auras always loop'`.
  - **no effects:** today's behaviour; the effect controls are hidden.
  - **mixed:**
    - facings and cell are enabled with `title:'applies to creature rows only'`;
    - creature actions are shown;
    - the effect controls are hidden, and effect rows keep their defaults.
- `queuePayload(..., { ..., regenerate = false })` adds `regenerate: true` when set and the rows are not props-only.
- `effectQueuePayload(rows, { frames = null, loop = null, regenerate = false }) → { targets, regenerate? }`:
  - targets are `{ subject_kind, name }`;
  - `frames` only when a number was picked;
  - `loop` only for `projectile`/`beam` rows and only when picked. Never for a burst or an aura (Review Focus 5).
- `queueRequests(catalog, rows, { ...queuePayload options, regenerate = false, effectFrames = null, effectLoop = null }) → Array<{ path: '/jobs'|'/effects/jobs', body }>`:
  - creature and prop rows go through `queuePayload`, effect rows through `effectQueuePayload`;
  - an empty side is omitted;
  - an effects-only selection passes `effectFrames` / `effectLoop`; a mixed selection passes `frames: null, loop: null` to the effect side.
- `selectionTotalEta({ boxSeconds, effectEta, prompts: { sprite: n1, effect: n2 }, promptEta }) → { low, typical, high, placeholder }`:
  - the sum of the creature `selectionBoxSeconds` total (or 0) and `effectSelectionEta`;
  - plus `promptPhaseSeconds`-equivalent for each lane with prompts: `switch_seconds + n × per_prompt_seconds`, so one switch per lane;
  - `placeholder = promptEta.placeholder && n1 + n2 > 0`.
- `totalEtaLabel(est) → string`: `etaLabel(est)`, plus `' (prompt time is an estimate, not yet measured)'` when `placeholder`. The bar shows it with `waitLabel(boxQueue)`.
- `jobStateLabel`: `'prompt pending'` when `job_state === 'queued' && needs_prompt`. Effect rows use `effectStatusLabel`.
- `nextConceptCaption`: `'Concept — regenerated'` when `kept_concept_regenerated`.
- Hooks:
  - `useRegeneratePrompt` (POST `/prompts/:kind/:key/regenerate`);
  - `useSavePrompt` (PUT `/prompts/:kind/:key`, body `{ text }`);
  - `useRevertPrompt` (DELETE).

  The key is `encodeURIComponent`-ed. All three invalidate `SUBJECTS_KEY` and `EFFECTS_KEY`.
- `SpritePromptCell({ subject, pending, onRegenerate, onSave, onRevert })`:
  - shows `sprite_prompt || prompt || name` and a source tag (`template` / `Sprite tab`);
  - `Regenerate prompt` and `Edit` (textarea, Save, Cancel) only when `subject.prompt_kind`;
  - `Revert` only when `sprite_prompt_source === 'sprite'`.
- Container (`SpriteConsoleAdmin`):
  - `subjects` = API subjects followed by `effectRows(effects)`;
  - the table shows a group header row (`Auras`, `Bolts`, `Impacts`, `Beams`) above the first effect row of each group on the page. The exact layout is left to the builder (spec §7).
  - A `Regenerate prompt` checkbox (default off) sits beside the Generation method, OUTSIDE the props-only/creature-only fragment so it shows for an effects-only selection.
  - When `effectFrames` is on: a `Frames` select (`Default per effect`, 1-64) and a `Loop` select (`Default per effect`, `Loop`, `One-shot`), disabled with its `title` when locked.
  - The Queue button runs every `queueRequests` entry (`useQueueSprites` / `useQueueEffects`) and clears the selection when all succeed.
  - `Approve N completed` approves creature rows by `job_ids`, and each done effect row by `useApproveEffect`.
  - An effect thumbnail opens `EffectStripPreview`, whose `Redraw` queues `{ subject_kind, name, frames: job.frames, loop: job.loop }` (`loop` omitted for bursts and auras).
- `SpriteTable`, for effect rows:
  - Concept `—`, Body `—`, Shape `effect`;
  - Actions shows `loop` / `one-shot`;
  - Directions shows a greyed `one direction` with `title="effects have one direction"`;
  - Frames shows `frames`, Backend `gpu-box`;
  - Status shows `effectStatusLabel` (or `prompt pending`).

- [ ] **Step 1: Write the failing tests:**

```js
// spriteSelection.test.js (add)
const fxRow = (kind, over = {}) => ({ id: `fx:${kind}`, effect: true, kind, subject_kind: kind === 'aura' ? 'aura' : 'vfx', name: `${kind}_x`, ...over });
const wolf = { id: 1, name: 'Wolf', is_creature: true };
it('effects only: facings and cell greyed with "effects have one direction", actions hidden, frames + loop shown', () => {
  const c = selectionControls([fxRow('projectile'), fxRow('beam')]);
  expect(c.facings).toEqual({ disabled: true, title: 'effects have one direction' });
  expect(c.cell).toEqual({ disabled: true, title: 'effects have one direction' });
  expect(c.creatureActions).toBe(false); expect(c.effectFrames).toBe(true);
  expect(c.effectLoop).toMatchObject({ shown: true, locked: false });
});
it('creatures only: as today; mixed: facings/cell apply to creatures only, effect controls hidden', () => {
  expect(selectionControls([wolf])).toMatchObject({ facings: { disabled: false }, creatureActions: true, effectFrames: false, effectLoop: { shown: false } });
  expect(selectionControls([wolf, fxRow('burst')])).toMatchObject({ facings: { disabled: false, title: 'applies to creature rows only' }, effectFrames: false, effectLoop: { shown: false } });
});
it('loop is locked for bursts (one-shot) and auras (loop)', () => {
  expect(selectionControls([fxRow('burst')]).effectLoop).toMatchObject({ locked: true, value: false, title: 'bursts always play once' });
  expect(selectionControls([fxRow('aura')]).effectLoop).toMatchObject({ locked: true, value: true, title: 'auras always loop' });
});
it('a mixed selection queues /jobs and /effects/jobs, both with regenerate', () => {
  const reqs = queueRequests(CATALOG, [wolf, fxRow('projectile')], { actions: ['idle'], frames: 4, directions: ['s'], cell: '96x128', regenerate: true, effectFrames: 12, effectLoop: false });
  expect(reqs.map((r) => r.path)).toEqual(['/jobs', '/effects/jobs']);
  expect(reqs[0].body.regenerate).toBe(true); expect(reqs[1].body).toEqual({ targets: [{ subject_kind: 'vfx', name: 'projectile_x' }], regenerate: true });
});
it('effectQueuePayload never sends loop for a burst or an aura; frames only when picked', () => {
  const b = effectQueuePayload([fxRow('burst'), fxRow('aura'), fxRow('projectile')], { frames: 12, loop: true });
  expect(b.targets).toEqual([
    { subject_kind: 'vfx', name: 'burst_x', frames: 12 },
    { subject_kind: 'aura', name: 'aura_x', frames: 12 },
    { subject_kind: 'vfx', name: 'projectile_x', frames: 12, loop: true }]);
});
it('total ETA = creatures + effects + one text-model switch per lane + per-prompt seconds; placeholder flagged', () => {
  const est = selectionTotalEta({ boxSeconds: { low: 100, typical: 100, high: 100 }, effectEta: { low: 35, typical: 35, high: 140 },
    prompts: { sprite: 1, effect: 2 }, promptEta: { switch_seconds: 120, per_prompt_seconds: 20, placeholder: true } });
  // 100 creature + 35 effect + (120 + 1×20) sprite lane + (120 + 2×20) effect lane; high uses the effect's 140
  expect(est).toEqual({ low: 435, typical: 435, high: 540, placeholder: true });
  expect(totalEtaLabel(est)).toMatch(/not yet measured/);
});
it('a queued row whose prompt is not written yet reads "prompt pending"', () => {
  expect(jobStateLabel({ job_state: 'queued', needs_prompt: true })).toBe('prompt pending');
});
it('the Effects shape filter keeps only effect rows', () => {
  expect(filterSpriteSubjects([wolf, fxRow('aura')], { shape: 'effect', status: 'all' }).map((r) => r.id)).toEqual(['fx:aura']);
});
```

  (The mixed case ignores `effectFrames` / `effectLoop`: effect rows keep their defaults.)
  - `effectSprites.test.js`: `effectRows maps the effects list into table rows`:
    - `id`, `effect`, `job_state` from `job.status`;
    - `frames` from the job, else `default_frames`;
    - `prompt_kind`/`prompt_key`; `sprite_prompt` from `prompt`.
  - `spriteConsoleTable.render.test.js`:
    - `an effect row shows "one direction" greyed with the tooltip, its frames and loop, and no Body select`;
    - `the prompt cell offers Regenerate prompt for creatures, appearances and effects but not props; Revert only for a Sprite-tab prompt`;
    - `group headers appear above the first effect row of each group`;
    - `a regenerated kept concept captions "Concept — regenerated"`.
- [ ] **Step 2: Run them and see them fail.** `cd frontend && npx vitest run src/games/something2/__tests__/spriteSelection.test.js src/games/something2/__tests__/effectSprites.test.js src/games/something2/__tests__/spriteConsoleTable.render.test.js`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement,** then delete `EffectSpritesSection.jsx` and its render test.
- [ ] **Step 4: Run** `cd frontend && npx vitest run src/games/something2`. Expected: fully green. Then `grep -rn "EffectSpritesSection" src` prints nothing.
- [ ] **Step 5: Commit.** `git commit -m "feat(sprites): effects as Sprite-table rows with gated controls, Regenerate prompt, editable prompt cell; drop EffectSpritesSection"`

---

### Task 8: Seed/export: effect descriptions and origin travel

**Files:**
- Modify:
  - `backend/tests/seed_sync_art_audio_roundtrip_db.test.js` (`seedFixture` at 180, assertions near 311);
  - `backend/seeds/sync/art.json`: regenerated, never hand-edited.
- Verify, without changing them:
  - `backend/src/services/seedSync/registry.js:434-441` (`art_prompt_descriptions`: `naturalKey ['subject_kind','subject_key']`, no kind filter, so `vfx`/`aura` are covered);
  - `coverage.js` `EXCLUDED` (18-21).

**Interfaces:** none new. `origin` is a plain exported column (not in `omit`). The machine-local tables (`sprite_sets`, `sprite_concepts`, `effect_sprite_jobs`) stay excluded. A regenerated concept does not travel between PCs; its prompt does, as the active `origin='sprite'` description.

- [ ] **Step 1: Write the failing test.** In `seedFixture`, add:
  - `('vfx','sx_aa_fx','sx swirling ember dart','m1', origin 'sprite')`;
  - `('aura','sx_aa_aura','sx slow gold halo', NULL, origin 'sprite')`;
  - `('entity','sx_aa_ent','sx shaggy wolf','m2', origin 'sprite')`.

  Then add `effect and Sprite-tab descriptions survive export → seed with their kind and origin`:
  1. export `art` to the temp roots;
  2. delete the three rows;
  3. `previewSeed` + `applySeed` take-git;
  4. the three rows are back with identical `subject_kind`, `subject_key`, `text`, `origin` and `active:true`, and an `art.art_prompt_descriptions` exported row has an `origin` key.
- [ ] **Step 2: Run and see it fail.** `cd backend && DATABASE_URL=<private> node scripts/testdb.js run --keep -- tests/seed_sync_art_audio_roundtrip_db.test.js`. Expected: FAIL only if `origin` is lost. If it already passes (the column flows automatically), keep the test as the guard and note that in the commit.
- [ ] **Step 3: Regenerate the seed file** on a private DB built by `testdb.js reset` from the checked-in files:

  ```
  cd backend && DATABASE_URL=<private> node scripts/seed-sync.js export --groups=art
  git diff --stat backend/seeds
  ```

  Expected:
  - only `art.json` changes;
  - the header `schema_version` is `1714440881000_sprite_prompt_regen`;
  - `row_counts` is unchanged;
  - `art_prompt_descriptions` rows gain `"origin": null`;
  - no PNG churn;
  - `node scripts/seed-sync.js status --groups=art` reports in sync.

  If anything else changes, stop and report.
- [ ] **Step 4: Run** `seed_sync_art_audio_roundtrip_db`, `seed_sync_coverage_db`, `seed_sync_registry_db` and `seed_sync_groups_roundtrip_db` on the private DB. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(seed-sync): Sprite-tab and effect prompt descriptions travel with origin (art group)"`

---

### Task 9: Browser verification on an isolated stack (stub box + stub /api/text)

**Files:** none committed. Scripts and screenshots go in the session scratchpad.

- [ ] **Step 1: Bring up an isolated stack** from the worktree, per memory `dev-run-browser-verify.md`:
  - backend `PORT=13201` with a private `DATABASE_URL` (`testdb.js reset`) and `CORS_ORIGINS` set;
  - vite on `15273` with a throwaway config (own `cacheDir`, proxy to 13201), deleted afterwards;
  - `ART_MAX_HELD_WAITS=1` and `ART_CARD_HELD_WAIT_MS=1000` for the busy check.
- [ ] **Step 2: Run one stub server** (scratchpad Node script, a free local port):
  - the box routes from the effect-sprites plan's Task 8 stub: `/api/vfx`, `/api/jobs[/{id}[/sheet|/atlas]]`, `/api/model-gateway`, plus generate_core concept, `/api/upload` and sheet job;
  - `POST /api/text` answers `{ text: 'stub swirling <n>', model: 'stub-qwen' }`. A `?busy=N` switch file makes the next N calls answer 503.
  - It logs every request with a timestamp.
  - Point the private DB's active `sprite` AND `text` providers at it.
- [ ] **Step 3: Gating** (muted headless Chrome, `/game/sprites`):
  - Shape → Effects shows 21 rows under Auras/Bolts/Impacts/Beams;
  - select 2 bolts: Directions and Cell size are greyed, and hovering shows "effects have one direction"; Frames offers 1-64 and Loop is active;
  - add a burst: Loop shows its lock title;
  - select a creature plus an effect: Facings shows "applies to creature rows only" and the effect controls are hidden.

  Screenshot each.
- [ ] **Step 4: Regenerate and Queue:**
  - tick Regenerate prompt, select 1 creature + 2 effects, and check the estimate line shows the prompt time "(… not yet measured)";
  - Queue: the network log shows `POST /api/sprite-admin/jobs` and `POST /api/sprite-admin/effects/jobs`, and the rows read "prompt pending";
  - Start batch: the stub log shows every `/api/text` call before the first `/api/vfx` of the effect lane and before the first concept call of the creature lane;
  - the creature's stub log shows a generate_core with the stub prompt and NO upload of the approved art;
  - after it finishes, the row captions "Concept — regenerated";
  - a second plain Queue + Start for that creature reuses the concept (no generate_core, no upload).
- [ ] **Step 5: Per-row prompt actions:** Regenerate prompt on a row (no job queued), Edit + Save, Revert. Each prompt cell updates. The art console's description view for that entity lists the versions.
- [ ] **Step 6: Busy path:** set `busy=10`, queue one effect with Regenerate. It fails "text model busy …" and the stub logs no `/api/vfx`.
- [ ] **Step 7: Tear down** the stub, backend and vite by checked PID. Drop the private DB.

---

### Task 10: Gated live run on the real text model and box

Start only when the owner confirms that no box spike is running. Before every call, `GET /api/model-gateway` must show no hold (read-only). Use a PRIVATE DB and the private live-box-leg harness (memory `private-live-box-leg-harness.md`), with providers read via `loadActiveProviderWithSecret(sharedPool, 'text'|'sprite')`. Read only, never write the shared DB.

**Files:** `backend/src/services/promptPhase.js` (`PROMPT_ETA` only, Step 4) and the spec's §6 (one line).

- [ ] **Step 1: Template baseline.** Draw `bolt_fire`, `pack_leader` and one creature with no active `entity` description (pick it by SQL on the private DB) with template prompts. Save the strips/sheets to the scratchpad.
- [ ] **Step 2: Regenerate** the same three through the real dispatchers (Queue with `regenerate:true`, then Start). Record:
  - the wall time of the first `/api/text` call (includes the model switch);
  - each later call's seconds;
  - the time from the last prompt to the first image job starting (the switch back).
- [ ] **Step 3: Compare** template and regenerated output side by side (scratchpad page or montage). Check that:
  - the effect prompts hold no style or background words;
  - the creature concept was drawn fresh, and `entity_types.image` is byte-identical before and after;
  - `sprite_concepts.regenerated` is true.

  Report anything wrong to the box session rather than patching around it.
- [ ] **Step 4: Replace the placeholder** with the measured switch and median per-prompt seconds, set `placeholder: false`, and update the `promptPhaseSeconds` test. Run `cd backend && node --test tests/prompt_phase.test.js` and `cd frontend && npx vitest run src/games/something2/__tests__/spriteSelection.test.js`. Commit: `git commit -m "feat(sprites): measured text-model switch and per-prompt seconds"`. Record the numbers and the run in spec §6.
