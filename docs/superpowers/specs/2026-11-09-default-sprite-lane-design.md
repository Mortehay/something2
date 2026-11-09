# Default creature sprite lane + predictable ETA — design

Date: 2026-11-09. Status: draft for the owner's approval.
Project 1 of 3 from the 2026-11-09 sprite brainstorm:
- Project 2, effect sprites (skills, auras, casts, projectiles, buffs), is a separate spec.
- Project 3, every GPU job visible in the box Activity tab, is box-side work already approved and in progress in the box session.

## 1. Intent

The owner wants a full creature sprite (all actions, 4 facings) generated on the GPU box in **1–2 hours**. That lane should be the Sprite tab's default. The other generation methods stay selectable, and every method shows a **predictable time estimate before queuing**.

Today a full sheet takes 1.8–3.7 h and sometimes 19 h, with no way to know in advance. Box measurements (report 2026-11-09, summarised in §9) show where the time goes:
- Drawing a cell costs a steady ~32 s at 4 steps (±5%).
- The waste comes from the **quality-check redraw rounds**: 52–58% of the slow sheets, and they fixed few cells (34 → 31 failing).
- Queue wait and model switches add unpredictable time on top.

The owner chose Qwen that fits the 12 GB card as the base. They do not want the 3D route, and it is closed by box decision 0016. Nunchaku, stable-diffusion.cpp, Flux Kontext and video models were investigated and rejected for now (§9).

## 2. Goals

1. **New default lane: "Fast full sheet".**
   - Qwen-Image-Edit-2511 Q2_K + Lightning, 4 steps (the box default engine, diffusers).
   - Facings s, e, n. The game draws w by mirroring e at render time, so the sheet has no w row. Already today's default (`SPRITE_DIRECTIONS`, frontend `DEFAULT_DIRECTIONS`), so no change is needed.
   - **All actions the body plan allows:** 7 for humanoids (idle, walk, attack, cast, damage, death, use), 5 for quadrupeds (cast and use are already excluded).
   - 4 frames per action.
   - **`quality_checks: false`.**
   - Target ~49 min of box time for a humanoid: 84 rendered cells at 32 s plus fixed overhead.
2. **Bad frames are fixed by a human, not by the box's QA loop.** The admin flags frames and uses the existing per-frame Redraw (81–326 s per redraw on the box).
3. **Every method shows an ETA before queuing:**
   - per row, plus a batch total;
   - from the box's measured time model (§5), not a single flat seconds-per-cell figure;
   - including the queue ahead on the box.
   - With QA on, the ETA is a **range**, never a single number.
4. **The ETA is checked against reality.** Each finished row stores predicted vs actual seconds, and the constants are re-derived from that history.
5. **Room for the reference-size speedup.**
   - A box spike is running now: reference encoded at 512/768/1024 instead of a fixed 1024, measured at 1.78× faster per step at 512.
   - If it passes and the box exposes a JobSpec field for it, the default lane uses the winning size and the ETA constant follows.
   - This lands as a follow-up slice, not as a blocker.

## 3. Non-goals

- Effect sprites (project 2) and box Activity visibility (project 3).
- Changing the box's drawing pipeline. That includes per-action frame counts, batch-2 cells and skipping unused west references. They are box-side speedups (box report §5 item 3) and become follow-ups when the box ships them.
- 8 facings. Rendered west rows come back facing east (measured), so w stays mirrored.
- Reviving the HQ ComfyUI lane or the 3D turnaround as defaults.
- Ping-pong frame reuse for idle/cast/use (render 3, play 0-1-2-1). The box recommended it, but it is a renderer change and it is not requested here. Candidate follow-up.

## 4. Anti-goals: this fails even if it "works" when

- **The ETA lies.** A row shows "~49 min" but routinely takes 2 h. For lanes that keep QA on, a single number is worse than an honest range.
- **QA is silently still on** for the default lane, because the box's default is `quality_checks: true` and the field was not sent. The ETA would be right only by luck.
- **The default draws only idle.** The Sprite tab's `defaultActionsFor` (`spriteSelection.js:590`) ticks only `idle` today, and the backend's `DEFAULT_ACTIONS` is not what the tab sends. The owner asked for all actions.
- **Some admin's earlier choice silently changes.** Existing rows keep their stored `sampling`, `sheet_method`, actions and QA setting; only new queues get the new default. Re-queueing a row in place (`enqueue` UPDATE) takes the new request's values, including `quality_checks`. A change of `quality_checks` must detach the old box job the same way a `sampling` change does (the existing detach CASE), so a stale box job drawn with the other setting is never reused.

## 5. ETA model (from the box, 2026-11-09)

```
T = Q + G + 15 + (25 + c·D) + (15 + 0.6·N) + (25 + c·N) + X + 5     seconds
```

