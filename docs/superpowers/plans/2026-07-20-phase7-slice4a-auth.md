# Phase 7 Slice 4a — Authentication, roles, predefined map: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real accounts — password login, player/admin roles, a locked-down admin API, revocable tokens, and a canonical world a logged-in player spawns into.

**Architecture:** A `users` table (bcryptjs hashes, a `role`, a `token_version`). Two Express middlewares (`requireAuth`, `requireAdmin`) applied to every mutating route. JWTs carry `token_version`; both HTTP and the WS authority reject a stale version. `/api/dev-token` is removed. A migration seeds the first admin from env and one canonical world.

**Tech Stack:** Node + Express 4.22 + `pg` (CommonJS, `node --test`), node-pg-migrate, `jsonwebtoken` (already a dep), **bcryptjs** and **express-rate-limit** (new), Vite/React frontend (Vitest, env `node`, no jsdom).

**Spec:** `docs/superpowers/specs/2026-07-20-phase7-slice4a-auth-design.md`

## Global Constraints

- **`role` is NEVER read from a request body.** Registration ignores any `role` field. This is a code invariant with its own test, not a validator rule.
- **No default credentials, ever.** The admin-seed migration creates nothing when `ADMIN_USERNAME`/`ADMIN_PASSWORD` are unset.
- **Passwords never round-trip.** No hash in any response, no plaintext in any log.
- **The protection test walks Express's real router stack** (`app._router.stack`, reachable in 4.22.1) — never a hand-maintained route list. It must assert it matched a plausible number of routes before checking them, or a zero-match run passes vacuously.
- **`token_version` is checked on BOTH paths** — HTTP `requireAuth` and the WS authority connect.
- Migrations: `DATABASE_URL="postgres://user:password@localhost:15432/game_db" npm run migrate -- up` / `-- down` from `backend/`. There is NO `migrate:down` script.
- Existing loot/equipment tests must pass **unmodified** through the `user_id` type change; if one needs editing, stop and escalate.
- The full 17 mutating routes to protect: `POST/PUT/DELETE /api/entity-types`, `POST/PUT/DELETE /api/item-types`, `POST /api/players/:userId/items`, `POST/PUT/DELETE /api/tile-types`, `POST /api/maps/generate`, `DELETE /api/maps/:id`, `POST /api/maps/:id/entities`, `POST /api/maps/:id/generate-entities`, `POST /api/sprite-jobs`, `POST /api/entity-types/:id/sprite`, `POST /api/worlds`.
- Backend suite must EXIT on its own (~7s, currently 431 passing). Commit after every task.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `backend/migrations/1714440025000_users.js` | create | users table, user_id type reconciliation, admin+world seed |
| `backend/src/auth/passwords.js` | create | bcryptjs hash/verify wrappers |
| `backend/src/auth/tokens.js` | create | sign/verify JWT incl. token_version |
| `backend/src/auth/middleware.js` | create | requireAuth, requireAdmin |
| `backend/src/auth/routes.js` | create | register / login / logout-all / me / role |
| `backend/src/index.js` | modify | mount auth routes, apply middleware, delete dev-token |
| `backend/src/authority/server.js` | modify | reject stale token_version on connect |
| `frontend/src/games/something2/src/js/net/EngineClient.js` | modify | login/register calls; drop fetchDevToken |
| `frontend/src/games/something2/src/js/core/Game.js` | modify | use stored token |
| `frontend/src/games/something2/Something2.jsx` | modify | login screen; use stored token |
| `frontend/src/pages/Login.jsx` | create | register/login UI |

---

## Task 1: Dependencies

**Files:** `backend/package.json`

- [ ] **Step 1: Install**

```bash
cd backend && npm install bcryptjs express-rate-limit
```

- [ ] **Step 2: Confirm they resolve and the suite is still green**

```bash
node -e "require('bcryptjs'); require('express-rate-limit'); console.log('ok')"
npm test 2>&1 | grep -E "^# (tests|pass|fail)"
```
Expected: `ok`, and 431 passing.

