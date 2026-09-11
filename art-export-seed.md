# Art export / seed

How generated catalog art gets from one machine's object store into git, and
from git into another machine's object store. Ticket: SOMET-572.

## Why this exists

Every AI-generated image lives in two places git cannot see: MinIO holds the
pixels, and a catalog row holds a job-scoped key pointing at them
(`sprites/objects/Tumble/rmt_c563eb.../static.png`). Clone the repo on another
machine and you get neither -- every tile falls back to flat colour, every
prop to a coloured rectangle, every skill and item to no icon. Regenerating
means owning the GPU box and spending hours on it.

`make art-export` copies the art into `backend/seeds/textures/` where it is
committed; `make art-seed` replays it from there on any machine.

## The five kinds

| `KIND`          | What it is                     | Pointer lives in            | Files under `backend/seeds/textures/` |
|-----------------|--------------------------------|-----------------------------|----------------------------------------|
| `tile`          | ground textures                | `tile_types.image`          | `tiles/*.png`, `tiles.json`            |
| `entity`        | props and creatures (stills)   | `entity_types.image`        | `entities/*.png`, `entities.json`      |
| `skill`         | class skill icons              | `catalog_art` (`skill`)     | `skills/*.png`, `skills.json`          |
| `passive_label` | passive-tree label icons       | `catalog_art` (`passive_label`) | `passives/*.png`, `passives.json`  |
| `item`          | item / stone icons             | `item_types.icon`           | `items/*.png`, `items.json`            |

Each manifest lists one entry per image: the subject key, its display name,
the file, and its size. Tile and entity manifests also carry the prompt (and
biome / creature flag) the image was drawn from, plus the flags the host-side
tools write (`seamless`, `cutout`, `needs_regen`).

## Commands

Both run inside the backend container, so the dev stack must be up
(`make dev` or `make up`).

```
make art-export                          # every kind -> backend/seeds/textures/
make art-export KIND=skill,item          # some kinds
make art-export ONLY=Wolf,grass          # some subjects; the rest of the manifest is kept

make art-seed                            # committed art -> MinIO + catalog rows
make art-seed KIND=tile                  # one kind
make art-seed KIND=entity ONLY=Wolf FORCE=1   # overwrite art this machine already has
```

`KIND` is a comma-separated subset of `tile entity skill passive_label item`
(default: all five). `ONLY` matches subject keys or display names.

The older per-kind targets still work and are plain aliases:

| Alias                  | Same as                      |
|------------------------|------------------------------|
| `make tiles-export`    | `make art-export KIND=tile`  |
| `make tiles-seed`      | `make art-seed KIND=tile`    |
| `make entities-export` | `make art-export KIND=entity`|
| `make entities-seed`   | `make art-seed KIND=entity`  |

## The workflow

### On the machine that generated the art

```
make art-export                # or KIND=... for what you regenerated
make tiles-seamless            # only if you exported tiles   (host-side, needs Pillow)
make entities-cutout           # only if you exported entities (host-side, needs Pillow)
git add backend/seeds/textures
git commit -m "feat(art): export regenerated <what> (SOMET-NNN)"
```

Tiles must go through `tiles-seamless` before they are committed. Entities
usually do NOT need `entities-cutout` any more: the object store already
holds keyed silhouettes for most of them, and the export marks an entry
`cutout: true` when its bytes are already transparent. Run
`make entities-cutout` only for the entries the export left unmarked (the
seed log names them as "not cut out"); re-running it over already-cut files
eats their feathered edges. Skills, passive labels and items need no
post-processing.

### On the other machine

```
git pull
make seed-catalogs             # the rows the art attaches to must exist
make seed-passive-tree         # if passive_label art is included
make art-seed                  # or KIND=...
```

`art-seed` is safe to re-run: a subject that already has art on that machine
is left alone (see the rules below). With `FORCE=1` it is overwritten in place
under the same stable key, never duplicated.

