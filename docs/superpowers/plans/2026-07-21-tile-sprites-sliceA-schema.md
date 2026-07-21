# Tile Sprites — Slice A (Schema & Editable Prompts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `tile_types` a seeded, editable base prompt plus the schema
foundation (`sprite`, `render_mode`) that Slices B and C fill in — no AI, no
rendering.

**Architecture:** One additive migration mirrors the entity `sprite` +
`render_mode` pattern on `tile_types` and seeds a base prompt per tile. The
existing tile-type POST/PUT handlers persist the new `prompt`. The Tile admin
modal gains an editable Prompt field; nothing on screen changes because
`render_mode` defaults to `color`.

**Tech Stack:** Node/Express + `pg` (CommonJS, `node --test`, `__setPool` seam),
`node-pg-migrate`, React/Vite frontend (Vitest **node env, no jsdom**),
styled-components, `@tanstack/react-query`.

## Global Constraints

- Every mutating `/api` route stays behind `adminGuard` (POST/PUT tile-types
  already are — do not remove it).
- `render_mode` defaults to `'color'`; all existing tiles must render exactly as
  today after this slice (strictly additive on screen).
- The `sprite` and `render_mode` columns are added now but only *used* in Slices
  B/C — this slice adds them to the schema and touches only `prompt` in the API
  and UI.
- Migration timestamps are `1714440NNNNNN`; the next free one is
  `1714440026000` (latest existing is `1714440025000_users.js`). If a collision
  appears at `migrate:up` time, bump to the next unused value and rename.
- Frontend has **no jsdom** — do not write React component-render tests. Verify
  JSX via `npx vite build` and a browser check.

---

### Task 1: Migration — add `prompt`/`sprite`/`render_mode` and seed prompts

**Files:**
- Create: `backend/migrations/1714440026000_tile_prompts_sprite.js`
- Test: `backend/tests/migration_tile_prompts.test.js`

**Interfaces:**
- Consumes: existing `tile_types` table (columns `id, name, color, walkable,
  speed, image, valid_neighbors, created_at, updated_at`).
- Produces: `tile_types.prompt` (`text NOT NULL DEFAULT ''`),
  `tile_types.sprite` (`jsonb` nullable), `tile_types.render_mode`
  (`text NOT NULL DEFAULT 'color'`); module also exports `TILE_PROMPTS`
  (`{ [tileName]: string }`) for testing.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/migration_tile_prompts.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

// Records the DDL calls node-pg-migrate would make, so we can assert the
// migration's shape without a live database (same pattern as
// migration_world_players.test.js).
function fakePgm() {
  const calls = { addColumns: [], sql: [], dropColumns: [] };
  return {
    calls,
    addColumns: (name, cols) => calls.addColumns.push({ name, cols }),
    dropColumns: (name, cols) => calls.dropColumns.push({ name, cols }),
    sql: (s) => calls.sql.push(s),
    func: (x) => ({ raw: x }),
  };
}

const mig = require('../migrations/1714440026000_tile_prompts_sprite.js');
const NAMES = ['grass', 'highgrass', 'leafs', 'sand', 'rocks', 'earth',
  'dirt', 'snow', 'ice', 'swamp', 'water'];

test('up adds prompt, sprite, render_mode with correct types and defaults', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  assert.equal(pgm.calls.addColumns.length, 1);
  const { name, cols } = pgm.calls.addColumns[0];
  assert.equal(name, 'tile_types');
  assert.equal(cols.prompt.type, 'text');
  assert.equal(cols.prompt.notNull, true);
  assert.equal(cols.prompt.default, '');
  assert.equal(cols.sprite.type, 'jsonb');
  assert.equal(cols.sprite.notNull, false);
  assert.equal(cols.render_mode.type, 'text');
  assert.equal(cols.render_mode.notNull, true);
  assert.equal(cols.render_mode.default, 'color');
});

