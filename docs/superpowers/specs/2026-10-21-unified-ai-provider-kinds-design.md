# Unified "Add provider": per-kind forms, templates, model discovery

Date: 2026-10-21. Status: draft, awaiting approval.

## Why

When you click "Add provider" in Settings → AI providers, the form always pre-fills one hardcoded A1111
image request (`EXAMPLE_TEMPLATE`, `frontend/src/games/something2/providerForm.js:18`). That happens even when
the provider is meant for text, audio or image edit.

Text and audio providers also have no model choice:

- **Text.** The form only *displays* the model list (`SettingsAdmin.jsx:256-262`). A text provider created in the
  UI has an empty `model`, so the audio drain fails with `NO_TEXT_MODEL`. The current one only works because its
  model came from the seed.
- **Audio.** Models are hardcoded: `GATEWAY_MODEL_FOR_GROUP = {music:'audio:ace-step',
  ambience:'audio:stable-audio'}` (`remoteAudioProvider.js:98-101`). SFX has no mapping at all.

The GPU box (`http://192.168.0.218:8001`) keeps growing: new models, and possibly whole new kinds of generation.
The admin UI should pick up what the box offers when you click Refresh, not wait for a code change.

## Goals

1. **Add provider is a three-step flow.** Pick the kind, pick a template for that kind (it fills the form), then
   edit only the fields that kind uses.
2. **Every kind can choose its model(s) from a list the provider reports.** If the provider can't report a list,
   you type the value.
3. **Templates are data, not code.** Built-in presets ship as seeded rows. You can create, edit, duplicate and
   delete templates in the admin UI.
4. **Discovery is generic enough for new box capabilities.** Refresh shows new models in the dropdowns. A box kind
   the game doesn't support yet is listed as "available on the box, not used by the game". It is never
   pretended-usable.
5. **Seed/Export carries all of it.** That means the new per-kind provider fields and the new templates group.

## Non-goals

- Any game feature that *uses* image edit. Image edit becomes a registrable provider kind only.
- Changes to the GPU box itself.
- Changing the sprite kind's behaviour. It keeps its concept-model dropdown from commit 8e3aec1b.
- Auto-creating providers from discovery. Discovery informs; a human registers.
- Changing per-type pins (`entity_types/tile_types.ai_provider_mode/_id`).

## Anti-goals (a failure even if it "works")

- **Silent model fallback.** If a chosen model is missing on the provider, show that and refuse to use it. Never
  quietly use another model. This is the same rule as `resolveConceptModel` refusing SDXL.
- **A token leaving the machine.** Templates never hold a secret. Seed/Export keeps `auth_token` out.
- **Breaking existing providers.** Seeded and dev-DB providers (the two image rows, audio, text) must keep working
  unchanged after the migration, with no manual re-entry.
- **A dropdown that offers models the kind can't use.** For example, a text model offered to an audio group.

## Current state (facts this design relies on)

### Providers table

- **Table:** `ai_providers`, with a single `model` text column.
- **Allowed kinds:** `modality IN ('image','audio','text','sprite')`. The kind is fixed after creation, and there
  is at most one active provider per kind (migrations `1714440360000`, `…560000`, `…610000`, `…821000`).
- **Service:** `backend/src/services/aiProviders.js`.
- **Routes:** `backend/src/index.js` ~2872-3010. These are list/get/post/patch/delete/activate/refresh-models/test,
  and the refresh and test routes branch per kind.

### How `model` is used today, per kind

| Kind | Use of `model` |
|---|---|
| image | `{{model}}` in `request_template` |
| sprite | concept `llm_name` |
| text | gateway target `brain:${model}` (`audioDispatcher.js:811`). `textProvider.complete()` never sends a model. |
| audio | ignored |

### Box endpoints

**Seen in the box's OpenAPI (fetched 2026-10-21):**

| Endpoint | What it does |
|---|---|
| `GET /api/model-gateway` | Gateway status and `choices` |
| `POST /api/model-gateway/switch {model, force}` | Pins a model. Returns 409 while any job is pending, unless `force`. |
| `GET /api/models/status` | "Declared / on disk / in use / how it performs, in one payload" |
| `GET /api/text/models` | Static roster, no `brain:` prefix |
| `GET /api/core-models` | Concept roster |
| `GET /api/edit-capabilities` | LoRA list. `null` means the base model. |
| `POST /api/edit {source, instruction, capability, steps, cfg_scale, seed}` | Image edit |
| `GET /api/audio/styles[?kind=sfx]` | Audio styles |
| `POST /api/audio {kind,…}` | **No model field.** The box picks the model, or the gateway pin decides it. |
| `POST /api/audio/sfx {cue, engine, …}` | **`engine` is chosen per request** |

