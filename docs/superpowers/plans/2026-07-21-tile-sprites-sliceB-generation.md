# Tile Sprites — Slice B (Generation via sprite-gen) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a static texture and an optional animation atlas per tile type through the existing local sprite-gen service, store them in MinIO, serve them to the browser, and let an admin generate/preview/approve from the Tile editor.

**Architecture:** Extend sprite-gen with a `kind:"tile"` branch (one seamless texture + an N-frame same-place loop, no 8 facings) reusing its job/storage/hardware-tier plumbing. Add Node bridge routes mirroring the entity sprite routes, plus a `GET /api/assets/*` route that streams objects from MinIO (the missing "pixels to the browser" piece). The Tile admin gets a generate→poll→preview→approve panel.

**Tech Stack:** Python FastAPI sprite-gen (pytest, pluggable backends, `stub` default), MinIO (Node `minio` ^7 client already a dep), Node/Express + `pg` (`node --test`, `__setPool`/injectable seams), React/Vite (`@tanstack/react-query`, Vitest node-env no jsdom), styled-components.

## Global Constraints

- Every **mutating** `/api` route stays behind `adminGuard`; the route-protection test (`backend/tests/auth_protection.test.js`) must find the three new mutating routes (`POST /api/tile-jobs`, `POST /api/tile-types/:id/image`, `POST /api/tile-types/:id/sprite`). `GET /api/assets/*` and `GET /api/tile-jobs/:jobId` are reads and stay open.
- The tile generation path must **not** reuse the creature facing/walk machinery: no 8 directions, no `walk cycle` / `facing` words in the prompt. One texture (+ optional loop).
- Creature generation (`kind` default `"creature"`) must be **untouched** — the tile branch is purely additive; existing sprite-gen tests pass unmodified.
- `stub` backend is the default everywhere; real SD is an env switch, not code. The sprite-gen container already runs `SPRITE_BACKEND=stub`, `DEVICE=cpu`, `SPRITE_STORE_ENABLED=true`, MinIO at `minio:9000` bucket `sprites`.
- Frontend Vitest is **node-env, no jsdom** — no React render tests; the frontend gate is a clean `vite build` + browser verification.
- New frontend mutation hooks that hit an `adminGuard` route **must** send `authHeaders()` (from `frontend/src/games/something2/src/js/net/EngineClient.js`). The existing `useSprites.js` omits this — do not copy that omission.
- Both the backend (`node src/index.js`, PID, not nodemon) and sprite-gen containers run a long-lived process that does **not** auto-reload source; any code change needs a manual process restart to take effect (see the browser-verification task).

## Storage key convention

`put_creature` stores keys **with the bucket name prefixed** into the object key (e.g. object `sprites/goblin/atlas.png` inside bucket `sprites`). Mirror that exactly for tiles so one `GET /api/assets/*` route serves both: tile keys are `sprites/tiles/<tile>/static.png`, `sprites/tiles/<tile>/atlas.png`, `sprites/tiles/<tile>/atlas.json`. The assets route treats the path after `/api/assets/` as the literal object key inside the `sprites` bucket.

---

### Task 1: sprite-gen tile prompt + orchestrator

**Files:**
- Modify: `sprite-gen/app/prompts.py` (add `build_tile_prompt`)
- Modify: `sprite-gen/app/orchestrator.py` (add `generate_tile`)
- Test: `sprite-gen/tests/test_tile_generation.py`

**Interfaces:**
- Consumes: `backends.get_backend(name)`; `postproc.to_transparent`, `crop_to_content`, `pack_atlas` (all existing).
- Produces:
  - `build_tile_prompt(base: str) -> str`
  - `generate_tile(tile: str, base_prompt: str, backend_name: str, seed: int, n_frames: int = 1, size=(128, 128), steps: int = 20, progress=None) -> dict` returning `{"static": Image, "frames": {str: Image}, "atlas": Image, "manifest": dict}` where `frames["0"]` is `static` and the manifest is `pack_atlas`'s shape (`{"cell":[w,h],"frames":{"0":[x,y,w,h],...}}`).

- [ ] **Step 1: Write the failing test**

Create `sprite-gen/tests/test_tile_generation.py`:

