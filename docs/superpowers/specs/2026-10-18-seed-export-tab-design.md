# Seed / Export admin tab — design

Date: 2026-10-18 · Status: draft for approval

## Why

The game is edited through the admin UI on one dev PC and has to start up identically on another dev PC, moving the data through git. Today that is a pile of make targets that cover only some of the data. Things get forgotten: AI configs, quests, entity edits, tile updates. Even when a seed is run, it often doesn't update anything, because several seeders skip rows that already exist (`ON CONFLICT DO NOTHING`). Nothing records when a group was last exported or seeded, so there is no way to see what is stale.

**Success:** one admin tab lists every group that matters for a normal start-up. For each group it shows when this PC last exported it, what is in git (when it was exported and from which PC), when this PC last seeded it, and a status that explains itself. It has buttons to export, to seed through a reviewable preview, and to run the git steps.

## Goals

- A new admin sidebar tab, **Seed / Export**, using layout A from the brainstorm: one table, one row per group, with a history log underneath.
- Every admin-edited group can be exported from the DB to files under `backend/seeds/` and seeded back from them, **losslessly**. A round trip (export → seed into a fresh DB → export again) produces byte-identical files.
- A per-PC history table records every export and seed run.
- Seeding always goes through a **preview** (the mass-check screen) before anything is written. Local edits are never overwritten silently.
- AI provider config travels; **bearer tokens never leave the PC**.
- Optional git buttons (pull / commit seeds / push). They run only when clicked.

## Non-goals

- The Orange Pi staging connection. The Pi runs a baked image with no repo. It gets its **own separate admin tab** (connection to the Pi, pushing seeds to it) in a later design. **Constraint for this design:** the export files and the seed engine must not assume a repo or a bind mount at seed time. The future Pi tab should be able to ship the same export files to the Pi and run the same preview/apply engine there.
- Moving players, characters, users, invite codes, live world state (`world_creatures`, `world_items`, `world_chunks` cache), or job/queue history (`art_jobs`, `audio_jobs`, `art_generations`, `audio_misses`, sprite job state).
- Real-time sync or a merge between two PCs that are both editing. The model is: export on A, push, pull on B, preview, seed.
- Rewriting the hand-authored `backend/seeds/data/*.js` files.

## Anti-goals (it is a failure even if it "works")

- A seed that silently overwrites or deletes something edited on this PC.
- A bearer token in git, in an export file, or in an API response.
- A status badge that says "in sync" when the DB and git actually differ. Status is computed by diffing, never assumed from timestamps alone.
- Automatic git commits, pushes or pulls. Every git action is an explicit click.
- Touching files outside `backend/seeds/` through the git buttons. The checkout is shared with other concurrent sessions.

## Groups

One row per group. The list is taken from the admin sidebar, plus Quests.

| Group | What travels (tables / storage) | Notes |
|---|---|---|
| Tile Types | `tile_types` + tile textures (MinIO) | Tile textures are covered by the art-export/art-seed code that already exists. |
| Entities | `entity_types`, `creature_drops`, `class_loadouts`, entity stills | Creatures, decorations, point types, classes, bosses, minibosses. |
| Items | `item_types`, `affix_types`, `weapon_types`, `elements`, `merchant_stock`, item icons | Currently migration-only. |
| Biomes | `biomes` | |
| Creature Behaviors | `creature_behaviors`, `creature_abilities`, `behavior_drops`, `chest_loot` | |
| Attack Effects | `vfx_effects`, `creature_skills`, `creature_behavior_skills`, `impact_behaviors`, `projectile_shapes`, `attack_origins`, `environment_types` | Currently migration-only. |
| Aura Effects | `aura_effects` + its bindings | |
| Maps | `worlds`, `map_links`, `waypoints`, `world_chests`, `villages`, `world_point_kinds`, `map_entities` | Covers the Maps, World Map Editor and Generated Worlds tabs. Admin link/village edits that currently exist only in the DB must travel. |
| Progression | `game_settings` | *My guess* that this is what the Progression tab edits. The builder confirms against the tab's API. |
| Skill Tree | `passive_nodes`, `passive_edges`, passive label icons, skill icons | |
| Quests | `quests` | Replaces the orphaned `scripts/seed-quests.js`, which defaults to a hard-coded local DB URL. |
| Art | `catalog_art`, `character_appearances` art, `art_prompt_descriptions`, `art_prompt_notes` | *My call:* the LLM-written descriptions travel (hours of CPU to regenerate). |
| Sprites | `sprite_sets` atlases + manifests (MinIO), `entity_types.sprite`, `character_appearances.sprite` | *My call:* included. Currently has no export at all. |
| Audio | `audio_clips`, `audio_bindings`, `audio_prompts` + OGG files | Covered by the audio-export/audio-seed code that already exists (`src/services/audioSeed.js`). |
| AI Providers | `ai_providers`, **without** `auth_token` | See "Tokens". |

