# Quest Giver Entities Implementation Plan (SOMET-678)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quest givers become `quest_giver` world-point entity types (art, sprite, `nearby` sound) bound per village, with the quest flow unchanged.

**Architecture:** Add `quest_giver` as a fifth village post kind. Everything keyed off `VILLAGE_POST_KINDS` (seed `applyPointArt`, admin `PUT /api/villages/:id/art`, spec export) picks it up. The join frame's `questGivers` entries take `art` from `resolvePointArt('quest_giver', …)` and `name` from that same entity name.

**Tech Stack:** Node/Express CommonJS, node-pg-migrate, raw pg, node:test; React admin; vitest.

**Spec:** `docs/superpowers/specs/2026-11-01-quest-giver-entities-design.md`

## Global Constraints

- Entity `name` is the shown name: `Elder Eldrin`, `Shadow Hunter`, `Lord Thorn`, `Elder Sunspire`, `Archon Aether`, `Astronomer Zahir`, `Arch-Druid Elyona`, `Captain Valdor`. The giver key is `questGiverKey(name)` = lowercase, runs of non-`[a-z0-9]` → `_`, trimmed of `_`. It must equal `quests.npc_key` (`shadow_hunter`, `arch_druid_elyona`, …).
- Kind default is `Elder Eldrin` (first `quest_giver` row in `POINT_TYPES`). `blackfen` is bound to `Shadow Hunter` in `vale-region.map.json`.
- Placeholders: `render_mode: 'rect'`, no image, so the gold diamond keeps drawing.
- The wire field stays `questGivers: [{ villageId, villageKey, x, y, name, art }]`.
- The migration timestamp goes after `1714440848000`. Never mutate the shared dev DB from tests.

## Review Focus

1. A village with no binding and no kind default (fresh DB before seeding) → name `Quest Giver`, art `null`, giver still drawn and interactable.
2. A village bound to a non-`quest_giver` entity in a spec → `validateMapSpec` rejects it (existing `checkArt` path, just needs the key allowed).
3. Re-running the seed keeps Shadow Hunter on Blackfen (it comes from the spec, not only the migration).
4. Renaming the giver entity in admin changes the label (name read from the join, not cached).
5. The migration runs on a DB where the seed already created some of the rows (`ON CONFLICT DO NOTHING`, default only if NULL).

---

### Task 1: Catalog + migration

**Files:** Modify `backend/seeds/data/pointTypes.js`, `backend/seeds/mapSpec.js:209`, `backend/seeds/maps/vale-region.map.json` (blackfen village), `backend/tests/pointTypes_seed.test.js`. Create `backend/migrations/1714440849000_quest_giver_point_kind.js`.

**Produces:** `POINT_KINDS` includes `'quest_giver'`; `VILLAGE_POST_KINDS` = `['merchant','bank','gem_merchant','skill_merchant','quest_giver']`; `QUEST_GIVER_NAMES` (array of the 8 names); `questGiverKey(name) -> string`; column `villages.quest_giver_entity_type_id`.

- [ ] Test (`pointTypes_seed.test.js`): `VILLAGE_POST_KINDS` deep-equals the 5-list; `villageArtColumn('quest_giver') === 'quest_giver_entity_type_id'`; the 8 `quest_giver` POINT_TYPES rows are in the order above, so Elder Eldrin is the kind default; `QUEST_GIVER_NAMES.map(questGiverKey)` deep-equals `['elder_eldrin','shadow_hunter','lord_thorn','elder_sunspire','archon_aether','astronomer_zahir','arch_druid_elyona','captain_valdor']`; every distinct `npc_key` in `questsData.js` is in that key list.
- [ ] Run `node --test tests/pointTypes_seed.test.js` → FAIL.
- [ ] Implement: add the kind, the 8 `pointType(name,'quest_giver','#eab308',64,96, subject)` rows, the export, and `questGiverKey`. `mapSpec.js` `VILLAGE_ART_KEYS` uses `VILLAGE_POST_KINDS`. Blackfen gets `"art": { "quest_giver": "Shadow Hunter" }`.
- [ ] Migration up: insert the kind row `ON CONFLICT DO NOTHING`; add column `quest_giver_entity_type_id` (integer, FK entity_types, `ON DELETE SET NULL`); insert the 8 entity rows with the same columns seed-catalogs writes, `ON CONFLICT (name) DO NOTHING`; set the kind default to Elder Eldrin `WHERE default_entity_type_id IS NULL`; bind `spec_key='blackfen'` villages to Shadow Hunter. Down: drop the column, delete the kind row.
- [ ] Run `node --test tests/pointTypes_seed.test.js tests/pointArt.test.js tests/map_spec_fixtures.test.js` → PASS (update the pointArt 4-column SQL assertion to 5 columns).
- [ ] Commit `feat(quests): quest_giver point kind and eight giver entities (SOMET-678)`.

### Task 2: Wire — names and art from the entity

**Files:** Modify `backend/src/services/villages.js` (fetchVillages: join `qa` on `quest_giver_entity_type_id`, return `questGiverArt`), `backend/src/authority/server.js:2114` (delete the if-chain). Create `backend/src/services/questGivers.js`. Test `backend/tests/questGivers.test.js` and `backend/tests/pointArt_wire.test.js`.

**Produces:** `buildQuestGivers(villages, pointArtDefaults) -> [{ villageId, villageKey, x, y, name, art }]`.

- [ ] Tests: a bound village → `name` and `art` equal the bound entity; an unbound one → kind default (`Elder Eldrin`); no default → `{ name: 'Quest Giver', art: null }`; a village with null x/y is skipped; the server source has no `'Lord Thorn'` literal and calls `buildQuestGivers(`. `fetchVillages` maps `quest_giver_art` → `questGiverArt`.
- [ ] Run → FAIL. Implement with `resolvePointArt`. Run → PASS.
- [ ] Commit `feat(quests): quest giver name and art come from the bound entity (SOMET-678)`.

### Task 3: Admin + export

**Files:** Modify `frontend/src/games/something2/MapsAdmin.jsx:113` (slot + label `Quest giver`), `backend/src/index.js:5293` (GET villages selects `quest_giver_entity_type_id`), `backend/src/services/mapSpecExport.js:167` (join `quest_giver`). Test: the existing mapSpecExport tests and a frontend vitest run.

- [ ] Add `quest_giver` to the export SELECT and check that the round-trip test still passes; add the admin slot. Run `node --test tests/mapSpecExport*.test.js` and `npx vitest run` → PASS.
- [ ] Commit `feat(admin): quest giver art picker per village (SOMET-678)`.

### Task 4: Verify

- [ ] Full backend `npm test` against a scratch `TEST_DATABASE_URL` (exit code) and `npx vitest run` (exit code); compare against the main baseline.
- [ ] Apply the migration and seed to a scratch DB: Blackfen → Shadow Hunter, others → Elder Eldrin, audio subjects list the 8 names.
- [ ] Browser check (muted Chrome): giver label + `!`, E opens the quest log, accept + turn-in reward.