```python
from app.prompts import build_tile_prompt
from app.orchestrator import generate_tile
from PIL import Image

def test_build_tile_prompt_has_tile_styling_and_no_facing_words():
    p = build_tile_prompt("molten lava")
    assert "molten lava" in p
    assert "seamless" in p and "tile" in p
    # Must NOT reuse the creature facing/walk vocabulary.
    for banned in ("facing", "walk cycle", "full body"):
        assert banned not in p, f"tile prompt leaked creature word: {banned}"

def test_generate_tile_static_only_produces_one_frame():
    out = generate_tile("grass", "green grass", "stub", seed=3, n_frames=1, size=(16, 16), steps=1)
    assert set(out.keys()) == {"static", "frames", "atlas", "manifest"}
    assert list(out["frames"].keys()) == ["0"]
    assert out["static"] is out["frames"]["0"]
    assert isinstance(out["static"], Image.Image)
    assert out["manifest"]["frames"]["0"][2] > 0  # non-empty cell

def test_generate_tile_animated_produces_n_frames_and_reports_progress():
    seen = []
    out = generate_tile("water", "blue water", "stub", seed=7, n_frames=4, size=(16, 16),
                        steps=1, progress=lambda d, t: seen.append((d, t)))
    assert list(out["frames"].keys()) == ["0", "1", "2", "3"]
    assert seen[-1] == (4, 4)  # progress reaches total
    # The static image is frame 0, and the atlas packs all 4 frames.
    assert len(out["manifest"]["frames"]) == 4

def test_generate_tile_is_deterministic():
    a = generate_tile("grass", "green grass", "stub", seed=3, n_frames=2, size=(16, 16), steps=1)
    b = generate_tile("grass", "green grass", "stub", seed=3, n_frames=2, size=(16, 16), steps=1)
    assert a["manifest"] == b["manifest"]
    assert a["static"].tobytes() == b["static"].tobytes()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sprite-gen && . .venv/bin/activate && pytest tests/test_tile_generation.py -q`
Expected: FAIL — `ImportError: cannot import name 'build_tile_prompt'` / `'generate_tile'`.

- [ ] **Step 3: Add `build_tile_prompt` to `sprite-gen/app/prompts.py`**

Append to the file (leave `build_prompt` untouched):

```python
def build_tile_prompt(base: str) -> str:
    # Tile styling only — deliberately NO facing/walk words. A tile is one
    # seamless top-down texture, not a directional character sprite.
    return (
        f"{base}, seamless top-down isometric ground tile, tileable texture, "
        f"flat even lighting, no shadows, centered, crisp pixel-art style, high detail"
    )
```

- [ ] **Step 4: Add `generate_tile` to `sprite-gen/app/orchestrator.py`**

Add the import and the function (leave `generate_creature` untouched):

```python
from .prompts import build_prompt, build_tile_prompt
```
(replace the existing `from .prompts import build_prompt` line), then append:

```python
def generate_tile(tile: str, base_prompt: str, backend_name: str,
                  seed: int, n_frames: int = 1, size=(128, 128), steps: int = 20,
                  progress: Optional[Callable[[int, int], None]] = None) -> dict:
    # One seamless texture, optionally an N-frame same-place loop. No directions.
    backend = get_backend(backend_name)
    total = max(1, n_frames)
    raw = {}
    for frame in range(total):
        prompt = build_tile_prompt(base_prompt)
        # Per-frame seed keeps frames stable but distinct (a placeholder for
        # real animation; loop coherence is a real-SD/GPU-era concern).
        frame_seed = seed * 1000 + frame
        img = backend.generate(prompt=prompt, pose=None, seed=frame_seed,
                               steps=steps, size=size)
        img = crop_to_content(to_transparent(img))
        raw[str(frame)] = img
        if progress:
            progress(frame + 1, total)
    atlas, manifest = pack_atlas(raw)
    return {"static": raw["0"], "frames": raw, "atlas": atlas, "manifest": manifest}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd sprite-gen && . .venv/bin/activate && pytest tests/test_tile_generation.py -q`
Expected: PASS (4 tests).

- [ ] **Step 6: Run the full sprite-gen suite (no regressions to creature path)**

Run: `cd sprite-gen && . .venv/bin/activate && pytest -q`
Expected: all prior tests still pass (the `@pytest.mark.slow` real-model test stays deselected by default).

- [ ] **Step 7: Commit**

```bash
git add sprite-gen/app/prompts.py sprite-gen/app/orchestrator.py sprite-gen/tests/test_tile_generation.py
git commit -m "feat(sprite-gen): tile prompt + generate_tile (texture + loop, no facings)"
```

---

### Task 2: sprite-gen storage `put_tile` + `kind:"tile"` API branch

**Files:**
- Modify: `sprite-gen/app/storage.py` (add `SpriteStore.put_tile`)
- Modify: `sprite-gen/app/main.py` (`GenerateRequest.kind`, branch in `generate`)
- Test: `sprite-gen/tests/test_tile_storage_api.py`

**Interfaces:**
- Consumes: `generate_tile` (Task 1); `SpriteStore` + `_png_bytes` (existing).
- Produces:
  - `SpriteStore.put_tile(tile: str, result: dict) -> dict` returning `{"image_key", "atlas_key", "manifest_key", "frames": int}` with keys `sprites/tiles/<tile>/static.png`, `.../atlas.png`, `.../atlas.json`.
  - `POST /generate` accepts `kind: "creature" | "tile"` (default `"creature"`). For `kind="tile"` the job runs `generate_tile`; with `SPRITE_STORE_ENABLED` it returns `put_tile`'s dict, else `{"frames": int, "manifest": dict}`.

- [ ] **Step 1: Write the failing test**

