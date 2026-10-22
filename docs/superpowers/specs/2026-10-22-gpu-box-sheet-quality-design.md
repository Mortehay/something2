# GPU-box sprite sheet quality — design (box-side fix)

Date: 2026-10-22. Status: draft for approval.
Audience: the GPU box's own Claude session (the box codebase:
`/api/jobs` sheet builder, Qwen-Image-Edit-2511 GGUF). The work happens on the
box. something2 keeps sending the same `POST /api/jobs` request.

## Why

The user generated full character sheets (7 actions × 6 frames × 8 facings =
336 cells) and finds them unusable in game. They reported four symptoms:

1. The character sometimes faces the opposite way from where it is moving.
2. The character is sometimes zoomed in so far that only the chest is visible.
3. Some frames have a background baked in.
4. Heavy distortion, worst in the attack action.

Measurement on something2's side (below) shows that all four come from the
sheet builder, not from the concept prompt. The user decided the fix goes on
the box.

## Evidence (both jobs are still on the box)

| Our subject | Box job id | Concept style |
|---|---|---|
| Cultist:1 | `212d56d7-c934-4a76-ae19-3fc87d438205` | pixel-art-like, flat |
| Cultist:2 | `8d9d164d-32ed-432a-aca1-c228f246d650` | painterly, highly detailed |

Both: actions `idle, attack, cast, damage, sway, use, walk`, frames 6, all 8
directions, cell 48x64, colors 24. Rows are action-major, directions in order
`s, se, e, ne, n, nw, w, sw` (row = action_index*8 + dir_index). Fetch them with
`GET /api/jobs/{id}/sheet` and `/atlas`.

Per-cell measurements (alpha > 128 = opaque):

- **Every cell's figure is 39-46 px tall, in both sheets, whatever the pose.**
  The builder fits each cell's figure to the cell height independently. When the
  model renders a close-up, the close-up is scaled up to full height.
  Cultist:2 attack `s`, `se`, `sw` frames 2 and 4 are torso-only for this
  reason.
- **Leftover backdrop:** a clean cell is about 24-32 % opaque. Cultist:2 has 26
  cells at 45-69 % opaque with a beige/grey rectangle behind the figure (e.g.
  attack `se` f3/f4, attack `w` f1, cast `se`/`sw` most frames, use `se`).
  Cultist:1 has none. Background removal fails on these cells and nothing
  catches it.
- **Facing flips within a row:** Cultist:1 attack `e` f3 pushes the orb to the
  LEFT (and the arm is cut off at the cell's left edge); attack `w` f3 faces
  RIGHT. Idle `ne` and `nw` alternate frame to frame between a back view and a
  side view facing the other way.
- **`se` and `sw` rows are the front view.** By eye, idle `se` and `sw` are
  the front pose, with no visible turn. Mean per-pixel difference from idle
  `s` f0: `se` 5.6 / 8.0, `sw` 5.8 / 7.6 (Cultist:1 / :2), against 11-12 for
  the real `e` and `n` views. There is no three-quarter view.
- **`w` duplicates `e`** on Cultist:1 (known, also seen on humanoids and
  wolves before): idle `w` faces right, like `e` (difference from `e` 7.8,
  from mirrored `e` 12.7). Cultist:2's `w` is ambiguous by the same measure
  (11.7 vs 10.2).
- **Identity drift:** attack/cast/use frames in Cultist:2 change body
  proportions, face and costume between frames. Cultist:1 drifts much less, so
  a detailed, painterly concept makes drift worse.

How the game consumes the sheet (why some rows matter more): something2 draws
`w`/`nw`/`sw` as `e`/`ne`/`se` mirrored horizontally, because the box's
western rows were unreliable. **So any wrong-facing frame in `e`, `ne` or `se`
appears on both sides of the screen.** The game also plays one row as a loop
(idle, walk, sway) or a one-shot (attack, cast, damage, use), so a single bad
frame flashes on every play.

## Goals

A sheet is "clean" when, for every cell:

1. **Facing:** the figure faces its row's direction (e.g. `e` = right profile,
   `ne` = back-right, `se` = front-right three-quarter, `s` = front, `n` =
   back), consistently across the row's frames. `se`/`sw` are real
   three-quarter views, not copies of `s`.
2. **Scale:** one scale per sheet. The character is the same size in every
   cell; poses can extend (raised arms, a thrust staff) without the body
   growing. A cell where the model drew a close-up is redrawn, not enlarged.
   Nothing touches the cell edge because the figure is too big.
3. **Background:** fully transparent around the figure. No rectangle, halo or
   backdrop.
4. **Identity:** the character in an attack/cast/use frame is recognisably the
   concept: same costume, colours, proportions, props.

## Decided approach

### Decided by the user (2026-10-22)