The builder must check the table list against the live schema and every admin `PUT/POST` route. Any table an admin tab writes to that is not listed here is either added to a group or explicitly excluded in code with a reason. A test asserts this, so a new admin table can't be silently forgotten.

## Behaviour

### Status (per group)

Status comes from a **diff between this PC's DB and the files in git** (the working tree under `backend/seeds/`). Timestamps are only for display. Badges, in order of precedence:

- **never exported**: no export files exist for the group.
- **N edits not exported**: the DB differs from the files, and the differing rows were not part of the last seed here (they were edited on this PC).
- **git is newer**: the files differ from the DB, and they come from an export newer than this PC's last seed of the group.
- **N tokens missing**: AI Providers only. Providers exist without a token on this PC.
- **in sync**: no differences.

Clicking a badge opens a popup (brainstorm mockup `status-popup.html`). It contains:
- one sentence explaining what the status means
- the differing rows: name, which fields changed, and when if that is known
- for git: which PC exported the files and when, and how many local edits will need a choice
- the single action that resolves the status: Export, Seed (preview)…, or Set token (links to AI Providers)

### Export

- Per group, or "Export all changed".
- Writes deterministic, sorted, pretty JSON (stable key order, so git diffs are readable) plus binary assets.
- Every group's export carries a header:
  - `group`
  - `exported_at` (ISO)
  - `exported_by` (PC label, see below)
  - `schema_version`: the name of the latest applied migration
  - `row_count`
- **Rows are identified by a UUID that travels between PCs** (user decision). This means a rename on A arrives on B as a rename, and B's references keep pointing at the right row.
  - Every exported table gets a `sync_uuid uuid NOT NULL UNIQUE` column (or uses its existing UUID primary key, e.g. `worlds.id`). Numeric ids stay local and are never exported.
  - Foreign keys are written as the referenced row's UUID.
  - **Backfill for existing rows.** *My call:* existing rows are backfilled with a **deterministic** UUIDv5(namespace, `<table>:<natural key>`). Two PCs that already hold the same "Goblin" then agree on its identity without ever having synced. New rows get a random v4.
  - **Fallback.** *My call:* if a git row's UUID is unknown here but its natural key matches a local row that has no baseline, the preview shows it as "same row, adopt git's identity" rather than as a create plus an only-here.
  - The natural key stays unique, as it is today.
- Binaries reuse `artSeed.js` / `audioSeed.js`. Export must also cover the gaps those modules leave today: non-static entity sprites, unbound audio clips if a group needs them, and the 6th art kind (`character_appearance`), which is missing from the docs.

### Seed: preview, then apply

- Per group, or "Seed all (preview)…". Groups run in **dependency order**:
  1. Items
  2. Tile Types
  3. Biomes
  4. Creature Behaviors
  5. Attack Effects
  6. Aura Effects
  7. Entities
  8. Skill Tree
  9. Progression
  10. Maps
  11. Quests
  12. Art
  13. Sprites
  14. Audio
  15. AI Providers

  The builder verifies this order from the actual FKs.