Create `sprite-gen/tests/test_tile_storage_api.py`:

```python
import io, json, time
from PIL import Image
from fastapi.testclient import TestClient
from app.storage import SpriteStore
from app.main import app

client = TestClient(app)

class FakeMinio:
    def __init__(self): self.objects = {}; self.buckets = set()
    def bucket_exists(self, b): return b in self.buckets
    def make_bucket(self, b): self.buckets.add(b)
    def put_object(self, bucket, key, data, length, content_type=None):
        self.objects[key] = data.read()

def _tile_result():
    img = Image.new("RGBA", (8, 8), (0, 255, 0, 255))
    return {"static": img, "frames": {"0": img},
            "atlas": img, "manifest": {"cell": [8, 8], "frames": {"0": [0, 0, 8, 8]}}}

def test_put_tile_uploads_static_atlas_and_manifest():
    fake = FakeMinio()
    store = SpriteStore(fake, "sprites")
    out = store.put_tile("grass", _tile_result())
    assert out["image_key"] == "sprites/tiles/grass/static.png"
    assert out["atlas_key"] == "sprites/tiles/grass/atlas.png"
    assert out["manifest_key"] == "sprites/tiles/grass/atlas.json"
    assert out["frames"] == 1
    assert "sprites/tiles/grass/static.png" in fake.objects
    manifest = json.loads(fake.objects["sprites/tiles/grass/atlas.json"])
    assert manifest["frames"]["0"] == [0, 0, 8, 8]

def _wait(job_id, timeout=10):
    for _ in range(int(timeout * 20)):
        r = client.get(f"/jobs/{job_id}").json()
        if r["status"] in ("done", "error"):
            return r
        time.sleep(0.05)
    raise AssertionError("job did not finish")

def test_generate_kind_tile_runs_tile_branch_no_store():
    # SPRITE_STORE_ENABLED defaults false in tests → the no-store result shape.
    r = client.post("/generate", json={"creature": "grass", "base_prompt": "green grass",
                                        "kind": "tile", "backend": "stub", "seed": 2,
                                        "frames": 3, "size": [16, 16], "steps": 1})
    assert r.status_code == 202
    done = _wait(r.json()["job_id"])
    assert done["status"] == "done"
    # tile branch: total progress == n_frames (NOT 8 dirs x frames).
    assert done["progress"]["done"] == done["progress"]["total"] == 3
    assert done["result"]["frames"] == 3

def test_generate_default_kind_is_creature_unchanged():
    r = client.post("/generate", json={"creature": "goblin", "base_prompt": "a goblin",
                                        "backend": "stub", "seed": 1, "frames": 2,
                                        "size": [16, 16], "steps": 1})
    done = _wait(r.json()["job_id"])
    assert done["progress"]["total"] == 16  # 8 dirs x 2 frames — creature path intact
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sprite-gen && . .venv/bin/activate && pytest tests/test_tile_storage_api.py -q`
Expected: FAIL — `AttributeError: 'SpriteStore' object has no attribute 'put_tile'` and the tile-branch progress assertion fails (defaults to the creature path → total 24).

- [ ] **Step 3: Add `put_tile` to `sprite-gen/app/storage.py`**

Add this method to the `SpriteStore` class (after `put_creature`):

```python
    def put_tile(self, tile: str, result: dict) -> dict:
        self.ensure_bucket()
        image_key = f"{self.bucket}/tiles/{tile}/static.png"
        data, length = _png_bytes(result["static"])
        self.client.put_object(self.bucket, image_key, data, length, content_type="image/png")
        atlas_key = f"{self.bucket}/tiles/{tile}/atlas.png"
        data, length = _png_bytes(result["atlas"])
        self.client.put_object(self.bucket, atlas_key, data, length, content_type="image/png")
        manifest_key = f"{self.bucket}/tiles/{tile}/atlas.json"
        mbytes = json.dumps(result["manifest"]).encode()
        self.client.put_object(self.bucket, manifest_key, io.BytesIO(mbytes), len(mbytes),
                               content_type="application/json")
        return {"image_key": image_key, "atlas_key": atlas_key,
                "manifest_key": manifest_key, "frames": len(result["frames"])}
```

- [ ] **Step 4: Add the `kind` branch to `sprite-gen/app/main.py`**

Add the import (extend the existing orchestrator import line):

```python
from .orchestrator import generate_creature, generate_tile
```

Add `kind` to `GenerateRequest` (after `base_prompt`):

```python
    kind: str = "creature"  # "creature" | "tile"
```

Change the `size` default so tiles are square, and branch the `work` function. Replace:

```python
    size = tuple(req.size) if req.size else (128, 160)

    def work(progress):
        out = generate_creature(
            creature=req.creature, base_prompt=req.base_prompt, backend_name=backend_name,
            seed=req.seed, n_frames=frames, size=size, steps=steps, progress=progress,
        )
        # Persist to MinIO only when a real store is reachable; failures surface
        # in the job error. In tests the store call is skipped (STORE disabled).
        if _STORE_ENABLED:
            from .storage import default_store
            return default_store().put_creature(req.creature, out)
        return {"frames": len(out["frames"]), "manifest": out["manifest"]}
```

