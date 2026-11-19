# Creature body types: stop drawing every creature as a human

Date: 2026-11-19. Status: draft for approval.

## Why

GPU-box sprite sheets for non-humanoid creatures come out human. Slimes become bodybuilders, crabs and
tentacle monsters grow arms, and four-legged beasts stand on their hind legs. Humanoid sheets and plain concept
images are good. The user wants each creature to move like what it is: a slime should wobble and squash, and a
beast should walk on all fours.

Measured causes (2026-11-19, box session answers in the conversation that produced this doc):

1. **We send every creature as a humanoid.** `entity_types.body_plan` is NULL for all 348 creatures, and
   `sprite_sets.body_plan` is NULL for all 309 sheets. A NULL row goes to the box without `body_plan`, so the
   box poses it with its human pose text, and the image model obeys pose text over the concept image. Body
   Detect (SOMET, 2b507133) was never run on this DB. The column is also `per-PC` in seed sync, so a value set
   on one PC never reaches another.
2. **Text cannot tell the body.** Most prompts read "a tiny physical-touched swamp creature". The shape is
   invented when the concept is drawn: the rock blob, crab and tentacle creatures exist only in their concept
   PNGs. **The concept picture is the truth about a creature's body** (user decision).
3. **The box's four-legged pose text stands animals up** (box `src/sprite_generator/action_prompts.json`):
   - `idle` and `sway` have no `front` family. s/se/sw fall back to SIDE text, whose "haunches raised",
     "weight rocked back onto the hind legs" and "weight drifting back onto the hind legs" read as rearing on a
     head-on, eye-level camera.
   - `attack` front frame 1 says "rearing up, forelegs lifting off the ground, chest high", and frame 2 says
     "forelegs striking out wide".
   - Every cell prompt says "the character is …".
4. **The box has only two pose sets.** Its catalog lists `body_plans: ["humanoid","quadruped"]` per action.
   Blob and many-legged bodies have no lane yet. That lane is decided by a separate image-to-video spike (see
   Non-goals).

## Goals

- **Part 1 (something2):** every creature has an explicit body, picked by looking at its concept. A
  creature with no body is never silently drawn as a human. Bodies the box cannot draw yet are not queued.
- **Part 2 (GPU box):** four-legged sheets stay on four legs in every direction and action.
- Success, judged by the user by eye: a re-drawn Volcanic Brute and Beast Skirmisher (default lane, s/e/n, all
  quadruped actions) show no rearing frame and no human shape.

## Non-goals

- How blob and many-legged bodies are animated. That waits for the image-to-video spike (brief sent to the box
  session 2026-11-19), with the box's CPU-warp idea as the fallback. This design only gives those bodies a
  name and keeps them out of the queue.
- A vision model that suggests the body from the concept (box Qwen3-VL). It needs a new box route and a
  labelled set first. Part 1 adds a slot for it later; it is not built here.
- Changing the box's concept wrapper ("… full body, standing, centered"). The box measured that dropping it
  doubles isolation failures.
- Re-drawing the existing 309 sheets. They stay live until a replacement is approved, as today.

## Anti-goals (a failure even if it technically works)

- Any path where a creature with no body, or with a body the box has no poses for, reaches the box as a
  humanoid job.
- The text LLM's guess overwriting a body an admin picked from the concept.
- A four-legged row the box quietly drew with human poses passing intake. The existing echo check must cover
  every non-humanoid body.

## Approaches considered

- **A. Body type per creature, set from the concept, plus a box fix per body (chosen).** It targets the
  measured causes. Four-legged is a pose-text fix; blob and many-legged wait for the spike.
- **B. Pose text for every body, image model only.** The least new code, but non-human pose text at 4
  distilled steps is unmeasured, and leg counts drift with nothing in QA to catch it.
- **C. A bigger or different model.** The bigger Qwen lane (HQ) was parked on 2026-11-03: facing was a coin
  flip and it was 5–7× slower. It also does not help on its own, because human pose text still draws humans.
  The image-to-video variant of C became the spike.

The user chose to test C's video variant first, then build A. This document is A's first two parts.

## Part 1 — something2: an explicit body for every creature

### Vocabulary

`entity_types.body_plan` ∈ `humanoid | quadruped | blob | multileg`, plus NULL (not set).

- `other` is retired. No row holds it today. The migration converts any `other` to NULL and replaces the
  CHECK constraint.
- UI labels: Two legs, Four legs, Blob (no limbs), Many legs.
- `sprite_sets.body_plan` records what the row was queued with, using the same values.

### Rules

1. **No body, no queue.** A creature with body NULL is refused at queue time, the same way `other` is today.
   The refusal is a 400 listing the names: "set a body first: …". The client mirrors the check so the Queue
   button explains it before the POST. Playable heroes and appearance variants are unaffected: they have no
   Body column today and stay humanoid.
2. **Only bodies the box can draw.** At queue time, each body is checked against the live box catalog
   (`actions[].body_plans`):
   - Actions the body does not list are dropped from the row. This generalises today's hardcoded
     `QUADRUPED_EXCLUDED_ACTIONS` (cast and use) to whatever the catalog says.
   - If a body is listed by none of the chosen actions, the creature is refused with "no poses for <body>
     yet".
   - Today that refuses `blob` and `multileg`. When the box adds a lane, they unlock with no something2 change
     beyond the spec field (rule 3).
3. **The box is told every body.** The sheet spec sends `body_plan` for every non-NULL row (today only
   `quadruped`, and only on diffusers). The intake echo check (`assertBodyPlanMatches`) applies to every
   non-humanoid body. For `humanoid`, the box's missing echo is accepted, because that is its default.