test('seeds a non-empty base prompt for each of the 11 named tiles', () => {
  assert.equal(Object.keys(mig.TILE_PROMPTS).length, 11);
  for (const n of NAMES) {
    assert.ok(mig.TILE_PROMPTS[n] && mig.TILE_PROMPTS[n].length > 0,
      `missing prompt for ${n}`);
  }
  const pgm = fakePgm();
  mig.up(pgm);
  for (const n of NAMES) {
    const stmt = pgm.calls.sql.find(
      (s) => /SET prompt =/.test(s) && s.includes(`WHERE name = '${n}'`));
    assert.ok(stmt, `no seed UPDATE for ${n}`);
  }
});

test('down drops the three columns', () => {
  const pgm = fakePgm();
  mig.down(pgm);
  assert.deepEqual(pgm.calls.dropColumns[0],
    { name: 'tile_types', cols: ['prompt', 'sprite', 'render_mode'] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/migration_tile_prompts.test.js`
Expected: FAIL — `Cannot find module '../migrations/1714440026000_tile_prompts_sprite.js'`.

- [ ] **Step 3: Write the migration**

Create `backend/migrations/1714440026000_tile_prompts_sprite.js`:

```js
exports.shorthands = undefined;

// Base prompts per seeded tile — human-readable descriptions only. The sprite-gen
// tile branch (Slice B) appends the "seamless top-down iso tile" styling, so
// these stay editable and readable.
const TILE_PROMPTS = {
  grass: 'lush green meadow grass',
  highgrass: 'tall dense green grass',
  leafs: 'dark green forest leaf litter',
  sand: 'fine golden beach sand',
  rocks: 'grey rocky stone ground',
  earth: 'bare brown earth soil',
  dirt: 'dark packed dirt ground',
  snow: 'fresh white snow',
  ice: 'pale blue cracked ice',
  swamp: 'murky green swamp mud',
  water: 'clear blue rippling water',
};

exports.up = (pgm) => {
  // Mirror the entity image/sprite/render_mode pattern on tile_types.
  // render_mode defaults to 'color' so every existing tile renders exactly as
  // today until a texture is generated and approved (Slices B/C).
  pgm.addColumns('tile_types', {
    prompt: { type: 'text', notNull: true, default: '' },
    sprite: { type: 'jsonb', notNull: false },
    render_mode: { type: 'text', notNull: true, default: 'color' },
  });

  // Seed a base prompt for each stock tile. None of these strings contain a
  // single quote, so direct interpolation is safe here.
  for (const [name, prompt] of Object.entries(TILE_PROMPTS)) {
    pgm.sql(`UPDATE tile_types SET prompt = '${prompt}' WHERE name = '${name}'`);
  }
};

exports.down = (pgm) => {
  pgm.dropColumns('tile_types', ['prompt', 'sprite', 'render_mode']);
};

// Exported for unit testing the seed values.
exports.TILE_PROMPTS = TILE_PROMPTS;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/migration_tile_prompts.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Apply the migration against the real database and verify the seed**

The unit test proves the migration's *shape*; this step proves it actually runs
and seeds. The backend runs in a container (host `docker exec`), so run migrate
there.

Run:
```bash
docker exec something2-backend-1 npm run migrate:up
```
Expected: output lists `1714440026000_tile_prompts_sprite` as migrated (no error).

Then verify the seed landed on real rows:
```bash
docker exec something2-db-1 psql -U postgres -d something2 -c \
  "SELECT name, prompt, render_mode FROM tile_types ORDER BY id;"
```
Expected: all 11 stock tiles show their seeded prompt (e.g. `grass | lush green
meadow grass | color`); `render_mode` is `color` for every row; `sprite` is null.

> If the container/service names differ, discover them with
> `docker ps --format '{{.Names}}'` and substitute. If `migrate:up` reports a
> duplicate-timestamp error, rename the file to the next unused
> `1714440NNNNNN` value and re-run Steps 2–5.

- [ ] **Step 6: Commit**

```bash
git add backend/migrations/1714440026000_tile_prompts_sprite.js \
        backend/tests/migration_tile_prompts.test.js
git commit -m "feat(tiles): add prompt/sprite/render_mode columns + seed tile prompts"
```

---

### Task 2: Persist `prompt` in the tile-type API

**Files:**
- Modify: `backend/src/index.js` (the `POST /api/tile-types` handler at
  `backend/src/index.js:415-434` and the `PUT /api/tile-types/:id` handler at
  `backend/src/index.js:435-455`)
- Test: `backend/tests/tile_types_api.test.js`

**Interfaces:**
- Consumes: `tile_types.prompt` column (Task 1); the test helper
  `./helpers/auth.js` exporting `adminToken()`, `isUserLookup(sql)`,
  `ADMIN_USER_ROW` (already used by `tests/item_types_api.test.js`).
- Produces: POST accepts `prompt` in the body and stores it as INSERT param `$7`;
  PUT accepts `prompt` and stores it as UPDATE param `$7` (with `id` shifting to
  `$8`). Both echo the persisted row.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/tile_types_api.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const { app, __setPool } = require('../src/index.js');

const AUTH = ['Authorization', `Bearer ${adminToken()}`];

// SQL-text-dispatch pool mock; auth's user lookup answered with an admin row.
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

test('POST /api/tile-types sends prompt as INSERT param $7 and echoes it', async () => {
  const pool = mockPool([
    [/INSERT INTO tile_types/i, (p) => ({ rows: [{ id: 1, name: 'lava', prompt: p[6] }] })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/tile-types').set(...AUTH).send({
    name: 'lava', color: '#f00', walkable: false, speed: 0,
    valid_neighbors: [], prompt: 'molten glowing lava',
  });
  assert.equal(res.status, 201);
  const call = pool.calls.find((c) => /INSERT INTO tile_types/i.test(c.sql));
  assert.equal(call.params[6], 'molten glowing lava', 'prompt must be INSERT $7');
  assert.equal(res.body.prompt, 'molten glowing lava');
});

test('PUT /api/tile-types/:id sends prompt as UPDATE param $7 and id as $8', async () => {
  const pool = mockPool([
    [/UPDATE tile_types/i, (p) => ({ rows: [{ id: Number(p[7]), name: p[0], prompt: p[6] }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/tile-types/9').set(...AUTH).send({
    name: 'grass', color: '#0f0', walkable: true, speed: 1,
    image: '', valid_neighbors: ['grass'], prompt: 'edited meadow grass',
  });
  assert.equal(res.status, 200);
  const call = pool.calls.find((c) => /UPDATE tile_types/i.test(c.sql));
  assert.equal(call.params[6], 'edited meadow grass', 'prompt must be UPDATE $7');
  assert.equal(String(call.params[7]), '9', 'id must be UPDATE $8');
  assert.equal(res.body.prompt, 'edited meadow grass');
});

test('POST defaults prompt to empty string when omitted', async () => {
  const pool = mockPool([
    [/INSERT INTO tile_types/i, (p) => ({ rows: [{ id: 2, prompt: p[6] }] })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/tile-types').set(...AUTH).send({
    name: 'plain', color: '#111',
  });
  assert.equal(res.status, 201);
  const call = pool.calls.find((c) => /INSERT INTO tile_types/i.test(c.sql));
  assert.equal(call.params[6], '', 'missing prompt must default to empty string');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/tile_types_api.test.js`
Expected: FAIL — the INSERT/UPDATE has only 6/6 params, so `call.params[6]` is
`undefined` (prompt assertions fail).

- [ ] **Step 3: Add `prompt` to the POST handler**

In `backend/src/index.js`, the `POST /api/tile-types` handler currently reads:

```js
    const { name, color, walkable, speed, image, valid_neighbors } = req.body;
    
    // Simple validation
    if (!name || !color) {
      return res.status(400).json({ error: 'Name and color are required' });
    }

    const result = await pool.query(
      'INSERT INTO tile_types (name, color, walkable, speed, image, valid_neighbors) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [name, color, walkable ?? true, speed ?? 1.0, image || '', JSON.stringify(valid_neighbors || [])]
    );
```

Replace it with:

```js
    const { name, color, walkable, speed, image, valid_neighbors, prompt } = req.body;
    
    // Simple validation
    if (!name || !color) {
      return res.status(400).json({ error: 'Name and color are required' });
    }

    const result = await pool.query(
      'INSERT INTO tile_types (name, color, walkable, speed, image, valid_neighbors, prompt) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [name, color, walkable ?? true, speed ?? 1.0, image || '', JSON.stringify(valid_neighbors || []), prompt || '']
    );
```

- [ ] **Step 4: Add `prompt` to the PUT handler**

In `backend/src/index.js`, the `PUT /api/tile-types/:id` handler currently reads:

```js
    const { name, color, walkable, speed, image, valid_neighbors } = req.body;
    
    const result = await pool.query(
      'UPDATE tile_types SET name = $1, color = $2, walkable = $3, speed = $4, image = $5, valid_neighbors = $6, updated_at = CURRENT_TIMESTAMP WHERE id = $7 RETURNING *',
      [name, color, walkable, speed, image, JSON.stringify(valid_neighbors), id]
    );
```

Replace it with:

```js
    const { name, color, walkable, speed, image, valid_neighbors, prompt } = req.body;
    
    const result = await pool.query(
      'UPDATE tile_types SET name = $1, color = $2, walkable = $3, speed = $4, image = $5, valid_neighbors = $6, prompt = $7, updated_at = CURRENT_TIMESTAMP WHERE id = $8 RETURNING *',
      [name, color, walkable, speed, image, JSON.stringify(valid_neighbors), prompt || '', id]
    );
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && node --test tests/tile_types_api.test.js`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the full backend suite (no regressions)**

Run: `cd backend && node --test`
Expected: all tests pass. (A single flaky integration failure with
`connection terminated` can occur under DB load — re-run once to confirm it is
not your change.)

- [ ] **Step 7: Commit**

```bash
git add backend/src/index.js backend/tests/tile_types_api.test.js
git commit -m "feat(tiles): persist prompt on tile-type create/update"
```

---

### Task 3: Editable Prompt field in the Tile admin

**Files:**
- Modify: `frontend/src/games/something2/TileTypesAdmin.jsx`
  - `formData` initial state (`:270-277`) and the reset effect (`:279-299`)
  - the `FormGroup` styled component's input selector (`:190-202`)
  - the modal `Form` (`:411-477`) — add the Prompt field
  - the `TileCard` body (`:360-397`) — show a truncated prompt

**Interfaces:**
- Consumes: the tile-type PUT/POST API persisting `prompt` (Task 2); the
  existing mutations `useCreateTileType` / `useUpdateTileType`
  (`frontend/src/games/something2/useMaps.js:120-161`), which already send the
  whole `formData` (minus `id`), so no hook change is needed.
- Produces: nothing consumed by later tasks (leaf UI change).

> **No unit test:** the frontend Vitest env is node with no jsdom, so there is no
> harness to render this component. Verify with a production build and a browser
> check (Steps 3–4). Do not add a jsdom dependency for this.

- [ ] **Step 1: Add `prompt` to form state and style textareas**

In `frontend/src/games/something2/TileTypesAdmin.jsx`, add `textarea` to the
`FormGroup` field selector so the Prompt box matches the other inputs. Change:

```js
  input, select {
    background: #0f0f1a;
    border: 1px solid rgba(74, 158, 255, 0.3);
    color: white;
    padding: 1rem;
    border-radius: 8px;
    font-size: 1.4rem;
    
    &:focus {
      outline: none;
      border-color: #4a9eff;
    }
  }
```
to:
```js
  input, select, textarea {
    background: #0f0f1a;
    border: 1px solid rgba(74, 158, 255, 0.3);
    color: white;
    padding: 1rem;
    border-radius: 8px;
    font-size: 1.4rem;
    font-family: inherit;
    
    &:focus {
      outline: none;
      border-color: #4a9eff;
    }
  }
```

Then add `prompt` to both `formData` blocks. The initial state (`:270-277`)
becomes:
```js
  const [formData, setFormData] = useState({
    name: '',
    color: '#000000',
    walkable: true,
    speed: 1.0,
    image: '',
    prompt: '',
    valid_neighbors: []
  });
```

And in the `useEffect` (`:279-299`), add `prompt` to both branches:
```js
  useEffect(() => {
    if (editingTile) {
      setFormData({
        name: editingTile.name,
        color: editingTile.color,
        walkable: editingTile.walkable,
        speed: editingTile.speed,
        image: editingTile.image || '',
        prompt: editingTile.prompt || '',
        valid_neighbors: editingTile.valid_neighbors || []
      });
    } else {
      setFormData({
        name: '',
        color: '#00ff00',
        walkable: true,
        speed: 1.0,
        image: '',
        prompt: '',
        valid_neighbors: []
      });
    }
  }, [editingTile, isModalOpen]);
```

- [ ] **Step 2: Add the Prompt field to the modal and a prompt line on the card**

In the modal `Form`, add a Prompt `FormGroup` immediately after the Color group
(before the walkable/speed row at `:432`):

```jsx
              <FormGroup>
                <label>Prompt (for AI texture generation)</label>
                <textarea
                  rows={3}
                  value={formData.prompt}
                  onChange={e => setFormData({ ...formData, prompt: e.target.value })}
                  placeholder="e.g. molten glowing lava, cracked crust"
                />
              </FormGroup>
```

In `TileCard`, add a prompt line after the closing `</TileStats>` (`:385`) and
before `<NeighborsList>`:

```jsx
            {tile.prompt ? (
              <div style={{ fontSize: '1.1rem', opacity: 0.7, marginBottom: '1rem', fontStyle: 'italic' }}>
                “{tile.prompt.length > 60 ? tile.prompt.slice(0, 60) + '…' : tile.prompt}”
              </div>
            ) : null}
```

- [ ] **Step 3: Build the frontend to verify it compiles**

Run: `cd frontend && npx vite build`
Expected: `✓ built` with no errors (module count builds successfully).

- [ ] **Step 4: Browser verification**

With the dev stack running, open the app → **TILE_TYPES Admin** tab (signed in as
admin). Verify:
- each tile card shows its seeded prompt in italics (e.g. grass → “lush green
  meadow grass”);
- opening **Edit** on a tile shows the prompt in the textarea;
- changing the prompt and clicking **Save Changes** persists it — reopen Edit and
  the new text is there (this exercises the Task 2 PUT round-trip end-to-end).

> If a browser edit appears not to save, confirm you are signed in as admin (the
> PUT is `adminGuard`-protected) and that the Vite dev server picked up the
> change (hard reload / clear `.vite` cache) before suspecting the code.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/TileTypesAdmin.jsx
git commit -m "feat(tiles): editable prompt field in Tile admin"
```

---

## Notes for the executor

- This slice is intentionally schema-and-plumbing only. Do **not** wire any
  generation, image serving, or rendering — those are Slices B and C and depend
  on this slice's columns.
- The `sprite` and `render_mode` columns are added here but left at their
  defaults; leaving them unused this slice is expected, not an omission.
- After all three tasks, the whole-branch review should confirm: existing tile
  rendering is unchanged (all `render_mode = 'color'`), the migration seeds all
  11 tiles, and the prompt round-trips through POST/PUT and the admin UI.
