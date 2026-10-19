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
| `tests/fixtures/world_gen/box_parity.json` | generated | `54092f09866b5ed503248472524593e01c9bd917567563d50e5aa3fc7a239f51` |
| `tests/fixtures/world_gen/constants.json` | generated | `8943bae14f58a2b19a7b5e22f498dc5d94abd07ca44b7a99085a4c839597a4d2` |
| `tests/fixtures/world_gen/helpers.json` | generated | `ad23f79af53ea0248fedf362ff4a1e67667d3abc2df7d18202716ecdf9abaf61` |
| `tests/fixtures/world_gen/plan_cases.json` | generated | `dd8c138864f4399b2faa8e5737f2880d62a7a4985cd165b8c084a2ec40af5931` |
| `tests/fixtures/world_gen/report_only.json` | generated | `22fdeaac7d8064de9c93432311d58582882827ffb5dce29bea2db410c578a3ca` |

## Regenerating the golden fixtures

From the repository root, on the host (never inside the backend container):

    python3 -I backend/tools/world_gen_ref/make_fixtures.py

It writes `backend/tests/fixtures/world_gen/*.json` deterministically: two runs
give byte-identical files. It prints the fixtures' sha256 rows; if a
regeneration is intended, paste them into the Golden fixtures table above, and
review the fixture diff with them. `backend/tests/world_gen_ref_integrity.test.js`
checks every sha256 value above (reference, box capture and fixtures) and
that every fixture parses; it needs neither
python nor a database.
