# Orange Pi Production Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the repository's first production-serving path — a real backend image, a real frontend bundle, and a composition that runs them behind Caddy — verifiable end to end on a workstation with no Orange Pi present.

**Architecture:** A new `compose/orangepi/` directory, sibling to `compose/develop/`. Four services: `caddy` (serves the built bundle and proxies `/api` and `/authority`), `backend` (production Node image), `db` (Postgres), and `cloudflared` (behind a profile, so no public URL ever opens as a side effect). Nothing bind-mounts source; nothing runs a dev server.

**Tech Stack:** Docker Compose, `node:20-alpine`, `caddy:2-alpine`, `postgres:15-alpine`, Vite 8, Express 4, `node --test`.

**Spec:** [docs/superpowers/specs/2026-08-17-orangepi-staging-design.md](../specs/2026-08-17-orangepi-staging-design.md)

**Plane:** SOMET-421 (backend image), SOMET-422 (frontend build), SOMET-423 (composition)

## Global Constraints

- **Base images:** `node:20-alpine` for builds (matches `compose/develop/*.Dockerfile`), `caddy:2-alpine`, `postgres:15-alpine`.
- **Build context is the repository root.** Every compose invocation passes `--project-directory .`, matching the existing `Makefile` pattern. Dockerfile `COPY` paths are therefore repo-relative (`COPY backend/ ./`), never relative to the Dockerfile.
- **`npm ci`, never `npm install`.** Both `backend/package-lock.json` and `frontend/package-lock.json` exist and must be honoured exactly.
- **`--omit=dev` on the backend only.** It drops `nodemon` and `supertest` but **keeps `node-pg-migrate`**, which is a production dependency because migrations run as a deploy step. The frontend build stage needs dev dependencies (Vite is one), so it does **not** use `--omit=dev`.
- **No bind-mounted source, anywhere.** The whole point of this stack is that the container *is* the service.
- **Exactly one backend container.** The authority holds an in-memory tick loop per live world; two instances would disagree about the same world.
- **Never modify `compose/develop/`.** The development stack must behave identically after this work.
- **Postgres data lives outside the app directory**, under a configurable data root — never inside the clone.

## Context an engineer needs before starting

Facts established by reading the codebase; do not re-derive them.

- **`/api/health` already exists** at `backend/src/index.js:367`. It returns `{status:'ok'}` unconditionally and **never touches the database**, so it is a liveness check only. Use it for the container healthcheck; making it a readiness check is SOMET-376 and out of scope here.
- **The backend boots fine without MinIO.** `backend/src/services/assetStore.js` builds its client lazily inside `getClient()`, and nothing calls it at startup. Sprites will 500 individually and render as placeholder boxes until SOMET-379 configures object storage. That is expected for this slice.
- **The backend does not serve static files.** There is no `express.static` anywhere in `backend/src/index.js`. That is precisely why Caddy exists.
- **`VITE_API_URL` is baked at build time**, read in over twenty modules via `import.meta.env.VITE_API_URL`, each falling back to `http://localhost:13101` (see `frontend/src/config.js:4`). A bundle built without it points every player at their own machine and fails silently.
- **The websocket needs no special proxy config.** `frontend/.../core/Game.js:379` derives it as `API_URL.replace(/^http/, 'ws') + '/authority'`, and `backend/src/authority/server.js` attaches it to the same HTTP server as the REST API. Caddy v2 proxies upgrades natively — unlike nginx, no explicit `Upgrade`/`Connection` headers are required.
- **`.dockerignore` already excludes `node_modules`** (294MB across the two apps). It does not yet exclude `.git`, which Task 1 addresses.
- **Existing test pattern:** `backend/tests/compose_port_bindings.test.js` and `compose_secret_requirements.test.js` assert on compose YAML **as text**, because no YAML parser is a project dependency. Follow that pattern — do not add a YAML parser.

## File Structure

