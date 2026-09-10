# Corrections should reshape the description, not the prompt

SOMET-558 follow-up. Planned 2026-09-10.

## The problem, as measured

An operator wrote this correction against `item/arrow`:

> we need arrow from a bow, you drawn a rocket, and not all background at image
> is transparent near the arrow

It was applied. `art_generations.composed_prompt` shows it landing verbatim in
the **positive** prompt, in the slot `objectPrompt.js` reserves for corrections:

```
only an arrow, a fantasy ammo and nothing else, one single object, centered,
flat solid neutral grey background, no frame, ... no other objects,
we need arrow from a bow, you drawn a rocket, and not all background at image
is transparent near the arrow,
pixel art RPG game asset, isometric 3/4 top-down view, ...
```

Three things are wrong with that, and none of them is the provider's fault.

1. **The correction is written as feedback to an agent.** SDXL is a stateless
   text-conditioned sampler with no memory of its last attempt. "you drawn a
   rocket" cannot be understood as a complaint; CLIP has no reliable negation,
   so the token *rocket* is conditioned **in**. The correction plausibly made
   the next image worse.
2. **Half of it targets a component that never sees a prompt.** "not all
   background is transparent" is about the provider's flood-fill cutout. No
   prompt text can affect it. Today it rides along adding tokens and doing
   nothing.
3. **The subject phrase was the real defect all along.** `arrow` has no
   description row, so it fell back to the catalogue template: `an arrow, a
   fantasy ammo`. Given *ammo, fantasy game asset*, a rocket is a defensible
   reading. The same failure killed `archmage staff` (`a fantasy weapon, arcane
   element`) until a description — `ornate wizard staff with a faceted violet
   gem at its tip` — replaced it and it generated first try.

## The discovery that reframes this

**There is no description UI.** SOMET-551 shipped `POST/GET
/api/art-subjects/:kind/:key/description` and `backend/scripts/describe-subjects.js`,
but `ArtConsoleAdmin.jsx` contains no reference to descriptions. Only three
subjects have one, all created out-of-band.

The correction box is the console's *only* affordance for "this came out
wrong". So every intent — including intents that are really descriptions — gets
expressed as a correction. The behaviour follows the UI. Fixing the routing
without exposing descriptions would leave the same funnel in place.

## Decisions already taken

Confirmed in grilling; not reopened here.

| # | Decision |
|---|---|
| 1 | Corrections reshape the **description**; exclusion-shaped corrections also reach `negative_prompt`. |
| 2 | The seed salt derives from the **active description's `id`**. No description = salt 0, so the 87 template-generated items stay byte-identical. A new description version = a new seed automatically. |
| 3 | Correction lifetime splits by type: reshaping notes are consumed into a description version then deactivated; exclusion notes persist. Deactivated, never deleted. |
| 4 | The describer sees: catalogue row + current active description + corrections + outcome history. |

## Challenges to those decisions

Raised now rather than discovered in implementation.

### Drop the LLM classifier — use two boxes

Decision 3 needs each note classified as reshaping or exclusion, and the
proposal was to have the LLM do it and show its guess for approval. That buys a
misclassification failure mode, an approval step, and a prompt to tune.

Two labelled inputs get the same result with none of it:

- **"What it should look like"** → feeds the description rewrite.
- **"What to avoid"** → appends to `negative_prompt`, persists.

The operator already knows which they mean. This also removes the fourth,
awkward category by construction: a complaint about the cutout fits neither box,
so the UI never invites it.

**Recommendation: two boxes. Classification by LLM is not planned.**

### Question the describer model before building around it

`ART_DESCRIBER_MODEL` defaults to `qwen2.5-coder:7b`, and that is what the local
`llama` service is serving. A code-specialised model is writing visual object
descriptions.

This may be higher leverage than the whole correction pipeline: better base
descriptions mean fewer corrections are ever needed. It is also a one-variable
experiment — change the env var, re-describe a fixed set of subjects, compare —
and it needs **no GPU**, so the wedging provider cannot confound it.

**Recommendation: run this experiment before Slice 3.** Track as its own item.

### Every description edit now costs a regeneration

Decision 2 means changing a description changes the seed, so the previous image
can never be reproduced. That is the intent — it is what makes a correction
visibly do something — but it forecloses holding composition fixed to A/B
prompt wording. Accepted; no escape hatch planned.

## Slices

Vertical, each independently verifiable. Slice 1 needs no GPU, which matters
while the provider is unreliable.

### Slice 1 — See the description (no GPU needed)

The subject preview modal gains a Description section: the active text, the
model that wrote it, and the version history. A **Rewrite** button calls the
existing endpoint with no `text`, and the result is shown but **not** applied
until confirmed.

- Backend: none. Endpoints exist.
- Frontend: `useArtDescription` hook, section in the preview modal.
- Proves: the plumbing works, and makes the currently-invisible state visible.

