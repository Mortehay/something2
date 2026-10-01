# Tile land-cover art — restore, stage, re-prompt

Date: 2026-10-01. Source: grill session of the same date (decisions below are settled; do not re-open them without evidence).

## Problem

On 2026-09-30 an Art Console batch regenerated every tile on `gguf:qwen-image-2512-Q2_K+lightning8` and wrote each result **straight to `tile_types.image`**. All 50 live tiles now point at unreviewed output that is photoreal and draws scenes instead of ground: a face (`titan_floor`, `maw_floor`), tunnels (`cave_wall`, `umbral_floor`, `chasm`), a well (`cistern_shallows`), a door. The raw output also skipped the host-side seamless/repeat pass, so even the good ones are not tileable.

Causes, each confirmed from the DB or the code:

1. **Subject nouns in the prompt get drawn.** "colossal weathered titan masonry", "raw pulsing flesh-like ground".
2. **Biome `art_style` is scene language.** 28 of 32 biomes are "<place> fantasy, <atmosphere>" ("monumental scale", "living devouring maw, organic horror", "torchlit gloom"). `composeBiomePrompt` appends it to every tile prompt.
3. **`Avoid: no grass` puts "grass" in the positive prompt.** The request also sends `cfg_scale 7, steps 20` + a negative prompt to a Lightning-8 model (designed for ~CFG 1 / 8 steps). Unknown whether the box honours or clamps these.
4. **Four paths write tiles live**, three of them with no approval: the Art Console dispatcher (`artDispatcher.js:394` → `catalogSubjects.js:224`), `bulkImageRegeneration.js:38`, and `scripts/generate-tile-textures.js:108`. The fourth is the older TILE_TYPES admin flow (`/api/tile-jobs` → `POST /api/tile-types/:id/image|sprite`, `index.js:4058/4075/4098`, via `useTileSprites.js`/`TileTypesAdmin.jsx:351`), which has an approve step but no seamless pass. **Only the dispatcher records `art_generations` rows.** The other three leave nothing a promote step could find.
5. **Seamless + `repeat=2` only exist host-side** (`tools/make-tiles-seamless.py`, run between `art-export` and `art-seed`), so nothing generated through the app is ever tileable until someone runs the host loop.

## Decisions (from the grill)

| # | Decision |
|---|---|
| D1 | Target: ground tiles read as continuous land cover for the RPG. |
| D2 | Style: stylised, hand-painted, **not** strict pixel art. The checked-in seeded batch is the style reference. Drop "pixel art" from tile prompts. |
| D3 | Restore the checked-in baseline first, then regenerate to a stricter bar (smaller features, lower contrast, even detail). |
| D4 | Keep the Qwen model; fix the prompt. |
| D5 | Tile prompt = material, texture and colour only. No subject nouns, scale or mood words, no `Avoid:` clause. |
| D6 | New biome field `tile_style` (palette stays). Tiles use `palette + tile_style`; `art_style`/`exclusions` stay for entities and creatures, untouched. |
| D7 | Scope: the 45 ground tiles (`wall_height = 0`). The 5 walls/doors get a visual check only. |
| D8 | Bulk runs create **candidates**. A tile goes live only by per-tile approval. |

## Facts verified while planning

- **Baseline is correct as committed.** HEAD's tile PNGs repeat with a period of exactly 256 px (mean abs diff ≈ 0.5–1.7 at a 256 px shift vs 14–50 at other shifts), i.e. **one** `repeat=2` pass. The 2026-09-11 seeds were raw. No double-processing, so restore from HEAD.
- **The restore command already exists:** `make tiles-seed FORCE=1 [ONLY=a,b]` (`artSeed.js` tile gate: `force` overrides `has-art`, and it writes `image`, clears `sprite` and sets `render_mode='image'`). Nothing to build.
- The Art Console has **no approve action** (`ArtConsoleAdmin.jsx`). Every generation is already recorded in `art_generations` with its own `image_key`, so candidates exist; only the promotion step is missing.
- `sprite-gen` (Python + Pillow) is running in the stack; the backend has no image library (`pngAlpha.js` is zlib-only).
- `make-tiles-seamless.py` records that the words "seamless", "tileable" and "repeating pattern" were **measured** producing stripes and sheets. The prompt suffix must not use them.