- [ ] **Step 3: Commit**

```bash
git add backend/package.json backend/package-lock.json
git commit -m "chore(deps): add bcryptjs and express-rate-limit"
```

---

## Task 2: Migration — users, type reconciliation, seeds

**Files:** Create `backend/migrations/1714440025000_users.js`

**Interfaces produced:** `users(id, username citext, password_hash, role, token_version, created_at)`; `player_items.user_id`/`player_equipment.user_id`/`world_players.user_id` re-typed to `integer`; one canonical world; optional first admin.

**Context:** All existing anonymous data is test detritus (20 users, 65 items, worlds named SeamTest/losTest*). This migration DISCARDS it — that is deliberate and stated in the spec. The admin/world seed reads env at migration time.

- [ ] **Step 1: Write the migration**

```js
exports.up = async (pgm) => {
  pgm.createExtension('citext', { ifNotExists: true });

  pgm.createTable('users', {
    id: 'id',
    username: { type: 'citext', notNull: true, unique: true },
    password_hash: { type: 'text', notNull: true },
    role: { type: 'text', notNull: true, default: 'player' },
    token_version: { type: 'integer', notNull: true, default: 1 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('users', 'users_role_check', "CHECK (role IN ('player','admin'))");

  // Discard anonymous test data, then re-key ownership tables to a real FK.
  // These tables held only test detritus (see spec); wiping them is intended.
  pgm.sql('TRUNCATE player_equipment, player_items, world_players RESTART IDENTITY CASCADE;');
  for (const t of ['player_items', 'player_equipment', 'world_players']) {
    pgm.sql(`ALTER TABLE ${t} ALTER COLUMN user_id TYPE integer USING NULL;`);
    pgm.sql(`ALTER TABLE ${t} ALTER COLUMN user_id SET NOT NULL;`);
    pgm.addConstraint(t, `${t}_user_fk`,
      { foreignKeys: { columns: 'user_id', references: 'users(id)', onDelete: 'CASCADE' } });
  }

  // Canonical world the player spawns into. Guarded so re-running is a no-op.
  pgm.sql(`INSERT INTO worlds (id, name) VALUES (gen_random_uuid(), 'Overworld')
           ON CONFLICT DO NOTHING;`);

  // First admin from env. With no env set, NOTHING is created — no default
  // credentials. The hash is computed in JS (bcryptjs) and injected as a
  // literal; migrations run in Node so this is available.
  const u = process.env.ADMIN_USERNAME, p = process.env.ADMIN_PASSWORD;
  if (u && p) {
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync(p, 12);
    pgm.sql(`INSERT INTO users (username, password_hash, role)
             VALUES (${pgm.func(`'${u.replace(/'/g, "''")}'`)}, '${hash}', 'admin')
             ON CONFLICT (username) DO NOTHING;`);
  }
};

exports.down = (pgm) => {
  for (const t of ['player_items', 'player_equipment', 'world_players']) {
    pgm.dropConstraint(t, `${t}_user_fk`);
    pgm.sql(`ALTER TABLE ${t} ALTER COLUMN user_id TYPE text USING user_id::text;`);
  }
  pgm.dropTable('users');
  // citext + the seeded world are left in place: dropping an extension other
  // objects may use, and a world that may now hold real data, is riskier than
  // the small residue of leaving them.
};
```

- [ ] **Step 2: Run up, verify, round-trip**

```bash
cd backend
DATABASE_URL="postgres://user:password@localhost:15432/game_db" npm run migrate -- up
docker exec something2-db-1 psql -U user -d game_db -c "\d users"
docker exec something2-db-1 psql -U user -d game_db -c "SELECT name FROM worlds WHERE name='Overworld';"
DATABASE_URL="..." npm run migrate -- down && DATABASE_URL="..." npm run migrate -- up
```
Both directions must succeed.

- [ ] **Step 3: Commit**

