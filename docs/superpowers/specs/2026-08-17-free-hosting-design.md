# Free hosting for something2 — design

Date: 2026-08-17
Status: approved, ready for planning
Plane: project `SOMET`, modules `Hosting: S / CI / A / E / B / C / D`

## Goal

Put the game on a public URL that up to ten people can play, at as close to zero
recurring cost as the constraints allow, and keep that URL current as `main`
advances.

Ten concurrent players is a small number. Nothing in this design is shaped by
throughput; it is shaped by the fact that the repo has never been built for
production, and by the failure modes of free and near-free infrastructure.

## Decisions already taken

These were settled before the design and are not open questions:

- **Sprite generation stays local.** `sprite-gen` (CPU Stable Diffusion, ~66s per
  tile, multi-GB image plus a model cache volume) is not deployed. Sprites are
  generated on a workstation and published to the hosted object store by a
  script.
- **The hosted world starts fresh and stays resettable.** No dump of the dev
  database is carried up. The hosted database runs the migrations, seeds
  catalogs and map specs, and can be wiped back to that state with one command.
- **Four hosting targets are planned in parallel, plus a fifth variant.** One is
  chosen later; the others are archived unbuilt. The shared work is factored out
  so that choice costs nothing extra now and little later.

## What the repository needs regardless of host

Four findings from reading the current stack. They are the reason Module S
exists and the reason it is larger than any single hosting module.

### There is no production path at all

`compose/backend.Dockerfile`, `compose/frontend.Dockerfile` and
`compose/engine.Dockerfile` all end in `CMD ["tail","-f","/dev/null"]`. The
containers idle with the host checkout bind-mounted, and `make dev` execs into
them to start `nodemon` and the vite **dev server**. Nothing in the repo builds
a production bundle or runs the backend as a service.

Consequences that every hosting module inherits:

- The frontend needs a real `vite build`, with `VITE_API_URL` supplied at
  **build** time. It is read in more than twenty modules via
  `import.meta.env.VITE_API_URL`, each falling back to `http://localhost:13101`.
  A wrong or missing value at build time produces a bundle that silently talks
  to the player's own machine.
- The production frontend has **no vite proxy**. `frontend/vite.config.js`
  proxies `/api` and `/authority` to `backend:3101`, which is what makes a
  single ngrok tunnel sufficient today. A static bundle has no such proxy, so
  the deployment must supply the equivalent — either a reverse proxy putting
  both on one origin, or an absolute cross-origin `VITE_API_URL` with CORS
  configured to match.
- The backend needs an image that installs production dependencies and actually
  runs `node src/index.js`. It already honours `PORT` (`backend/src/index.js:28`,
  default 3101), so it is PaaS-compatible once the `CMD` is real.

### The object store swap is one file

Sprites are **streamed through the backend**, not served by presigned URL:
`backend/src/index.js:2404` calls `assetStore.getObjectStream(key)`, and
`backend/src/services/assetStore.js` is the only file in `backend/src` that
touches MinIO. The `minio` SDK speaks S3, so pointing it at Cloudflare R2,
Supabase Storage, Backblaze B2 or a self-hosted MinIO is an endpoint,
credential and bucket change in one module.

This also means the object store is never contacted by the browser directly, so
it needs no CORS configuration and no public bucket policy. It only has to be
reachable from the backend.

### TLS needs no code change, but CORS does

`frontend/src/games/something2/src/js/core/Game.js:379` derives the authority
socket as `API_URL.replace(/^http/, 'ws') + '/authority'`. An `https://` API URL
therefore yields `wss://` with no further work, and the websocket is attached to
the same HTTP server as the REST API (`backend/src/authority/server.js`), so one
origin and one port covers everything the game needs.

CORS is the opposite: `backend/src/index.js:49` is
`app.use(cors({ exposedHeaders: ['X-Live-World-Pending'] }))`, which permits
**every** origin. That is correct for a workstation and wrong for a public
deployment; it must become an allowlist driven by configuration.

### Redis, the Go engine and sprite-gen all drop out