with:

```python
    size = tuple(req.size) if req.size else ((128, 128) if req.kind == "tile" else (128, 160))

    def work(progress):
        if req.kind == "tile":
            out = generate_tile(
                tile=req.creature, base_prompt=req.base_prompt, backend_name=backend_name,
                seed=req.seed, n_frames=frames, size=size, steps=steps, progress=progress,
            )
            if _STORE_ENABLED:
                from .storage import default_store
                return default_store().put_tile(req.creature, out)
            return {"frames": len(out["frames"]), "manifest": out["manifest"]}
        out = generate_creature(
            creature=req.creature, base_prompt=req.base_prompt, backend_name=backend_name,
            seed=req.seed, n_frames=frames, size=size, steps=steps, progress=progress,
        )
        # Persist to MinIO only when a real store is reachable; failures surface
        # in the job error. In tests the store call is skipped (STORE disabled).
        if _STORE_ENABLED:
            from .storage import default_store
            return default_store().put_creature(req.creature, out)
        return {"frames": len(out["frames"]), "manifest": out["manifest"]}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd sprite-gen && . .venv/bin/activate && pytest tests/test_tile_storage_api.py -q`
Expected: PASS (4 tests).

- [ ] **Step 6: Full sprite-gen suite**

Run: `cd sprite-gen && . .venv/bin/activate && pytest -q`
Expected: all pass; creature path unchanged.

- [ ] **Step 7: Commit**

```bash
git add sprite-gen/app/storage.py sprite-gen/app/main.py sprite-gen/tests/test_tile_storage_api.py
git commit -m "feat(sprite-gen): put_tile storage + kind:tile /generate branch"
```

---

### Task 3: Node `GET /api/assets/*` MinIO serving route

**Files:**
- Create: `backend/src/services/assetStore.js`
- Modify: `backend/src/index.js` (require assetStore; add the route near the sprite routes ~`backend/src/index.js:700`)
- Test: `backend/tests/assets_route.test.js`

**Interfaces:**
- Consumes: `minio` (^7, already a dep) via env (`MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_SECURE`, `MINIO_BUCKET`).
- Produces:
  - `assetStore.getObjectStream(key) -> Promise<Readable>` (rejects if the object is missing).
  - `assetStore.__setAssetClient(fake)` test seam.
  - `GET /api/assets/*` — streams the object at the splat key from the `sprites` bucket; `image/png` / `application/json` content-type by extension; `Cache-Control: public, max-age=300`; 404 when the object is missing. **Read route — not `adminGuard`.**

- [ ] **Step 1: Write the failing test**

Create `backend/tests/assets_route.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { Readable } = require('node:stream');
const { app } = require('../src/index.js');
const assetStore = require('../src/services/assetStore.js');

test('GET /api/assets/* streams a known object with png content-type', async () => {
  assetStore.__setAssetClient({
    getObject: async (bucket, key) => {
      assert.equal(bucket, 'sprites');
      assert.equal(key, 'sprites/tiles/grass/static.png');
      return Readable.from([Buffer.from('PNGDATA')]);
    },
  });
  const res = await request(app).get('/api/assets/sprites/tiles/grass/static.png');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /image\/png/);
  assert.equal(res.text, 'PNGDATA');
});

test('GET /api/assets/* returns 404 when the object is missing', async () => {
  assetStore.__setAssetClient({
    getObject: async () => { throw new Error('NoSuchKey'); },
  });
  const res = await request(app).get('/api/assets/sprites/tiles/nope/static.png');
  assert.equal(res.status, 404);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/assets_route.test.js`
Expected: FAIL — `Cannot find module '../src/services/assetStore.js'`.

- [ ] **Step 3: Create `backend/src/services/assetStore.js`**

```js
const Minio = require('minio');

// A lazily-built MinIO client from env, with a test seam so routes can be
// exercised without a live MinIO. The sprite-gen service writes objects into
// the `sprites` bucket; this reads them back for the browser.
let client = null;

function makeClient() {
  const endpoint = process.env.MINIO_ENDPOINT || 'minio:9000';
  const [host, portStr] = endpoint.split(':');
  return new Minio.Client({
    endPoint: host,
    port: portStr ? parseInt(portStr, 10) : 9000,
    useSSL: (process.env.MINIO_SECURE || 'false').toLowerCase() === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
  });
}

function getClient() {
  if (!client) client = makeClient();
  return client;
}

const BUCKET = () => process.env.MINIO_BUCKET || 'sprites';

// Resolve to a readable stream for the object, or reject if it is missing.
async function getObjectStream(key) {
  return getClient().getObject(BUCKET(), key);
}

// Test seam: inject a fake client ({ getObject(bucket, key) -> Readable }).
const __setAssetClient = (impl) => { client = impl; };

module.exports = { getObjectStream, __setAssetClient, BUCKET };
```

