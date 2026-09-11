# Art prompt corrections and generation history

**Date:** 2026-09-05
**Tickets:** SOMET-547 (history), SOMET-548 (notes), SOMET-549 (region marking)
**Status:** design approved; slice A in progress

## The problem

The art console can generate ~1000 subjects but gives no way to *steer* one that
comes back wrong, and no record of what produced the images we already have.

Both gaps were hit on the day this was written. `darts` generated successfully —
95% transparent, recorded, passing every guard — and is a **dartboard** with an
opaque grey shadow blob attached, when the subject is *throwing darts*. Nothing
in the product lets an operator say "no shadow, and these are throwing weapons"
and re-run. The only recourse is editing the catalogue's base prompt, which
affects nothing else useful and is not where a per-subject correction belongs.

Separately, nothing records what prompt produced which image. After a prompt
change (the backdrop moved magenta → white → grey inside two days) there is no
way to answer "what was this image actually asked for".

## Decisions

1. **A mark produces WORDS, not a mask.** The marked region and its note become
   text appended to the next prompt, and the whole image is regenerated. True
   inpainting was considered and deferred: the provider's `/api/edit` capability
   is unverified (the box was unreachable at design time) and masked editing is
   a materially larger build. Direct pixel erasure was also considered and
   rejected as a *replacement* — it fixes the artefact but teaches the generator
   nothing, so the next subject repeats the mistake.

2. **Corrections are LAYERED, not an override.** The base prompt keeps coming
   from the catalogue and corrections are appended. A per-subject override was
   rejected for one measured reason: on 2026-09-05 a single global backdrop
   change fixed 21 subjects at once. Under overrides, every corrected subject
   would have silently missed that fix. Global improvements must keep reaching
   corrected subjects.

3. **History records every attempt, including failures.** Failed prompts are the
   ones most worth reading.

4. **"Reproduce the same result" is BEST EFFORT and must be labelled as such.**
   Same prompt + seed + model can still differ across driver or model versions.
   The stored PNG is the only exact record. Any UI affordance must not promise
   more than that.

## Data model

Two tables, deliberately separate.

**`art_prompt_notes`** — intent. Editable, revocable.
`(id, subject_kind, subject_key, note, region jsonb NULL, active bool, created_at)`

**`art_generations`** — fact. Append-only, never edited.
`(id, subject_kind, subject_key, art_job_id NULL, composed_prompt, seed,
  model, provider_id, params jsonb, image_key NULL, outcome, error, created_at)`

They are separate because they answer different questions. Notes are what we
*want*; history is what *happened*. Storing corrections inside the history table
would mean editing the record of the past, and storing history in the notes
table would make an append-only fact revocable.

`region` is stored as normalised floats (0..1) so it survives a resolution
change — the same batch has run at 512 and 1024, and a pixel box would silently
mean a different area after a size change.

## Prompt composition

`buildObjectPrompt(base, { backdrop, corrections })`.

Corrections are inserted **with the exclusions, before the styling block**. That
ordering is load-bearing: the existing comment records that naming exclusions
first is what stops SDXL returning framed art rather than an object. Appending
corrections at the end would put them in the weakest position in the prompt.

`regionPhrase(box)` turns a normalised box into a positional phrase ("beneath
the subject", "in the lower third", "top-left corner"). It lives in the backend
beside the other prompt rules, for the same reason `artFailures.classify` does:
the composed prompt must have exactly one author, and this repo already carries
one rule duplicated across the front/back split.

## API

- `GET  /api/art-subjects/:kind/:key/history` → generations, newest first
- `GET  /api/art-subjects/:kind/:key/notes` → active notes
- `POST /api/art-subjects/:kind/:key/notes` `{ note, region? }`
- `DELETE /api/art-subjects/:kind/:key/notes/:id` → deactivate (not delete:
  a note that was in force when an image was made stays readable)

## UI — inside the existing preview modal

Image with a drag-to-mark overlay; note field; list of active notes with remove;
history below with prompt, seed, date and thumbnail; "Regenerate with these
notes".

## Testing, and what would make it vacuous

The trap is asserting that a note is *stored*. The assertions that matter:

- an active note **appears in the composed prompt**
- a deactivated note **does not**
- corrections sit **before** the styling block, not after
- history records a row on **failure**, not only on success
- `regionPhrase` is pinned per quadrant/band, including the degenerate
  full-image box (which should produce no positional phrase at all rather than
  a misleading one)

## Slices

- **A — history.** `art_generations`, recorded on every attempt, shown in the
  popup. First, because unrecorded history cannot be backfilled: every
  generation between now and shipping it is lost.
- **B — notes.** Text notes, layered composition, regenerate. Usable without C.
- **C — region marking.** The canvas overlay and `regionPhrase`.

## Open questions

- Does the provider's `/api/edit` support masked inpainting? Unverified — the
  box was unreachable during design. If it does, C could later feed a real mask
  instead of words, without changing A or B.
- Corrections accumulate. Growth is unbounded by this design; the composed
  prompt is shown in the UI so an operator can see it getting long, but no cap
  is specified yet.