`grep -rn redis backend/src` returns only two unrelated English words in
comments. Redis was consumed exclusively by the frozen Go engine, which
`AGENTS.md` and the `go-dev` skill both record as superseded by the Node
authority. Neither is deployed. With `sprite-gen` also excluded, the hosted
stack is **three processes**: backend, static frontend, Postgres — plus an
object store and whatever terminates TLS.

That reduction is what makes single-board hosting viable at all.

### One property that constrains every target

The backend authority is **stateful**: it holds an in-memory tick loop per live
world. Exactly one instance may run. No horizontal scaling, no rolling deploy
with two instances briefly overlapping, and any platform that silently runs two
replicas is disqualified.

## Module S — production readiness

Provider-agnostic. Every hosting module depends on all of it. Nothing here
picks a vendor.

1. **Production frontend build.** `vite build` producing a static bundle, with
   `VITE_API_URL` injected at build time and asserted non-default in CI. Output
   is an artifact any of the targets can serve.
2. **Production backend image.** Real base image, `npm ci --omit=dev`, `CMD node
   src/index.js`, no bind mount, `PORT` honoured, non-root user.
3. **Health endpoint.** A cheap unauthenticated liveness route that checks the
   database handle. Required by nearly every platform in modules B, C and D and
   used by the post-deploy smoke test in all of them.
4. **Deploy-time migration run.** The 106 migrations in `backend/migrations`
   against an empty database, with order checking on. This repo has hit
   migration-ledger collisions twice (`1714440008000`, and again around
   `171000`/`172000`), so the task also documents the
   `backend/scripts/repair-migration-order.js` path and explicitly forbids
   `--no-check-order`.
5. **Deploy-time seed.** Catalogs and map specs, in the order the seeders
   require — the spine-descent map is seeded last, and `validateMapSpec`
   (`backend/seeds/mapSpec.js:137`) gates the map invariants, because a re-seed
   overrides anything a migration did to the entry world.
6. **Object store behind configuration.** `assetStore.js` takes endpoint,
   region, credentials, bucket and path-style from environment, defaulting to
   the existing MinIO values so local development is unchanged. Covered by tests
   through the existing `__setAssetClient` seam.
7. **Sprite publish script.** Copies a local MinIO bucket into the hosted
   bucket. Idempotent and re-runnable, because sprite generation stays local and
   this is how new sprites reach production forever after.
8. **Public-deployment hardening.** CORS allowlist from configuration; a
   deliberate decision on whether registration is open, invite-gated or closed;
   confirmation that `express-rate-limit` covers login and registration with
   sane values; production `JWT_SECRET` distinct from any committed default;
   `SEED_TEST_USER` provably off; admin routes verified to require admin.
9. **Hosted reset command.** One command that drops, re-migrates and re-seeds
   the hosted database back to the fresh-world state, refusing to run without an
   explicit confirmation flag naming the target.
10. **Trim the deployed composition.** A production compose file or equivalent
    containing backend, frontend and Postgres only. Redis, `game-engine` and
    `sprite-gen` are absent, and a test asserts the backend starts without them.
11. **Smoke test.** A script taking a base URL and performing: register, log in,
    join the entry world, move, confirm a sprite loads rather than a placeholder
    box, and connect a second player. This is the acceptance gate for every
    hosting module and the post-deploy check in Module CI.

## Module CI — continuous delivery from `main`

1. **Test workflow** on pull requests and `main`: frontend `vitest`, backend
   `node --test`. The backend job runs a Postgres service container and sets
   `TEST_DATABASE_URL` **explicitly** — unset, the database suites fall back to
   `DATABASE_URL`, and a bare `npm test` silently omits dozens of database test
   files. Map specs are seeded before the suite or roughly fifteen tests fail
   for reasons unrelated to the change.
2. **Image build and publish** to GHCR on green `main`, tagged by commit SHA:
   the backend production image and the frontend static bundle. Tagging by SHA
   is what makes rollback and the Orange Pi's pull-based deploy possible.