| Symbol | Meaning |
|---|---|
| N | cells drawn = actions × rendered facings × frames (rendered facings exclude mirrored w/nw/sw) |
| D | facings requested. The box renders one turnaround reference per requested facing, so D = 3 for default rows (s, e, n). Rows that request west facings pay for references nothing uses (box follow-up) |
| c | seconds per cell = 7.7·steps + 1.3 at 512 px Q2_K. 4 steps 32 s (±5%); 8 steps 58–62 s; Q6_K presets use their existing measured constants in `spriteSampling.js`; reference at 512² ≈ 18.6 s (one probe, pending the spike) |
| X | 0 when `quality_checks:false`. Otherwise r·N·c + 40 s per round, ≤3 rounds, r ∈ [0, 1.45], median ≈ 0.3. **Shown as a range** (low r=0, typical r=0.3, high r=1.45) |
| Q | remaining ETA of every job ahead on the box (one solo worker, FIFO) |
| G | 0–300 s model-gateway switch when another model holds the card. Shown as "+ up to 5 min" when the gateway reports a different active model, else 0 |

Box checks (both QA on; predicted with the X that actually happened, Q = G = 0):

| Job | Spec | N | D | steps | X (measured redraw) | Predicted | Actual |
|---|---|---|---|---|---|---|---|
| 3990224b | 1 action × 8 dirs × 6 frames, 96x128 | 30 (5 rendered dirs) | 8 | 4 | 988 s | 2,288 s | 2,322 s |
| 98045cb9 | 7 actions × 3 dirs × 4 frames, 96x128 | 84 | 3 | 8 | 7,751 s | 13,098 s | 13,254 s |

The unit tests replay these with X fixed to the measured redraw time and expect predicted within ±2% of the box's own predicted figure. A separate test checks the QA-on range: given only the spec, the actual time falls between the low (r=0) and high (r=1.45) ends.

**What is "actual":** the box drawing time, i.e. the existing `sprite_sets.sheet_seconds` (box job running → done, `spriteDispatcher.js:~1008`). Reuse that column; don't add a second definition. The ETA shown before queuing is two parts: **box time** (formula without Q and G, compared against `sheet_seconds`) and **wait ahead** (Q + G, slice 3). Only box time is compared and calibrated.

**Where Q comes from:** the box's `/api/jobs` (queued/running jobs with their specs and progress), each run through the same formula. After project 3 lands, also from the gateway `hold`.

**Calibration:**
- Store `predicted_seconds` (box time only) at queue time. Actual is the existing `sheet_seconds`.
- The Sprite tab shows predicted vs actual on finished rows.
- `c` per lane is the median of (`sheet_seconds` − fixed overhead) / N over the last N finished QA-off rows of that lane, falling back to the constants above. This replaces today's single `SEED_SECONDS_PER_CELL = 57` / `lastSecondsPerCell` logic in `spriteBatchRoutes.js`.
- Incremental re-runs and redraw jobs are excluded from calibration, because their N is not the sheet's N.

## 6. What changes, by area

### Backend

- `spriteSampling.js` / `generationMethods()`:
  - Add the default lane: id `fits_fast`, already present as "Fits card, fast", gains `quality_checks: false`.
  - Each method gains an explicit `quality_checks` value and its ETA constants.
  - **Marked as the builder's call:** whether QA-on variants appear as separate methods ("Fits card, fast + auto-fix") or as one QA toggle per row. The owner's intent: QA off by default, still possible to turn on.
- `spriteDispatcher.js`: always send `quality_checks` explicitly in the box `/api/jobs` JobSpec (full and incremental sheets), never relying on the box default. **Redraw requests are unchanged** (`{frames}` only): a redraw is human-chosen frames, and the box's redraw contract is marked `[ASSUMED]` in `gpuBoxSprites.js:395`, so adding fields there is out of scope.
- **The default lane is diffusers-only.** `fits_fast` today carries `hq: true`, so on the parked `comfyui-hq` connector it sends `HQ_FAST` (Q6_K). HQ rows keep their current behaviour and are not the default. Whether ComfyUI honours `quality_checks` is irrelevant while HQ is parked.
- **Frontend default actions** (`spriteSelection.js` `defaultActionsFor`): the default ticks every action in the box action catalog that the row's body plan allows, i.e. all 7 for humanoids and no cast/use for quadrupeds (`creatureBodyPlan.js`). Props keep their separate `prop_fx` behaviour. Align the backend `DEFAULT_ACTIONS.creature` in `spriteJobQueue.js` with this too, so API callers that omit `actions` get the same default.
- `sprite_sets`:
  - Persist the QA choice: a new column `quality_checks boolean`. NULL means a legacy row, drawn with the box default (on).
  - Persist `predicted_seconds`. Actual is the existing `sheet_seconds`.
  - Add `quality_checks` to the `enqueue` UPDATE and its detach-box-job CASE (§4).
  - One migration. Mind the migration timestamp collision pattern.
