# Sprite Incremental Re-runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A re-run of a creature's sprites draws only what is missing or broken: good frames of the newest finished sheet drawn from the same concept are kept, only rows with missing cells go to the GPU box, and flagged kept frames are fixed with use-good-frames.

**Architecture:** A pure module `backend/src/services/spriteIncremental.js` plans reuse (which cells to keep, which rows to draw) and merges a base sheet with a newly drawn partial sheet into one sheet.png + sheet.json. `spriteDispatcher.js` uses it at dispatch: after the concept is resolved, it picks an eligible base, submits a reduced JobSpec (or none), and merges at intake before the existing size check; then auto-runs `spriteFrameReplace.replaceFrames` on flagged cells.

**Spec:** Plane SOMET-702 (user decisions + acceptance criteria). Related: SOMET-697 (spriteSizeCheck), SOMET-701 (spriteFrameReplace).

## Global Constraints
- Base eligibility: newest row (by updated_at) of the same entity_type_id + appearance_variant with status `done` or `approved`, backend `gpu-box`, generation_kind `creature`, atlas_key and manifest_key set, manifest.cell equal to [48,64], and its concept file (concept_key object) byte-identical (sha256) to the concept file this run uses. Redraw rows qualify (their sheet is the full updated sheet).
- Only when the run REUSES the kept concept. A freshly drawn concept (no kept, other box, refused) → no base → today's full draw.
- Requested cells = row.actions × row.directions × frames_per_action. A base cell (a,d,i) exists when the base manifest has key `a/d/i`. Flagged = base quality entry with passed:false.
- Keep (a,d,i) iff it exists in base AND not flagged. Draw row (a,d) iff any requested cell of it does not exist in base. In drawn rows, take from the new drawing: every cell that doesn't exist in base PLUS every flagged base cell; keep the existing unflagged ones (user decision: keep and add).
- Flagged base cells in NOT-drawn rows: kept, then fixed with use-good-frames (spriteFrameReplace) after merge.
- Box JobSpec for a partial draw: actions = sorted unique actions of drawn rows (in row.actions order), directions = unique directions of drawn rows (compass order s,se,e,ne,n,nw,w,sw), frames = frames_per_action. Extra rows the box draws from the cartesian product are ignored.
- No drawn rows → no box job at all: build the sheet from the base (+use-good-frames), store, complete; concept_key = the run's concept copy.
- Merged manifest: exactly the requested actions × directions × frames, rows in buildBoxSheetManifest's order, cell [48,64]; quality: kept cells keep base entries, drawn cells take the new sheet's entries; then size check (withSizeJumpFlags) then auto replace of failed cells via replaceFrames (skips recorded, never throw). `unmirrored` from row.real_western as buildBoxSheetManifest does. Add `reused_from: <base row id>` and `reused_cells: <n kept>`.
- Note on the row: `reused <kept> of <total> cells from sheet <base updated_at YYYY-MM-DD HH:MM>`.
- Never modify the base row or its files.
- DB tests: scratch DB postgres://user:password@localhost:15432/game_db_incr (TEST_DATABASE_URL and DATABASE_URL; never game_db). No git stash. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; subjects `(SOMET-702)`.

## Review Focus
1. A base drawn from a different concept must never be reused (hash differs) — test.
2. Frame count 2 → 6: rows drawn whole, frames 0-1 kept from base (unless flagged), 2-5 from the new draw — test.
3. Nothing to draw: no box call at all — test.
4. Partial job returns extra cartesian rows: ignored, merge still exact — test.
5. A base with flagged cells in kept rows: fixed by replaceFrames after merge; a row with no good frame stays flagged (skipped) — test.

---

### Task 1: Pure planner + merger (`backend/src/services/spriteIncremental.js`)
**Produces:**
- `planReuse({ actions, directions, frames, baseManifest }) -> { keep: Set<'a/d/i'>, drawRows: [{action,direction}], jobSpec: {actions, directions} | null, total }`
- `mergeSheets({ actions, directions, frames, realWestern, base: {png, manifest}, drawn: {png, manifest} | null, keep }) -> { png, manifest }` (decode with pngAlpha.decodeRGBA, encode with pngTrim.encodeRGBA; manifest shape as buildBoxSheetManifest produces, including `frames` rects, `rows`, `quality`, `unmirrored`).
- [ ] Tests first (`backend/tests/sprite_incremental.test.js`, synthetic sheets): all Review Focus cases 2, 4 at module level; keep/draw sets; jobSpec unions in the right order; merged pixels equal sources; quality carried from the right source; unmirrored per realWestern.
- [ ] Implement; run the file + sprite*/gpu_box* twice; commit `feat(sprites): plan and merge incremental sprite sheets (SOMET-702)`.

### Task 2: Dispatcher integration
**Consumes:** Task 1. **Files:** `backend/src/services/spriteDispatcher.js` (submit/execute paths for creature rows, intake storing), maybe `spriteJobQueue.js` (a base lookup query).
- [ ] Base lookup (Global Constraints) + concept hash compare (read both concept objects via the store; sha256).
- [ ] When the kept concept is reused and a base qualifies: planReuse → no rows → build from base, store, complete, note; else submit JobSpec with the reduced actions/directions, remember the plan on the row (a jsonb `reuse_plan` is NOT available — re-derive the plan at intake from the same inputs; the base id goes in the note/manifest; persist `reuse_base_id` on the row ONLY if needed via a migration `1714440861000_sprite_sets_reuse_base.js` (nullable uuid) so a resumed job after restart merges against the same base).
- [ ] At intake: build the drawn partial manifest from the box atlas (buildBoxSheetManifest with the reduced actions/directions), merge with the base, size check, auto replace, store, complete, note.
- [ ] Tests (sprite_dispatcher.test.js style with fakes): Review Focus 1, 3, 5; resumed job after restart merges with the same base; redraw and prop paths untouched; no base → unchanged full draw.
- [ ] Run sprite*/gpu_box* twice; commit `feat(sprites): re-runs keep good frames and draw only what is missing (SOMET-702)`.

### Task 3: Tab note
- [ ] The subject row / preview shows the row note (if not already shown) so "reused N of M cells…" is visible; the cell estimate stays the full count (the plan is decided at dispatch) — add a hint `cells already drawn from the same concept are reused at run time` under the estimate. Test the hint text. Commit `feat(sprites): show reused cells in the sprite tab (SOMET-702)`.