3. **Migration stage.** Migrations run as their own deploy step, before the new
   container starts, never as a side effect of application boot — the dev server
   has previously auto-applied half-written migrations from a bind mount, and a
   deploy must fail loudly instead. Order checking stays on.
4. **Deploy job**, gated on tests and build, with secrets in a GitHub
   environment and a `workflow_dispatch` entry point for manual re-runs.
5. **Rollback.** Redeploy a previous SHA tag. The task states plainly that
   migrations are **not** reverted by this and documents what to do when a bad
   migration is the problem.
6. **Post-deploy smoke test.** Module S's smoke test, run against the live URL
   after deploy; a failure fails the deploy.

Deploys are not zero-downtime. A restart of roughly thirty seconds is the right
trade for ten players, and the single-instance authority makes blue/green
substantially harder than it is worth.

## Module A — Cloudflare Tunnel from the development machine

Cost: nothing. No payment method. Least work of the five targets.

A named Cloudflare tunnel replaces the current ngrok arrangement, which suffers
from a single-agent-per-account limit, an assigned rather than chosen domain,
and a URL that does not survive restarts. The tunnel needs no inbound port, no
static IP and works behind CGNAT.

- Named tunnel plus credentials, run as a service alongside the stack.
- DNS and TLS through Cloudflare, on a domain that stays stable.
- Origin configuration putting the static frontend and the backend on one
  origin, replacing the vite dev-server proxy.
- Autostart and reboot survival.
- Delivery: a runner or watcher on the machine pulls the new image, migrates,
  and restarts.
- External verification, including the websocket, from a network that is not
  this one.

The obvious limit: the machine must be on, and its uptime is the game's uptime.

## Module E — Orange Pi Zero 3

A delta on Module A, not a copy: the tunnel, DNS, TLS and origin tasks are
reused unchanged. E covers only what the hardware forces.

Hardware: Allwinner H618, four Cortex-A53 cores, 4GB RAM, 64–128GB of flash.

Memory is not the constraint. The deployed stack budgets to well under a
gigabyte — Postgres around 150MB, the Node backend around 300MB, a reverse proxy
around 20MB, `cloudflared` around 30MB, MinIO around 200MB if it is kept
on-device. `sprite-gen` and the Go engine were the only components that would
have exhausted 4GB, and both are already excluded.

**Flash endurance and power loss are the constraints**, and both fail
destructively rather than gracefully.

1. **arm64 images.** GHCR builds become multi-architecture
   (`linux/amd64` + `linux/arm64`). This reaches back into Module CI and carries
   a decision: emulated cross-builds are slow for a Node image, native arm64
   runners cost money or setup, and building on the Pi itself is the option to
   avoid — `vite build` on a Cortex-A53 is punishing.
2. **Postgres off the microSD.** The highest-value task in the module. WAL and
   checkpoint traffic on a microSD card destroys it, and the result is a corrupt
   database rather than a slow one. If the board is microSD-only, which the Zero
   3 typically is, `PGDATA` moves to a USB SSD. USB 2.0 caps throughput around
   35MB/s, which is irrelevant at this player count and an enormous endurance
   gain.
3. **Write reduction.** Docker `json-file` log size and rotation caps —
   unbounded container logs are the second most common way these cards die —
   plus `noatime`, ZRAM in place of a swap file, and a decision on whether the
   sprite bucket lives on the SSD or in a cloud bucket.
4. **Power-loss survival.** A nightly `pg_dump` pushed **off** the device, a
   documented and *tested* restore, and an explicit recommendation on a UPS. On
   a VPS the backup is prudent; here it is load-bearing.
5. **On-device delivery.** A decision between a self-hosted Actions runner,
   which holds a persistent connection and competes for memory, and a
   lightweight watcher that polls GHCR for a new SHA then migrates and restarts.
   The watcher is the likely answer.
6. **Bring-up.** Heatsink and thermal check under sustained load — the H618
   throttles — plus headless boot, autostart and reboot survival.

If the Pi is the intended destination, Module A is best understood as a
rehearsal: it validates the whole tunnel and delivery path on a machine that is
comfortable to debug, before ARM and flash are added to the problem.

