# Unified AI Provider Kinds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One "Add provider" flow (choose the kind, choose a template, fill in that kind's fields) with a model
choice for every kind, editable templates, discovery of the models a provider serves, and Seed/Export coverage.

**Architecture:**
- **Two new `ai_providers` columns decide behaviour.** `adapter` picks how discovery, test and text completion
  talk to a provider; NULL means today's behaviour. `models_by_group` holds the audio model for each drain group.
- **Templates** live in a new table, `ai_provider_templates`. A new provider copies a template's values; there is
  no foreign key back to the template.
- **Discovery** is a new pure service. It writes `discovery_cache` and leaves `models_cache` as it is today.

**Tech Stack:**
- Backend: Express (CommonJS), raw `pg`, node-pg-migrate, `node --test` + supertest.
- Frontend: React 19, styled-components, TanStack Query, vitest (node env).

**Spec:** `docs/superpowers/specs/2026-10-21-unified-ai-provider-kinds-design.md`. Read it first; this plan does
not restate the reasons behind the decisions.

## Global Constraints

### Where the work happens

- **Use a worktree.** `../something2-wt-provider-kinds`, branch `feat/unified-provider-kinds`, from `origin/main`.
  Run `git worktree list` first.
- **Never touch the shared checkout.** No `checkout`/`stash`/`rebase`/`reset` in it.
- **Link `node_modules`.** Symlink `backend/node_modules` and `frontend/node_modules` to the main checkout instead
  of reinstalling.

### Databases

- **Every DB test needs a scratch DB.** Set both variables, on **separate** `export` lines, to the same database:
  ```
  export DATABASE_URL=postgres://user:password@localhost:15432/s2_provider_kinds
  export TEST_DATABASE_URL=postgres://user:password@localhost:15432/s2_provider_kinds
  ```
  Create it with `createdb`, migrate it, and seed it: `seed-catalogs`, both map specs with vale-region LAST, and
  `FORCE=1 seed-passive-tree`.
- **Never run destructive commands against `game_db`.** Put that sentence in every subagent prompt.

### Migrations

- **Timestamp:** strictly above the newest file in `backend/migrations/` at the time you write it. That is
  `1714440822000` today. Re-check before committing, because concurrent branches collide.

### Fixed values (exact strings)

- **Modalities:** `'image' | 'audio' | 'text' | 'sprite' | 'image_edit'`.
- **Adapters:** `'box' | 'a1111' | 'openai_compatible' | 'ollama' | 'generic'`.
- **Audio groups:** keys of `models_by_group` ⊆ `audioJobQueue.DRAIN_ORDER`, i.e. `music`, `ambience`,
  `sfx_realistic`, `sfx_retro`.
- **Backfill values:** existing audio rows get exactly `{"music":"audio:ace-step","ambience":"audio:stable-audio"}`.

### Rules every task obeys

- **The token never leaves the process.** `auth_token` is never returned, never stored in a template, and never
  exported. Every provider read goes through `serializeProvider`.
- **No silent model fallback.** A chosen model the provider no longer lists is reported as an error. It is never
  swapped for another model.
- **`models_cache` stays a flat string array** with today's meaning. Its readers are `audioGeneration.js:243`,
  `audioSubjects.js`, `audioRoutes.js:114`, `AudioAdmin.jsx:61` and the image/sprite dropdowns.

## Review Focus

1. **Saving a provider while the token field is untouched must keep the stored token.** This includes applying a
   template to an existing provider's form. Task 8 test: `applyTemplate` never sets `token_touched` and never
   touches `auth_token`.
2. **A pre-existing row with `adapter = NULL` must refresh, test and complete exactly as before.** Task 4 and
   Task 5 tests: a NULL-adapter text provider still POSTs `/api/text`, and a NULL-adapter image provider still uses
   `models_path`.
3. **A box that answers `/api/models/status` with 404 or an unknown shape must still fill the dropdowns** from the
   per-kind endpoints. Task 4 test: `discover` with models/status → 404 returns per-kind entries and
   `source: 'per_kind'`.
4. **A template whose `defaults` contain an `auth_token`, even nested, is refused** by both the save-as-template
   route and POST/PATCH. Task 2 test.
5. **An audio provider whose `models_by_group` is NULL**, for example created before the migration on another PC
   and then seeded, must still drain. The current code would fall back to learning from refusals. Task 6 test:
   `modelForGroup(null, 'music', {})` returns null and the drain makes no up-front switch.