- **A sheet is a folder of per-frame images, and `sheet.png` is assembled
  from them.** One directory per action row, named `<action>_<direction>`,
  holding frames numbered `0.png` … `<frames-1>.png` (frames = 4 → 0..3):

  ```
  <job>/
    sheet.json           parts list + per-frame quality (see below)
    sheet.png            assembled from the frames, same layout as today
    idle_s/0.png 1.png 2.png 3.png
    attack_e/0.png …
  ```
  Each frame PNG is one 48x64 RGBA cell, exactly the pixels it occupies in
  `sheet.png`. The existing `/sheet` and `/atlas` responses stay as they are;
  the folder is how the box builds and repairs a sheet. **Claude's call:** the
  box also exposes the parts read-only (e.g. `GET /api/jobs/{id}/frames/<action>_<dir>/<n>.png`
  plus their list in the atlas), so something2 can mirror the same layout in
  its own storage and later swap in a single redrawn frame.
- **Work row by row.** The box draws one action row (frames 0..N-1), checks
  each frame, redraws only the frames that fail, and moves on to the next row
  once the whole row passes (or its retries are spent).
- **Distortion triggers a redraw** (not just a report), at frame level.
- **Every frame is drawn from the core (concept) image as its template**, for
  identity: costume, colours, proportions, props.
- **Context passes between frames:** each frame's edit also takes the
  previous frame of its row as an input, and a redrawn frame takes both
  neighbours, so the row stays continuous. (Qwen-Image-Edit-2511 accepts
  several input images; the box session confirms how many fit in 12 GB and
  what each extra input costs per frame, and reports it.)
- No total time limit for a sheet; per-frame retries bound it.
- **Redraw of chosen frames on request.** The user will mark bad frames in
  something2's admin panel and send them for redraw, so the box needs an API
  to redraw specific frames of a finished job, e.g.
  `POST /api/jobs/{id}/redraw` with `{"frames": [{"action": "attack",
  "direction": "e", "frame": 2}, …]}` → a job/task id that can be polled
  like a sheet job (shape is the box session's call; additive only). Each
  marked frame is drawn with the core image as its template and **the frames
  to its left and right in the same row as context**, so it does not break the
  row's continuity. When neighbours are both marked (e.g. frames 2 and 3),
  they are redrawn in order and each one uses the other's NEW version as
  context. Frame 0 and the last frame have one neighbour. The redrawn frames
  go through the same checks and retry cap as above, only those frame files
  are replaced, `sheet.png` is reassembled and the atlas `quality` entries for
  those frames are updated. Frames that were not marked never change.

### Claude's calls

- **Retry cap: 2 redraws per frame** (3 attempts). If a frame still fails —
  in particular if it won't match its neighbours — the **whole row is redrawn
  once** as a last resort. A row that still fails keeps the best-scoring
  attempt per frame and is flagged in `sheet.json`; the job does not fail.
- Expected cost (estimate, to be measured): with ~1 bad frame in 10, a full
  sheet takes ~10-20 % longer than today; per-frame redraw costs about 1/6 of
  a row.

### Checks (per frame)

1. **Check every cell after it is drawn, and redraw the cells that fail.**
   Checks, against the row's own reference and the concept:
   - figure size compared to the idle `s` frame (or the turnaround frame for
     that direction), measured before any fitting;
   - opaque fraction / opaque border pixels (backdrop left behind);
   - facing compared to the row's direction (e.g. compare against the
     turnaround frame for that direction and its mirror image; the closer one
     wins);
   - similarity to the concept (identity / distortion);
   - for a redrawn frame, similarity to its neighbours (continuity).
   A failing frame is redrawn with a different seed, as described above.
2. **One scale for the whole sheet**, taken from the reference (idle `s` /
   turnaround), applied to every cell, instead of per-cell fit-to-height.
3. **Real `se`/`sw` three-quarter views**, and western rows that face west.
   (something2 will keep mirroring the eastern rows until the box's western rows
   are measured as correct; that switch is ours.)
   **Claude's call:** the box MAY build `w`/`nw`/`sw` by mirroring its
   finished `e`/`ne`/`se` rows instead of drawing them. something2 already does
   exactly that in game, so asymmetric details (weapon hand, one-sided costume)
   are already lost there and mirroring costs nothing new. That puts the checks
   and redraws on 5 directions: `s, se, e, ne, n`.

## More of Claude's calls (the box session may revisit if its code shows a better way)

- **Report per-frame quality in the atlas.** Add a field the job result
  carries, e.g. `atlas.quality = [{action, direction, frame, attempts,
  passed, failed_checks: [...], row_redrawn}]`. It must be additive:
  something2 ignores unknown atlas fields today, so nothing breaks. With it,
  something2 can later show bad frames to the user.
- something2's side of manual redraw (marking frames in the admin preview,
  sending the request, swapping in the new frames) is a separate design that
  follows this one; it relies on the redraw API above.
- Thresholds are the builder's to tune. Starting points from the measurements:
  backdrop = opaque fraction > 1.4× the row's idle median, or opaque pixels on
  the cell border; close-up = body height (before fitting) > 1.25× the
  reference.
- The concept prompt is not part of this fix. A side note for the user: a
  flatter, simpler concept drifts less.

## Non-goals

- Changes to something2's request, renderer or mirroring rule.
- Changing cell size (48x64), palette size (24), or the action catalog.
- Speed work beyond the retry cap.
- Changes on something2's side (mirroring the per-frame folders into our
  storage, the admin panel's frame marking). Those are the follow-up design.