## Module B — all-cloud, no payment method

Cost: nothing, and no card anywhere. The most constrained option, and the one
whose terms are least stable.

Shape: static frontend on a free static host; backend container on a free
container host; managed Postgres on a free tier; object storage on a free tier
that does not demand a card.

- **First task is verification, before any other work in this module.** Free
  tiers in this category churn constantly — several providers that offered
  free always-on containers or free managed Postgres have withdrawn or
  time-limited them. The plan does not assert current terms; it requires them to
  be confirmed at signup and recorded.
- Managed Postgres provisioning, connection limits and idle-suspend behaviour.
- Object storage bucket and credentials, consumed through Module S's
  configuration.
- Backend deployment, with an explicit check that the platform will not run two
  replicas.
- Frontend deployment with build-time `VITE_API_URL`.
- **Cold start and sleep behaviour**, which is the real cost here: a scale-to-zero
  or idle-suspended backend drops live worlds and websocket connections. The
  task covers what a player sees on reconnect after a sleep, and whether that is
  acceptable.
- Delivery through provider-native git auto-deploy, with migrations as a
  pre-start release command.

## Module C — Oracle Cloud Always Free ARM instance

Cost: nothing, but a payment method is required at signup. Capability far beyond
what this game needs — an Ampere instance in the Always Free allowance offers on
the order of four cores and 24GB of RAM.

- **First task is verification** of the current Always Free allowance and its
  reclamation policy for idle instances, before any work is committed to it.
- Instance provisioning, including the capacity errors that are common in
  popular regions.
- arm64 images — shares the Module CI multi-architecture work with Module E.
- Production compose deployment, reverse proxy, TLS and domain.
- Volume and backup arrangement.
- Delivery: GitHub Actions over SSH — pull the SHA-tagged image, migrate,
  restart.

The headroom is real enough that `sprite-gen` could later run here, which none
of the other free targets can offer.

## Module D — small paid VPS

Cost: roughly four euros a month. Included because it is the honest baseline the
free options are measured against.

Same shape as Module C without the free-tier conditions: provision, install
Docker, deploy the production compose file, reverse proxy with TLS and a domain,
backups, and Actions-over-SSH delivery. No verification task, because nothing
about it is conditional.

## Comparison

| | Target | Cost | Card | Always on | Main risk |
|---|---|---|---|---|---|
| A | Cloudflare Tunnel, dev machine | none | no | while the machine is | machine uptime is the game's uptime |
| E | Orange Pi Zero 3 | hardware only | no | yes | flash wear, power loss |
| B | All-cloud, no card | none | no | no | cold starts, terms that expire |
| C | Oracle Always Free ARM | none | yes | yes | capacity, reclamation, ARM builds |
| D | Small paid VPS | ~€4/mo | yes | yes | none material |

**Recommendation: A first, E as the destination.** A reaches a stable public URL
with the least work and validates the tunnel, the production build and the
delivery loop on debuggable hardware. E then moves that same arrangement onto a
device that can stay on without occupying a workstation. C and D remain
available as config changes rather than rewrites, because Modules S and CI hold
everything that is not vendor-specific.

## Risks and unknowns

- **Free-tier terms are stated nowhere in this document as fact.** This design
  was written against knowledge with a May 2026 cutoff, and this category of
  offering changes faster than that. Modules B and C each open with a
  verification task for exactly this reason.
- **The single-instance authority** disqualifies any platform that may run two
  replicas. It must be checked per platform, not assumed.
- **A public deployment changes the threat model.** Open CORS, open
  registration and the committed development secrets are all acceptable on a
  workstation and none of them are acceptable on a public URL. Module S task 8
  is not optional polish.
- **Sprites are a manual pipeline by choice.** New sprites require a local
  generation run and a publish, forever. That is the accepted cost of not
  hosting `sprite-gen`.

## Acceptance

A hosting module is done when Module S's smoke test passes against its public
URL from an external network — register, log in, join the entry world, move,
load a real sprite, and hold two simultaneous players — and when a commit pushed
to `main` reaches that URL through Module CI with no manual step.