## Slices

Each slice ships and is verifiable on its own. Order matters: S1 fixes the live game today, and S2 must land before any regeneration (S4) or the next batch goes live unreviewed again.

### S1 — Restore the baseline (ops, no code)

- Run `make tiles-seed FORCE=1` against the dev DB. **This mutates the shared dev DB. Confirm with the user before running.** It is the documented seed path, not an experiment.
- Walls/doors (D7) are restored too; they were never in scope for regeneration.
- **Verify:** all 50 `tile_types.image` keys are `sprites/tiles/<name>/seeded/...`. In the browser, walk the entry world plus one dungeon: ground reads as the old painterly textures with no faces or tunnels. Remember the game auto-fullscreens on Play.
- **Accept:** the in-game ground matches the pre-2026-09-30 look.

### S2 — Tile generations become candidates, with a promote action

**Principle:** the Art Console dispatcher is the **only** way a tile gets generated. It is the only path that records `art_generations`, so it is the only path whose output can be promoted.

**Backend**
- The dispatcher stops writing live for tiles. The generation row (already written, with `image_key`) is the candidate. Implement it as a registry flag (e.g. `staged: true` on the tile subject in `catalogSubjects.js`) checked at `artDispatcher.js:394`, not as a tile special-case buried in the dispatcher.
- `bulkImageRegeneration` for `tile_types`: **enqueue art jobs** instead of generating and writing. If that's awkward, refuse `tile_types` with a message pointing to the Art Console. Don't stage there, because it records no generation, so staged output would be thrown away.
- `scripts/generate-tile-textures.js` / `make tiles-generate`: same treatment. Enqueue art jobs, or retire it. Keep its pin/biome bookkeeping only if it is still needed.
- TILE_TYPES admin generate/approve (`/api/tile-jobs`, `POST /api/tile-types/:id/image|sprite`, `useTileSprites.js`, `TileTypesAdmin.jsx:351`): remove the static-image generate/approve UI for tiles and link to the Art Console. Keep `/sprite` only if animated tiles are still generated there (out of scope; don't break them).
- New `POST /api/art-subjects/tile/:key/promote { generationId }` (adminGuard): loads the generation, **runs tile post-processing (S3) on the raw generation image**, uploads the result under a new key, and sets `image`, `sprite = NULL`, `render_mode='image'` and a new `tile_types.art_generation_id` (nullable FK). The processed key never equals a generation's `image_key`, so the column is what tells the UI which candidate is live.
- **Undo** = promote an older generation. **Revert to the seeded baseline** = `make tiles-seed ONLY=<name> FORCE=1`, which also clears `art_generation_id`. Seeded images have no generation row, so promote can't target them.

**Frontend (`ArtConsoleAdmin.jsx`)**
- Each `done` row in Generation history gets **Use this**. The row matching `art_generation_id` is badged **Live**. Show "seeded baseline" when the column is null.

**Tests** (`tdd-seams`: through the route and the dispatcher, not by reading source)
- Dispatching a tile job leaves `tile_types.image` unchanged and adds a `done` generation. Make it **fail first** on current main.
- Promote writes the processed key and `art_generation_id`. Promoting the previous generation switches both back.
- A bulk or tile-script run for tiles writes nothing to `tile_types.image`.
- Update `backend/tests/tile_jobs_api.test.js:51-93`, which asserts the live-write SQL. It is also a regex-matched mock pool (a known vacuous shape), so don't copy that pattern. Assert the live key **before and after** with a real dispatch against a scratch DB (`TEST_DATABASE_URL` set; never the shared dev DB).

**Accept:** run a 3-tile batch from the Art Console. The game does not change. Click **Use this** on one tile, reload the game, and only that tile changes and tiles seamlessly.

### S3 — Tile post-processing on the promote path

- Move the offset-and-heal + repeat logic from `tools/make-tiles-seamless.py` into the **existing** `sprite-gen/app/postproc.py` (it imports only PIL at the top) as a pure function, exposed as `POST /postprocess/tile {image}`. The host tool imports the same function. Pin Pillow explicitly in `sprite-gen/requirements.txt` (today it arrives transitively). **One implementation, not two copies:** this project has shipped drift between duplicated copies before (collision, `authHeaders`).
- The promote route calls it. If sprite-gen is down, promote fails loudly (502 with a message) and never promotes a raw image.
- Repeat is a **constant 2**. `repeat` in `tiles.json` is only an output marker written by the host tool; nothing reads it, and the renderer stretches one image per diamond (`tileTexture.js:48-55`). No column, no migration.
- *Rejected alternative:* promote sets the raw key, then the admin runs `make tiles-export ONLY=x && make tiles-seamless && make tiles-seed ONLY=x FORCE=1`. It needs no new endpoint, but raw non-seamless art is live in between and every approval needs a host shell. Revisit only if the sprite-gen endpoint turns out costly.
- **Tests:** the Python unit test asserts wrap-continuity (edge column diff below a threshold) and period = size/repeat, reusing the 256 px periodicity measurement from this plan. A backend test covers the route calling the service. Double-processing guard: promote always processes the **raw generation**, never the live key, so re-promoting cannot compound.
- **Accept:** a promoted Qwen tile shows no visible seams across a 5×5 patch in game, and its measured period is 256 px.

(S2 and S3 can be built in parallel but must merge together. S2 without S3 would promote raw, non-seamless tiles.)

### S4 — Prompt contract + `tile_style`

- Migration: `biomes.tile_style text not null default ''`, editable in the Biomes admin next to `art_style`. Seed the 32 values in `backend/seeds/data/biomes.js` **and** add `tile_style` to the biome upsert in `seed-catalogs.js:97-110`, both the INSERT and the ON CONFLICT (per `spec beats migration on re-seed`). Draft all 32 as "hand-painted, <2–4 colour/light adjectives>", with no place nouns. Example: Umbral Warren → "hand-painted, deep violet-black, faint cold sheen".
- New `composeTilePrompt(material, biome)`: `material + palette + tile_style + TILE_SUFFIX`. `composeBiomePrompt` is unchanged for the other kinds. Tile call sites: `catalogSubjects.js:220` (tile `composePrompt`), `index.js:3158` (interactive), `bulkImageRegeneration.js:181` and `generate-tile-textures.js:89`. After S2 the last two may be gone or enqueue-only; whichever survive must use the new function.
- Tile Prompt corrections: the dispatcher drops notes for any kind with `composePrompt` (`artDispatcher.js:156-160`), and tiles have one. So the console's "Prompt corrections" box does nothing for tiles today. Either wire tile notes into `composeTilePrompt` (corrections appended, avoid-notes **dropped**, because this model has no working negative prompt), or hide the box for tiles. Recommended: wire corrections, since S5's review loop depends on it.
- `TILE_SUFFIX` (draft; tune in S5): "top-down ground surface for a 2D fantasy RPG, stylised hand-painted texture, flat even light, small evenly spread detail, no objects, no figures, no perspective, no horizon". Deliberately excludes "seamless/tileable" (measured harmful) and "pixel art" (D2).
- Rewrite the 45 ground tiles' `prompt` in `backend/seeds/data/tileTypes.js` (the only source; map specs hold no tile prompts, and `seed-catalogs.js:45-63` makes the seed win) to material-only. Drop "extreme close-up, fills the entire frame, even soft daylight, pixel art" from all of them. Examples: `titan_floor` → "weathered grey granite slabs with dust-gold grit"; `maw_floor` → "wet dark-red fleshy ground with glossy black bile puddles"; `cistern_shallows` → "shallow clear water over pale flat stone".
- **Lightning check (do first, before tuning words):** on the box, run the same seed and prompt for 3 tiles at `cfg 7 / 20 steps + negative` vs `cfg 1 / 8 steps, no negative`. If they differ materially, the box honours the params, so update provider row 4's `request_template` to the Lightning settings (a DB write to the shared provider row: **confirm with the user**). If they are identical, the box clamps them; note it and move on.
- **Tests:** unit-test `composeTilePrompt` (no `Avoid:`, no `art_style` text, includes `tile_style` and palette). Add a guard test over the seeded tile prompts rejecting the words `pixel art`, `close-up`, `Avoid`, `seamless`. Derive the forbidden list independently of the suffix constant; do not assert the code against its own constant.
- **Accept:** a 6-tile trial batch (grass, sand, cobblestone, water, maw_floor, titan_floor) with per-subject seeds produces candidates with no faces, tunnels or perspective in at least 5 of 6.

### S5 — Regenerate and review the 45

- Queue the 45 ground tiles (`wall_height = 0`) via the Art Console with per-subject seeds, concurrency 1 (the 217 box crashes at concurrency 2 on large jobs).
- Review each in the modal, **Use this** for the good ones, and reject the rest by leaving them unpromoted (the seeded tile stays live). For the rejects, add a Prompt correction (works once S4 wires tile notes) or edit the tile's material prompt, then requeue.
- Then `make tiles-export` and commit the new seeds. A full export drops every `seamless` flag (`artSeed.js:291-294`), but **every** live tile is already processed: promoted ones by S3, and unpromoted seeded ones by the earlier host pass. So set `seamless: true` on **all** manifest entries and **do not run `make tiles-seamless`**. Verify the period-256 measurement on every exported PNG before committing. It catches both a missed pass and a double one.
- **Accept (user-visible):** walking a meadow, a desert, a cave and The Maw, ground reads as continuous land cover, with no stamped grid, no objects or figures, and neighbours of different types blend. The user signs off in-game.
- **Rollback trigger:** if more than about 15 of the 45 are rejected after one correction round, stop and re-open D4 (model choice) with a bake-off against `sdxl-base-1.0+local:something2-terrain`.

## Out of scope

- The 5 wall/door tiles (D7): visual check only after S1.
- Entity, creature, item, skill and passive art, and their use of `art_style`/`exclusions`.
- Strict pixel-art post-processing (palette quantize, nearest upscale). Rejected in D2.
- Model changes or LoRA training (unless the S5 rollback trigger fires).
- Animated tiles (`render_mode='animated'`).

## Assumptions (unverified)

- A1 (checked by review): no code deletes `art_generations` objects (`removeObject` is used only in `audioLibrary.js`). Re-check if a cleanup job is ever added.
- A2: Nobody depends on `make tiles-generate` or the TILE_TYPES static-image flow outside this admin. S2 retires or redirects both.
- A3: Qwen can produce flat top-down ground once subject and scene words are gone. S4's 6-tile trial tests exactly this before S5 spends 45 generations.

## Risks

- **Green suite over a dead feature** (recurring in this repo): staging tests pass while one of the three live writers still writes. Mitigation: S2's acceptance is a real Art Console batch plus a DB check, not the suite.
- **Tile post-processing moved into a service** adds a runtime dependency to promote. Mitigation: fail loudly and never fall back to raw.
- **Re-seed overwrites.** Tile prompts and `tile_style` must live in the seed specs or a re-seed undoes them (see `spec-beats-migration-on-reseed`).
- **Shared dev DB and shared checkout.** Build in a worktree, test on a scratch DB, and do not `git checkout` in the main directory (concurrent sessions).

## Verification summary

| Slice | Automated | Manual / live |
|---|---|---|
| S1 | — | DB keys all `seeded`; browser walk |
| S2 | dispatch-doesn't-write (fails on main), promote/undo | 3-tile batch leaves game unchanged; one promote changes one tile |
| S3 | Python continuity + period; route test | 5×5 patch seamless in game |
| S4 | composeTilePrompt unit; seeded-prompt word guard | Lightning A/B; 6-tile trial ≥ 5/6 clean |
| S5 | period-256 on exported PNGs | user in-game sign-off |
