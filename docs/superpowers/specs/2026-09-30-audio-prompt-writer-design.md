# Audio prompt writer — design

Date: 2026-09-30. Builds on the game audio epic (SOMET-589, spec
`2026-09-28-game-audio-design.md`) and the art-descriptions epic
(SOMET-550..553). Box side is a handoff (Appendix A); everything else is
this repo.

## 1. Problem

Audio slots have no prompt anyone can see before a clip exists.

- The slot card's style/prompt fields start blank; only **Suggest**
  (`POST /api/audio/admin/propose` → box `/api/audio/propose`) fills them,
  and nothing is saved.
- Batch jobs carry no prompt. At drain time `generateForSlot` calls
  `propose` with `contextFor()`'s thin phrase (`"the Meadow biome"`,
  `"a medieval fantasy world called X with A, B regions"`). Measured
  2026-09-30: Meadow ambience came back as the `forest` style.
- SFX has no prompt at all: `entity` is `entityPhrase()` (a lowercased
  creature name, an item name, a skill's English name) plus `(take N)`.

## 2. Outcome

Every audio slot — world/biome music and ambience **and** all SFX slots
(~2,300 rows in the slot table) — can carry a **stored, versioned,
editable prompt**, written in bulk by an instruct LLM running on the GPU
box (CPU Ollama fallback), and used by both the per-slot Generate and the
batch drain.

Success:

1. `make audio-describe` fills prompts for every slot kind, resumably.
2. The slot card shows the stored prompt pre-filled, who wrote it, and a
   stale badge; an admin can edit/save it or re-write it with a hint.
3. A clip generated with no request prompt uses the stored one (music:
   `prompt` + `style`; SFX: `entity`), verified live on the box.
4. The slot table shows prompt coverage (none / written / stale).

Out of scope: moving the image art describer (`subjectDescriber.js`) onto
the new text client (a later one-line follow-up); an in-UI bulk writer
with its own job queue; a model picker for the text provider.

## 3. Box text endpoint and `textProvider`

### 3.1 Box (handoff — Appendix A)

`POST /api/text` and `GET /api/text/models`, same bearer keys, the text
model **loaded through the model gateway, never resident** (VRAM is the
known wedge cause: <7 GB free = one pipeline). 409 = gateway busy /
switching, 503 = model unavailable; neither means "broken". Cold load up
to ~2 min.

### 3.2 Provider registration

- `ai_providers.modality` gains `'text'` (validator in `aiProviders.js`
  currently accepts `'image' | 'audio'`). One active provider per
  modality, like audio. `request_template` is not required for `'text'`
  (same rule as audio).
- AI Providers form: `text` appears in the modality select; the card hides
  Model (as audio does) and shows `GET /api/text/models` read-only.

### 3.3 `backend/src/services/textProvider.js`

```
complete({ system, prompt, jsonSchema, temperature, maxTokens },
         { db, fetchImpl, env }) →
  { ok: true,  text, json, model, via: 'box' | 'fallback', ms }
| { ok: false, error, busy, via }
```

- Never throws.
- Order: active `text` provider → on **no provider / 409 / 503 /
  transport error / timeout** → local Ollama at `ART_DESCRIBER_URL`
  (OpenAI-compatible `/v1/chat/completions`, `response_format` with the
  schema, model `ART_DESCRIBER_MODEL`). Any other 4xx is our bug: no
  fallback, return the error.
- `opts.boxOnly` disables the fallback (batch `BOX_ONLY=1`).
- Timeout `TEXT_PROVIDER_TIMEOUT_MS`, default 300000 (a model is always
  cold exactly when someone first clicks — art-describer lesson).
- Temperature default `AUDIO_PROMPT_TEMPERATURE` = 0.15 (0.4 made two
  runs of the same contract agree on 7/20).

## 4. Data model

Migration `audio_prompts`:

| column | type | notes |
|---|---|---|
| `id` | bigserial PK | |
| `subject_kind`, `subject_key`, `slot` | text not null | the Audio tab's slot key |
| `style` | text null | music/ambience only; must be a box style value |
| `text` | text not null | prompt (music/ambience) or entity phrase (sfx); `''` allowed = deliberately cleared |
| `source_input` | text null | the exact context string the LLM was given; null for hand-written |
| `hint` | text null | admin hint used for this write, if any |
| `model` | text null | null = written by a person |
| `via` | text null | `'box' \| 'fallback'`, null when hand-written |
| `active` | boolean not null default true | |
| `created_at` | timestamptz not null default now() | |

Partial unique index on `(subject_kind, subject_key, slot) WHERE active`.
Saving = one transaction: deactivate the current active row, insert the
new one. Old rows remain as history.

Migration timestamp: pick above the current highest at implementation
time and re-check against every open branch (collision memory).

Export/seed: `make audio-export` / `audio-seed` carry active prompts in
the manifest (`prompts.json`), merged by kind like the existing manifests,
so a seeded box (Orange Pi) gets the prompts too.

## 5. LLM input: `audioPromptContext(db, kind, key, slot)`

One function (new `backend/src/services/audioPromptContext.js`) builds
the context string. That string is what gets stored in `source_input`.

| kind | inputs |
|---|---|
| world | name, biomes, `level_min`–`level_max` |
| biome | name, `art_style` |
| creature, world_point | name; the **active `art_prompt_descriptions` text** if one exists, else `entity_types.prompt` |
| item | name, `category`, `req_level`; the active art description if one exists |
| skill | English name, class, type; the active art description if one exists |
| attack_type | key plus the existing `ATTACK_TYPE_PHRASE` for the slot |
| every sfx slot | also the box cue (`slash`, `hit`, …) |

- Music/ambience contract: return `{style, prompt}`. The style list comes
  from `rap.listStyles()` for that clip kind. A style not in the list →
  one retry → fail for that slot.
- SFX contract: return `{entity}` — a short phrase describing the
  **source** of the sound (material, size, creature voice), not the cue
  itself; the box cue already carries the action.
- Optional admin `hint` is appended as a separate labelled line and
  stored in `hint`; it is not part of `source_input`.

**Stale** = the active row has a non-null `source_input` that differs
from what `audioPromptContext` builds now. A stale prompt is **still
used** and only flagged — dropping it would silently undo a choice someone
made (art-descriptions rule). Hand-written rows (null `source_input`) are
never stale.

## 6. Generation precedence

In `generateForSlot` / `generateSfxForSlot`, first match wins:

1. The request's own `style`/`prompt` (card Generate with typed text).
2. The active `audio_prompts` row for the slot.
3. Current behaviour: `propose(contextFor…)` for music/ambience,
   `entityPhrase` for sfx.

SFX: the stored text becomes `entity`, and `sfxEntityText(text, take)`
still appends `(take N)`. Editing a prompt therefore also gets past the
box's global SFX cache on its own. A stored `''` means "no prompt" and
falls through to step 3.

Queued jobs (`audio_jobs`) are enqueued **without** a prompt, as they are
now, so the drain reads the stored prompt at run time: a prompt edited
while a batch is queued is the one used.

The clip keeps recording the prompt the box reports it used
(`audio_clips.prompt`), unchanged.

## 7. API

Under `/api/audio`, adminGuard'd like the rest of `/admin`:

- `GET /admin/prompts/:kind/:key` → the active prompt per slot plus
  `stale`, `currentInput`, and history.
- `PUT /admin/prompts/:kind/:key/:slot` `{style?, text}` → saves a
  hand-written version (`model`/`via`/`source_input` null).
- `POST /admin/prompts/:kind/:key/:slot/write` `{hint?}` → synchronous
  LLM write; stores and returns the new active row. On failure,
  `502 {error, via}`.
- `GET /admin/subjects` / slot-table rows gain `prompt_state`:
  `'none' | 'written' | 'stale'`, computed in the same query (no N+1).

## 8. Batch: `make audio-describe`

`backend/scripts/describe-audio-slots.js`, env options `DRY=1`,
`LIMIT=`, `KIND=`, `SLOT=`, `STALE=1` (rewrite stale rows only),
`BOX_ONLY=1`.

- Resumable with no cursor: a slot with an active row is skipped (except
  stale rows under `STALE=1`). Killing it is safe.
- Sequential, one slot at a time. Busy box → fallback, or wait-and-retry
  under `BOX_ONLY`.
- A failure is logged and counted, and the run moves on; a busy box never
  stops the run.
- End summary per kind: written / failed / via box / via fallback /
  **duplicate texts** (identical `text` across different subjects),
  which surfaces the "everything is a generic sword" collapse measured in
  the art epic.
- Runs from the backend container, which has nodemon watching
  `backend/`. **Do not edit backend files while a batch runs** (the
  art-batch-dies-on-backend-edit trap).

**Canary before the full run:** ~20 slots per kind at the default
temperature, run **twice**, then compare agreement and duplicate counts
before any run over all slots. The full run needs the user's go-ahead.

## 9. UI

Slot card (`AudioSlotCard.jsx`):

- A prompt row for **every** clip kind (SFX included — today it has none).
  Music/ambience: style + prompt. SFX: an entity phrase field.
- Pre-filled from the stored active row. A provenance line shows the
  model and `box`/`fallback`, or "edited by hand", plus a stale badge
  with the current input shown on hover or expand.
- **Save**: a new hand-written version. Local draft state keeps
  null ("nobody typed") distinct from `''` ("cleared") — reuse the
  `artDescriptionDraft.js` rules.
- **Write with model**, with an optional hint field; the button shows
  pending across remounts (the same `useIsMutating` pattern the card
  already uses for Generate).
- Suggest (box `propose`) stays for music/ambience as a quick,
  non-stored fill.

Slot table: a Prompt column (none / written / stale) and a `prompt`
filter with those three values, carried through the URL params like the
existing filters (ref-carried pending params — the same-tick clobber
trap).

## 10. Errors

| case | behaviour |
|---|---|
| box 409/503, transport error, timeout | fallback to Ollama (unless boxOnly) |
| box other 4xx | fail, no fallback, error surfaced |
| invalid JSON / empty / style not in list | one retry, then fail that slot |
| no text provider and no Ollama | write fails (502); generation unaffected (step 3) |
| stale prompt | used, flagged |

Generation never waits on text: a missing prompt means today's path.

## 11. Testing

TDD through public seams; one scratch DB with its own per-file lock key;
`TEST_DATABASE_URL` and `DATABASE_URL` both set.

- `textProvider` (unit, injected fetch): box OK; box 409 → fallback with
  `via:'fallback'`; no provider → fallback; boxOnly + 409 → busy failure;
  other 4xx → no fallback; bad JSON → retry → fail. The fake records the
  request and **asserts the schema and prompt it received**.
- `audioPromptContext` (unit + DB): per kind, including the "active art
  description present" vs "absent → entity_types.prompt" branches — a
  similar branch was dead in the art epic because only the fixture
  reached it.
- Stale: changed biome `art_style` → stale; hand-written → never stale.
- `audio_prompts` store (DB): versioning, one active row, `''` vs null.
- Generation precedence (DB): request beats stored beats propose/entityPhrase;
  sfx `entity` = stored text + `(take N)`. The fake box **fails on an
  unexpected prompt/entity** (no input-ignoring mocks).
- Batch script (DB): skip-if-active, `STALE=1`, `DRY` writes nothing,
  duplicate count.
- Frontend (vitest): draft null/`''` model, `prompt_state` filter
  param merge.
- Live: one real `/api/text` call per kind once the box lands; canary
  twice; one real music track and one SFX pack generated from stored
  prompts, checked in the browser (prompt pre-filled, clip's recorded
  prompt matches).

## 12. Slices

1. **Text client + provider modality** — `textProvider`, `'text'`
   modality, AI Providers form; testable against Ollama before the box
   endpoint exists.
2. **Store + context + generation precedence** — migration,
   `audioPromptContext`, API, `generateForSlot` changes, export/seed.
3. **Batch** — `make audio-describe` + canary.
4. **UI** — slot card editor, table column and filter, browser
   verification.

Slice 1 does not depend on the box; slice 3's canary is more useful after
Appendix A lands but works on the fallback.

---

## Appendix A — box handoff: `/api/text`

For the session that owns the GPU box service (192.168.0.217:8001).

**Endpoints** (bearer auth, like every other route; suggested key name
`something2-text`):

```
POST /api/text
{ "system": str?, "prompt": str, "max_tokens": int = 256,
  "temperature": float = 0.15, "json_schema": object? }
→ 200 { "text": str, "json": object|null, "model": str, "ms": int }

GET /api/text/models
→ 200 [ { "value": str, "label": str, "loaded": bool } ]
```

- When `json_schema` is present, use constrained decoding (grammar or
  JSON mode) so `json` validates against it; `text` is the raw output.
  If decoding cannot satisfy the schema → 422 `{detail}`.
- **The model is loaded through the existing model gateway**, same as the
  image and audio models: never kept resident alongside a diffusion or
  audio pipeline. VRAM headroom is the known wedge cause
  (`dxgkio_make_resident -12`). 409 while switching or busy
  (same meaning as `/api/model-gateway/switch`), 503 when it cannot load.
- **No caching by request body.** The caller may send the same prompt
  twice on purpose (canary agreement runs); the audio SFX cache ignoring
  the seed caused real trouble.
- Model: an **instruct** model (not coder-tuned), ~7–8B at Q4 or smaller,
  chosen so it loads within the free VRAM when nothing else is loaded.
  Report its id in `model`.
- Cold load of up to ~2 min is acceptable; the caller waits 300 s.
- Measure and report back: cold and warm latency for a ~200-token JSON
  answer, and VRAM while loaded.
