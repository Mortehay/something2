# Local World Generator Fallback (SOMET-644) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** When the GPU box is unreachable, the Generated Worlds tab can still generate a region on this PC. It uses a JavaScript port of the box's rules-based generator (`world_gen.py`) that produces the same spec, byte for byte, for the same inputs.

**Architecture:**
- The box's generator is pure, stdlib-only Python. Its seeds come from sha256, and the LLM only ever chooses biomes; that choice happens in the box's router, not in `world_gen.py`.
- We vendor the Python original at a pinned commit as the reference. We generate golden fixtures from it once, with the host's python3, and commit them. We port it to a Node module checked against those fixtures, so the CI and container tests never need Python.
- The admin route offers a "generate locally" path when the box is unreachable. The output is saved as a `.map.json` spec, which the Plan 4 Maps group then seeds and syncs like any other.

**Source:** `github.com/Mortehay/llama-cpp-only-cpu` @ `71ecfc85b210061d77d39d7d675fe6b46aa34744` (MIT, same owner):

| File | sha256 |
|---|---|
| `src/sprite_generator/world_gen.py` | `75178d63…b3a3` |
| `src/sprite_generator/bestiary_p4.json` | `3c5e3c5c…868a` |
| `scripts/smoke-world-gen.py` | `e5f39cfa…8ee8` |

## User decisions
- Port to JavaScript (not a vendored Python runtime, not a shared package), with a parity test against the Python original (2026-10-20).

## Global Constraints
- Byte parity is the definition of done. For every fixture input, `toJson(planRegion(...))` must equal the Python `to_json(plan_region(...))` output exactly, and `report(spec, target)` must deep-equal the Python result.
- Do not edit the vendored Python files. They are the reference; re-syncing means replacing them and regenerating the fixtures.
- Read the bestiary at module load, from a path next to the module. A missing bestiary must fail at load, not at call time; the Python original behaves the same way.
- Port `check_units` as runtime code, run inside `report()`. Every position must be a tile centre, `n*100+50`.
- The header docstring keeps a superseded claim (the "Meadow trap") next to its correction. Port the CORRECTED behaviour: `resolveDensity` takes no biome, and the density field normalises to a mean of 1.0.
- No DB writes in tests except on the scratch DB. Never call the real box from tests.
- Work happens in a worktree on branch `feat/local-world-gen` from main. Commits are `type(scope): summary (SOMET-644)`, with the Co-Authored-By trailer. Never push.

## Python→JS traps (every task)

| Python | JavaScript port |
|---|---|
| `round(x)` / `round(x, n)` rounds half to even, on the binary float | `pyRound` |
| `//` and `%` floor toward −∞ for negatives | `floorDiv` / `pyMod` |
| `float` repr: `100.0` prints as `100.0`; `1e-05` vs `0.00001` | `toJson` must emit Python's float repr for floats, so the code must know which numbers are floats: track them, or format by the source field's type |
| `json.dumps` defaults to `ensure_ascii=True` (non-ASCII becomes `\uXXXX`) and uses separators `", "`/`": "` with `indent=2`, keeping insertion order | Match. Note that JS objects reorder integer-like keys; use `Map`s or arrays where keys can be numeric strings |
| `sorted()` is a stable sort on tuples | Write explicit comparators |
| `int(h[:6], 16)` | Fits in a JS number; check any wider slice |
| Truthiness: empty list and dict are False, `0`/`""` falsy | Check each `if x:` translation |

## Tasks

### Task 1: Vendor the reference and generate the golden fixtures
- **Files:**
  - Create `backend/tools/world_gen_ref/`: the 3 files unchanged, plus `SOURCE.md` (commit sha and sha256s).
  - Create `backend/tools/world_gen_ref/make_fixtures.py`, which imports the vendored module and writes the outputs as JSON.
  - Create `backend/tests/fixtures/world_gen/` with the committed fixtures.
  - Create `backend/tests/world_gen_ref_integrity.test.js`.
- **Fixture matrix:** at least 24 cases covering:
  - `world_count` values 1, 2, 6, 12 and 36
  - `size` values 32, 128 and 224
  - `chunk_size` and `biome_cell` set to 8, 32 and 64
  - `target_per_screen` values 0.5, 2, 6, 14 and 25
  - explicit `biome_plan` (including deep biomes and invalid names), with `entry_biomes` variants and `bestiary` true/false
  - names with spaces, accents and non-ASCII characters
- **Outputs per case:**
  - `to_json(plan_region(...))` as an exact string
  - `report(spec, target)` as JSON
  - the results of several helpers: `per_screen`, `resolve_density`, `choose_density`, `_seed_for`, `_spiral(n)`, `flora_types`, `enrich_flora`, `creature_types`, `bestiary_types`, `enrich_variety`, `leader_count`, and `check_units` on hand-built bad worlds
- **Report-only cases:**
  - a spec carrying a link with `to_name` and no `to`
  - `kind:"edge"`
  - `graph` without `grid`
  - `vale-region.map.json` and `p5-descent.map.json` from `backend/seeds/maps`