- [ ] **Step 4: Add the route to `backend/src/index.js`**

Near the top with the other service requires (e.g. beside `let spriteGen = require('./services/spriteGen');`):

```js
const assetStore = require('./services/assetStore');
```

Add the route (place it beside the other sprite/job routes, around `backend/src/index.js:700`):

```js
// Stream a generated asset (sprite/tile texture, atlas, manifest) from MinIO to
// the browser. Read-only; the object key is the path after /api/assets/.
app.get('/api/assets/*', async (req, res) => {
  const key = req.params[0];
  if (!key) return res.status(400).json({ error: 'asset key required' });
  try {
    const stream = await assetStore.getObjectStream(key);
    if (/\.png$/i.test(key)) res.type('image/png');
    else if (/\.json$/i.test(key)) res.type('application/json');
    res.set('Cache-Control', 'public, max-age=300');
    stream.on('error', () => { if (!res.headersSent) res.status(404).json({ error: 'asset not found' }); });
    stream.pipe(res);
  } catch (err) {
    res.status(404).json({ error: 'asset not found' });
  }
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && node --test tests/assets_route.test.js`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/assetStore.js backend/src/index.js backend/tests/assets_route.test.js
git commit -m "feat(assets): GET /api/assets/* streams sprite/tile objects from MinIO"
```

---

### Task 4: Node tile-job + approve routes

**Files:**
- Modify: `backend/src/index.js` (add four routes beside the sprite routes ~`backend/src/index.js:731`)
- Test: `backend/tests/tile_jobs_api.test.js`

**Interfaces:**
- Consumes: `spriteGen.postGenerate`/`getJob`/`getCapability` (existing, `__setSpriteGen` seam); `sprite_sets` table; `tile_types` (`image`, `sprite`, `render_mode` from Slice A).
- Produces:
  - `POST /api/tile-jobs` (adminGuard): body `{ tile_type, base_prompt, backend?, frames?, seed?, tier? }` → calls `spriteGen.postGenerate({ creature: tile_type, base_prompt, kind:'tile', backend, frames, seed, tier })`, inserts a queued `sprite_sets` row, returns `{ ...row, job_id, recipe }`.
  - `GET /api/tile-jobs/:jobId` → proxies `spriteGen.getJob`.
  - `POST /api/tile-types/:id/image` (adminGuard): body `{ image_key, job_id? }` → sets `tile_types.image=image_key`, `render_mode='image'`; marks the sprite_set approved.
  - `POST /api/tile-types/:id/sprite` (adminGuard): body `{ atlas_key, manifest_key, frames?, job_id? }` → sets `tile_types.sprite={atlas_key,manifest_key,frames}`, `render_mode='animated'`; marks the sprite_set approved.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/tile_jobs_api.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const { app, __setPool, __setSpriteGen } = require('../src/index.js');

const AUTH = ['Authorization', `Bearer ${adminToken()}`];

function mockPool(handlers) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      if (isUserLookup(sql)) return ADMIN_USER_ROW;
      calls.push({ sql, params });
      for (const [re, fn] of handlers) if (re.test(sql)) return fn(params);
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test('POST /api/tile-jobs passes kind:tile to sprite-gen and records a queued row', async () => {
  let sentBody = null;
  __setSpriteGen({
    postGenerate: async (body) => { sentBody = body; return { job_id: 'job1', recipe: { backend: 'stub', frames: 1 } }; },
    getCapability: async () => ({ tier: 'cpu' }),
  });
  const pool = mockPool([
    [/INSERT INTO sprite_sets/i, (p) => ({ rows: [{ id: 1, creature: p[0], job_id: p[4], status: 'queued' }] })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/tile-jobs').set(...AUTH)
    .send({ tile_type: 'grass', base_prompt: 'green grass', frames: 1, seed: 0 });
  assert.equal(res.status, 201);
  assert.equal(sentBody.kind, 'tile', 'must tell sprite-gen this is a tile job');
  assert.equal(sentBody.creature, 'grass');
  assert.equal(res.body.job_id, 'job1');
  const insert = pool.calls.find((c) => /INSERT INTO sprite_sets/i.test(c.sql));
  assert.equal(insert.params[0], 'grass');
  assert.equal(insert.params[4], 'job1');
});

test('POST /api/tile-types/:id/image sets image and flips render_mode to image', async () => {
  const pool = mockPool([
    [/UPDATE sprite_sets/i, () => ({ rows: [{ job_id: 'job1' }] })],
    [/UPDATE tile_types SET image/i, (p) => ({ rows: [{ id: Number(p[1]), image: p[0], render_mode: 'image' }] })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/tile-types/5/image').set(...AUTH)
    .send({ image_key: 'sprites/tiles/grass/static.png', job_id: 'job1' });
  assert.equal(res.status, 200);
  const upd = pool.calls.find((c) => /UPDATE tile_types SET image/i.test(c.sql));
  assert.equal(upd.params[0], 'sprites/tiles/grass/static.png');
  assert.equal(String(upd.params[1]), '5');
  assert.match(upd.sql, /render_mode = 'image'/);
  assert.equal(res.body.render_mode, 'image');
});

test('POST /api/tile-types/:id/sprite sets sprite jsonb and flips render_mode to animated', async () => {
  const pool = mockPool([
    [/UPDATE sprite_sets/i, () => ({ rows: [{ job_id: 'job1' }] })],
    [/UPDATE tile_types SET sprite/i, (p) => ({ rows: [{ id: Number(p[1]), sprite: JSON.parse(p[0]), render_mode: 'animated' }] })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/tile-types/5/sprite').set(...AUTH)
    .send({ atlas_key: 'sprites/tiles/water/atlas.png', manifest_key: 'sprites/tiles/water/atlas.json', frames: 4, job_id: 'job1' });
  assert.equal(res.status, 200);
  const upd = pool.calls.find((c) => /UPDATE tile_types SET sprite/i.test(c.sql));
  const stored = JSON.parse(upd.params[0]);
  assert.deepEqual(stored, { atlas_key: 'sprites/tiles/water/atlas.png', manifest_key: 'sprites/tiles/water/atlas.json', frames: 4 });
  assert.match(upd.sql, /render_mode = 'animated'/);
  assert.equal(res.body.render_mode, 'animated');
});

test('tile mutating routes reject a missing token', async () => {
  __setPool(mockPool([]));
  for (const path of ['/api/tile-jobs', '/api/tile-types/5/image', '/api/tile-types/5/sprite']) {
    const res = await request(app).post(path).send({});
    assert.equal(res.status, 401, `${path} must require auth`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/tile_jobs_api.test.js`