- **ETA service.** A small pure module implementing §5, unit-tested against the box's two real-job checks above. It is used by:
  - the queue preview endpoint (before queuing);
  - the batch countdown that today uses `run.current.secondsPerCell` / `run.queuedSeconds`.

### Frontend (Sprite tab, `/game/sprites`)

- The Generation method select lists every method with its ETA for the selected rows, e.g. "Fits card, fast — ~49 min", or "Fits card, slower + auto-fix — 1 h 40–3 h 10". This **replaces** the existing per-method estimate (`samplingOptionLabel` / `estimateLabel` / `presetSecondsPerCell` in `spriteSelection.js`), which today is a flat cells × s/cell. Feed it from the backend ETA module so the frontend and backend never disagree.
- The queue confirmation shows the batch total, the queue ahead on the box, and a "+ up to 5 min model switch" when it applies.
- Finished rows show "took X (estimated Y)".
- New queues default to the fast lane with all actions.

### Box dependencies

None for the default lane. `quality_checks` is in the box's live JobSpec (openapi, read 2026-11-09), and the box's own 2026-11-09 timings were taken with `quality_checks:false`. Nothing in something2 sends it yet. Slice 2's live run is the proof that the box honours it: no redraw stage in the job's progress and time inside ±10%. The reference-size slice needs a box JobSpec field, proposed by the box as `ref_size` (§7).

## 7. Slices

1. **ETA module + calibration columns.** The pure formula, tests, `predicted_seconds`/`actual_seconds`, and "took X (est Y)" on finished rows. Ships value alone: honest numbers for every existing method.
2. **Default lane.** Explicit `quality_checks`, full default actions, the method select showing ETAs, and a QA-on option. Includes a live box run: one humanoid on the default lane. Its actual time must land within ±10% of the predicted time, with QA off.
3. **Queue-ahead in the ETA.** Read the box's queued and running jobs and add Q and G.
4. **Reference size (conditional).** Only if the box spike passes and the box ships the JobSpec field: send the winning size on the default lane and update `c`. Otherwise this slice is dropped and noted.

## 8. Verification

- Unit tests for the ETA module against the two real box jobs (±2%), and a QA-off case.
- **The dispatcher test asserts the JobSpec body carries `quality_checks:false`**, captured at the HTTP seam, not from a mock's echo.
- **Live:** one default-lane humanoid sheet on a private DB, following the private live-box-leg harness. Record predicted vs actual (`sheet_seconds`), and look at the sheet: all 7 actions present, rows s, e and n (w is mirrored in-game, not on the sheet). Check in-game that w draws as mirrored e. Don't run it while the box reports a hold or a spike.
- **Browser check** in muted headless Chrome: the method select shows the ETAs, and the queue POST body carries the chosen method and actions.

## 9. Evidence: box report 2026-11-09, condensed

- **Per-cell cost:** 7.7 s/step, so 32 s/cell at 4 steps and 60 s at 8.
- **Redraws:** 52–58% of the slow sheets.
- **4 facings (s, e, n + w mirrored), QA off:** 7 actions × 4 frames ≈ 49 min; 3 frames ≈ 38 min.
- **Same, QA on:** 61–118 min and 39–92 min.
- **Rejected:**
  - 384 px output, which lost the walk motion;
  - 3D (decision 0016);
  - Nunchaku, which has no custom LoRA support, so the angles LoRA cannot load;
  - stable-diffusion.cpp, which saves ≤25% for a large integration;
  - Flux Kontext and video models, which are not on disk.
- **Pending:** the reference-size spike (512/768/1024 × warrior + wolf × 2 seeds).
- Full summary saved in the session scratchpad. The original lives on the box at `~/sprite-speed-report-2026-11-09.md`.

## 10. Left to the builder

- How QA-on is exposed: separate methods vs a per-row toggle (intent in §6).
- The exact calibration window N and the fallback rules.
- UI wording and layout of the ETA within the existing Sprite tab patterns.

## 11. Calls made by the spec author (not confirmed by the owner)

- Default cell size stays 48x64 (today's default). The box recommends 96x128, and drawing time is the same because cells render at 512 px either way. Switching the default is a one-line follow-up if the owner wants it.
- 4 frames per action, not 3 (~49 vs ~38 min; both fit the owner's 1–2 h).
- Actual time = box drawing time (`sheet_seconds`); queue wait shown separately.
- The default lane is diffusers only; HQ rows unchanged.
- Redraw requests don't carry `quality_checks`.
- Ping-pong reuse and per-action frame counts are deferred.
