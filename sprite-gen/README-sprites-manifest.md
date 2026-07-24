# Batch sprite generation from a manifest (Sprites epic, Slice 1)

Generates static, 8-facing directional idle sprites (creatures/heroes) and flat
scenery from `sprites.manifest.json`, driving the existing backend admin API.
Generate-only: it produces + stores atlases in MinIO and prints an approve
report. It does **not** modify the DB.

## Prerequisites
- The full stack running (backend on `:3101`, sprite-gen, MinIO) — e.g. `docker compose up`.
- An admin user. Set:
  - `SOMETHING2_API_URL` (default `http://localhost:3101`)
  - `SOMETHING2_ADMIN_USER`, `SOMETHING2_ADMIN_PASSWORD`

## Run
```bash
cd backend
npm run sprites:gen -- --dry-run              # plan only, no generation
npm run sprites:gen                            # generate everything not already current
npm run sprites:gen -- --only Wolf,hero_knight # a subset
npm run sprites:gen -- --force --only Wolf     # regenerate even if unchanged
```

`sprites.manifest.lock.json` records a fingerprint per entity; unchanged entries
are skipped on rerun. Editing a `prompt`/`seed`/`size` changes the fingerprint
and re-generates that entity next run.

## Approve
The run prints a ready-to-paste `curl` for each generated entity that maps to an
`entity_types` row (get `$TOKEN` from the login response or the admin UI). Heroes
have no row yet and are stored only — the hero picker (Slice 3) will consume them.
Approval uses `animated: true, frames: 1` so the single idle frame renders
directionally (`<dir>/0`) rather than as a fixed south-facing static.

Reruns re-print approve commands too: an entity that's unchanged (`status: skipped`)
still gets its approve `curl` re-emitted, reconstructed from the lockfile's
`atlas_key`/`manifest_key`/`job_id`. Approval doesn't have to happen in the same
run as generation — you can generate now and approve later, even after other
entities have been regenerated in between. (Lock entries written before this
behavior existed lack `manifest_key`; those rows stay a bare skip with no
approve hint until the entity is regenerated once.)