---

### Task 0: Capture the box's discovery payloads (manual, blocks Task 4's models/status branch)

The permission system blocks agents from reading the provider token. **The user has to run the probe.**

- [ ] **Step 1:** Ask the user to run this in their own terminal and paste the output. This is the probe from the
  2026-10-21 brainstorm, the version with the `try … ->` loop that stops at the first working token:
  ```
  docker exec -i something2-backend-1 node - <<'EOF' … EOF
  ```
  The working token is on the text or audio row; the "desktop gpu" image row's token is revoked.
- [ ] **Step 2:** Paste the trimmed `/api/models/status`, `/api/model-gateway` and `/api/edit-capabilities` bodies
  into this plan, under "Task 0 result". Record:
  - whether each `/api/models/status` entry carries a kind;
  - the `audio:` ids in gateway `choices`, which should include the SFX ids.
- [ ] **Step 3:** If the user can't run it, write "Task 0 result: not captured". Task 4 then ships the per-kind
  path only, and the models/status branch becomes a no-op that returns `null`.

**Task 0 result:** _(fill in)_

---

### Task 1: Migration and provider validation

**Files:**
- Create: `backend/migrations/<ts>_ai_provider_kinds_templates.js`
- Modify: `backend/src/services/aiProviders.js` (`WRITABLE` :25-49, `providerFieldError` :108-130, `TEMPLATELESS` :18)
- Test (pure): `backend/tests/ai_providers.test.js`
- Test (DB): `backend/tests/ai_provider_kinds_db.test.js`

**Interfaces — Produces:**
- **`ai_providers` gains four columns:**

  | Column | Type | Constraint |
  |---|---|---|
  | `adapter` | text NULL | CHECK in the adapter list |
  | `models_by_group` | jsonb NULL | |
  | `discovery_cache` | jsonb NULL | |
  | `discovery_fetched_at` | timestamptz NULL | |

- **`ai_providers_modality_check` allows `image_edit`.**
- **New table `ai_provider_templates`:**

  | Column | Type |
  |---|---|
  | `id` | serial PK |
  | `name` | text UNIQUE NOT NULL |
  | `modality` | text NOT NULL, same CHECK as providers |
  | `adapter` | text NULL, same CHECK |
  | `description` | text NOT NULL DEFAULT '' |
  | `defaults` | jsonb NOT NULL DEFAULT '{}' |
  | `builtin` | boolean NOT NULL DEFAULT false |
  | `sync_uuid` | uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE |
  | `created_at` / `updated_at` | timestamptz |

  Copy the `sync_uuid` default from how `ai_providers` got its own column.
- **`aiProviders.MODALITIES`, `aiProviders.ADAPTERS`:** exported frozen arrays.
- **`providerFieldError(body, {partial})` new rules:**
  - accepts `image_edit`, `adapter`, `models_by_group`;
  - for `text` with `enabled !== false` on create, a missing or blank `model` → `'a text provider needs a model'`.
- **TEMPLATELESS:** `image_edit` is NOT in it, so `request_template` is optional-object for it. Make a
  `TEMPLATE_OPTIONAL = {'image_edit'}` set so it isn't required either.

- [ ] **Step 1: Write the failing pure tests** in `ai_providers.test.js`:
  ```js
  assert.equal(providerFieldError({ name:'a', base_url:'http://x', modality:'image_edit' }), null);
  assert.equal(providerFieldError({ name:'a', base_url:'http://x', modality:'text', model:'' }), 'a text provider needs a model');
  assert.equal(providerFieldError({ name:'a', base_url:'http://x', modality:'text', model:'', enabled:false }), null);
  assert.match(providerFieldError({ name:'a', base_url:'http://x', modality:'audio', adapter:'nope' }), /adapter must be one of/);
  assert.match(providerFieldError({ name:'a', base_url:'http://x', modality:'audio', models_by_group:{ jazz:'x' } }), /unknown audio group 'jazz'/);
  assert.match(providerFieldError({ name:'a', base_url:'http://x', modality:'audio', models_by_group:{ music: 3 } }), /must be a string/);
  assert.match(providerFieldError({ name:'a', base_url:'http://x', modality:'image', models_by_group:{ music:'x' } }), /only an audio provider/);
  ```