*Acceptance:* opening `item/archmage staff` shows `ornate wizard staff with a
faceted violet gem at its tip`. Opening `item/arrow` shows "no description —
using the catalogue template", and shows the template it will use.

### Slice 2 — Edit it, and make it change the image

Hand-editing (`POST` with `text`), plus the seed change.

- Backend: `seedFor(kind, key, salt)` is called with `salt = activeDescriptionId
  ?? 0` at enqueue and on reseed.
- Frontend: editable field, save, confirm-on-replace.
- Proves: an edited description produces a genuinely different image.

*Acceptance:* editing `arrow`'s description to name a fletched shaft, then
regenerating, yields a different seed in `art_generations` and an image that is
not a rocket.

*Risk:* needs one working generation. Verify during a quiet provider window.

### Slice 3 — Two boxes, and corrections that reshape

Replace the single correction field with the two labelled inputs. "What it
should look like" feeds a rewrite: the model returns a proposal, the operator
approves, a new description version is written and the note is deactivated.

- Backend: describer accepts current description + notes + outcome history
  (decision 4); a `rewrite` path distinct from first-write.
- Frontend: the two inputs, the proposal/approve step.

*Acceptance:* the arrow note, entered in the "should look like" box, yields a
proposed description naming a fletched arrow; approving it deactivates the note
and bumps the description version and seed.

### Slice 4 — Exclusions reach `negative_prompt`

"What to avoid" entries persist and are appended to the provider request's
`negative_prompt` rather than the positive prompt.

- Backend: `requestForSubject` merges persistent exclusions into the template's
  `negative_prompt`.

*Acceptance:* the darts note "no grey shadow" appears in the sent
`negative_prompt` in `art_generations.params`, and nowhere in
`composed_prompt`.

## Scope

**Included:** description visibility and editing in the console; correction
routing into descriptions; exclusions into `negative_prompt`; seed derived from
description version; the describer-model experiment as a separate item.

**Excluded:**
- The provider wedge. Not ours; see SOMET-558's `abd95c9`.
- The cutout step. "Background not transparent" is a provider-side flood-fill
  concern and no prompt change addresses it.
- Non-object kinds. `tile` composes its own prompt from its biome palette and
  the endpoint already refuses a description with 409.
- Bulk re-description of the catalogue. `describe-subjects.js` already exists
  for that and is not being changed.
- Migrating the 3 existing notes. Two are darts exclusions and one is the arrow
  note; they will be re-entered through the new boxes.

## Assumptions

- The local `llama` service stays reachable at `ART_DESCRIBER_URL`; it is CPU-only
  and independent of the GPU box, so describer work is unblocked by the wedge.
- `art_prompt_descriptions.id` is stable and monotonic per version — verified:
  `replace()` inserts rather than overwrites, under one transaction.
- Only three subjects currently have descriptions, so a seed rule keyed on
  description id changes the seed for exactly those three and nothing else.

## Verification strategy

- **Slice 1** is fully verifiable without a generation: assert rendered content
  against seeded rows.
- **Slices 2–4** each need at least one real generation. The provider manages
  ~5 images before wedging and self-clears after a few minutes idle, so verify
  one subject at a time rather than in a batch.
- **Never** treat a green suite as proof a description reached the provider.
  Read `art_generations.composed_prompt` and `params` for the attempt — that
  table settled every question in this investigation and is the only record of
  what was actually sent.
- Both-directions check on the seed rule: a subject **without** a description
  must keep its existing seed exactly, or the 87 template-generated items
  silently change.

## Acceptance criteria

1. Every subject in the console shows its description, or states that it is
   using the catalogue template and shows that template.
2. A description can be written, rewritten by the model, and edited by hand,
   without leaving the console.
3. A description change produces a different seed; no description means an
   unchanged seed.
4. "What to avoid" text appears only in `negative_prompt`, never in the
   positive prompt.
5. A reshaping correction is deactivated once folded into a description version,
   and remains readable in history.
6. `item/arrow` generates an arrow.

## Risks and open questions

- **The provider is the bottleneck for verifying anything visual.** Slices 2–4
  cannot be validated on a wedged box, and a confounded A/B is worse than none —
  this investigation already produced one (seed and prompt both moved on
  `archmage staff`, so neither could be credited).
- **Open:** should the model's rewrite proposal always require approval, or
  auto-apply once trust is established? Planned as always-approve; revisit after
  Slice 3.
- **Open:** success for "the icon looks right" has no automated metric. Every
  acceptance criterion above is structural except #6, which is judged by eye.
  Accepted — the five-trees problem is documented and no metric has been found.
- **Unresolved:** whether the arrow's recovery came from the reseed or the
  description. Both changed. Slice 2 makes this separable for future cases.
