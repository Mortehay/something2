# Vendored world-spec generator reference (SOMET-644)

These files are the GPU box's Python world-spec generator, vendored as the
byte-parity reference for the JavaScript port (`backend/src/services/worldGen*`).
They are NOT run by the backend, and they must NOT be edited. To re-sync,
replace them with a newer upstream copy, update the table below, and rerun
`make_fixtures.py`.

- Repository: https://github.com/Mortehay/llama-cpp-only-cpu (MIT, same owner)
- Commit: `71ecfc85b210061d77d39d7d675fe6b46aa34744`

| File | Upstream path | sha256 |
|---|---|---|
| `world_gen.py` | `src/sprite_generator/world_gen.py` | `75178d631c0f8c87cb16ae8db490c3a0f4a33f79c6df1bd6f408638916c8b3a3` |
| `bestiary_p4.json` | `src/sprite_generator/bestiary_p4.json` | `3c5e3c5c5b55e8fc0f0260b506eb9c004f3071fa42e9abb794e7cd64f094868a` |
| `smoke-world-gen.py` | `scripts/smoke-world-gen.py` | `e5f39cfa4293c7c10a8f64e8db97974a99b201a59e1e30f86b0194ef31f98ee8` |

## Live-box capture

`box_parity/` holds one live GPU-box `POST /api/worlds` exchange (author
`rules`, region `parity-somet644`), captured 2026-10-20 with user approval. It
is not from the repository above; it is what the running box returned, and
`make_fixtures.py` asserts the vendored module reproduces it: the parsed
`spec` is equal, `to_json` of the generated spec equals `to_json` of the box's
parsed spec (the re-serialisation, not the box's raw response bytes, which were
not stored separately), and `report(spec, 4)` equals the box's `report`.

| File | Origin | sha256 |
|---|---|---|
| `box_parity/create-params.json` | POST body | `074c5d1fc719796ec845fcf3c1b3ff98c05e8d5a28b28078bfba2c8469a22544` |
| `box_parity/create-response.json` | box response | `b7427d7c5d326f92d7272c6a7af00fbc9719d90b4cfc368655964882c068b48e` |

`bestiary_p4.json` sits next to `world_gen.py` because the module loads it
relative to its own path at import time.
The JS port loads its own byte-identical copy,
`src/services/worldGen/bestiary_p4.json`, the same way;
`tests/world_gen_parity.test.js` pins both copies to the sha256 above.

`smoke-world-gen.py` is kept for reference only. It imports `world_preview`
(PIL), which is not vendored, so it does not run here as-is.

## Golden fixtures

Pinned so that a regenerated or hand-edited fixture cannot silently become the
new golden. Paths are relative to `backend/`.

| File | Origin | sha256 |
|---|---|---|
| `tests/fixtures/world_gen/box_parity.json` | generated | `a3e2cf74c4ee5ec1fe9b31870349648180fee8393c0c13e75a1ed6e00ccc1187` |
| `tests/fixtures/world_gen/constants.json` | generated | `43e4a1bebc15c44c8b1b67ce136882f8b1f0976a20c4f6ba2251eb00b3470a06` |
| `tests/fixtures/world_gen/helpers.json` | generated | `d1b2a4a83ee0852f1c570ecaced5c816c83a28b95bf5df36950360f2ea16bbf9` |
| `tests/fixtures/world_gen/plan_cases.json` | generated | `3257790a3967d7e578716fcc8a45c086b4115b027c2b0a37a24869be05ec2919` |
| `tests/fixtures/world_gen/report_only.json` | generated | `8b3262a1b8e7946cb603e2c6662306a37ed285bfebb151bf2810aa073fdf34df` |

## The oracle is Python 3.11

The GPU box runs **Python 3.11.16**, and the fixtures are generated under
that version (`python:3.11.16-slim`). Python 3.12 changed float `sum()` to
compensated (Neumaier) summation, while 3.11 - and the JS port - add left to
right. The two disagree whenever a mean or a biome multiplier lands on a
rounding edge (report-only cases `sum-py311-mean` and
`sum-py311-biome-multiplier` are such edges, and make_fixtures.py asserts their
3.11 values). Fixtures from host 3.12 would therefore not describe the box.
`make_fixtures.py` refuses to run under any major.minor other than 3.11 and
records `platform.python_version()` (e.g. `3.11.16`, not the full `sys.version`, whose build date would change the hashes on an image rebuild) in every fixture's `python` header field;
`world_gen_ref_integrity.test.js` asserts that header says 3.11.

## Regenerating the golden fixtures

From the repository root, in a throwaway Python 3.11 container (never inside
the backend container, and not with the host's python3):

    docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/backend:/w" -w /w \
        python:3.11.16-slim python -I tools/world_gen_ref/make_fixtures.py

It writes `backend/tests/fixtures/world_gen/*.json` deterministically: two runs
give byte-identical files. It prints the fixtures' sha256 rows; if a
regeneration is intended, paste them into the Golden fixtures table above, and
review the fixture diff with them. `backend/tests/world_gen_ref_integrity.test.js`
checks every sha256 value above (reference, box capture and fixtures) and
that every fixture parses; it needs neither
python nor a database.

## Drift check against the live box (SOMET-645)

`node tools/world_gen_ref/drift-probe.js` (from `backend/`, `GAME_DB_URL` pointing at a DB with the
GPU-box `ai_providers` row) rebuilds every region stored on the box from its stored params — and its
stored `biome_plan` for LLM-authored regions — and compares sha256 with the box's `ETag`. Read-only.
Any `DIFFERS` means the box generator has moved past the vendored commit: re-sync as above.

Verified 2026-10-20 against the box (Python 3.11.16, 192.168.0.218): all 4 stored regions MATCH
(2 rules-authored, 2 LLM-authored), and a fresh throwaway region with non-default
`chunk_size: 16, biome_cell: 64, size: 96, worlds: 7, target_per_screen: 8` matched the stored-bytes
ETag and the report text byte for byte. Note: the box's `POST /api/worlds` does not accept a
`biome_plan` (it echoes `null`); the local route likewise reports it as ignored.
