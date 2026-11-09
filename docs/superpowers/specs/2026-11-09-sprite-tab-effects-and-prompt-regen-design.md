# Sprite tab: effects as rows + prompt regeneration with the big Qwen — design

Date: 2026-11-09. Status: draft for the owner's approval.
Builds on `2026-11-09-default-sprite-lane-design.md` (creature lane, shipped) and `2026-11-09-effect-sprites-design.md` (effect sprites, shipped 6502fcc5).

## 1. Intent

The owner wants one place to generate sprites:

1. Effects move into the main Sprite table, on the same rails as creature sprites. For effect rows, **directions are blocked; only "actions" are active**: frame count and loop vs one-shot.
2. A **"Regenerate prompt"** option, applying to the selected rows (creatures and effects alike). When set, the box's big text model (the 35B Qwen "brain" behind the `gpu-box-text` provider) rewrites each subject's prompt before drawing. That gives a better core image (concept / keyframe) and a better sprite drawn from it.

## 2. Goals

1. **Effect rows in the main table.**
   - The 21 batch-1 effects appear as rows under their own groups: Auras, Bolts, Impacts, Beams.
   - The shape filter gains "Effects".
   - They share selection, Queue, the estimate, the box wait, status, the preview modal, Approve and Redraw with creature rows.
   - The separate `EffectSpritesSection` is removed.
2. **Controls by selection.**

   | Selection | Facings | Cell size | Creature actions | Frames | Loop / one-shot |
   |---|---|---|---|---|---|
   | Effects only | **disabled** (visible, greyed) | **disabled** | hidden | active, 1–64, default per effect | active, default per effect |
   | Creatures only | as today | as today | as today | as today | n/a |
   | Mixed | apply to creature rows only | creature rows only | as today | effect rows keep their own defaults | effect rows keep defaults |

   - Bursts are always one-shot: the toggle is locked, because the box answers 422 for burst + loop. Auras always loop (no `sprite_loop` column on auras), so their toggle is locked too.
   - New default frames: bolts and beams **8** (the box observed 4 frames looks too static), auras 8, bursts 6. These are calls marked in §8.
3. **One Queue click** sends creature rows to the creature queue and effect rows to the effect queue. The batch estimate is the sum of both, plus the box wait.
4. **Regenerate prompt** is a checkbox beside the Generation method, default off.
   - **When checked**, Queue first runs a prompt phase over every selected row, on the box's text model only, so the card switches models once. It then queues the drawing jobs with the new prompts.
   - **For creatures:** the new description becomes the prompt the sheet's concept is drawn from, and that job draws a **fresh concept**. **Owner decision (2026-11-09): the approved entity art is NOT replaced.** The fresh concept is ADDED as the creature's sprite concept (the kept-concept store) and UPDATES it on each later regenerate. Later sprite jobs for that creature build on this regenerated concept in preference to the approved art, so the result never silently reverts on the next normal queue. Approved art stays as it is for every other use.
   - **For effects:** the new description becomes the effect's prompt; the box keyframe is drawn from it.
   - **A per-row "Regenerate prompt" action** (button in the row) runs the prompt phase for that row only, without queuing, so the admin can read and edit the result before drawing.
   - The row shows the active prompt. It is editable. **Owner decision: a regenerated or edited prompt is saved as a new VERSION of the subject's official description in `art_prompt_descriptions`.** This is the same mechanism as the art console's existing "regenerate existing prompt" option, so the art console uses it too. Earlier versions are kept; "Revert" goes back to the template (the existing DELETE behaviour).
5. **The estimate shows the prompt phase.** It adds the text-model time (one switch plus about N × per-prompt seconds) when Regenerate is checked. Constants are measured during the live check; until then they are clearly labelled as estimates.

## 3. Non-goals

- New effect subjects beyond batch 1, and new creature actions.
- Changing the box's prompt wrapping. Effect prompts stay **subject only**, with no style or background words; creature prompts follow the existing entity contract.
- Changing how the art console or icons use descriptions.
- Prompt regeneration for props or tiles in this tab: the checkbox is ignored for prop rows. Hero appearance rows use their own `character_appearance` contract.

## 4. Anti-goals

- **A prompt regeneration that silently does nothing.** Example: a creature job that still reuses the old concept after "regenerate" was checked.
- **A creature sheet drawn from a description written for an icon,** i.e. the wrong contract.
- **A text model that wedges the GPU card** so drawing jobs fail. The prompt phase must use the existing card-held handling (SOMET-680 / 684 patterns).
- **The UI hiding why a control is disabled.** Disabled facings and cell on effect rows carry a tooltip: "effects have one direction".
- **Prompt text with style or background words reaching the box for effects.** The box would paint them (see the "ground" lesson from the death pose).