4. **Admin choices win.** This is unchanged: `body_plan_source = 'admin'` is never overwritten by Detect.
5. **Other paths that reach the box.** *My calls:*
   - **Rows queued before the migration** are left alone. Only new queue requests are gated.
   - **A frame redraw keeps its sheet's own body**, never the creature's current one. One box job must not
     mix pose sets.
   - **Legacy NULL sheets** (all 309 today) still redraw as humanoid, which is what they were drawn as. A
     redraw cannot fix a wrong body: the fix is a new full run after the creature is labelled.
   - **The batch-restart resume** re-sends rows as stored. That is fine, because each row passed the gate (or
     predates it) when it was queued.
6. **Which catalog, which connector.** *My calls:*
   - **Rule 2 uses the catalog of the connector the row will be drawn by** (the chosen connector, else the
     default), not whichever provider is active.
   - **An action whose catalog entry has no `body_plans` field** counts as humanoid only.
   - **The HQ connector (`comfyui-hq`)** is parked and lists no bodies, so non-humanoid creatures are refused
     on it at queue time. `body_plan` is sent only on diffusers, as today.

### Picking the body from the concept

- The Sprite tab already shows the Concept column next to Body. The Body select gets the four values. Its
  tooltip says that the concept picture decides, and that a text guess must be checked against it.
- **Detect (text LLM) stays as a first guess, with an updated vocabulary.** Slime, ooze, jelly and rock-mass
  wording maps to `blob`. Spider, crab, insect, centipede and tentacle wording maps to `multileg`.
  "undecided" stays the honest answer for vague text, and most current creatures will get it. Bats, birds,
  serpents and floating spirits have no body of their own yet: Detect leaves them undecided, and an admin
  picks the nearest body or leaves them unqueued.
- **Bulk labelling.** 348 creatures have no body.
  - Add a Body filter to the Sprite tab: Not set / each value.
  - Add a bulk "Set body for N ticked" control.
  - The admin then filters to "Not set", reads concepts down the list, ticks a group, and sets it at once
    (source `admin`).
  - Creatures with no concept yet are labelled after their concept is drawn.
- **A later vision suggestion.** The labelling flow and the Detect button should not assume the guess is
  text-based. A box vision classifier can later feed the same `llm` source. Nothing is built for it now.

### Where the body travels

The body belongs to the concept art, not to the PC. It moves from `per-PC` to whatever group carries the
creature's art (`image`/`sprite`, marked `ART` in `seedSync/registry.js`), so the body arrives with the sheet
it describes. *My call:* the builder confirms what the `ART` group does on export and import, and keeps
`body_plan_source` with it. **A seed file without `body_plan`** (every file exported before this change) keeps
the target PC's local value: it never writes NULL over a label. Add a test for that.

### Part 1 acceptance

- A queue POST with a NULL-body creature returns 400 naming it. No row is created.
- A `blob` or `multileg` creature is refused while the live catalog lists neither.
- A `quadruped` row sends `body_plan: "quadruped"`. A box answer without a matching echo fails the row.
- A browser check of the Sprite tab:
  - the Body filter and the bulk set work
  - the POST body carries what the UI shows (the SOMET-686 lesson: the request whitelist once dropped a field)
- Seed export and import round-trip a creature's body.

## Part 2 — GPU box: four-legged pose text that stays on four legs

**something2 does not edit box code.** The something2 plan covers only:
- writing and sending this brief to the box session
- the acceptance redraw once the box reports done

The box owner approves the work and builds it in the box session. Edit only between builds: the
text is baked into embeds at actions-encode.

1. **Add a `front` family** (s/se/sw view) to quadruped `idle` and `sway`.
   - Weight shifts stay sideways or as a head dip: head lowering and rising, chest breathing, shoulders
     rolling, tail moving, all four paws planted.
   - No words that move weight onto the hind legs or raise the forequarters.
2. **Rewrite quadruped `attack`, front family.**
   - Frame 1 (rearing) and frame 2 (forelegs striking out wide) are replaced with low attacks: head thrust
     forward with jaws open, a lunge with the forelegs staying on the ground, a single low foreleg swipe.
   - Also check the side and back attack families for "rearing" and "forelegs lifting".
3. **Side-family `idle` frames 2 and 4** ("haunches raised", "weight rocked back onto the hind legs") are
   softened to small shifts, because se/sw may still read them as rearing at eye level.
4. **"the creature is" instead of "the character is"** for non-humanoid jobs.
   - This is an A/B first: one direction, a few seeds, the same concept, judged by eye.
   - Keep the change only if it is no worse.
5. **Verification on the box:** `test-body-plan.py` still passes (no human words in quadruped text), plus the
   A/B above.

### Part 2 acceptance

On the default lane (Q2_K, 4 steps, 96x128, 768 ref, quality checks off), redraw Volcanic Brute and Beast
Skirmisher with Body = Four legs, s/e/n, all actions the catalog allows for quadrupeds. The user judges by
eye:

- no frame with both forelegs off the ground in idle, sway or walk
- no rearing in attack
- no human silhouette in any frame

Grade crops at 2x or more, not a thumbnail montage (SOMET-767 lesson).

## Order and dependencies

1. Part 1 can be built now. It adds no box dependency: blob and multileg are refused until the box lists
   them.
2. Part 2 is box-side and independent of Part 1. Its acceptance run needs Part 1's quadruped path, which
   already works today once a body is set.
3. The image-to-video spike decides the blob and multileg lane. That lane becomes its own design.

## Left to the builder

- Migration details and numbering. Re-check the numbering against open branches before merging (see the
  migration-collision history).
- The exact Detect prompt wording, within the vocabulary rules above.
- Filter and bulk-set UI placement, following the Sprite tab's existing controls.
- Where the client gate lives: today's `other` check sits in `queueBlockReason` in `spriteSelection.js`.