```bash
git add backend/migrations/1714440025000_users.js
git commit -m "feat(db): users table, user_id FK reconciliation, admin+world seed"
```

**Cross-task hazard — read before Task 6/7.** The WS authority sets
`ws.userId = String(payload.user_id)` (`server.js:46`) and writes it into
`world_players.user_id` via `persist` (`server.js:121`). After this migration
that column is `integer NOT NULL REFERENCES users(id)`:
- The **type** is fine — Postgres coerces a numeric string, so `String()` may stay.
- The **FK is not satisfiable until `/api/dev-token` is gone.** Today a connect
  can carry any `user_id`; the FK then rejects the `persist` insert for any id
  absent from `users`. It becomes correct only once login (Task 5) is the sole
  token issuer and dev-token is deleted (Task 6). So between this task and Task 6
  the game path is knowingly broken — do not spend time "fixing" a FK violation
  on connect during that window; it resolves when Task 6 lands. The browser pass
  (Task 9) is the first point the full game path is expected to work end to end.

---

## Task 3: Password + token modules

**Files:** Create `backend/src/auth/passwords.js`, `backend/src/auth/tokens.js`; tests `backend/tests/auth_passwords.test.js`, `backend/tests/auth_tokens.test.js`

**Interfaces produced:**
- `hashPassword(plain) -> Promise<string>`, `verifyPassword(plain, hash) -> Promise<boolean>`
- `signToken({ userId, username, role, tokenVersion }) -> string`, `verifyToken(token) -> payload | null` (payload includes `tv`)

- [ ] **Step 1: Write the failing tests**

```js
// passwords
test('a hash verifies its own password and rejects others', async () => {
  const h = await hashPassword('correct horse');
  assert.equal(await verifyPassword('correct horse', h), true);
  assert.equal(await verifyPassword('wrong', h), false);
});
test('the hash is not the plaintext and differs per call (salt)', async () => {
  const a = await hashPassword('x'); const b = await hashPassword('x');
  assert.notEqual(a, 'x'); assert.notEqual(a, b);
});

// tokens
test('a signed token round-trips its claims including token_version', () => {
  const t = signToken({ userId: 7, username: 'bob', role: 'player', tokenVersion: 3 });
  const p = verifyToken(t);
  assert.equal(p.user_id, 7); assert.equal(p.role, 'player'); assert.equal(p.tv, 3);
});
test('a tampered or wrong-secret token verifies to null, never throws', () => {
  assert.equal(verifyToken('garbage.token.here'), null);
});
```

- [ ] **Step 2: Run to verify failure, implement, run to verify pass**

`tokens.js` reads `process.env.JWT_SECRET` (the same secret the authority already uses) and signs HS256 with `expiresIn: '24h'`. `verifyToken` returns null on any error rather than throwing — callers branch on null.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(auth): password hashing and token signing/verification"
```

---

## Task 4: Middleware

**Files:** Create `backend/src/auth/middleware.js`; test `backend/tests/auth_middleware.test.js`

**Interfaces produced:** `requireAuth(pool)` and `requireAdmin(pool)` — Express middleware factories. Both verify the token AND compare `payload.tv` against the user's current `token_version` row; a mismatch is 401.

- [ ] **Step 1: Write the failing tests**

```js
test('requireAuth rejects a missing token with 401', async () => { /* fake req/res/next */ });
test('requireAuth rejects a stale token_version', async () => {
  // token carries tv=1; the users row now has token_version=2 -> 401
});
test('requireAuth attaches req.user on success', async () => { /* tv matches -> next() called, req.user set */ });
test('requireAdmin rejects a valid player token with 403', async () => {});
test('requireAdmin allows an admin token', async () => {});
```

Use a fake pool `{ query: async () => ({ rows: [{ token_version: N, role }] }) }`. The stale-version test is the load-bearing one — it is what makes revocation real.

- [ ] **Step 2: Implement, verify, commit**

```bash
git commit -m "feat(auth): requireAuth and requireAdmin with token_version checks"
```

---

## Task 5: Auth routes + rate limiting

**Files:** Create `backend/src/auth/routes.js`; test `backend/tests/auth_routes.test.js`

**Interfaces produced:** an Express router mounting `POST /register`, `POST /login`, `POST /logout-all`, `GET /me`, `POST /admin/users/:id/role`.

- [ ] **Step 1: Write the failing tests**

```js
test('register creates a player and returns a token, never a hash', async () => {
  const res = await request(app).post('/api/auth/register').send({ username: 'bob', password: 'pw123456' });
  assert.equal(res.status, 201);
  assert.ok(res.body.token);
  assert.equal(JSON.stringify(res.body).includes('password_hash'), false);
  assert.equal(JSON.stringify(res.body).includes('pw123456'), false);
});