## Rules the seeder applies, per kind

These are what keep a seed run from destroying local work. They live in
`backend/src/services/artSeed.js` (`SEED_POLICY`) and are pinned by
`backend/tests/art_seed_policy.test.js`.

- **Already has art -> skipped unless `FORCE=1`.** "Has art" means the row
  HOLDS an image key or a sprite atlas -- never its `render_mode`.
  `seed-catalogs` inserts the decoration types (pine_tree, bush, ...) as
  `static` with no image, and judging by mode called those "already had art"
  while the game drew their fallback colour box.
- **A pointer to an object this machine's store does not hold is not art.**
  The seeder checks the store before honouring a skip and re-seeds such a
  row (logged as "is not in the store -- re-seeding", counted as
  "re-seeded over a missing object"). Rows cloned with a database dump keep
  their keys; the bucket does not come along.
- **Entities: only `static` rows are exported.** A `directional` or
  `animated` entity is an atlas plus a manifest, not one still; exporting one
  PNG for it would quietly downgrade it on the next seed. `FORCE=1` on seed is
  the one deliberate way to flatten such an entity, and it does exactly that.
- **Entities are seeded one by one on their `cutout` flag.** An entry
  without it is skipped and named in the log ("not cut out"); only a
  manifest where NOTHING is cut out is refused outright, because that means
  the step was skipped. One opaque file no longer blocks the other 307.
- **Entities flagged `needs_regen` by the cutout pass are never seeded.** A
  box or a blank where a sprite should be is worse than the coloured
  rectangle it would replace. If a subject shows as a coloured rectangle on
  another machine, check its manifest entry for this flag first.
- **Skill, passive and item icons are committed at 256 px max edge**
  (SOMET-573). The generator draws them at 1024 px and the game shows them
  at 30-48 px; uncapped, the three sets were 96 MB, capped they are 26 MB.
  The export resamples (area average over premultiplied alpha, so edges do
  not darken) and records the original size as `source` in the manifest.
  This is a bounded loss on the committed copy only -- the object store on
  the generating machine keeps the original. Tiles and entities are never
  resampled.
- **Tiles are stored as drawn; everything else is trimmed on upload** with
  the same `trimForStorage` the live generation path uses. The PNGs on disk
  stay as the generator drew them -- they are source (SOMET-564).
- **Stable keys.** Seeded art is uploaded under
  `<bucket>/<prefix><subject>/seeded/static.png`, never under the job id it
  came from on somebody else's machine. Prefixes: `tiles/` for tiles, none
  for entities, `objects/` for skills, passive labels and items.
- **Skills are keyed by skill id (`arc_tumble`), not display name.** Display
  names repeat across classes; ids do not. Art whose skill is no longer in
  `seeds/data/skills.js` is not exported -- nothing could seed it back.
- **A subject whose row is missing is reported, not invented.** Run
  `make seed-catalogs` (and `make seed-passive-tree`) first.
- **A row whose object is gone from MinIO is reported and skipped** on
  export; it means that subject needs regenerating.

## What a re-export does to the manifest

A full export (no `ONLY`) rewrites the manifest from what the database says,
which drops `seamless` / `cutout` flags -- correctly, because the PNGs it just
wrote are fresh from the generator and need those passes again.

An export with `ONLY=...` replaces just the named entries and keeps the rest,
flags included, so re-exporting one regenerated tile does not force the whole
catalogue back through `tiles-seamless`.

## Size

Tiles are 512px PNGs at roughly 300-500 KB each; entities are 1024px
cutouts; icons are capped at 256 px (p50 45 KB, p90 62 KB). The whole
catalogue is ~50 MB of binary in git. That is the cost of not needing a GPU
to see the game as intended. Tiles and entities are never downscaled.

## Not covered

- Directional / animated sprite sets (atlas + manifest) -- still sprite-gen's
  business.
- The Orange Pi targets (`pi-seed-*`) do not yet wrap `art-seed`.
