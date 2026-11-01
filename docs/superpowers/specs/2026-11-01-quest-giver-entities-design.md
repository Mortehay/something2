# Quest givers as entities — design

Date: 2026-11-01
Status: draft, awaiting approval

## Intent

Elder Eldrin and the other village quest givers should be real entities, so
an admin can give each one an image or animated sprite and sounds, the same
way merchants, banks and waypoints already work. More quest givers may be
added later; adding one should be data, not code.

The hard constraint: the quest flow must not break. Today a quest giver
opens the quest log, and accepting quests, turning them in, rewards, the
`!`/`?` markers, the tracker arrow and the minimap entry all keep working
exactly as now.

## Current state (as found on main @ cfd78f83)

- The quest giver is invented at join time in
  `backend/src/authority/server.js` (~L2114): one per village, position
  from `villageQuestGiverPost` (`backend/src/services/mapService.js`,
  derived from village geometry, not stored), name from a hardcoded
  `specKey` if-chain (default `Elder Eldrin`; `emberfall` → Lord Thorn,
  `sylvan_haven` → Arch-Druid Elyona, `abyssal_tideport` → Captain Valdor,
  `ashen_oasis` → Astronomer Zahir, `blackfen` → Shadow Hunter).
- Art is the literal string `'quest_giver'`. No entity type has that name,
  so `RenderSystem.drawQuestGiver` always falls back to the gold diamond.
- The other four village posts (merchant, bank, gem_merchant,
  skill_merchant) already have art: `world_point_kinds` row per kind with a
  default entity type, `entity_types.point_kind`, a per-village
  `<kind>_entity_type_id` column on `villages`, resolved by
  `resolvePointArt` (`backend/src/services/pointArt.js`). See
  `backend/seeds/data/pointTypes.js` (`POINT_KINDS`, `POINT_TYPES`,
  `VILLAGE_POST_KINDS`).
- Sound: the `world_point` audio subject kind
  (`backend/src/services/audioSubjects.js`) lists every entity type with
  a non-null `point_kind` and gives it a `nearby` sfx slot. An entity with
  `point_kind = 'quest_giver'` gets a sound slot with no audio changes.
- Quest logic does NOT depend on the giver's name or art: it keys on
  `village_key`/`specKey` and the giver's x/y (`questRoute.js`,
  `questMarkers.js`, `Game.js` interact at ~L3190 opens the quest log
  within 140px of any giver). No server-side check ties accept/turn-in to
  a specific giver.

## Goals

1. Add `quest_giver` as a world point kind, wired exactly like the other
   village posts: kind row, default entity type, per-village art column,
   resolved through `resolvePointArt`.
2. Eight quest-giver entity types with `point_kind = 'quest_giver'`, so
   each can have its own image, sprite and `nearby` sound in the existing
   admin Entity Types / Audio tabs (user decision: create all of them now,
   even those with no village yet). Each carries a stable key; seven keys
   match the existing `quests.npc_key` values exactly:

   | key | shown name | bound to a village now |
   |---|---|---|
   | `elder_eldrin` | Elder Eldrin | kind default (every village not listed below) |
   | `shadow_hunter` | Shadow Hunter | `blackfen` |
   | `lord_thorn` | Lord Thorn | none yet |
   | `elder_sunspire` | Elder Sunspire | none yet |
   | `archon_aether` | Archon Aether | none yet |
   | `astronomer_zahir` | Astronomer Zahir | none yet |
   | `arch_druid_elyona` | Arch-Druid Elyona | none yet |
   | `captain_valdor` | Captain Valdor | none yet |

   Matching `npc_key` keeps "quests owned by one giver" a later data change.
   Today's dead if-chain branches (`emberfall`, `sylvan_haven`,
   `abyssal_tideport`, `ashen_oasis` — no such villages exist in any map
   spec or the dev DB) are dropped with the if-chain; names players see
   today do not change.
