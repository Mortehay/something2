# LLM-authored art prompts — implementation plan

**Date:** 2026-09-05
**Depends on:** SOMET-547 (history), SOMET-548 (prompt notes)
**Route:** custom lightweight plan, sliced. Requirements were settled in a grilling
session; Superpowers brainstorming would re-tread them.

## Why

Base prompts are built by template from a row's name:
`a ${deslug(name)}, a fantasy ${category}` (catalogSubjects.js:67). That produces
**"a darts, a fantasy weapon"** — ungrammatical and ambiguous — and SDXL resolved
it to a dartboard. For skills it is worse: `"Crushing Blow, a Warrior melee
ability"` draws a warrior, which commit 6d57c77 recorded as an unfixed problem
and made a gate on proceeding to a full batch.

A local model writes a real description instead. Measured on the failing case:

```
template            "a darts, a fantasy weapon"        -> a dartboard
qwen2.5-coder:7b    "Pointy dart with feather."
llama.cpp :20445    "Sharp projectile with feathered tip."
```

## THE NUMBER THAT SHAPES THIS PLAN

Subjects missing art, by kind:

| kind | total | missing |
|---|---|---|
| item | 189 | 102 |
| **skill** | 300 | **300** |
| **passive_label** | 128 | **128** |
| entity | 308 | 0 |
| tile | 50 | 0 |

**428 of the 530 missing subjects are skills and passive labels** — abstract
subjects, not objects. That is 81% of the work, and it is precisely the category
where "describe the object" is the wrong frame: an ability icon is not a thing
with a shape. Proving the contract on items and discovering it fails on skills
would waste the whole batch, so slice 1 targets the hard case FIRST.

## Decisions already made (do not re-litigate)

1. One authoring pass per subject, **stored**, re-runnable, with a length setting.
   Not per-generation: that makes two runs incomparable and undoes SOMET-547.
2. **Local CPU model** (llama :20445 or ollama :20434). The GPU box's effective
   headroom is under one SDXL pipeline; an LLM there competes for the exact VRAM
   behind every ENOMEM fault. CPU also lets prompt-writing and image generation
   run concurrently.
3. **Auto-used for subjects with no art.** Subjects that already have art keep it.
4. **Strict output contract + few-shot exemplars.** A system prompt alone drifts
   at 7B, and inconsistent phrasing across 975 rows becomes inconsistent art.

## Slices

### Slice 1 — the contract, proven on the hard case

The risky question answered before anything is built to scale.

- Write the system contract (one noun phrase, object only, no art-style words,
  no colours unless the name implies one) and 4-6 hand-written exemplars
  spanning a weapon, armour, a ring, **a skill** and **a passive label**.
- A single function `describeSubject(subject, { length })` calling the local
  model, plus a throwaway script that prints template-vs-LLM for N subjects.
- Run it over ~10 skills, ~5 passive labels, ~5 items. Generate images for a
  subset and look at them.

**Deliverable is a decision, plus the exemplars.** If abstract subjects need a
different contract (likely — an ability is a symbol, not an object), that is
discovered here for the cost of ~20 generations rather than 428.

**Verification:** a side-by-side of template vs LLM images for the sample. The
only useful measure is human judgment: is it recognisably the named thing.
There is no automated check — every guard we have passed a dartboard.

### Slice 2 — storage, and one description used end to end

- Table `art_prompt_descriptions`: `(id, subject_kind, subject_key, text,
  length, model, active, created_at)`. Re-runs insert a new row and deactivate
  the previous, so history is preserved (same rule as art_prompt_notes).
- `catalogSubjects` prefers an active stored description over the template for
  `basePrompt`; absent, nothing changes.
- Add `prompt_model` to `art_generations` — SOMET-547 records which IMAGE model
  ran but would not record which LLM wrote the prompt. Without it the history
  can no longer explain a prompt, which is the hole this feature would open in
  the work shipped today.

**Verification:** a stored description reaches the composed prompt (assert it
appears, and that a deactivated one does not); with none stored the prompt is
byte-for-byte what it is today. Negative control: remove the lookup and the
first test must fail.

### Slice 3 — the batch authoring pass

- A resumable CLI over subjects missing art, honouring the length setting,
  writing one description per subject, skipping those that already have one.
- Runs on CPU concurrently with GPU image generation.

**Verification:** run it over the 128 passive labels first (smallest of the two
hard kinds), confirm every row got a description, then spot-check 10 by eye.

### Slice 4 — UI

In the preview modal beside the notes: show the active description, its length
and model; edit it; re-run at a chosen length. Length is a select, not free
text.

**Verification:** in the browser — edit a description, regenerate, confirm the
recorded prompt in the history reflects the edit.

## Scope

**In:** description authoring, storage, batch pass, UI, and the `prompt_model`
column.

**Out:** inpainting or masks (deferred, provider capability unverified);
replacing prompt notes (they layer on top of the description); regenerating art
that already exists; entities and tiles (both fully covered already).

## Assumptions

- The local models stay available on :20445 and :20434. Neither is pinned by
  version today; slice 2's `model` column records what was used, which is the
  minimum needed to explain a description later.
- ~10-30s per description on CPU, so 530 subjects is 3-8 hours as a one-time
  background pass. Not verified at scale — slice 3 should measure the first 20
  and extrapolate before committing to the rest.

## Acceptance criteria (user-visible)

- Opening a subject in the art console shows the description that will be used,
  where it came from, and lets it be edited or re-run at a chosen length.
- A subject with no art generates from a written description rather than
  `a ${name}, a fantasy ${category}`.
- Nothing that already has art changes unless someone asks for it.
- The generation history explains any image: which prompt, which image model,
  and which model wrote the prompt.

## Risks and unresolved

- **Abstract subjects may not fit one contract.** 81% of the work. Slice 1
  exists to find out cheaply; if it fails, skills need their own approach and
  this plan covers items only.
- **The model is confidently wrong in ways no guard sees.** Both models turned
  `darts` into ONE dart when the item is presumably a stack. The ambiguity moved
  rather than vanished; prompt notes remain necessary.
- **A stored description is a second source of truth.** If a catalogue row is
  renamed, its description goes stale silently. No mechanism proposed here —
  worth deciding before slice 3 writes 530 of them.
- **`qwen2.5-coder:7b` is coder-tuned.** It performed acceptably on the one case
  tested; a general instruct model may be better, and pulling one is ~5GB.
  Unresolved, and slice 1 is where to settle it.