**Not yet seen.** All responses are untyped in the OpenAPI. The live payloads of `/api/models/status` and
`/api/model-gateway` were not captured: the probe used the "desktop gpu" image row, whose token the box rejects
as **revoked**. That token is a separate issue, worth fixing before any testing.

### Seed/Export and drain groups

- **Seed/Export:** registry group `ai_providers` (`backend/src/services/seedSync/registry.js:83-102`).
  - natural key: `name`
  - omitted: `models_cache`, `models_fetched_at`, `is_active`
  - secret: `auth_token`
  - file: `backend/seeds/sync/ai_providers.json`
- **Audio drain groups:** `music, ambience, sfx_realistic, sfx_retro` (`audioJobQueue.DRAIN_ORDER`).

## Design (decided)

### Kinds

Add `image_edit` to the modality check (new migration).

| Kind | Status after this work |
|---|---|
| image, audio, text, sprite | Unchanged meaning |
| image_edit | New. Registrable, refreshable and testable. No game consumer yet, so the provider card shows a "not used by the game yet" note. |

### Model fields per kind

**image.** Same as today: `model` plus `request_template`, `models_path`/`models_pointer`,
`response_image_pointer` and the sheet fields.

**text.** `model` becomes a real dropdown, filled from `/api/text/models`, with free text when no list is
available.

*Decided by the user:* text providers made from the Ollama and OpenAI-compatible templates must **really generate
text in the game**, not just be registered. To do that:

- **`textProvider.complete()` switches on the active text provider's `adapter`.**
  - `box` or `NULL`: today's `/api/text` path.
  - `openai_compatible` / `ollama`: a chat-completions call that sends the provider's `model`. The existing
    `ART_DESCRIBER_URL` fallback already speaks this format (`textProvider.js:30-31`), so reuse that code.
- **The audio drain's gateway switch to `brain:${model}` runs only for box text providers.** A non-box text
  provider needs no switch.
- **Text model discovery** for these adapters uses Ollama `/api/tags` → `models[*].name` and OpenAI
  `/v1/models` → `data[*].id`. Validation: a text provider can't be saved enabled with an empty model, which closes the `NO_TEXT_MODEL`
gap.

**audio.** New jsonb column `models_by_group`, e.g.
`{"music":"audio:ace-step","ambience":"audio:stable-audio","sfx_realistic":"…","sfx_retro":"…"}`.

- **Music and ambience:** the value is the gateway switch target, because the request itself can't carry a model.
- **SFX:** the value is **only** the gateway switch target for that drain group (`audioDispatcher.js:847`
  `ensureModel`). *Builder-check call:* it never overwrites `engine`. Each SFX job keeps its own engine
  (`'realistic'`/`'retro'` or a per-cue engine), `drainGroupFor` keeps deriving the group from that engine, and the
  queue, `generateForSlot` and pack building are untouched.
- **Where the dropdown options come from (builder-check call):** the gateway's `choices` with the `audio:` prefix,
  plus `/api/models/status` entries labelled audio if it labels kinds. Free text is always allowed. A `brain:` id is
  never offered here.
- **Removing the hardcoded map:** `GATEWAY_MODEL_FOR_GROUP` stops being the source of truth. The migration
  backfills `models_by_group` on existing audio rows with today's two hardcoded values. A blank group keeps
  today's behaviour, which is learning the model from refusals. Making that learning work is not in scope.
- **The form:** one dropdown per group.

**image_edit.** Two settings:

- **`model` holds the default capability.** It is chosen from `/api/edit-capabilities`, and blank means the base
  model.
- **The request settings live in `request_template`.** These are steps and cfg, and the provider stores them like
  an image provider does.

**sprite.** Unchanged.

### Discovery (Refresh)

Refresh produces a normalised list of `{kind, id, label, available, group?}` and stores it in a **new** jsonb column
`discovery_cache`.

**`models_cache` keeps its current flat-string shape and meaning (builder-check call).** These readers depend on it:

- audio cue check `audioGeneration.js:243`
- `audioSubjects.js`
- `audioRoutes.js:114`
- `AudioAdmin.jsx:61`
- the image and sprite dropdowns

`discovery_cache` is omitted from Seed/Export as a machine cache, the same way `models_cache` is.

**Box providers:**

1. **Read `/api/models/status` first.** Use it if its entries say which kind each model is.
2. **Otherwise use the per-kind endpoints in the table above,** which each say their own kind.
3. **Unsupported kinds.** An entry whose kind matches no supported modality goes into an `unsupported` list. The
   provider card shows it as "available on the box, not used by the game".

