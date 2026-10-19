# Seed/Export Plan 3: size report (SOMET-640)

Measured on 2026-10-19. The counts come from `game_db` (SELECTs only; schema head
`1714440790000_seed_sync_plan2`). The bytes come from the `feat/seed-export-plan3`
worktree's `backend/seeds`.

## Asset keys in game_db (non-empty)

| Table / column | Rows | Plan 3 dir |
|---|---:|---|
| `tile_types.image` | 50 | `textures/tiles` |
| `tile_types.sprite` | 0 | `textures/sprites/tile_types` |
| `entity_types.image` | 371 | `textures/entities` |
| `entity_types.sprite` | 0 | `textures/sprites/entity_types` |
| `item_types.icon` | 279 | `textures/items` (capped at 256 px) |
| `catalog_art` `skill` | 300 | `textures/skills` (capped at 256 px) |
| `catalog_art` `passive_label` | 128 | `textures/passives` (capped at 256 px) |
| `character_appearances.image` | 30 | `textures/character-appearances` |
| `character_appearances.sprite` | 0 | `textures/sprites/character_appearances` |
| `audio_clips`, bound (the ones that sync) | 4944 of 4944 | `audio/<kind>` |
| bound clips with no `sha1` | 0 | (none, so no `audio_sha1_missing` refusal) |

That is 1158 images and 0 sprite atlases (no row anywhere has an `atlas_key`).

## Bytes on disk today

| Path | Files | Bytes |
|---|---:|---:|
| `textures/` (total) | 1158 png + 6 manifests | 211,216,041 (204 MB) |
| ↳ `entities/` | 371 | 139,690,619 |
| ↳ `skills/` | 300 | 20,946,226 |
| ↳ `items/` | 279 | 16,352,557 |
| ↳ `tiles/` | 50 | 13,726,708 |
| ↳ `character-appearances/` | 30 | 12,015,464 |
| ↳ `passives/` | 128 | 8,244,963 |
| `audio/` (total) | 4944 ogg + 3 manifests | 326,372,406 (322 MB) |
| ↳ `music/` | 101 | 184,662,628 |
| ↳ `sfx/` | 4692 | 75,855,211 |
| ↳ `ambience/` | 151 | 61,431,626 |

`git count-objects -vH`: the pack is 647.76 MiB.

## Expected churn on the first export

### Audio: none

The Plan 3 audio file is `audio/<kind>/<safeName(label)>-<sync_uuid first 8>.ogg`. The
Plan 3 migration sets `sync_uuid = id` for existing clips, so this is the same name the
legacy exporter used (`<safe(label)>-<id8>.ogg`).

I checked every bound clip in game_db against its file, using sha1sum on the file:

- **4944 of 4944 files exist and match their row's `sha1`.**
- 0 are missing.
- 0 have a different sha1.
- 0 files on disk are orphans.

`prepareExportAssets` reuses a file whose sha1 matches, so the first audio export
downloads nothing and changes no file. Only `backend/seeds/sync/audio.json` is new.

### Art: every image downloads once, and 428 icons get new names

- **Downloads: all 1158 images, about 211 MB.** No PC has `seed_asset_hashes` entries yet,
  and an uncached key is always fetched, even when a file with the right name exists.
- **Rewritten in place, same name:** tiles (50), entities (371), items (279) and character
  appearances (30). The Plan 3 name `<dir>/<safeName(name)>.png` equals the legacy name
  for all 730 of them.
  - **Entities:** every one of the 371 files changes. The legacy upload trimmed them,
    and the export writes the store's bytes. That is about 140 MB of new blobs in git
    history, once.
  - **Tiles, items and appearances:** these change only where the stored object differs
    from the legacy file. Measuring that would mean reading the real bucket, which this
    task does not do. The item icon cap uses the same `shrinkToEdge` as the legacy
    exporter.
- **New names for catalog icons:**
  - The file name is the natural key `subject_kind|subject_key`, as the plan specifies.
  - So skills become `textures/skills/skill_<key>.png` (legacy: `<key>.png`), and
    passives become `textures/passives/passive_label_<key>.png` (legacy: a label-based
    name).
  - **All 428 are new files, about 29 MB after the 256 px cap.** The 428 legacy files
    stay where they are as orphans.
  - The export reports them as `orphanFiles` and does not delete them; pruning is out of
    scope.
  - Until someone prunes them, the icons sit in the tree twice.