Expected: FAIL — routes return 404 (not defined), assertions fail.

- [ ] **Step 3: Add the four routes to `backend/src/index.js`**

Place these right after the entity `POST /api/entity-types/:id/sprite` handler (around `backend/src/index.js:731`):

```js
// Tile generation bridge: mirror /api/sprite-jobs but with kind:'tile' so
// sprite-gen produces a seamless texture (+ optional loop), not a directional set.
app.post('/api/tile-jobs', adminGuard, async (req, res) => {
  try {
    const { tile_type, base_prompt, backend, frames, seed = 0, tier } = req.body;
    let effectiveTier = tier;
    if (!effectiveTier && !backend) {
      try { effectiveTier = (await spriteGen.getCapability()).tier; } catch (_) { /* ignore */ }
    }
    const gen = await spriteGen.postGenerate({
      creature: tile_type, base_prompt, kind: 'tile', backend, frames, seed, tier: effectiveTier,
    });
    const chosenBackend = backend || (gen.recipe && gen.recipe.backend) || 'stub';
    const chosenFrames = frames || (gen.recipe && gen.recipe.frames) || 1;
    const row = await pool.query(
      `INSERT INTO sprite_sets (creature, backend, seed, frames, job_id, status)
       VALUES ($1, $2, $3, $4, $5, 'queued') RETURNING *`,
      [tile_type, chosenBackend, seed, chosenFrames, gen.job_id]
    );
    res.status(201).json({ ...row.rows[0], job_id: gen.job_id, recipe: gen.recipe });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to start tile job' });
  }
});

// Proxy tile job status (job ids are global to the sprite-gen job manager).
app.get('/api/tile-jobs/:jobId', async (req, res) => {
  try {
    res.json(await spriteGen.getJob(req.params.jobId));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});

// Approve a generated static texture and link it to a tile type.
app.post('/api/tile-types/:id/image', adminGuard, async (req, res) => {
  try {
    const { image_key, job_id } = req.body;
    if (job_id) {
      await pool.query(`UPDATE sprite_sets SET status = 'approved' WHERE job_id = $1`, [job_id]);
    }
    const result = await pool.query(
      `UPDATE tile_types SET image = $1, render_mode = 'image', updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
      [image_key, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Tile type not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save tile image' });
  }
});