test('register IGNORES a role field in the body', async () => {
  // THE privilege-escalation test.
  const res = await request(app).post('/api/auth/register')
    .send({ username: 'sneak', password: 'pw123456', role: 'admin' });
  // fetch the row; role must be 'player'
  const row = await getUser('sneak');
  assert.equal(row.role, 'player');
});

test('login rejects a wrong password without revealing which field was wrong', async () => {});
test('logout-all bumps token_version so a prior token stops working', async () => {});
test('username uniqueness is case-insensitive (Bob == bob)', async () => {});
test('a non-admin cannot promote anyone', async () => {});
```

Choose a test HTTP driver consistent with how `item_types_api.test.js` exercises the app (this project may inject the app rather than use supertest — follow the existing pattern; do not add supertest if a lighter seam exists).

- [ ] **Step 2: Implement**

`register`: reject if username taken; hash; insert as `'player'` (role literal, never from body); return a token. `login`: `verifyPassword`, then a token. `logout-all`: `UPDATE users SET token_version = token_version + 1 WHERE id = req.user.id`. Rate-limit `login` and `register` with `express-rate-limit`, keyed on IP and username.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(auth): register/login/logout-all/me/role routes with rate limiting"
```

---

## Task 6: Wire middleware into index.js, delete dev-token

**Files:** Modify `backend/src/index.js`; test `backend/tests/auth_protection.test.js` (create)

**Context:** This is the task the whole slice turns on. The protection test must walk the real router.

- [ ] **Step 1: Write the failing protection test**

```js
const { app } = require('../src/index');   // or however the app is exported

function mutatingRoutes(app) {
  const stack = (app._router || app.router).stack;
  const out = [];
  for (const layer of stack) {
    if (!layer.route) continue;
    const path = layer.route.path;
    for (const m of Object.keys(layer.route.methods)) {
      if (['post', 'put', 'delete'].includes(m) && path.startsWith('/api')
          && !path.startsWith('/api/auth')) out.push(`${m.toUpperCase()} ${path}`);
    }
  }
  return out;
}

test('every mutating /api route (except auth) is guarded by requireAdmin or requireAuth', () => {
  const routes = mutatingRoutes(app);
  assert.ok(routes.length >= 15,
    `expected the full mutating surface (~17), found ${routes.length} — a zero/low match passes vacuously`);
  for (const r of routes) {
    // assert the route's middleware chain includes requireAuth/requireAdmin
    // (inspect layer.route.stack handlers by name/marker)
    assert.ok(isGuarded(app, r), `${r} is not behind requireAuth/requireAdmin`);
  }
});

test('GET /api/dev-token returns 404 (the takeover primitive is gone)', async () => {
  const res = await request(app).get('/api/dev-token?user_id=1');
  assert.equal(res.status, 404);
});
```

`isGuarded` must detect the middleware concretely — tag `requireAuth`/`requireAdmin` with a named function or a marker property so the test can find it in `layer.route.stack`, rather than counting handlers.

- [ ] **Step 2: Implement**

Mount `app.use('/api/auth', authRouter)`. Add `requireAdmin(pool)` to all 17 mutating routes (list in Global Constraints). **Delete the `/api/dev-token` handler entirely.** Verify the protection test now enumerates ~17 routes and all pass.