| File | Responsibility |
|---|---|
| `.dockerignore` (modify) | Keep build context small; matters most on the Pi's fallback build |
| `compose/orangepi/backend.Dockerfile` (create) | Production Node image that actually runs the server |
| `compose/orangepi/frontend.Dockerfile` (create) | Two-stage: Vite build → Caddy image containing the bundle |
| `compose/orangepi/caddy/Caddyfile` (create) | Single-origin routing: static + `/api` + `/authority` |
| `compose/orangepi/docker-compose.yml` (create) | The four-service production composition |
| `backend/tests/orangepi_images.test.js` (create) | Asserts Dockerfile invariants |
| `backend/tests/orangepi_compose.test.js` (create) | Asserts composition invariants |

---

### Task 1: Production backend image

**Files:**
- Create: `compose/orangepi/backend.Dockerfile`
- Modify: `.dockerignore`
- Test: `backend/tests/orangepi_images.test.js`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: an image whose entrypoint is `node src/index.js`, listening on `PORT` (default 3101). Task 4's `backend` service builds it via `dockerfile: compose/orangepi/backend.Dockerfile`.

**Architecture note:** build for the host architecture only. `node:20-alpine` is a multi-arch manifest, so the same Dockerfile builds on arm64 unchanged — but publishing multi-arch images to GHCR is SOMET-397 and explicitly not part of this slice. Do not add `--platform` or buildx configuration here.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/orangepi_images.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// SOMET-421/422. The production images are the first thing in this repo that
// actually runs the app as a service -- every compose/develop/*.Dockerfile
// ends in `tail -f /dev/null` with the source bind-mounted. These tests read
// the Dockerfiles as text (no Dockerfile parser is a project dependency) and
// assert the properties that would silently produce a broken deployment:
// a dev-idling CMD, `npm install` ignoring the lockfile, or --omit=dev
// dropping node-pg-migrate, which migrations need at deploy time.

const ORANGEPI = path.join(__dirname, '..', '..', 'compose', 'orangepi');
const BACKEND_DOCKERFILE = path.join(ORANGEPI, 'backend.Dockerfile');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

test('backend image runs the server rather than idling', () => {
  const text = read(BACKEND_DOCKERFILE);
  assert.match(
    text,
    /^CMD \["node", "src\/index\.js"\]/m,
    'production backend must exec the server, not tail -f /dev/null'
  );
  // Scoped to CMD lines on purpose. The file's header comment names
  // `tail -f /dev/null` to contrast with the development image, and a
  // whole-file check would fail on that comment -- forbidding the code from
  // explaining itself.
  const cmdLines = text.split('\n').filter((l) => l.startsWith('CMD'));
  assert.ok(cmdLines.length > 0, 'a production image must declare a CMD');
  for (const line of cmdLines) {
    assert.doesNotMatch(line, /tail/, `dev-idling CMD in a production image: ${line}`);
  }
});

test('backend image installs from the lockfile without dev dependencies', () => {
  const text = read(BACKEND_DOCKERFILE);
  assert.match(text, /npm ci --omit=dev/, 'must be `npm ci --omit=dev`');
  assert.doesNotMatch(
    text,
    /npm install/,
    '`npm install` ignores the lockfile and can drift from what was tested'
  );
});