- **Test:** the vendored files' sha256s equal those in `SOURCE.md`, and every fixture parses.
- **Commit:** `chore(world-gen): vendor box generator reference and golden fixtures (SOMET-644)`.

### Task 2: Python-compatible helpers
- **File:** create `backend/src/services/worldGen/pyCompat.js` with:
  - `pyRound(x, n)`, using Python's correctly rounded algorithm (port CPython's `round` via the decimal representation; the cases are tested)
  - `floorDiv`
  - `pyMod`
  - `pyFloatRepr(x)`
  - `dumpsPy(value, { indent: 2 })`, handling insertion order, ensure_ascii and float-vs-int formatting through a `PyFloat` wrapper or an equivalent marker
- **Test:** `backend/tests/world_gen_pycompat.test.js`. Ties such as 0.5, 1.5, 2.675 with n=2, and -2.5. Float reprs such as 100.0, 0.1, 1e-05, 1e16, 3.0000000000000004. ensure_ascii and key order. Expected values are hard-coded from Python output, which the implementer captures with the host python3 and pastes in.
- **Commit:** `feat(world-gen): python-compatible rounding and json (SOMET-644)`.

### Task 3: Port the generator
- **Files:**
  - `backend/src/services/worldGen/worldGen.js`, mirroring the Python module function by function under the same names in camelCase: constants, `BIOMES`, bestiary, `spawnable`, `familiesFor`, `bestiaryTypes`, `enrichVariety`, `leaderCount`, `toPx`, `isTileCentre`, `checkUnits`, `biomeMultiplier`, `perScreen`, `resolveDensity`, `chooseDensity`, `socketKibS`, `floraTypes`, `enrichFlora`, `creatureTypes`, `seedFor`, `spiral`, `planRegion`, `addRoads`, `slug`, `title`, `toJson`.
  - `backend/src/services/worldGen/bestiary_p4.json`, copied byte-exact.
- **Tests:** `backend/tests/world_gen_parity.test.js`. Every helper fixture deep-equals, and every `planRegion` fixture is byte-equal through `toJson`.
- **Commit:** `feat(world-gen): JS port of the box rules generator (SOMET-644)`.

### Task 4: Port `report()`
- **File:** add `report(spec, targetPerScreen)` to `worldGen.js`.
- **Tests:** every report fixture deep-equals. The `to_name` case has three assertions: no throw, no "names a world that does not exist" problem, and the source world is not reported unreachable.
- **Commit:** `feat(world-gen): JS port of report and check_units (SOMET-644)`.

### Task 5: Port the box's smoke suite
- **File:** `backend/tests/world_gen_smoke.test.js` (no DB). Port the 34 cases of `smoke-world-gen.py` one-to-one, with the same names and assertions, against the JS module. Skip only `_preview`, which uses Pillow, and record that skip.
- **Commit:** `test(world-gen): port the box generator smoke suite (SOMET-644)`.

### Task 6: Fallback in the Generated Worlds tab
- **Backend** (`backend/src/services/worldGenService.js` or a new `worldGenLocal.js`, plus routes in `backend/src/index.js` beside `/api/world-gen/*`):
  - `POST /api/world-gen/local/preview`, admin only. Takes the same body as the box's create (`name`, `worlds`, `target_per_screen`, `size`, `chunk_size`, `biome_cell`). Ignores `theme` and `author`; there is no LLM locally. Returns `{ spec, report, author: 'rules (local fallback)' }`.
  - `POST /api/world-gen/local/save`, admin only. Takes `{ name, params }`, regenerates deterministically, and validates with `validateMapSpec` against the live catalogs, the same as the box download route. Writes `SEED_MAPS_DIR/<slug>.map.json` (tmp then rename). Refuses to overwrite an existing file unless `overwrite: true`, and returns 409 otherwise. Never writes `.gen.json`. The Plan 4 Maps group then shows the new spec as `new` and seeds it.
- **Frontend** (Generated Worlds tab, `WorldGenAdmin.jsx` / `useWorldGen.js`): when list or create reports `unreachable`, show "GPU box unreachable — generate locally (rules only: no LLM biome choice, no preview image)" with the same create form. It calls `local/preview`, shows the report problems, then offers "Save as map spec".
- **Tests:** a route test on the scratch DB with a temp `SEED_MAPS_DIR` covering preview, save, overwrite 409, and an invalid name. A frontend model or render test for the fallback state.
- **Commit:** `feat(world-gen): local generator fallback in Generated Worlds (SOMET-644)`.

### Task 7: Verification
- Run the full new test set.
- If the box is reachable, generate one throwaway region on the box with `author: "rules"`, and the same inputs locally. Show that the specs are byte-identical, then delete the throwaway box region. If the box is not reachable, rely on the fixtures.
- Do a browser check of the fallback UI using fetch fixtures, which simulate the box being unreachable.
- Post a Plane comment.

## Out of scope
- The LLM biome authoring (`theme`, `reauthor`).
- The preview PNG.
- Automatic re-sync when the box's generator changes. Manual: replace the vendored files at a new commit, regenerate the fixtures, and fix the port until parity holds.
