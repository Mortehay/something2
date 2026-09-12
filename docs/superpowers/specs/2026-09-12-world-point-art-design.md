# World Point Art — design

Outcome of a grill session on 2026-09-12. Every decision below was confirmed
by the user; the "why" lines record the alternative that was rejected.

## Problem

Every fixed world point — portal, waypoint, merchant, bank, gem merchant,
skill merchant, vault chest, field chest — is drawn as a hand-coded canvas
shape (`landmarkRenderer.js` diamonds, `RenderSystem.drawMerchant/drawBank/
drawWorldChest` boxes). None can carry an image or sprite, although
`entity_types` already supports non-creature art (`is_creature=false`,
`render_mode`, `image`, `sprite`, `prompt`) and decorations render through
that path today.

## Goal

Any fixed world point can be given an image or sprite from the existing
entity-art pipeline, selectable **per instance**, with the list of point
kinds open for future kinds without a migration per kind.

## Decisions

### D1 — Binding lives in nullable FK columns on the instance rows, authored in the map spec

- `map_links.entity_type_id`, `waypoints.entity_type_id`,
  `world_chests.entity_type_id`, and four on `villages`
  (`merchant_entity_type_id`, `bank_entity_type_id`,
  `gem_merchant_entity_type_id`, `skill_merchant_entity_type_id`).
  All `NULL`-able, `ON DELETE SET NULL`. `NULL` ⇒ use the kind default.
- The map spec is the source of truth: `links[].art`, `links[].waypoint_art`,
  `worlds[].waypoints[].art`, `worlds[].chest.art`,
  `worlds[].village.art.{merchant,bank,gem_merchant,skill_merchant}` — each
  an entity type **name**. `validateMapSpec` rejects unknown names and
  kind mismatches. `seed-map` converges every touched instance to the
  spec, writing `NULL` when the spec says nothing.
- Why not a polymorphic side table keyed by position: no FK integrity, and it
  silently detaches when a spec moves a post by a tile (a trap already on
  record for villages).
- Why not admin-only DB edits: undone by the next `make seed-map`.

### D2 — Kind catalog

- `entity_types.point_kind` (nullable text, FK → `world_point_kinds.kind`)
  marks a type as art for exactly one kind. The editor's per-kind pickers
  filter on it; a portal picker never offers a pine tree.
- `world_point_kinds(kind PK, default_entity_type_id NULL FK)` seeded with
  `portal, waypoint, merchant, bank, gem_merchant, skill_merchant,
  chest_vault, chest_field`. A new kind is one row.
- A point-kind type's `walkable / spawn_tiles / chance / is_creature` are
  ignored by the world (`loadDecorationDefs` already excludes rows with no
  `spawn_tiles`; the sim never places point types). The editor hides those
  fields when `point_kind` is set.
- Resolution order, server-side, once per point: instance column → kind
  default → `null`. The wire carries the resolved entity type **name** as
  `art`; the client resolves the art from the entity-type catalog it already
  loads for decorations. No second loader per kind: each kind's existing
  fetcher does the join.

### D3 — Art replaces the body shape only; state is a treatment; `stateKey` seam

- The bound type's image/sprite draws through the existing `drawEntity`
  fit path, anchored exactly like a decoration (tile centre), inside the
  depth-sorted pass so a player walks behind a gate.
- Overlays stay: portal beam + `🌀 To X` pill, `[e] Trade` / `[f] open`
  prompts, captions.
- State is generic on top of one asset: unactivated waypoint → 45 % alpha +
  ground ring; opened chest → 45 % alpha. Locked/unlocked chests keep their
  caption text as the distinction.
- `resolveSprite` gains an optional `stateKey`: if the manifest has a frame
  by that name it is used, else current behaviour. Nothing produces such
  frames yet; the seam exists so state frames can land later as a pure
  pipeline change.
- Missing art ⇒ today's placeholder shape, never a hole.
- A waypoint that shares a tile with a portal (`is_waypoint: true` links)
  draws no body of its own when the portal has art; its beam/label and the
  activation ring still draw.
- Why not one type per (kind, state): triples art cost and bakes state into
  names. Why not state frames now: pulls the deferred sprite-actions slice
  forward before one portal has art.

### D4 — Authoring surfaces in v1

- Entity editor: `point_kind` select (options read from the catalog table)
  and a "Make default for <kind>" action.
- Map spec `art` fields as in D1.
- Seeded point types with **no art**: one placeholder-rect row per kind
  (`portal`, `waypoint_stone`, `merchant_post`, `bank_post`,
  `gem_merchant_post`, `skill_merchant_post`, `chest_vault`, `chest_field`)
  with a prompt, so the editor has a row to generate art for and the kind
  defaults point somewhere. Placeholder shapes keep drawing until art is
  approved.
- Deferred: MapsAdmin per-instance picker (fights the spec), starter art
  (agents cannot generate images), a separate arrival-side art on a portal
  link (`art` applies to both rows of the pair in v1).

## Non-goals

Minimap/overview markers, compass doorways, state frames in atlases,
MapsAdmin picker, starter art, creatures/decorations/ground items.

## Acceptance (user-visible)

1. In the entity editor, `portal` shows point kind "portal", hides
   walkable/spawn fields, and "Make default for portal" is available.
2. After approving or uploading an image for `portal`, joining a world with
   a portal draws that image at the portal tile inside the depth sort, with
   the beam and `🌀 To X` pill still above it; the pink diamond is gone.
3. A vale-region spec edit `links[i].art = "<other portal type>"` followed
   by `make seed-map SPEC=vale-region` changes that one portal's art and
   nothing else; removing the field and re-seeding returns it to the
   default.
4. An unactivated waypoint with art draws dimmed with a ground ring;
   activating it draws it at full alpha. An opened chest with art draws
   dimmed.
5. A kind with no default and an instance with no binding draws exactly what
   it draws today.
6. `validateMapSpec` rejects `art: "pine_tree"` on a portal link with a
   message naming the link and the required kind.