test('backend image does not run as root', () => {
  assert.match(read(BACKEND_DOCKERFILE), /^USER node$/m);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `backend/`:

```bash
node --test tests/orangepi_images.test.js
```

Expected: FAIL — `ENOENT: no such file or directory` for `backend.Dockerfile`.

- [ ] **Step 3: Write the Dockerfile**

Create `compose/orangepi/backend.Dockerfile`:

```dockerfile
# Production backend image. Unlike compose/develop/backend.Dockerfile, which
# ends in `tail -f /dev/null` so `make dev` can exec nodemon into a container
# with the host checkout bind-mounted, this image IS the service: no bind
# mount, no nodemon, no source volume.
FROM node:20-alpine

WORKDIR /app

# Manifests first, so the dependency layer caches independently of source
# changes. On the Pi's fallback build path this is the difference between a
# rebuild that reinstalls everything and one that does not.
COPY backend/package.json backend/package-lock.json ./

# `npm ci` installs exactly the lockfile; `npm install` may resolve differently
# from what was tested. --omit=dev drops nodemon and supertest but KEEPS
# node-pg-migrate, which is a production dependency precisely because
# migrations run as their own deploy step.
RUN npm ci --omit=dev

# .dockerignore excludes backend/node_modules, so this does not clobber the
# modules installed above.
COPY backend/ ./

# node:20-alpine ships an unprivileged `node` user. The app only reads its
# own source at runtime, so root ownership of /app is fine.
USER node

# The internal port. backend/src/index.js honours PORT and falls back to 3101.
EXPOSE 3101

CMD ["node", "src/index.js"]
```

- [ ] **Step 4: Run the test to verify it passes**

Run from `backend/`:

```bash
node --test tests/orangepi_images.test.js
```

Expected: PASS — 3 tests.

- [ ] **Step 5: Shrink the build context**

Replace `.dockerignore` with:

```
**/node_modules
frontend/node_modules
backend/node_modules

# Everything below is context the images never COPY. Excluding it keeps the
# tarball sent to the daemon small, which barely matters on a workstation and
# matters a great deal on the Pi's fallback build path over four A53 cores.
.git
docs
engine
sprite-gen
tools
**/__tests__
**/*.test.js
```

- [ ] **Step 6: Build the image for real**

Run from the repository root:

```bash
docker build -f compose/orangepi/backend.Dockerfile -t s2-backend:plan-check .
```

Expected: build succeeds. Then confirm the entrypoint and that dev dependencies really are absent:

```bash
docker run --rm s2-backend:plan-check node -e "console.log(require('node-pg-migrate/package.json').version)"
docker run --rm s2-backend:plan-check sh -c "ls node_modules/nodemon 2>&1 || echo 'nodemon absent (correct)'"
```

Expected: a version number printed, then `nodemon absent (correct)`.

- [ ] **Step 7: Commit**

```bash
git add compose/orangepi/backend.Dockerfile .dockerignore backend/tests/orangepi_images.test.js
git commit -m "feat(orangepi): production backend image (SOMET-421)"
```

---

### Task 2: Production frontend build

**Files:**
- Create: `compose/orangepi/frontend.Dockerfile`
- Modify: `backend/tests/orangepi_images.test.js`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: an image based on `caddy:2-alpine` containing the built bundle at `/srv` and expecting a Caddyfile at `/etc/caddy/Caddyfile` (supplied by Task 3). It takes one build arg, `VITE_API_URL`. Task 4's `caddy` service builds it.

**Why the final stage is Caddy:** the built bundle has to be served by something, and a separate volume-shared static directory would mean two services agreeing on a mount path. Baking `dist/` into the Caddy image keeps the unit self-contained — one image is "the web tier". The compose service is therefore named `caddy` while its Dockerfile is named `frontend.Dockerfile`; that mismatch is deliberate and noted in both files.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/orangepi_images.test.js`:

```javascript
const FRONTEND_DOCKERFILE = path.join(ORANGEPI, 'frontend.Dockerfile');

test('frontend image builds the bundle rather than serving a dev server', () => {
  const text = read(FRONTEND_DOCKERFILE);
  assert.match(text, /RUN npm run build/, 'must run the vite build');
  assert.doesNotMatch(text, /npm run dev/, 'no dev server in a production image');
  assert.doesNotMatch(text, /tail/, 'no dev-idling CMD');
});

test('frontend build refuses to bake a localhost API url', () => {
  const text = read(FRONTEND_DOCKERFILE);
  assert.match(text, /ARG VITE_API_URL/, 'API url must be a build arg');
  // VITE_API_URL is read in 20+ modules with a http://localhost:13101
  // fallback. A bundle built without it points every player at their own
  // machine and fails silently, so the BUILD must fail loudly instead.
  //
  // Asserting on the GUARD, not on the bare word "localhost": this file's
  // comments mention localhost too, so a looser check would still pass with
  // the guard deleted -- a test that asserts nothing.
  assert.match(
    text,
    /grep -qE 'localhost\|127\\\.0\\\.0\\\.1'/,
    'the build must actively test VITE_API_URL against localhost'
  );
  assert.match(text, /exit 1/, 'the guard must fail the build, not warn');
});

test('frontend image serves the bundle from caddy', () => {
  const text = read(FRONTEND_DOCKERFILE);
  assert.match(text, /^FROM caddy:2-alpine/m);
  assert.match(text, /COPY --from=build \/app\/dist \/srv/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `backend/`:

```bash
node --test tests/orangepi_images.test.js
```

Expected: FAIL — `ENOENT` for `frontend.Dockerfile`. The three Task 1 tests still pass.

- [ ] **Step 3: Write the Dockerfile**

Create `compose/orangepi/frontend.Dockerfile`:

```dockerfile
# Production web tier: a Vite build stage, then a Caddy image carrying the
# built bundle. The compose service is called `caddy` because that is what it
# runs; this file is called frontend.Dockerfile because that is what it builds.
FROM node:20-alpine AS build

WORKDIR /app

# VITE_API_URL is baked into the bundle at BUILD time -- it is read in more
# than twenty modules via import.meta.env, each falling back to
# http://localhost:13101 (frontend/src/config.js:4). A bundle built without it
# silently points every player at their own machine, so the build refuses
# rather than emitting one. On the Pi this value is the tunnel hostname, which
# changes on every restart while the trycloudflare phase lasts.
ARG VITE_API_URL

RUN if [ -z "$VITE_API_URL" ]; then \
      echo "ERROR: VITE_API_URL build-arg is required" >&2; exit 1; \
    fi; \
    if echo "$VITE_API_URL" | grep -qE 'localhost|127\.0\.0\.1'; then \
      echo "ERROR: VITE_API_URL is still the localhost default: $VITE_API_URL" >&2; \
      exit 1; \
    fi

COPY frontend/package.json frontend/package-lock.json ./

# No --omit=dev here: vite itself is a dev dependency, so the build needs them.
RUN npm ci

COPY frontend/ ./

ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

FROM caddy:2-alpine

COPY --from=build /app/dist /srv
COPY compose/orangepi/caddy/Caddyfile /etc/caddy/Caddyfile
```

- [ ] **Step 4: Run the test to verify it passes**

Run from `backend/`:

```bash
node --test tests/orangepi_images.test.js
```

Expected: PASS — 6 tests.

- [ ] **Step 5: Prove the guard actually fires**

The image cannot build yet (the Caddyfile arrives in Task 3), but the guard runs before that `COPY`, so both failure modes are testable now. Run from the repository root:

```bash
docker build -f compose/orangepi/frontend.Dockerfile -t s2-web:plan-check . 2>&1 | tail -3
docker build -f compose/orangepi/frontend.Dockerfile --build-arg VITE_API_URL=http://localhost:13101 -t s2-web:plan-check . 2>&1 | tail -3
```

Expected: the first fails with `VITE_API_URL build-arg is required`; the second fails with `still the localhost default`. A guard that has never fired is not a guard.

- [ ] **Step 6: Commit**

```bash
git add compose/orangepi/frontend.Dockerfile backend/tests/orangepi_images.test.js
git commit -m "feat(orangepi): production frontend build with a build-time API url guard (SOMET-422)"
```

---

### Task 3: Caddy single-origin routing

**Files:**
- Create: `compose/orangepi/caddy/Caddyfile`
- Test: `backend/tests/orangepi_compose.test.js`

**Interfaces:**
- Consumes: the `backend` service name and port 3101 from Task 1's image.
- Produces: an origin on port 80 serving `/srv` and proxying `/api/*` and `/authority*` to `backend:3101`. Task 2's Dockerfile copies this file to `/etc/caddy/Caddyfile`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/orangepi_compose.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// SOMET-423. Today a single tunnel is enough only because the vite DEV SERVER
// proxies /api and /authority through to backend:3101
// (frontend/vite.config.js). A production static bundle has no such proxy, so
// that routing has to be reproduced by Caddy -- and if it is not, the page
// loads and the game is simply unplayable, which is a much worse failure than
// a page that does not load at all.

const ORANGEPI = path.join(__dirname, '..', '..', 'compose', 'orangepi');
const CADDYFILE = path.join(ORANGEPI, 'caddy', 'Caddyfile');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

test('caddy proxies both backend surfaces to one upstream', () => {
  const text = read(CADDYFILE);
  assert.match(text, /reverse_proxy \/api\/\* backend:3101/);
  // The authority websocket is attached to the SAME http server as the REST
  // API (backend/src/authority/server.js), so it is the same upstream.
  assert.match(text, /reverse_proxy \/authority\* backend:3101/);
});

test('caddy serves the SPA with a history fallback', () => {
  const text = read(CADDYFILE);
  assert.match(text, /root \* \/srv/);
  // react-router owns client-side routes; without this, a hard reload on any
  // route other than / returns 404.
  assert.match(text, /try_files \{path\} \/index\.html/);
  assert.match(text, /file_server/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `backend/`:

```bash
node --test tests/orangepi_compose.test.js
```

Expected: FAIL — `ENOENT` for `Caddyfile`.

- [ ] **Step 3: Write the Caddyfile**

Create `compose/orangepi/caddy/Caddyfile`:

```
# Plain HTTP on :80. TLS is deliberately absent: cloudflared dials OUT to
# Cloudflare, which presents the certificate at the edge, so this origin needs
# no certificate, no ACME client and no renewal timer.
:80 {
	encode gzip

	# Both backend surfaces are one upstream. The authority websocket is
	# attached to the same http server as the REST API
	# (backend/src/authority/server.js), and the client derives its url from
	# the API url (Game.js:379), so they can never be on different hosts.
	#
	# Caddy v2 forwards websocket upgrades natively -- no Upgrade/Connection
	# header dance is needed here, unlike nginx.
	reverse_proxy /api/* backend:3101
	reverse_proxy /authority* backend:3101

	# Everything else is the built bundle. try_files sends unknown paths to
	# index.html so a hard reload on a react-router route still works.
	root * /srv
	try_files {path} /index.html
	file_server
}
```

Note: Caddyfiles are tab-indented by convention and `caddy fmt` will rewrite spaces. Use tabs.

- [ ] **Step 4: Run the test to verify it passes**

Run from `backend/`:

```bash
node --test tests/orangepi_compose.test.js
```

Expected: PASS — 2 tests.

- [ ] **Step 5: Validate the syntax with Caddy itself**

Run from the repository root:

```bash
docker run --rm -v "$PWD/compose/orangepi/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile
```

Expected: `Valid configuration`. A text assertion proves the directives are present; only Caddy proves they parse.

- [ ] **Step 6: Commit**

```bash
git add compose/orangepi/caddy/Caddyfile backend/tests/orangepi_compose.test.js
git commit -m "feat(orangepi): caddy single-origin routing for the static bundle and backend (SOMET-423)"
```

---

### Task 4: The production composition

**Files:**
- Create: `compose/orangepi/docker-compose.yml`
- Modify: `backend/tests/orangepi_compose.test.js`

**Interfaces:**
- Consumes: `backend.Dockerfile` (Task 1), `frontend.Dockerfile` (Task 2), `Caddyfile` (Task 3).
- Produces: a composition runnable as
  `docker compose --project-directory . --env-file .env -f compose/orangepi/docker-compose.yml <cmd>`.
  Task 5 verifies it; SOMET-428's `pi-*` targets will wrap it.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/orangepi_compose.test.js`:

```javascript
const COMPOSE = path.join(ORANGEPI, 'docker-compose.yml');

test('production composition excludes the development-only services', () => {
  const text = read(COMPOSE);
  // Redis has no reference anywhere in backend/src -- it belonged to the
  // frozen Go engine. sprite-gen is a multi-GB CPU Stable Diffusion image
  // that no small board will run.
  for (const service of ['redis:', 'game-engine:', 'sprite-gen:']) {
    assert.ok(
      !text.includes(`\n  ${service}`),
      `${service} must not be in the production composition`
    );
  }
});

test('production composition bind-mounts no application source', () => {
  const text = read(COMPOSE);
  // The container IS the service here. A source bind mount would silently
  // reintroduce the development stack's behaviour.
  for (const mount of ['./backend:/app', './frontend:/app', './engine:/app']) {
    assert.ok(!text.includes(mount), `source bind mount ${mount} defeats the production image`);
  }
});

test('postgres data lives outside the app directory', () => {
  const text = read(COMPOSE);
  // Provisioning empties the app dir; data under it would be destroyed on
  // every re-provision, and would present as corruption rather than as
  // operator error.
  assert.match(text, /\$\{ORANGEPI_DATA_DIR[^}]*\}\/pgdata:\/var\/lib\/postgresql\/data/);
});

test('the tunnel never opens as a side effect of starting the stack', () => {
  const text = read(COMPOSE);
  // Same rule the development stack applies to ngrok: `up` must never
  // publish the game to the internet without being asked.
  const idx = text.indexOf('\n  cloudflared:');
  assert.ok(idx !== -1, 'cloudflared service must exist');
  // Slice past the leading newline, then cut at the next 2-space-indented
  // service so the assertion runs against this block and no other.
  const rest = text.slice(idx + 1);
  const end = rest.search(/\n {2}\S/);
  const block = end === -1 ? rest : rest.slice(0, end);
  assert.match(block, /profiles: \["tunnel"\]/);
});

test('exactly one backend instance is configured', () => {
  const text = read(COMPOSE);
  // The authority holds an in-memory tick loop per live world; two instances
  // would disagree about the same world.
  assert.ok(!/replicas:/.test(text), 'no replica count may be set');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `backend/`:

```bash
node --test tests/orangepi_compose.test.js
```

Expected: FAIL — `ENOENT` for `docker-compose.yml`. The two Task 3 tests still pass.

- [ ] **Step 3: Write the composition**

Create `compose/orangepi/docker-compose.yml`:

```yaml
# Production stack for the Orange Pi (SOMET-423). Sibling to
# compose/develop/docker-compose.yml, which stays the development stack and is
# not affected by anything here.
#
# Run it the same way as the development stack, from the repository root:
#   docker compose --project-directory . --env-file .env \
#     -f compose/orangepi/docker-compose.yml up -d
#
# A distinct project name so it can never collide with the development stack's
# containers or volumes on the same machine.
name: something2-orangepi

services:
  # Named for what it runs; built from frontend.Dockerfile, which bakes the
  # vite bundle into a caddy image. This is the only service the tunnel talks
  # to -- it serves the bundle and proxies both backend surfaces, so one origin
  # covers the whole game.
  caddy:
    build:
      context: .
      dockerfile: compose/orangepi/frontend.Dockerfile
      args:
        # The public origin players reach. Baked into the bundle at build
        # time, so changing it REQUIRES a rebuild, not just a restart.
        VITE_API_URL: ${PUBLIC_URL:?PUBLIC_URL must be set -- the public origin, e.g. https://example.trycloudflare.com}
    ports:
      # Loopback only. The public path is the tunnel; publishing on 0.0.0.0
      # would expose the game to the LAN as a side effect.
      - "127.0.0.1:8080:80"
    depends_on:
      - backend
    restart: unless-stopped

  backend:
    build:
      context: .
      dockerfile: compose/orangepi/backend.Dockerfile
    environment:
      - PORT=3101
      - DATABASE_URL=postgres://user:${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set in .env}@db:5432/game_db
      - JWT_SECRET=${JWT_SECRET:?JWT_SECRET must be set in .env}
      # Object storage is not configured yet (SOMET-379). The MinIO client in
      # backend/src/services/assetStore.js is built lazily inside getClient()
      # and nothing calls it at startup, so the backend boots fine without it;
      # sprite requests fail individually and render as placeholder boxes.
      - MINIO_ENDPOINT=${MINIO_ENDPOINT:-minio:9000}
      - MINIO_ACCESS_KEY=${MINIO_ACCESS_KEY:-minioadmin}
      - MINIO_SECRET_KEY=${MINIO_ROOT_PASSWORD:-minioadmin}
      - MINIO_BUCKET=${MINIO_BUCKET:-sprites}
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped
    healthcheck:
      # /api/health (backend/src/index.js:367) is LIVENESS ONLY -- it returns
      # ok without touching the database. Making it a readiness check is
      # SOMET-376.
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3101/api/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s

  db:
    image: postgres:15-alpine
    environment:
      - POSTGRES_USER=user
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set in .env}
      - POSTGRES_DB=game_db
    volumes:
      # OUTSIDE the app directory, always. Provisioning empties the app dir,
      # and data underneath it would be destroyed on every re-provision.
      - ${ORANGEPI_DATA_DIR:-./.orangepi-data}/pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U user -d game_db"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  # Behind a profile deliberately, exactly as the development stack does with
  # ngrok: starting the stack must NEVER open a public URL as a side effect.
  # Wiring and verifying the tunnel is SOMET-431.
  cloudflared:
    image: cloudflare/cloudflared:latest
    profiles: ["tunnel"]
    command: tunnel --no-autoupdate --url http://caddy:80
    depends_on:
      - caddy
    restart: unless-stopped
```

- [ ] **Step 3b: Keep the fallback data directory out of git**

`ORANGEPI_DATA_DIR` defaults to `./.orangepi-data` when unset. Docker creates
missing bind-mount sources **as root**, so an unset variable would leave a
root-owned Postgres cluster inside the checkout — the same mess Docker already
left behind in `compose/` once. Add to `.gitignore`:

```
.orangepi-data/
```

- [ ] **Step 4: Run the test to verify it passes**

Run from `backend/`:

```bash
node --test tests/orangepi_compose.test.js
```

Expected: PASS — 7 tests.

- [ ] **Step 5: Verify the composition parses**

Run from the repository root. `PUBLIC_URL` is required, which is the point:

```bash
docker compose --project-directory . --env-file .env -f compose/orangepi/docker-compose.yml config >/dev/null \
  && echo "UNEXPECTED: should have demanded PUBLIC_URL" || echo "correctly refused without PUBLIC_URL"

PUBLIC_URL=https://example.trycloudflare.com docker compose --project-directory . --env-file .env \
  -f compose/orangepi/docker-compose.yml config >/dev/null && echo "CONFIG OK"
```

Expected: `correctly refused without PUBLIC_URL`, then `CONFIG OK`.

- [ ] **Step 6: Confirm the development stack is untouched**

```bash
docker compose --project-directory . --env-file .env -f compose/develop/docker-compose.yml config >/dev/null && echo "DEVELOP STILL OK"
```

Expected: `DEVELOP STILL OK`.

- [ ] **Step 7: Commit**

```bash
git add compose/orangepi/docker-compose.yml backend/tests/orangepi_compose.test.js .gitignore
git commit -m "feat(orangepi): production composition of caddy, backend, db and cloudflared (SOMET-423)"
```

---

### Task 5: End-to-end verification on the workstation

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: a documented, repeatable local run of the production stack. No Orange Pi is involved.

This task exists because the previous four assert on *text*. A green test suite has repeatedly failed to catch defects in this project that a real session exposes immediately. Nothing here is proven until the game is played through the production images.

- [ ] **Step 1: Build and start the stack**

Run from the repository root. Use a data directory under `/tmp` so the workstation run cannot touch anything that matters:

```bash
export PUBLIC_URL=http://localhost:8080
export ORANGEPI_DATA_DIR=/tmp/s2-orangepi-verify
mkdir -p "$ORANGEPI_DATA_DIR"

docker compose --project-directory . --env-file .env -f compose/orangepi/docker-compose.yml build
docker compose --project-directory . --env-file .env -f compose/orangepi/docker-compose.yml up -d
```

Expected: three containers start (`caddy`, `backend`, `db`); `cloudflared` does **not**, because it is behind the `tunnel` profile.

- [ ] **Step 2: Confirm only the expected services are running**

```bash
docker compose --project-directory . --env-file .env -f compose/orangepi/docker-compose.yml ps
```

Expected: exactly `caddy`, `backend`, `db`. If `cloudflared` is running, the profile is wrong and a public URL may have opened — stop the stack and fix it before continuing.

- [ ] **Step 3: Run the migrations**

```bash
docker compose --project-directory . --env-file .env -f compose/orangepi/docker-compose.yml \
  exec -T backend npm run migrate:up
```

Expected: all 106 migrations apply against the empty database. This is the first time they have run start-to-finish on a fresh database. If it fails on ordering, the repair path is `backend/scripts/repair-migration-order.js` — **do not pass `--no-check-order`.**

- [ ] **Step 4: Seed a playable world**

```bash
docker compose --project-directory . --env-file .env -f compose/orangepi/docker-compose.yml \
  exec -T backend node scripts/seed-catalogs.js
docker compose --project-directory . --env-file .env -f compose/orangepi/docker-compose.yml \
  exec -T backend sh -c "SPEC=vale-region node scripts/seed-map.js"
```

Expected: both complete. Run `make list-specs` if `vale-region` is not present, and use a spec that is.

- [ ] **Step 5: Verify routing through Caddy, not the backend directly**

```bash
curl -s -o /dev/null -w 'root      %{http_code}\n' http://localhost:8080/
curl -s -o /dev/null -w 'api       %{http_code}\n' http://localhost:8080/api/health
curl -s -o /dev/null -w 'spa route %{http_code}\n' http://localhost:8080/some/client/route
```

Expected: `200`, `200`, `200`. The third proves the `try_files` history fallback — a `404` there means a hard reload on any client route breaks.

- [ ] **Step 6: Confirm the bundle points at the right origin**

```bash
docker compose --project-directory . --env-file .env -f compose/orangepi/docker-compose.yml \
  exec -T caddy sh -c "grep -rlo 'localhost:13101' /srv | head" \
  && echo "BAD: bundle still references the dev backend" \
  || echo "good: no dev backend url in the bundle"
```

Expected: `good: no dev backend url in the bundle`.

- [ ] **Step 7: Play it in a browser**

Open `http://localhost:8080`, then: register a new account, log in, create a character, enter the world, and move with the movement keys.

Expected: movement works, which means the `/authority` websocket upgraded through Caddy. Sprites will render as **placeholder colour boxes** — object storage is not configured until SOMET-379, and that is expected here, not a defect.

If the page loads but the character cannot move, the websocket is not being proxied — check the `/authority*` line in the Caddyfile before anything else.

- [ ] **Step 8: Tear down and confirm data survived separately**

```bash
docker compose --project-directory . --env-file .env -f compose/orangepi/docker-compose.yml down
ls "$ORANGEPI_DATA_DIR/pgdata" | head -3
```

Expected: the stack stops and `pgdata` still holds the cluster — proving Postgres wrote outside the app directory, which is the rule the Pi's provisioning depends on.

- [ ] **Step 9: Document the run**

Add to `README.md`, after the existing development-stack section:

```markdown
## Production stack (local verification)

`compose/orangepi/` is the production-shaped stack: built images, no bind
mounts, no dev server. It is what the Orange Pi runs, and it can be exercised
on a workstation without any hardware.

    export PUBLIC_URL=http://localhost:8080
    export ORANGEPI_DATA_DIR=/tmp/s2-orangepi-verify
    docker compose --project-directory . --env-file .env \
      -f compose/orangepi/docker-compose.yml up -d --build

Then run the migrations and seed a map with `exec -T backend`, as in the
development stack, and open http://localhost:8080.

Two things to know. `PUBLIC_URL` is baked into the frontend bundle at build
time, so changing it needs `--build`, not just a restart. And `cloudflared`
sits behind the `tunnel` profile, so starting the stack never opens a public
URL by accident — see the Orange Pi design doc for the tunnel itself.
```

- [ ] **Step 10: Commit**

```bash
git add README.md
git commit -m "docs: how to run and verify the production stack locally (SOMET-423)"
```

---

## Notes for whoever executes this

- **Do not touch `compose/develop/`.** Several sessions share this checkout, and breaking the development stack blocks everyone.
- **Do not run the full backend suite as a progress check.** `npm test` from `backend/` reaches a database, and with `TEST_DATABASE_URL` unset it targets the shared development database. The two test files in this plan read files only — run them by name.
- **The `/api/health` endpoint already exists** and is liveness-only. Do not "fix" it here; that is SOMET-376.
- **Placeholder sprites are expected** until SOMET-379 configures object storage. Do not chase them.