## Anti-goals (fails even if it "works")

- A check that always passes. Prove each check catches the bad cells listed in
  Evidence: re-score jobs `212d56d7…` and `8d9d164d…` with the new checks and
  show they flag at least attack `e` f3 (Cultist:1, facing), attack `s` f2/f4
  (Cultist:2, close-up), attack `se` f3/f4 (Cultist:2, backdrop), and idle `se`
  (both sheets, front view in a three-quarter row).
- Fixing scale by shrinking every cell so the figure is tiny. The idle `s`
  figure should stay about the size it is now (~44 px tall in a 64 px cell).
- Breaking the existing API: `POST /api/jobs` body, job status fields,
  `/sheet` PNG layout (frames × 48 by rows × 64, RGBA) and `/atlas` fields
  stay as they are; only additions.
- Silent failure: a cell that never passed must show up in the job result.

## Verification

1. Re-score the two evidence jobs as above (checks only, no redraw).
   **Claude's call:** if the box no longer has those jobs' raw, pre-fit cell
   outputs, the close-up proof may use a proxy on the fitted cell (head size
   relative to the reference, bbox width, similarity to the reference crop) and
   say so. The production check is then proven on the new job in step 2,
   which must keep its raw outputs until it has been measured.
2. Generate a new Cultist sheet (same prompt; something2 can queue it) with all
   7 actions × 6 frames. something2 re-measures it with the same per-cell
   script: every cell's figure height within ±15 % of idle `s` except
   deliberate pose changes, no cell over 40 % opaque, `se`/`sw` visibly
   different from `s`, no wrong-facing frames in `e`/`ne`/`se` (checked by
   eye on a 3× row view).
3. Report the measured time per cell before and after, the number of frame
   redraws and row redraws, and the cost of each extra input image per edit.
4. `sheet.png` is pixel-for-pixel equal to the frame PNGs placed in the grid
   (assemble check), and replacing one frame file then reassembling changes
   only that cell.
5. Redraw API: on a finished job, request a redraw of two adjacent frames
   (e.g. `attack_e` 2 and 3); only those two cells change in `sheet.png`, the
   rest of the sheet is pixel-identical, and the new frames pass the
   continuity check against their neighbours.

## Spike results (something2 side, 2026-10-22, throwaway)

A ~150-line numpy/PIL checker was run on the two evidence sheets. It only sees
fitted cells (no raw outputs, no embeddings). It is a starting point for
thresholds, not the implementation. (The spike script is not committed; the
checks are described here so they can be rebuilt on the box.)

| Check | Rule that worked | Result |
|---|---|---|
| Front copy in `se`/`sw` | idle row's mean abs diff to idle `s` < 0.6× (`e` to `s`) | Caught in both sheets (6.7 / 6.2 vs 17.8; 9.9 / 10.3 vs 17.4) |
| Close-up | opaque fraction > 1.6× the direction's idle median, OR bbox width ≥ 46 of 48 with opaque > 1.25× | Caught Cultist:2 attack `s` f2/f4, and most of cast `s`/`se`/`sw`/`e` |
| Backdrop | opaque > 1.4× idle median AND > 15 % of border pixels opaque | Fired 0 times; the backdrop cells came out as close-ups instead. Flagged, wrong label. Needs a colour test (flat low-saturation region touching the figure) |
| Facing | silhouette IoU with the direction's idle f0 vs its mirror; mirror wins by > 0.08 | Good on calm poses (idle/sway/walk `ne`/`nw` alternation all caught). **Missed** Cultist:1 attack `e` f3 (caught only as a close-up). Silhouettes fail on big poses; use a pose/embedding signal there |
| Identity | colour-histogram distance to the concept > 0.55 | **Useless**: fires on every back view (`n`), because the back of a robe has different colours from the front concept. Needs an embedding (e.g. DINO/CLIP image features) against the turnaround frame for that direction, not against the front concept |

**New cause found: spell effects.** In Cultist:2's cast row (and some
attack/use/sway frames), the "backdrop" is mostly a grey or beige glow, aura or
energy arc painted behind the character, which background removal keeps as part
of the figure. Some frames also have speckle noise around the figure. The game
draws its own attack/cast effects, so sheets must not contain any.
**Box-side prompt fix:** the action prompts for attack/cast/use (and
everything else) must exclude effects, e.g. "no spell effects, no glow, no
aura, no energy, no particles, no background", and a check should treat
detached or low-saturation blobs around the figure as a backdrop.

Flag counts with these rules: Cultist:1 72/336, Cultist:2 57/336. Many of
Cultist:1's are the identity false positives on `n`; with identity removed,
Cultist:1 is mostly facing flips in `ne`/`nw` and Cultist:2 mostly close-ups
and effects in cast/attack/use.

## Left to the box session

How to measure facing and identity (embedding similarity, mirror comparison,
keypoints…), the exact thresholds, where in the pipeline the checks run, how a
redraw gets its new seed and prompt, and the exact `quality` field shape
(additive only).