// Approve a generated animation atlas and link it to a tile type.
app.post('/api/tile-types/:id/sprite', adminGuard, async (req, res) => {
  try {
    const { atlas_key, manifest_key, frames, job_id } = req.body;
    if (job_id) {
      await pool.query(
        `UPDATE sprite_sets SET atlas_key = $1, manifest_key = $2, status = 'approved' WHERE job_id = $3`,
        [atlas_key, manifest_key, job_id]
      );
    }
    const sprite = { atlas_key, manifest_key, frames: frames || 1 };
    const result = await pool.query(
      `UPDATE tile_types SET sprite = $1, render_mode = 'animated', updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
      [JSON.stringify(sprite), req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Tile type not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save tile sprite' });
  }
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/tile_jobs_api.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Confirm the route-protection test still passes and covers the new routes**

Run: `cd backend && node --test tests/auth_protection.test.js`
Expected: PASS. The walk now enumerates the three new mutating routes (`POST /api/tile-jobs`, `POST /api/tile-types/:id/image`, `POST /api/tile-types/:id/sprite`) and asserts each is guarded; the "found >= 15" floor still holds.

- [ ] **Step 6: Full backend suite**

Run: `cd backend && node --test`
Expected: all pass (a single flaky `connection terminated` integration failure can be re-run once).

- [ ] **Step 7: Commit**

```bash
git add backend/src/index.js backend/tests/tile_jobs_api.test.js
git commit -m "feat(tiles): tile-jobs + image/sprite approve routes"
```

---

### Task 5: Frontend tile-sprite hooks + admin generate/approve panel

**Files:**
- Create: `frontend/src/games/something2/useTileSprites.js`
- Modify: `frontend/src/games/something2/TileTypesAdmin.jsx` (add a `TileSpritePanel` inside the edit modal)
- Test: none automated (no jsdom) — `vite build` + browser verification.

**Interfaces:**
- Consumes: `authHeaders()` from `frontend/src/games/something2/src/js/net/EngineClient.js`; the Task 3/4 routes; `useSpriteCapability` from `./useSprites.js` (existing, reusable read of `/api/sprite-capability`).
- Produces: hooks `useGenerateTileJob`, `useTileJob(jobId)`, `useApproveTileImage`, `useApproveTileSprite`; a `TileSpritePanel` rendered in the tile edit modal (only when editing an existing tile — a tile must exist to own an asset).

- [ ] **Step 1: Create `frontend/src/games/something2/useTileSprites.js`**

```js
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders } from "./src/js/net/EngineClient.js";

const API = import.meta.env.VITE_API_URL || "http://localhost:13101";

// Absolute URL for a stored asset served through the backend (not MinIO directly):
export function assetUrl(key) {
  return key ? `${API}/api/assets/${key}` : null;
}

export function useGenerateTileJob() {
  return useMutation({
    mutationFn: async (body) => {
      const res = await fetch(`${API}/api/tile-jobs`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("failed to start tile job");
      return res.json();
    },
    onSuccess: () => toast.success("Tile generation started"),
    onError: (e) => toast.error(`Tile job failed: ${e.message}`),
  });
}

export function useTileJob(jobId) {
  return useQuery({
    queryKey: ["tile-jobs", jobId],
    enabled: !!jobId,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === "done" || s === "error" ? false : 1000;
    },
    queryFn: async () => {
      const res = await fetch(`${API}/api/tile-jobs/${jobId}`);
      if (!res.ok) throw new Error("failed to fetch tile job");
      return res.json();
    },
  });
}

export function useApproveTileImage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ tileId, ...body }) => {
      const res = await fetch(`${API}/api/tile-types/${tileId}/image`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("failed to approve tile texture");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tileTypes"] });
      qc.invalidateQueries({ queryKey: ["mapTiles"] });
      toast.success("Texture approved");
    },
    onError: (e) => toast.error(e.message),
  });
}

export function useApproveTileSprite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ tileId, ...body }) => {
      const res = await fetch(`${API}/api/tile-types/${tileId}/sprite`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("failed to approve tile animation");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tileTypes"] });
      qc.invalidateQueries({ queryKey: ["mapTiles"] });
      toast.success("Animation approved");
    },
    onError: (e) => toast.error(e.message),
  });
}
```

- [ ] **Step 2: Add the `TileSpritePanel` component to `TileTypesAdmin.jsx`**

Add the imports near the top (after the existing imports):

```jsx
import { useGenerateTileJob, useTileJob, useApproveTileImage, useApproveTileSprite, assetUrl } from './useTileSprites.js';
import { useSpriteCapability } from './useSprites.js';
```

Add this component definition above `function TileTypesAdmin() {`:

```jsx
function TileSpritePanel({ tile }) {
  const [mode, setMode] = useState(null);     // 'image' | 'animated' while a job runs
  const [jobId, setJobId] = useState(null);
  const { data: capability } = useSpriteCapability();
  const generate = useGenerateTileJob();
  const { data: job } = useTileJob(jobId);
  const approveImage = useApproveTileImage();
  const approveSprite = useApproveTileSprite();

  const start = (which) => {
    setMode(which);
    setJobId(null);
    generate.mutate(
      { tile_type: tile.name, base_prompt: tile.prompt || tile.name, frames: which === 'animated' ? 4 : 1 },
      { onSuccess: (data) => setJobId(data.job_id) }
    );
  };

  const status = job?.status;
  const result = job?.result;
  const previewKey = mode === 'animated' ? result?.atlas_key : result?.image_key;
  const previewUrl = assetUrl(previewKey);

  const approve = () => {
    if (!result) return;
    if (mode === 'animated') {
      approveSprite.mutate({ tileId: tile.id, atlas_key: result.atlas_key, manifest_key: result.manifest_key, frames: result.frames, job_id: jobId });
    } else {
      approveImage.mutate({ tileId: tile.id, image_key: result.image_key, job_id: jobId });
    }
  };

  return (
    <FormGroup>
      <label>AI Texture / Animation</label>
      <div style={{ fontSize: '1rem', opacity: 0.7, marginBottom: '0.5rem' }}>
        {capability ? `Backend tier: ${capability.tier} (${capability.recommended_backend})` : 'Sprite service…'}
        {' · '}render mode: {tile.render_mode || 'color'}
      </div>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <SecondaryButton type="button" onClick={() => start('image')} disabled={generate.isPending}>Generate texture</SecondaryButton>
        <SecondaryButton type="button" onClick={() => start('animated')} disabled={generate.isPending}>Generate animation</SecondaryButton>
      </div>
      {jobId && (
        <div style={{ marginTop: '0.75rem', fontSize: '1.1rem' }}>
          {status && status !== 'done' && status !== 'error' && <span>Generating… ({job?.progress?.done ?? 0}/{job?.progress?.total ?? 0})</span>}
          {status === 'error' && <span style={{ color: '#ef4444' }}>Generation failed: {job?.error}</span>}
          {status === 'done' && result && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginTop: '0.5rem' }}>
              {previewUrl && <img src={previewUrl} alt="preview" style={{ width: 64, height: 64, imageRendering: 'pixelated', background: '#0f0f1a', borderRadius: 6 }} />}
              <MainButton type="button" onClick={approve} disabled={approveImage.isPending || approveSprite.isPending}>
                Approve {mode === 'animated' ? 'animation' : 'texture'}
              </MainButton>
            </div>
          )}
        </div>
      )}
    </FormGroup>
  );
}
```

Render it in the modal `Form`, only when editing an existing tile (so `tile.id` exists). Immediately after the Prompt `FormGroup` (added in Slice A), insert:

```jsx
              {editingTile && <TileSpritePanel tile={editingTile} />}