- **Preview** (mockup `seed-preview.html`) lists every difference between the git files and the DB:
  - **changed**: field-by-field diff
  - **new from git**: will be created
  - **edited here since last seed**: red
  - **only on this PC**: exists locally, not in git
- Filter chips by kind, plus a name filter.
- Bulk bar: select rows, then **Take git / Keep local / Delete local**.
- Per-row switch.
- Defaults:
  - changed / new → take git
  - only-here → keep
  - red rows have **no default**: Apply stays disabled until every red row has a choice
- Footer: "Will write: X updates, Y creates, Z deletes · N rows still need a choice".
- **Apply** writes only the chosen changes, one DB transaction per group, in dependency order. Binary uploads happen before the transaction commits, and a failure rolls back the group. The builder decides how to keep MinIO and the DB consistent if the commit fails after uploads (the existing art seed uses stable keys, so a re-run is idempotent).
- **"Edited here since last seed"** detection. *My call:* when a seed is applied, store a hash of each seeded row (`seed_row_hashes(group, key, hash)`). A row is "edited here" when its current hash ≠ the stored hash. This avoids adding `updated_at` to dozens of tables and catches every edit path.
  - **Baseline = last sync, not last seed.** *My call:* both a successful seed **and** a successful export write the row hashes. A row exported from this PC and later changed by the other PC is therefore not red.
  - **No baseline yet** (first run on a PC): every differing row is red. Resolving them is one click with the bulk "Take git" or "Keep local". *My call:* safe beats quiet.
- **Deletions.** *My call:*
  - A row that is absent in git and **unchanged here since the baseline** was deleted on the other PC. It is shown as "deleted in git" and defaults to delete.
  - A row absent in git with no baseline, or changed here, is "only on this PC" and defaults to keep.
  - A delete that is referenced by data this design doesn't move is **blocked** for that row, with the reason shown ("3 characters are in this world"). This covers characters, inventories, `world_creatures` and similar. Never cascade into player data.
- **Export when git is newer.** *My call:* exporting a group whose status is "git is newer" is refused with "seed (preview) first". Otherwise the export would write over the other PC's rows in the files. The preview is where the two sides get merged.
- **Migrations.** *My call:*
  - Game data for exported groups changes through the tab from now on, not through new data-inserting migrations. Schema migrations are fine.
  - Rows that existing migrations insert are ordinary rows: the first export captures them, and they are subject to the same preview rules.
  - The round-trip test runs migrations on the fresh DB first, then applies the seed with "take git" plus deletes for rows not in git.
- **Schema guard:**
  - Refuse to seed when the export's `schema_version` is newer than this DB's latest migration ("run migrations first").
  - Warn when it is older.
- **After any successful seed** (user decision): the tab shows a persistent banner, "Seeded data is applied on restart — Restart backend", with a button. There is no live reload. The builder picks the restart mechanism in the dev compose (for example exiting the process under a restart policy, or the nodemon trigger). While the banner is up, the status badges carry a note that the running game still uses the old data.

### Tokens (AI Providers)

- The export contains every provider field except `auth_token`, plus `has_token: bool` for information only.
- When seeding:
  - an existing provider keeps its local token
  - a new provider is created with no token, and the group shows "N tokens missing"; the popup links to AI Providers
