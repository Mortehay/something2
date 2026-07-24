# Pre-audit baseline — 2026-07-24

Captured before any audit findings are filed or any fixes land, per Phase 0 of
the `audit-cycle` skill. Purpose: nobody misattributes a pre-existing failure
to a later fix.

## 1. Backend tests

Command: `cd backend && npm test`

Result: **662 pass / 0 fail** (662 total).

```
# tests 662
# suites 0
# pass 662
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

No failing tests.

## 2. Frontend tests

Command: `cd frontend && npm test` (vitest)

Result: **237 pass / 0 fail** across 43 test files.

```
 Test Files  43 passed (43)
      Tests  237 passed (237)
```

No failing tests. One test (`ChunkStreamer.test.js > retries a chunk whose
fetch failed, even when the center chunk is unchanged`) logs an expected
`stderr` line (`ChunkStreamer: failed to load 1,1 Error: simulated transient
network failure`) as part of exercising its simulated-failure path — this is
intentional test output, not a failure; the test passes.

## 3. Frontend lint

Command: `cd frontend && npm run lint` (eslint)

Result: **39 problems (36 errors, 3 warnings)** across 20 files. 0 errors and
1 warning are auto-fixable via `--fix` (not run, per baseline scope).

Full list of flagged locations:

- `src/context/DarkModeContext.jsx:30:28` — error — `react-refresh/only-export-components`: Fast refresh only works when a file only exports components.
- `src/games/something2/EntityTypesAdmin.jsx:742:7` — error — `react-hooks/set-state-in-effect`: Calling setState synchronously within an effect.
- `src/games/something2/EntityTypesAdmin.jsx:804:5` — error — `react-hooks/set-state-in-effect`: Calling setState synchronously within an effect.
- `src/games/something2/EntityTypesAdmin.jsx:807:6` — warning — `react-hooks/exhaustive-deps`: useEffect missing dependency `liveEditingEntity`.
- `src/games/something2/ItemTypesAdmin.jsx:502:7` — error — `react-hooks/set-state-in-effect`: Calling setState synchronously within an effect.
- `src/games/something2/MapsAdmin.jsx:56:21` — error — `react-hooks/set-state-in-effect`: Calling setState synchronously within an effect.
- `src/games/something2/Something2.jsx:354:79` — warning — `react-hooks/exhaustive-deps`: useMemo has unnecessary dependency `authed`.
- `src/games/something2/Something2.jsx:391:21` — error — `no-unused-vars`: `isLoadingMapTiles` assigned but never used.
- `src/games/something2/Something2.jsx:452:5` — warning — unused eslint-disable directive (no problems reported from `react-hooks/exhaustive-deps`).
- `src/games/something2/Something2.jsx:546:3` — error — `react-hooks/refs`: Cannot access refs during render (`handleEnterRef.current = handleEnterChunkedWorld`).
- `src/games/something2/TileTypesAdmin.jsx:380:7` — error — `react-hooks/set-state-in-effect`: Calling setState synchronously within an effect.
- `src/games/something2/src/js/core/Game.js:256:95` — error — `no-unused-vars`: `spawnX` assigned but never used.
- `src/games/something2/src/js/core/Game.js:256:107` — error — `no-unused-vars`: `spawnY` assigned but never used.
- `src/games/something2/src/js/core/Game.js:425:30` — error — `no-unused-vars`: `_` defined but never used.
- `src/games/something2/src/js/core/Map.js:44:21` — error — `no-useless-assignment`: value assigned to `inst` not used in subsequent statements.
- `src/games/something2/src/js/core/__tests__/aim.test.js:1:10` — error — `no-unused-vars`: `describe` defined but never used.
- `src/games/something2/src/js/core/__tests__/inventory.test.js:1:10` — error — `no-unused-vars`: `describe` defined but never used.
- `src/games/something2/src/js/entities/Entity.js:1:10` — error — `no-unused-vars`: `MAP_TILE_SIZE` defined but never used.
- `src/games/something2/src/js/entities/Player.js:2:10` — error — `no-unused-vars`: `GAME_WIDTH` defined but never used.
- `src/games/something2/src/js/entities/Player.js:2:22` — error — `no-unused-vars`: `GAME_HEIGHT` defined but never used.
- `src/games/something2/src/js/entities/__tests__/ProjectileManager.test.js:1:10` — error — `no-unused-vars`: `describe` defined but never used.
- `src/games/something2/src/js/net/EngineClient.js:164:10` — error — `no-undef`: `Buffer` is not defined.
- `src/games/something2/src/js/net/EngineClient.test.js:28:5` — error — `no-undef`: `Buffer` is not defined.
- `src/games/something2/src/js/net/__tests__/WorldAuthorityClient.test.js:1:10` — error — `no-unused-vars`: `describe` defined but never used.
- `src/games/something2/src/js/net/__tests__/WorldAuthorityClient.test.js:1:44` — error — `no-unused-vars`: `vi` defined but never used.
- `src/games/something2/src/js/net/__tests__/WorldAuthorityClient.test.js:13:20` — error — `no-undef`: `global` is not defined.
- `src/games/something2/src/js/net/__tests__/authExpiry.test.js:13:15` — error — `no-undef`: `Buffer` is not defined.
- `src/games/something2/src/js/net/worldPreviewClient.test.js:9:5` — error — `no-undef`: `global` is not defined.
- `src/games/something2/src/js/net/worldPreviewClient.test.js:11:12` — error — `no-undef`: `global` is not defined.
- `src/games/something2/src/js/net/worldPreviewClient.test.js:16:5` — error — `no-undef`: `global` is not defined.
- `src/games/something2/useMaps.js:365:23` — error — `no-unused-vars`: `id` defined but never used.
- `src/pages/GameSomething2.jsx:2:8` — error — `no-unused-vars`: `LoginForm` defined but never used.
- `src/pages/GameSomething2.jsx:3:8` — error — `no-unused-vars`: `Logo` defined but never used.
- `src/pages/GameSomething2.jsx:4:8` — error — `no-unused-vars`: `Heading` defined but never used.
- `src/pages/GameSomething2.jsx:8:7` — error — `no-unused-vars`: `LoginLayout` assigned but never used.
- `src/ui/MainNav.jsx:3:36` — error — `no-unused-vars`: `HiOutlineCalendarDays` defined but never used.
- `src/ui/MainNav.jsx:3:59` — error — `no-unused-vars`: `HiOutlineCog6Tooth` defined but never used.
- `src/ui/MainNav.jsx:3:94` — error — `no-unused-vars`: `HiOutlineHomeModern` defined but never used.
- `src/ui/MainNav.jsx:3:114` — error — `no-unused-vars`: `HiOutlineUsers` defined but never used.

## 4. Sprite-gen tests

Command: `docker exec something2-sprite-gen-1 pytest -q`

Result: **3 failed / 51 passed / 1 deselected**.

Failing tests (full names):

1. `tests/test_health.py::test_health_ok`
   `AssertionError: assert 'sd-turbo' == 'stub'` — the `/health` endpoint's
   `default_backend` is `sd-turbo`, not the `stub` the test expects as the
   "safe default".
2. `tests/test_object_storage_api.py::test_generate_kind_object_manifest_keys_are_flat`
   `KeyError: 'manifest'` — `done["result"]` no longer has a `manifest` key
   for a `kind: "object"` generate job.
3. `tests/test_recipe.py::test_generate_fills_defaults_from_tier_recipe`
   `AssertionError: assert 'sd-turbo' == 'sdxl'` — the `gpu` tier recipe now
   resolves to `sd-turbo` instead of the `sdxl` backend the test expects.

All three failures share the same root cause pattern: the default/recipe
backend for the sprite-gen service has moved from `stub`/`sdxl` to
`sd-turbo` (consistent with the "real sd-turbo now LIVE on CPU" change noted
in prior project history), and these tests were not updated to match. This is
recorded as-is; no fix applied per Task 11 scope.

## 5. tools/audit toolkit suite

Command: `cd tools/audit && npm test`

Result: **51 pass / 0 fail** (51 total) — matches the expected 51/51 green
baseline for the audit toolkit itself.

```
# tests 51
# suites 0
# pass 51
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## Database snapshot