- [ ] **Step 2:** Run `cd backend && node --test tests/ai_providers.test.js`. Expected: FAIL on the new asserts.
- [ ] **Step 3: Write the migration.**
  - `up`: add the columns; swap the modality CHECK (pattern of `1714440821000_ai_providers_sprite_modality.js`);
    create the templates table; backfill audio rows with
    `UPDATE ai_providers SET models_by_group = '{"music":"audio:ace-step","ambience":"audio:stable-audio"}' WHERE modality='audio' AND models_by_group IS NULL`.
  - `down`: delete `image_edit` rows, then reverse the rest.
- [ ] **Step 4:** Implement the validation rules and add the new columns to `WRITABLE`. `discovery_*` is NOT
  writable. Update the existing test expecting the message `'image', 'audio', 'text' or 'sprite'` in
  `ai_providers_text_modality_db.test.js` to the new wording `"modality must be one of image, audio, text, sprite, image_edit"`.
- [ ] **Step 5: Write `ai_provider_kinds_db.test.js`** (pattern: `ai_providers_text_modality_db.test.js`):
  - POST an `image_edit` provider → 201;
  - POST a text provider with no model → 400;
  - after migrate, an audio row inserted pre-backfill can't be simulated, so instead assert the migration's
    backfill SQL by running it on a row with NULL `models_by_group` → equals the backfill value;
  - GET never contains `auth_token`.
- [ ] **Step 6:** Run the migration up, down and up again on the scratch DB, then both test files. Expected: PASS.
- [ ] **Step 7:** Commit `feat(ai-providers): image_edit kind, adapter, per-group audio models, templates table`.

---

### Task 2: Templates service and routes

**Files:**
- Create: `backend/src/services/aiProviderTemplates.js`
- Modify: `backend/src/index.js`, next to the ai-providers routes (~2872-3010)
- Test: `backend/tests/ai_provider_templates.test.js` (pure), `backend/tests/ai_provider_templates_db.test.js`

**Interfaces — Produces:**
- **`TEMPLATE_DEFAULT_KEYS`:** `['base_url','auth_header_name','request_template','model','models_path','models_pointer','response_image_pointer','sheet_layout','sheet_columns','sheet_rows','sheet_directions','models_by_group']`.
- **`templateFieldError(body, {partial}) -> string|null`:**
  - name required;
  - modality and adapter in their lists;
  - `defaults` a plain object whose keys ⊆ `TEMPLATE_DEFAULT_KEYS`;
  - **any `auth_token` key at any depth → `'templates never hold a token'`**;
  - `defaults` values pass `providerFieldError({...defaults, name:'x', base_url: defaults.base_url ?? 'http://placeholder', modality}, {partial:true})`.
- **`templateFromProvider(row, name) -> {name, modality, adapter, description:'', defaults, builtin:false}`:** picks
  only `TEMPLATE_DEFAULT_KEYS` from the row and drops nulls.
- **DB functions:** `listTemplates(db)`, `getTemplate(db,id)`, `createTemplate(db,body)`,
  `updateTemplate(db,id,patch)`, `deleteTemplate(db,id)`.
- **Routes, all `adminGuard`:**

  | Route | Returns |
  |---|---|
  | `GET /api/ai-provider-templates` | 200 list ordered by modality, name |
  | `POST /api/ai-provider-templates` | 201 / 400 / 409 duplicate name |
  | `PATCH /api/ai-provider-templates/:id` | 200 / 400 / 404 |
  | `DELETE /api/ai-provider-templates/:id` | 204 / 404 |
  | `POST /api/ai-providers/:id/save-as-template` `{name}` | 201 template / 404 / 409 |

- [ ] **Step 1: Write the failing pure tests:**
  - `templateFieldError` with `defaults:{ request_template:{ headers:{ auth_token:'x' } } }` →
    `'templates never hold a token'`;
  - an unknown key `defaults:{ enabled:true }` → `/unknown default 'enabled'/`;
  - `templateFromProvider({..., auth_token:'s', is_active:true, models_cache:['a']}, 'T').defaults` has none of
    `auth_token`, `is_active` or `models_cache`.
- [ ] **Step 2:** Run it. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement the service. Follow the module-header style of `aiProviders.js`: pure helpers first,
  then DB functions that take `db` first.
- [ ] **Step 4:** Add the routes. On a unique violation (`23505`) → 409 `{error:'a template with that name exists'}`.
- [ ] **Step 5: Write the DB test.**
  - Run create → list → patch → save-as-template from a provider that has a token.
  - Assert the response body and the stored row both lack the token: `JSON.stringify` doesn't include the token
    value.
  - Delete → 204.
