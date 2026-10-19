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
`make_fixtures.py` asserts the vendored module reproduces it byte for byte.

| File | Origin | sha256 |
|---|---|---|
| `box_parity/create-params.json` | POST body | `074c5d1fc719796ec845fcf3c1b3ff98c05e8d5a28b28078bfba2c8469a22544` |
| `box_parity/create-response.json` | box response | `b7427d7c5d326f92d7272c6a7af00fbc9719d90b4cfc368655964882c068b48e` |

`bestiary_p4.json` sits next to `world_gen.py` because the module loads it
relative to its own path at import time.

`smoke-world-gen.py` is kept for reference only. It imports `world_preview`
(PIL), which is not vendored, so it does not run here as-is.

## Regenerating the golden fixtures

From the repository root, on the host (never inside the backend container):

    python3 -I backend/tools/world_gen_ref/make_fixtures.py

It writes `backend/tests/fixtures/world_gen/*.json` deterministically: two runs
give byte-identical files. `backend/tests/world_gen_ref_integrity.test.js`
checks the sha256 values above and that every fixture parses; it needs neither
python nor a database.