```bash
AUDIT_DUMP="${AUDIT_DUMP:-/tmp/something2-audit/game_db-pre-audit.sql}"
mkdir -p "$(dirname "$AUDIT_DUMP")"
docker exec something2-db-1 pg_dump -U user game_db > "$AUDIT_DUMP"
wc -c "$AUDIT_DUMP"
```

Dump path: `/tmp/something2-audit/game_db-pre-audit.sql` (outside the repo,
not committed).

Dump size: **7,809,462 bytes** — well above the 1000-byte sanity threshold.

## Environment

- Commit: `442973759af4a4c5cdf0e2bf16e9e935ecc9cfc6`
- Node: `v22.19.0`
- Containers (`docker ps --filter name=something2`):

```
NAME                       STATUS
something2-sprite-gen-1    Up 3 hours
something2-frontend-1      Up 12 hours
something2-backend-1       Up 3 hours
something2-game-engine-1   Up 22 hours
something2-db-1            Up 37 hours
something2-minio-1         Up 22 hours
something2-redis-1         Up 22 hours
```

## Summary

| Suite | Result |
|---|---|
| Backend tests | 662/662 pass |
| Frontend tests | 237/237 pass |
| Frontend lint | 39 problems (36 errors, 3 warnings) |
| Sprite-gen tests | 51 pass / 3 fail / 1 deselected |
| tools/audit toolkit | 51/51 pass |

`engine/` (Go, paused) is out of scope for this baseline and was not run.