- **Every later export** downloads only keys that changed since the last export, because
  the cache then holds every key.

### Sprites: 0 today

No tile, entity or appearance row has a sprite atlas, so sprite export adds 0 bytes.
`textures/sprites/` does not exist yet.

## LFS verdict

**LFS is not needed now.** Revisit it when the first sprite atlas is approved.

- Today's binary payload is flat, already in git, and already measured: 204 MB of art
  plus 322 MB of audio.
- The first export adds one generation of about 140 MB (entities) and about 29 MB (new
  icon names).
- After that, churn tracks what admins regenerate.

Sprite atlases (multi-frame sheets) are the only asset type that could grow the repo by
multiples. Revisit LFS once the first atlas is approved and measured. Also prune the 428
legacy icon orphans, so the tree does not carry them twice.

## Verification (Task 7)

### Part A: CLI journey against real services, isolated

Setup:

- `backend/scripts/seed-sync.js` run with node.
- Scratch DB `game_db_seedsync` on both `DATABASE_URL` and `TEST_DATABASE_URL`.
- Shared MinIO at `localhost:19000`, using a throwaway bucket `seedsync-verify-85f0916b`.
- Temporary `SEED_ASSETS_ROOT` and `SEED_SYNC_DIR`.

Results:

1. **Fixtures:** a tile, an item with a 512×384 icon, a `catalog_art` skill at 300×300,
   and a bound sfx clip with a correct sha1.
2. **Export:** `export --group=art` printed
   `progress art download 1/3`, `progress art download 3/3` and `art ok rows=733`.
   - The item icon and the skill icon were written at 256×192 and 256×256.
   - The JSON holds `{ file, sha256 }` for images and `{ file, sha1 }` for audio.
   - `status` then reported `in_sync` for both groups.
3. **Other PC, simulated:** I cleared the art values and the baselines and cache rows,
   and emptied the bucket.
   - `seed --group=art` without `--resolve` refused with `undecided` (exit 2).
   - With `--resolve=git`, both groups seeded (exit 0).
   - Seeded keys:
     - images: `<bucket>/seedsync/<sha256>/textures_<dir>_<name>.png`
     - audio: `audio/sfx/<sync_uuid>-<sha1 first 8>.ogg`
   - The objects exist, and `status` reports `in_sync`.
4. **Re-export:** the asset files are byte-identical by sha256, and the JSON bodies are
   identical apart from `exported_at`.
5. **Missing file:** with a png deleted and its row taking git, the preview blocks a `new`
   row with `asset_file_missing` and its message. The seed refuses `asset_file_missing`.
6. **Cleanup:** I removed all fixture rows, baselines and cache rows, the bucket and the
   temp dirs.

### Part B: tab UI in a browser, against real-engine fixtures

How it was run:

- Worktree vite with `proxy: {}`.
- An unsigned fixture admin token, with `window.fetch` stubbed.
- The fixtures are real engine output from the scratch DB: `/groups` per the route's
  code, plus `previewSeed`, `recentRuns` and real `jobs.js` job objects (running,
  cancelled, failed and ok).
- No console errors.

Screenshots, all under
`/tmp/claude-1000/-home-markunn-worker-coding-jsgame-something2/456368f4-4cc2-43a5-9180-2717ebdcf796/scratchpad/t7/shots/`:

- `1-art-audio-rows.png`: the Art row shows the "git is newer" badge, the Audio row shows
  "in sync", and the "Art and Audio run separately" buttons are visible.
- `2-running-export-job.png`: "Downloading art 1 / 3", with a progress bar and Cancel.
  Cancel then showed "Cancelling…" and then "Cancelled".
- `3a-preview-200-show-more.png` and `3b-preview-400-after-click.png`: a 422-row preview,
  "showing 200 of 422", then 400 after the click.
- `4-blocked-asset-file-missing.png`: `t7sx_tile` is red, "Take git" is disabled, and the
  missing-file message is shown.
- `5-history-art.png`: History filtered to Art, with the export runs and their
  downloaded/reused summaries.
- `6-seed-all-modal.png`: Seed all lists Art and Audio under "run separately", each with
  its own button, outside the batch.
- `7-failed-job.png`: "Failed: regenerate or clear these images first", with the row key
  `t7sx_icon_item`.