## 5. How it gets made (decided)

### Describer

`backend/src/services/subjectDescriber.js` gains an **`effect` contract**:
- Rules: describe the visual effect's shape, motion, colours and materials in at most about 40 words.
- No style words ("pixel art", "sprite"), no background or scene words ("ground", "sky", "black background"), no negations.
- Made-up exemplars per kind (aura, projectile, burst, beam), never batch-1 names, following the SOMET-682 lesson about exemplars being copied verbatim.
- `clean()` strips any style/background words that slip through.

Creatures use the existing **`entity` contract** unchanged.

### Storage

The existing `art_prompt_descriptions` table: kind `entity` for creatures and `character_appearance` for hero appearances (both shared with the art pipeline, by owner decision). Effects use `subject_kind` **`vfx` / `aura`**, matching `effect_sprite_jobs` and `BATCH_1`; the table has no CHECK, and seed-sync keys on (subject_kind, subject_key).
- `sprite_sets.base_prompt` already exists and is filled from `entity_types.prompt || name` at queue time. Add a per-target prompt override to `queueRequestFrom`/`enqueue`. The ON CONFLICT update path for an already-queued row must also update `base_prompt` and the new flag, otherwise a re-queue with regenerate silently keeps the old prompt.
- A new per-row flag `sprite_sets.regenerate_concept` (boolean, default false) makes `submit()` skip the approved-art upload and draw a fresh concept from `base_prompt`. The kept-concept store then records it as the creature's **regenerated sprite concept**, and later jobs prefer it over approved art. Today a non-matching kept concept is dropped against the approved art's bytes; that rule must exempt a concept marked regenerated.
- Without regenerate, behaviour is unchanged, including the 17 creatures that already have active entity descriptions: the sprite lane keeps using `entity_types.prompt` unless a prompt was regenerated or edited from the Sprite tab.
- Effect jobs read the active `vfx`/`aura` description when present, else the template default.

### Transport and card handling

Reuse `textProvider.complete` with `boxOnly: true`, but the art dispatcher's phase can't be reused as is: it drains `art_jobs` through `catalogSubjects`. Add a **prompt phase to the sprite dispatcher and the effect dispatcher**: rows queued with `needs_prompt` are written first, all prompts before any image, so the card switches once. Queue returns immediately; rows show "prompt pending". A `busy` / card-held answer waits and retries per the existing art rules (held-wait up to the same limit). After the limit the row fails with a readable reason ("text model busy") instead of drawing with the old prompt. Never silent.

### Effect overrides

`POST /api/sprite-admin/effects/jobs` targets gain optional `frames` (1–64) and `loop` (bool; refused for bursts). `boxRequestFor` uses them over the `BATCH_1` defaults. They are stored on the job, so Redraw repeats them.

### Seed/export

`art_prompt_descriptions` must carry the new effect kinds through seed/export. Verify its seed-sync group covers them, and extend the round-trip test.

## 6. Verification

- **Unit:**
  - the effect contract (rules present, exemplars made-up, `clean()` strips style/background words);
  - selection gating table (§2.2);
  - mixed Queue split;
  - effect frames/loop overrides incl. the burst-loop refusal;
  - creature regenerate → `base_prompt` set and no concept reuse.
- **Browser:** isolated stack with a stub box plus a stub `/api/text`.
  - Effects-only selection greys out facings and cell; frames and loop work.
  - Regenerate prompt runs the prompt phase, then queues.
  - A mixed queue sends both requests.
- **Live, gated:** regenerate prompts for 2 effects and 1 creature on the real box text model, draw them, and compare side by side with the template-prompt versions. Measure seconds per prompt and the switch time.

## 7. Left to the builder

- Exact row layout of the prompt cell and the Regenerate/Revert buttons.
- How the effect group headers sit among creature groups.
- Exemplar wording.

## 8. Calls made by the spec author (not confirmed by the owner)

- Bolts and beams default to 8 frames, after the box's observation about 4-frame motion.
- (Owner-decided, see §2.4) Regenerate on a creature draws a fresh concept that is added as its sprite concept and updated on later regenerates; approved art is never replaced. Prompts become new description versions shared with the art console.
- A per-row Regenerate (prompt only, no queue) exists beside the batch checkbox, so prompts can be reviewed before drawing.
- A mixed selection queues both kinds in one click.

- Effect description kinds are `vfx` / `aura` (matching existing effect names), not new names.
- The prompt phase lives in the sprite and effect dispatchers (rows flagged `needs_prompt`), not in the Queue HTTP call and not in `art_jobs`.
- When the text model stays busy past the held-wait limit, the row fails with a reason; it never draws with the stale prompt.