**Non-box image providers** keep `models_path`/`models_pointer`.

**Picking an endpoint.** The adapter is chosen by the template a provider was created from (see Templates), not
by sniffing the URL.

### Templates

New table `ai_provider_templates`:

| Column | Meaning |
|---|---|
| `id` | |
| `name` | Unique |
| `modality` | |
| `adapter` | `box` \| `a1111` \| `openai_compatible` \| `ollama` \| `generic`. This selects discovery and test behaviour. |
| `description` | |
| `defaults` | jsonb. Any writable provider field except the secret, e.g. `base_url`, `auth_header_name`, `request_template`, `models_path`, `models_pointer`, `response_image_pointer`, sheet fields, `model`, `models_by_group`. |
| `builtin` | bool |
| `sync_uuid` | |
| `created_at` / `updated_at` | |

`ai_providers` gains a nullable `adapter` column. The value is copied from the chosen template when the provider
is created and can be edited afterwards. *Builder-check call:* `NULL` means "today's per-kind behaviour", and
existing rows are not backfilled. That way the four existing rows keep refreshing and testing exactly as they do
now. It is **not** a foreign key: deleting or editing a template never changes
a provider that already exists.

**Templates admin.** A "Templates" section in the AI providers settings, with list/create/edit/duplicate/delete.

- `defaults` is edited as fields for its kind. Raw JSON is used for `request_template` only.
- `builtin` rows can be edited too. `builtin` only marks where a row came from.
- Templates are rejected if `defaults` contains `auth_token`, on both server and client.

**Built-in presets** are seeded and exported via Seed/Export:

| Kind | Presets |
|---|---|
| image | GPU box (Qwen-Image), GPU box SDXL objects (the current two rows' settings), Stable Diffusion WebUI (A1111), OpenAI-compatible images |
| text | GPU box brain, Ollama (`/api/tags`), OpenAI-compatible (`/v1/models`) |
| audio | GPU box audio |
| image_edit | GPU box edit |
| sprite | GPU box sprite sheets |

Each preset's `defaults` is copied from today's working seed rows where they exist.

### Add provider flow

1. Choose the kind.
2. Choose a template, filtered by kind. "Blank" is also offered.
3. The form opens pre-filled with the template's defaults, showing only that kind's fields, plus Refresh and Test.
4. On save, `adapter` is copied from the template.

**Saving a provider as a template.** "Save as template" on an existing provider copies its non-secret fields into a
new template.

### Test

- **Per kind:** auth plus one listing call, or for image, today's one-step generation.
- **The model check:** Test reports a chosen model or group model that the provider no longer lists as an error,
  per the anti-goal on silent fallback.

### Seed/Export

- **`ai_providers` group:** gains `adapter` and `models_by_group`. Secret handling and the omit list are unchanged.
- **New group `ai_provider_templates`:**
  - natural key: `name`
  - omitted: `id`, timestamps
  - no secret columns
  - file: `backend/seeds/sync/ai_provider_templates.json`
  - label: added in `seedExportModel.js`
- **Order:** templates come before providers in the registry. They have no FK, but this keeps import order natural.

## Left to the builder

- **The exact shape of `/api/models/status` and `/api/model-gateway`.** Task 0 is to capture both live, using a
  provider whose token works (the text or audio row), and to write the normaliser against what they return.
  - **If neither labels kinds:** use the per-kind endpoints only. Record "new box kinds won't auto-appear until the
    box labels kinds" as a known limit.
  - **If they do label kinds:** decide whether discovery runs once per box origin or once per provider.
- **The SFX model and engine IDs.** Read them from the box, then backfill.
- **UI layout** of the kind and template step. It should follow existing admin patterns (`--s2-*` tokens, light
  mode).
- **Migration numbering.** Watch the timestamp collision pattern with concurrent branches.

## Verification expectations

- **Migration round trip** on a scratch DB, never `game_db`. Existing rows must keep working: the image rows
  generate, the audio drain switches to the same models as before, and text completes.
- **Create one provider per kind from a template in the browser.** For each: Refresh fills the dropdown, Test
  passes, saving persists, and reopening shows the saved model.
- **Seed/Export round trip** for both groups. No token appears in either file.
- **A text provider can't be saved enabled without a model.**
- **An Ollama or OpenAI-compatible text provider, when active, writes a real art prompt and audio prompt end to
  end.** The local Ollama on `:20434` is one reachable target. The audio drain must make no gateway switch for it.