```

- [ ] **Step 3: Build the frontend**

Run: `cd frontend && npx vite build`
Expected: `✓ built` with no errors.

- [ ] **Step 4: Restart the sprite-gen and backend containers to load the new code, then browser-verify**

The long-lived processes do not auto-reload. Restart them:

```bash
# sprite-gen (uvicorn): restart the container process
docker restart something2-sprite-gen-1
# backend (plain node under tail -f): kill + relaunch detached
BPID=$(docker exec something2-backend-1 sh -c "pgrep -f 'node src/index.js'")
docker exec something2-backend-1 sh -c "kill $BPID"
docker exec -d something2-backend-1 sh -c 'cd /app && nohup node src/index.js > /tmp/backend.log 2>&1 &'
sleep 3
curl -s http://localhost:13101/api/health
curl -s http://localhost:18100/health
```
Expected: both report ok; sprite-gen `default_backend: stub`, `SPRITE_STORE_ENABLED` is already true in the container.

Then in the browser (signed in as admin), open **TILE_TYPES Admin → Edit** on a tile:
- Click **Generate texture** → a stub texture preview appears within a second; click **Approve texture** → toast "Texture approved"; the tile's `render_mode` flips to `image` (re-open Edit to confirm the line reads `render mode: image`).
- Click **Generate animation** → preview of the atlas; **Approve animation** → `render_mode` becomes `animated`.
- Confirm the preview image actually loads (it is served through `GET /api/assets/*`, proving the MinIO round-trip). If it 404s, verify `SPRITE_STORE_ENABLED=true` in `something2-sprite-gen-1` and that MinIO (`something2-minio-1`) is up.

> Ground-truth check (independent of the UI): after approving, `curl -s http://localhost:13101/api/tile-types | ` inspect the tile — `image` (or `sprite`) is populated and `render_mode` changed. And `curl -s -o /dev/null -w '%{http_code}' http://localhost:13101/api/assets/<image_key>` returns `200`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/useTileSprites.js frontend/src/games/something2/TileTypesAdmin.jsx
git commit -m "feat(tiles): admin generate/preview/approve panel for tile textures + animation"
```

---

## Notes for the executor

- Slice B produces and stores assets and flips `render_mode` to `image`/`animated`, but **nothing renders them yet** — the game still draws flat-color diamonds until Slice C teaches `RenderSystem` to consume the tile texture. Approving a texture in this slice will therefore NOT change the in-world look; verify via the admin preview and the DB, not the game canvas. That is expected.
- The `stub` backend makes deterministic placeholder discs, so the preview will be a small coloured blob, not real art — that is the point (pipeline over fidelity; real SD is an env switch later).
- Do not "fix" the `useSprites.js` (entity) missing-auth-header issue in this slice — note it for a later cross-cutting pass. Only the new tile hooks are in scope, and they use `authHeaders()`.
- After all tasks, the whole-branch review should confirm: creature generation untouched, the three new mutating routes guarded, tile keys retrievable via `/api/assets/*`, and approvals correctly set `image`/`sprite` + `render_mode`.