- [ ] **Step 3: Run, verify count, commit**

```bash
cd backend && npm test 2>&1 | grep -E "^# (tests|pass|fail)"
git commit -m "feat(auth): protect all mutating admin routes, remove dev-token"
```

---

## Task 7: WS authority rejects stale token_version

**Files:** Modify `backend/src/authority/server.js`; test `backend/tests/authority_server.test.js`

**Context:** `server.js:45` already `jwt.verify`s on connect. It must additionally reject a token whose `tv` is behind the user's row — otherwise `logout-all` and bans work over HTTP but a live game socket survives.

- [ ] **Step 1: Write the failing test**

```js
test('the authority rejects a connect whose token_version is stale', async () => {
  // issue a token at tv=1, bump the users row to tv=2, attempt to connect -> refused
});
```

- [ ] **Step 2: Implement**

After `jwt.verify`, look up the user's `token_version` and close the socket if it differs from `payload.tv`. This adds one indexed query per connect (not per tick) — acceptable.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(authority): reject stale token_version on connect"
```

---

## Task 8: Client login

**Files:** Modify `EngineClient.js`, `Game.js`, `Something2.jsx`; create `frontend/src/pages/Login.jsx`

**Context:** Vitest env `node`, NO jsdom — the login *form* is verified by build + browser pass. Put token storage/refresh logic in pure functions and test those. There are TWO `fetchDevToken` call sites (`Something2.jsx:329`, `Game.js:256`); both must change.

- [ ] **Step 1: Replace the token source**

Add `register(apiUrl, u, p)` and `login(apiUrl, u, p)` to `EngineClient.js`, each POSTing and returning `{ token, user }`. **Remove `fetchDevToken`.** Store the token (in-memory + localStorage) and read it at both former call sites.

- [ ] **Step 2: Login screen**

`Login.jsx`: username/password, register/login toggle, error display. `Something2.jsx` shows it when no valid token is stored and the game once one is. A stored token surviving reload is the SOMET-97 fix — a reload no longer mints a new identity.

- [ ] **Step 3: Verify build + tests, commit**

```bash
cd frontend && npm test && npm run build
git commit -m "feat(client): login/register screen; retire dev-token"
```

---

## Task 9: Browser verification

**Files:** none.

**Context — stale-environment traps (each has cost a real misdiagnosis):** restarting `something2-frontend-1` kills Vite (entrypoint `tail -f /dev/null`) and nothing restarts it; an old backend process may answer on 3101 while a fresh `npm start` dies with EADDRINUSE; `GET /api/item-types` is a `SELECT *` passthrough and is not evidence of current code. `docker compose` fails here — use `docker exec`. Migrations need `DATABASE_URL=...`. **This slice needs `ADMIN_USERNAME`/`ADMIN_PASSWORD` set when the backend starts and when the migration runs**, or no admin exists to test with.

- [ ] **Step 2: Verify each**

- [ ] Register a new player, land on the canonical Overworld map.
- [ ] Reload the page — you stay logged in as the SAME user (SOMET-97 fixed), inventory intact.
- [ ] Log out and back in.
- [ ] As a player, the admin item-type editor is refused (403 / hidden).
- [ ] As the seeded admin, edit an item type successfully.
- [ ] `POST /api/item-types` with no token via curl → 401/403, NOT 201. (The core SOMET-78 fix.)
- [ ] `GET /api/dev-token?user_id=1` → 404.
- [ ] `logout-all`, then confirm a still-open game socket for that user is dropped.

- [ ] **Step 3: Record findings in `.superpowers/sdd/progress.md`.**

---

## Final review

Dispatch the whole-branch review on the most capable model, then use superpowers:finishing-a-development-branch. Security-sensitive: the reviewer must specifically probe for a role coming from a request body, a password or hash in any response/log, an unguarded mutating route, and a token that survives a version bump.