- [ ] **Step 6:** Run both tests. Expected: PASS.
- [ ] **Step 7:** Commit `feat(ai-providers): editable provider templates + save-as-template`.

---

### Task 3: Seed/Export for templates and new provider columns, plus built-in presets

**Files:**
- Modify: `backend/src/services/seedSync/registry.js` (GROUPS, before `ai_providers`; fix the comment "ai_providers
  is first")
- Modify: `frontend/src/games/something2/seedExportModel.js:232` (label `ai_provider_templates: 'AI provider templates'`)
- Create: `backend/seeds/sync/ai_provider_templates.json`
- Modify: `backend/seeds/sync/ai_providers.json` (re-export from the scratch DB so the rows carry `adapter` and
  `models_by_group`)
- Test: the existing `seed_sync_registry_db.test.js`, `seed_sync_coverage_db.test.js` and
  `seed_sync_groups_roundtrip_db.test.js`, plus whatever the template group adds

**Interfaces — Produces:**
- **New group:**
  `{ id:'ai_provider_templates', label:'AI Provider Templates', tables:[{ table:'ai_provider_templates', naturalKey:['name'], omit:{ id:'local', created_at:'local', updated_at:'local', sync_uuid:'identity' }, secretColumns:[], refs:{} }] }`.
- **`ai_providers` omit additions:** `discovery_cache: 'machine cache'`, `discovery_fetched_at: 'machine cache'`.
- **Built-in presets** (`builtin: true`). `defaults` are copied from today's seed rows where a row exists, minus
  `name`/`enabled`/`modality`/token:

  | Template name | Kind | Adapter | Defaults |
  |---|---|---|---|
  | GPU box — Qwen-Image | image | box | from row "desktop gpu" |
  | GPU box — SDXL objects | image | box | from row "desktop gpu (objects)" |
  | Stable Diffusion WebUI (A1111) | image | a1111 | today's `EXAMPLE_TEMPLATE`, `models_path '/sdapi/v1/sd-models'`, `models_pointer '$[*].model_name'`, `response_image_pointer 'images[0]'` |
  | OpenAI-compatible images | image | openai_compatible | `models_path '/v1/models'`, `models_pointer 'data[*].id'`, `request_template {model:'{{model}}',prompt:'{{prompt}}',size:'{{width}}x{{height}}',response_format:'b64_json'}`, `response_image_pointer 'data[0].b64_json'` |
  | GPU box — brain | text | box | from the text row |
  | Ollama | text | ollama | `base_url 'http://localhost:11434'` |
  | OpenAI-compatible text | text | openai_compatible | `{}` |
  | GPU box — audio | audio | box | from the audio row, plus the backfill `models_by_group` |
  | GPU box — image edit | image_edit | box | `base_url 'http://192.168.0.218:8001'`, `auth_header_name 'Authorization'`, `request_template {steps:20, cfg_scale:4.0}` |
  | GPU box — sprite sheets | sprite | box | `base_url 'http://192.168.0.218:8001'`, `auth_header_name 'Authorization'` |

  Check `auth_header_name` against the existing seed rows and use whatever they hold.

- [ ] **Step 1:** Add the group and the omits. Run `seed_sync_registry_db.test.js` and
  `seed_sync_coverage_db.test.js`. Expected: PASS. Coverage fails if the table is unclassified, which is the point.
- [ ] **Step 2:** Insert the presets into the scratch DB (a one-off script under the scratchpad, not committed),
  then run `make seed-sync-export GROUP=ai_provider_templates` and `GROUP=ai_providers` **with `DATABASE_URL`
  pointing at the scratch DB**. Review the diff:
  - no `auth_token` anywhere;
  - `discovery_*` absent;
  - `sync_uuid` follows the existing file's convention.
- [ ] **Step 3:** Round trip. Create a second fresh scratch DB, migrate it, and run
  `make seed-sync-seed GROUP=ai_provider_templates`. Assert there are 10 rows and that a preset's `defaults` equal
  the file's.
- [ ] **Step 4:** Run `npx vitest run` in the frontend for the seedExportModel tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(seed-export): ai_provider_templates group + built-in presets`.

---

### Task 4: Discovery service (Refresh writes discovery_cache)

**Files:**
- Create: `backend/src/services/providerCatalog.js`
- Modify: `backend/src/services/aiProviders.js` (add `saveDiscoveryCache(db, id, cache)` next to
  `saveModelsCache` :297)
- Modify: `backend/src/index.js` refresh route (~2970)
- Test: `backend/tests/provider_catalog.test.js`, plus additions to `ai_provider_kinds_db.test.js`

**Interfaces — Produces:**
- **Entry:** `{ kind: string, id: string, label: string, available: boolean, group?: string }`.
- **`discover(provider, { fetchImpl = fetch }) -> { ok:true, cache:{ entries, unsupported, source } } | { ok:false, error, status? }`:**
  - `source` is one of `'models_status' | 'per_kind' | 'models_path' | 'ollama' | 'openai'`.
  - `unsupported` holds the entries whose `kind` ∉ `MODALITIES`.
- **Dispatch on `provider.adapter`, then on modality when the adapter is NULL:**

  | Adapter | What discovery calls |
  |---|---|
  | `box` | `fromModelsStatus` (returns null unless the Task 0 shape labels kinds), then per-kind |
  | `ollama` | `GET /api/tags` → `models[*].name` as `text` entries |
  | `openai_compatible` | `GET /v1/models` → `data[*].id`, with `kind` = provider modality |
  | `a1111` / `generic` / NULL | existing `providerDiscovery.fetchModels`, with `kind` = provider modality |

- **NULL-adapter box rows** (audio/text/sprite with NULL adapter) are treated as `box`: those modalities only exist
  on the box today.
- **Box per-kind sources:**

  | Kind | Source | Mapping |
  |---|---|---|
  | text | `textProvider.listTextModels` | as-is |
  | sprite | `gpuBoxSprites.listConceptModels` | as-is |
  | image_edit | `GET /api/edit-capabilities` | `null` → id `''`, label `'Base model'` |
  | audio | `GET /api/model-gateway` `choices` | only ids starting `audio:` |

  Each source is independent: one failing doesn't fail the others. `ok:false` only if all of them fail.
- **Shared helpers:** reuse `authHeaders`, `resolveUrl` (`providerDiscovery.js`), `safeFetch` and
  `readJsonCapped`.
- **The refresh route** additionally calls `discover` and `saveDiscoveryCache`, and returns `discovery` in the
  body. It keeps today's `models` and `models_cache` behaviour byte-for-byte.

- [ ] **Step 1: Write the failing tests** with a fake `fetchImpl` keyed by URL:
  - **box audio:** models/status → 404, gateway
    `{choices:['brain:qwen3.6-35b-a3b','audio:ace-step','audio:stable-audio']}` → audio entries are exactly
    `['audio:ace-step','audio:stable-audio']`, and `source==='per_kind'`;
  - **box:** `/api/edit-capabilities` → `[null,'pixelate']` → image_edit ids `['', 'pixelate']`;
  - **box:** text models 500 but core-models 200 → `ok:true` and sprite entries present;
  - **ollama:** `{models:[{name:'llama3:8b'}]}` → `[{kind:'text',id:'llama3:8b',…}]`;
  - **openai:** `{data:[{id:'gpt-x'}]}` with provider modality `text` → one text entry;
  - **NULL-adapter image:** goes through `models_path` (assert the fetched URL);
  - **unsupported (only if Task 0 shows labelled kinds):** a `video` entry lands in `unsupported`.
- [ ] **Step 2:** Run `node --test tests/provider_catalog.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement `providerCatalog.js` and `saveDiscoveryCache`, and wire up the route.
- [ ] **Step 4:** Add a DB test: refresh an audio provider against a local `http.createServer` box. The response has
  `discovery.entries`, and `models_cache` is still the flat style/cue strings.
- [ ] **Step 5:** Run both tests and the existing `ai_providers_text_modality_db.test.js` and
  `ai_providers_sprite_modality_db.test.js`. Expected: PASS.
- [ ] **Step 6:** Commit `feat(ai-providers): kind-aware model discovery into discovery_cache`.

---

### Task 5: Text completion by adapter (Ollama/OpenAI really generate)

**Files:**
- Modify: `backend/src/services/textProvider.js` (`callFallback` :91-121, `complete` :122, `listTextModels` :155)
- Modify: `backend/src/services/audioDispatcher.js:811` (gateway switch only for box text)
- Modify: `backend/src/index.js` text Test branch (uses `listTextModels`, which now goes by adapter)
- Test: `backend/tests/text_provider.test.js`

**Interfaces — Produces:**
- **`callChat({ url, model, headers }, req, fetchImpl) -> same shape as callBox`.** This is extracted from
  `callFallback`. `callFallback` becomes `callChat({ url: FALLBACK_URL(), model: FALLBACK_MODEL(), headers: {} }, …)`
  and its behaviour doesn't change.
- **`complete`:** if the provider's `adapter` ∈ `{'ollama','openai_compatible'}`, call
  `callChat({ url: resolveUrl(base_url,'/v1/chat/completions'), model: provider.model, headers: authHeaders(provider) }, …)`
  through `safeFetch`. Ollama serves the same OpenAI-compatible path.
  - The fallback/busy semantics are the same as `callBox`: 409/503 busy, other 5xx fallbackable, 4xx not.
  - `via: 'provider'` on success.
  - Otherwise use today's `callBox`.
- **`isBoxText(provider) -> boolean`:** `!provider.adapter || provider.adapter === 'box'`. Exported.
- **`listTextModels`:** goes by adapter — box `/api/text/models` (unchanged), ollama `/api/tags`, openai
  `/v1/models`. It returns `{ok, models: string[]}`.
- **audioDispatcher:** `textModel = textProv && textProv.model && textProvider.isBoxText(textProv) ? \`brain:${textProv.model}\` : null`.

- [ ] **Step 1: Write the failing tests:**
  - an `ollama` provider `{adapter:'ollama', model:'llama3:8b', base_url:'http://o:11434'}`:
    - `complete` POSTs `http://o:11434/v1/chat/completions` with `body.model==='llama3:8b'`;
    - it returns `{ok:true, via:'provider', text}`;
  - a NULL-adapter provider still POSTs `/api/text` with no `model` key (regression);
  - an openai provider answering 401 → `{ok:false}` with **no** fallback call made (assert the fake saw one request);
  - `isBoxText({adapter:null})===true` and `isBoxText({adapter:'ollama'})===false`.
- [ ] **Step 2:** Run `node --test tests/text_provider.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement the changes.
- [ ] **Step 4:** In `audio_dispatcher_db.test.js` (follow its deps-injection pattern), add a case: the active text
  provider has `adapter:'ollama'` → the prompt phase makes no `switchModel` call.
- [ ] **Step 5:** Run both. Expected: PASS.
- [ ] **Step 6:** Commit `feat(text-provider): Ollama/OpenAI-compatible text providers generate for real`.

---

### Task 6: Audio models per group

**Files:**
- Modify: `backend/src/services/remoteAudioProvider.js:85-101` (keep `GATEWAY_MODEL_FOR_GROUP` only as the
  documented backfill value; add `modelForGroup`)
- Modify: `backend/src/services/audioDispatcher.js:847`
- Test: `backend/tests/remote_audio_provider.test.js`, `backend/tests/audio_dispatcher_db.test.js`

**Interfaces — Produces:**
- **`modelForGroup(provider, group, learned) -> string|null`:**
  - returns `provider?.models_by_group?.[group]` when it's a non-empty string;
  - else `learned[group]`;
  - else `null`.
  - *Call made here:* an admin's configured model beats a model learned from a refusal. A blank group keeps
    learning from refusals.
- **The dispatcher line** becomes `const model = rap.modelForGroup(switchProv, group, learned);`. When `model` is
  null, `ensureModel` is skipped, the same as the SFX path today.
- **SFX `engine` is untouched.** Grep to confirm no change in `audioJobQueue.js`, `generateForSlot` or
  `generateSfxPack`.

- [ ] **Step 1: Write the failing tests:**
  ```js
  modelForGroup({models_by_group:{music:'audio:x'}},'music',{music:'audio:y'}) === 'audio:x'
  modelForGroup({models_by_group:{}},'music',{music:'audio:y'}) === 'audio:y'
  modelForGroup(null,'music',{}) === null
  modelForGroup({models_by_group:{music:''}},'music',{}) === null
  ```
  Dispatcher case: the audio provider has `models_by_group:{sfx_retro:'audio:retro-engine'}` and there is one
  sfx_retro job → `switchModel` is called with `'audio:retro-engine'`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement the change, and update the comment block at :85-97 to say the values now live on the
  provider row.
- [ ] **Step 4:** Run both test files. Expected: PASS.
- [ ] **Step 5:** Commit `feat(audio): per-group gateway model from the provider row`.

---

### Task 7: Image edit refresh/test, and the Test route's model check

**Files:**
- Modify: `backend/src/index.js` refresh and test routes
- Create (helper, pure): `backend/src/services/providerModelCheck.js`
- Test: `backend/tests/provider_model_check.test.js`, plus additions to `ai_provider_kinds_db.test.js`

**Interfaces — Produces:**
- **`missingModels(provider, entries) -> string[]`.**
  - **What it checks:**
    - text and sprite: `provider.model`
    - image_edit: `provider.model`, where blank is always fine because it means the base model
    - audio: every non-empty value in `models_by_group`
    - image: nothing, because its model list is `models_cache` and the image check stays as it is
  - **What counts as missing:** any checked value not in `entries.filter(e => e.kind === provider.modality).map(e => e.id)`.
  - **Empty entries** return `[]`: if discovery couldn't run, we can't judge.
- **Refresh for `image_edit`:** `discover` only. `models_cache` is written with the capability ids so the existing
  dropdown plumbing works.
- **Test for `image_edit`:** an authenticated `GET /api/edit-capabilities`. A 401 → `ok:false`.
- **Test for every kind except image:** after the existing reachability check, run `discover`; if
  `missingModels` is non-empty → `{ok:false, error:\`provider no longer offers: ${list.join(', ')}\`}`.

- [ ] **Step 1: Write the failing tests:**
  - `missingModels({modality:'text',model:'a'}, [{kind:'text',id:'b'}])` → `['a']`;
  - `missingModels({modality:'image_edit',model:''}, [])` → `[]`;
  - audio with `{music:'audio:x', ambience:''}` against `[{kind:'audio',id:'audio:y'}]` → `['audio:x']`.

  Also a DB test: an image_edit provider against a fake box with edit-capabilities → refresh ok, Test ok. The same
  setup with a 401 → Test `ok:false`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement the changes.
- [ ] **Step 4:** Run them, plus every `ai_providers*` test. Expected: PASS.
- [ ] **Step 5:** Commit `feat(ai-providers): image_edit discovery/test; Test reports models the provider dropped`.

---

### Task 8: Frontend form logic (pure)

**Files:**
- Modify: `frontend/src/games/something2/providerForm.js`
- Create: `frontend/src/games/something2/useAiProviderTemplates.js`, following the `useAiProviders.js` hook style
- Test: `frontend/src/games/something2/__tests__/providerFormKinds.test.js`

**Interfaces — Produces:**
- **`KINDS`:** `[{value:'image',label:'Image'},{value:'image_edit',label:'Image edit'},{value:'text',label:'Text'},{value:'audio',label:'Audio'},{value:'sprite',label:'Sprite sheets'}]`.
- **`GAME_USES = {image:true, image_edit:false, text:true, audio:true, sprite:true}`.** This drives the "not used by
  the game yet" note.
- **`emptyProviderForm(modality = 'image')`:** returns a BLANK form for that kind. `EXAMPLE_TEMPLATE` is removed
  from the default. It also gains the fields `adapter: ''` and `models_by_group: {}`.
- **`applyTemplate(form, template) -> form`:**
  - overwrites `modality`, `adapter`, and every key in `template.defaults`, converting through the same
    conversions as `providerToForm`;
  - never touches `name`, `auth_token`, `token_touched`, `has_token` or `enabled`.
- **`templatesForKind(templates, modality)`:** templates for that kind, built-in ones first.
- **`modelOptions(discoveryCache, modality, current)`:** `[{value,label}]` from entries of that kind. It keeps
  `current` even when it isn't listed, the same rule as `spriteModelOptions` (keep that function, delegating to
  this one).
- **`providerFormToPayload`:**
  - sends `adapter` (or null);
  - for audio, sends `models_by_group`, dropping blank values;
  - for image_edit, sends `model` and `request_template`;
  - text model is required by `validateProviderForm` when enabled, with the message `'Pick or type a model'`.
- **`templateToPayload(form)` / `templateToForm(row)`:** the same field handling, with no token and no
  `name`/`enabled` in `defaults`.
- **Hook `useAiProviderTemplates()`:** `{ templates, create, update, remove, saveProviderAsTemplate(id, name) }`.

- [ ] **Step 1: Write the failing tests:**
  - `applyTemplate({...emptyProviderForm(), token_touched:true, auth_token:'typed'}, tpl)` keeps
    `token_touched===true` and `auth_token==='typed'`;
  - `applyTemplate(providerToForm({has_token:true, …}), tpl)` → `providerFormToPayload` has no `auth_token` key
    (Review Focus 1);
  - `emptyProviderForm('text').request_template` doesn't contain `sd_model_checkpoint`;
  - the audio payload with `models_by_group:{music:'audio:x', ambience:''}` → `{music:'audio:x'}`;
  - `validateProviderForm({...text form, model:''})` → `'Pick or type a model'`;
  - `modelOptions({entries:[{kind:'text',id:'a'},{kind:'audio',id:'audio:b'}]}, 'text', 'gone')` values
    `['a','gone']`.
- [ ] **Step 2:** Run `cd frontend && npx vitest run src/games/something2/__tests__/providerForm`. Expected: the new
  file FAILS. Existing tests that assumed `EXAMPLE_TEMPLATE` in the empty form must be updated to call
  `applyTemplate` with an A1111 template instead. Record each one you change in the commit message.
- [ ] **Step 3:** Implement the changes.
- [ ] **Step 4:** Run all four providerForm test files. Expected: PASS.
- [ ] **Step 5:** Commit `feat(admin): provider form kinds, templates, per-kind payloads`.

---

### Task 9: Admin UI (Add provider flow, per-kind fields, Templates section) and browser verification

**Files:**
- Modify: `frontend/src/games/something2/SettingsAdmin.jsx` (the Add button :351, ProviderCard :52-341)
- Create: `frontend/src/games/something2/ProviderTemplatesSection.jsx`

**Behaviour (use the existing `--s2-*` tokens and light mode; no new design system):**
- **"Add provider"** opens step 1, a row of kind buttons from `KINDS`. Step 2 is a template list from
  `templatesForKind` plus "Blank". Choosing one renders a `ProviderCard` with `applyTemplate(emptyProviderForm(kind), tpl)`.
- **ProviderCard fields per kind:**

  | Kind | Fields |
  |---|---|
  | image | unchanged |
  | text | model `<select>` from `modelOptions` + "Other…" free-text input |
  | audio | four selects (`music`, `ambience`, `sfx_realistic`, `sfx_retro`), each from audio entries + free text; styles/cues display stays |
  | image_edit | capability select ("Base model" = blank), steps and cfg inputs written into `request_template` |
  | sprite | unchanged |

- **Every card:**
  - an adapter `<select>` (an advanced field, collapsed by default);
  - "Save as template";
  - an "Available on the provider, not used by the game" list from `discovery_cache.unsupported`, when it isn't
    empty;
  - when `GAME_USES[kind]` is false, the note `Not used by the game yet.`
- **`ProviderTemplatesSection`** is a list grouped by kind, with edit (reusing the card's field components),
  duplicate (`POST` with name `"<name> copy"`), and delete (a confirm dialog).

- [ ] **Step 1:** Implement the UI. Run `npx vitest run` and `npm run build` in `frontend`. Expected: both pass.
- [ ] **Step 2: Browser-verify** against the worktree's own vite plus the scratch-DB backend. Follow the memory
  "Dev-run & browser-verify" recipe, so you never restart the shared stack. For each kind:
  1. create from a template;
  2. Refresh (use a local fake box `http.createServer`, or the real box if a working token is available);
  3. choose a model;
  4. save;
  5. reload and reopen — the saved model is shown;
  6. Test.

  Also:
  - edit the provider's name without touching the token → Test still passes (token kept);
  - in the Templates section, save as template, edit, duplicate, delete;
  - take screenshots of each kind's card for the PR.
- [ ] **Step 3:** Commit `feat(admin): unified Add provider flow and templates section`.

---

### Task 10: End-to-end verification and merge readiness

- [ ] **Step 1:** On a fresh scratch DB: migrate up → down → up. Seed `ai_providers` and `ai_provider_templates`
  from the files. The four existing providers are present, `adapter IS NULL`, and audio has the backfilled
  `models_by_group`.
- [ ] **Step 2:** Run the full backend suite against the scratch DB, with both variables set, and the frontend
  suite.
  - Compare the failures with main's known-red list (memory "8-branch merge batch 2026-10-13", baseline-diff
    technique).
  - Run the suite **twice** to catch fail-then-pass on a fresh DB.
- [ ] **Step 3:** Run a real Ollama text check. With the local Ollama on `:20434` registered as an `ollama`
  provider and activated, write one art prompt via the admin "describe" action. `via:'provider'` is returned and no
  gateway switch appears in the backend log.
- [ ] **Step 4:** Run `grep -rn auth_token backend/seeds/sync/` and expect only the existing `secretColumns`
  metadata, if any — never a value.
- [ ] **Step 5:** Hand off via superpowers:finishing-a-development-branch.