- Tokens stay stored as they are today (plaintext in each PC's DB, write-only through the API). Encrypting them is out of scope.

### History

New table `seed_export_runs`, one row per run:
- `id`
- `group`
- `action` (`export` | `seed` | `git_pull` | `git_commit` | `git_push`)
- `started_at`, `finished_at`
- `status` (`running` | `ok` | `failed` | `cancelled`)
- `pc_label`
- `git_commit` (HEAD at the time)
- `summary` (jsonb: counts of rows and files created, updated and kept)
- `error`

Each PC keeps its own history. The tab's three timestamp columns come from this table ("last export / last seed on this PC") and from the export headers ("in git"). The history log under the table shows the latest runs, filterable by group.

**PC label.** *My call:* an env var `SEED_PC_LABEL`, falling back to the host's hostname. It must not be the container's hostname, which is random.

### Long-running runs

Exporting or seeding art, sprites and audio can take minutes and hundreds of MB. Runs execute as a background job with progress the UI polls, following the `bulk-image-jobs` pattern:
- single-flight
- `GET current`
- cancel

It also needs a stored run row so a restart leaves a visible "failed/interrupted" entry instead of nothing. Only one export or seed runs at a time per PC.

### Git strip and buttons

At the top of the tab, always visible: the branch, ahead/behind origin, the number of uncommitted changes under `backend/seeds/`, and a warning if there are changes outside it.

Buttons, each run only on click, with a confirm dialog showing what will happen:
- **Pull**: `--ff-only`. Refuses when the tree is dirty.
- **Commit seeds**: stages only `backend/seeds/`. The message is editable and defaults to "seed export: <groups> from <pc>".
- **Push**: current branch to origin, never `--force`.

Hints appear in the popups as well, for example "git is newer but you're 3 commits behind, so pull first".

**Open technical decision, left to the builder with a recommendation.** The backend container mounts only `./backend` as `/app`, so it has no `.git` and no SSH key. The two options:
1. A small host-side helper that the backend calls, with a fixed command allow-list and loopback-only access with a shared secret. **Recommended**: it keeps the push-capable key out of the web server.
2. Mount the repo root plus an ssh-agent socket into the backend container.

Either way the git actions are an allow-list, never arbitrary commands.

## Constraints

- Follow the repo's patterns:
  - Express inline routes and raw `pg` (`nodejs-dev`)
  - React + TanStack Query hooks + styled-components tokens (`react-dev`)
  - the tab is added in both `frontend/src/ui/navSections.js` and `App.jsx` (`navRoutes.test.js` checks they match)
  - the tab is admin-only
- Every export/seed/git route is admin-only, and none returns `auth_token`.
- Tests that need a database use a **scratch DB**, with both `DATABASE_URL` and `TEST_DATABASE_URL` set. Never the shared dev DB.
- The existing make targets (`art-*`, `audio-*`, `seed-catalogs`, `seed-map`, `seed-passive-tree`) keep working. The tab's export/seed engine should be callable from a CLI too, so headless use stays possible.
- Git size: audio is already about 322 MB in git without LFS, and sprites add more. The builder reports the expected size, and whether LFS is needed, before shipping the Sprites group.

## Left to the builder

- Exact file layout under `backend/seeds/` for the new JSON exports, and how they relate to `seeds/data/*.js`. *My call:* when an export file for a group exists, seeding from the tab uses it, and `seed-catalogs` keeps working from `seeds/data` for a fresh bootstrap. The builder flags any group where the two would fight.
- How Maps export reaches lossless round trip: extend the existing `.map.json` spec, or write a separate export file.
- Splitting into slices. Suggested order:
  1. history table + tab shell + status for the existing art/audio
  2. data-group export/seed with preview
  3. Maps, Sprites and AI Providers
  4. git strip and buttons

## Verification

- A round-trip test per group on a scratch DB: export → fresh DB → seed → export, with byte-identical files.
- Preview correctness, tested against a hand-crafted DB:
  - a row edited after the seed shows as red
  - a row only on this PC defaults to keep
  - Apply writes exactly the chosen rows
- A test that `auth_token` never appears in any export file or route response.
- A test that every admin-writable table belongs to a group or to the explicit exclusion list.
- A browser check of the tab on a dev PC: badges, popups, a preview with bulk actions, history rows.

## Brainstorm artifacts

Mockups: `.superpowers/brainstorm/40347-1792311639/content/` (`seed-export-layout.html` option A, `seed-preview.html`, `status-popup.html`).