3. The giver's shown name comes from its bound entity, not the hardcoded
   if-chain. The if-chain is deleted.
4. Existing villages are backfilled so every village shows the same name
   it shows today.
5. A village with no specific giver bound falls back to the kind default
   (Elder Eldrin), so newly generated villages still get a giver.
6. Admin can change which giver entity a village uses, through the same
   path used for the other village posts (`resolvePointArtId` and the Maps
   admin post-art controls).

## Non-goals

- Quests owned by one specific giver. Quests stay attached to a village
  (`village_key`), and every giver opens the same quest log as today.
- More than one giver per village. The wire format is already an array, so
  this can be added later (likely a `village_quest_givers` table) without
  changing the client contract.
- New dialogue, voice lines or animation states beyond what entity sprites
  already support.
- Moving givers: positions stay derived by `villageQuestGiverPost`.

## Anti-goals (would count as failure even if it "works")

- Any change to quest accept, turn-in, rewards, markers, tracker or minimap
  behaviour.
- A giver that disappears, loses its `[e] Quests` prompt, or shows a blank
  or `null` name when no art is approved yet. The gold diamond fallback
  must keep working.
- A second source of truth for names: the if-chain and the entity must not
  both exist.

## Decisions

Decided by the user:
- Each giver is a separate entity with its own name.
- Create entities for all eight characters now, including the six with no
  village yet.
- Every giver can hand out quests, take turn-ins and give rewards as now.
- More givers may come later; design must not block that.

Made by me (Claude), open to correction:
- Follow the existing village-post pattern rather than invent a new
  table. One giver per village for now.
- The entity `name` IS the shown name (`Elder Eldrin`, `Arch-Druid Elyona`).
  The giver key is derived: lowercase, non-alphanumeric runs → `_`
  (`arch_druid_elyona`), which equals `quests.npc_key`. No new column;
  renaming in admin uses the existing entity rename path.
- Elder Eldrin has no `npc_key` today; its key `elder_eldrin` is my call.
- Placeholder entity rows use `render_mode: 'rect'` and no image, like the
  other `POINT_TYPES`, so nothing changes visually until an admin
  approves art.

## Backfill must survive re-seed (found in review)

`applyPointArt` (`backend/src/services/pointArt.js`) writes NULL to every
village post column the map spec does not mention, on every seed run. A
migration-only backfill would be reverted by the next `make seed`. So:
add `quest_giver` to `VILLAGE_POST_KINDS`, and put the non-default
binding in the map spec (`art.quest_giver` on the `blackfen` village in
`backend/seeds/maps/vale-region.map.json`). A migration covers DBs that
are not re-seeded. Admin bindings are wiped on re-seed, the same as for
merchants and banks today; that is accepted.

## Constraints

- Migrations: follow project migration rules in `AGENTS.md`; mind the
  recurring timestamp-collision problem (pick a timestamp after the
  newest on main at merge time).
- Seeds: new entity rows go through `POINT_TYPES` so `make seed` /
  `seed-catalogs.js` upsert them; map-spec validation of `art:` names
  must still pass.
- Never run destructive experiments on the shared dev DB; DB tests use a
  scratch `TEST_DATABASE_URL`.

## Verification

- Tests: wire `questGivers` payload carries the per-village name and art
  from the entity; fallback to default when unbound; unknown/unset art
  still renders the diamond; admin binding rejects a non-`quest_giver`
  entity.
- Browser check (muted Chrome): walk to Elder Eldrin, see the name and
  `!` marker, press E, accept and turn in a quest, receive the reward.
  Then bind an approved image to the giver entity and confirm it draws.
- Confirm the giver entity appears under World points in the admin Audio
  tab with a `nearby` slot.

## Left to the builder

- Exact migration shape and column names (follow `<kind>_entity_type_id`).
- Name storage, within the constraint above.
- Prompt text for each giver's image generation subject.
- Whether the minimap snapshot needs changes (it reads `qg.name`, which
  should keep working).
