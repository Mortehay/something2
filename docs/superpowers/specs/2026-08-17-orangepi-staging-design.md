# Orange Pi staging over a Cloudflare Tunnel — design

Date: 2026-08-17
Status: approved, ready for planning
Plane: project `SOMET`, module `Hosting P · Orange Pi staging over Cloudflare Tunnel`
Supersedes parts of: [2026-08-17-free-hosting-design.md](2026-08-17-free-hosting-design.md)

## Goal

Stand the game up on an Orange Pi Zero 3, reachable from the internet through a
Cloudflare Tunnel, operated entirely from a workstation over SSH, and kept
current as `main` advances.

The box is small and the audience is up to ten players, but it is **treated as a
production server**, not a second development machine. Nothing bind-mounts
source, nothing runs a dev server, and `make dev` has no equivalent here.

## Decisions already taken

Settled before the design; not open questions.

- **The production path is built inside this module.** The repository has none,
  so this module delivers it rather than waiting on Module S.
- **Cloudflare in two phases.** Phase 1 uses an ephemeral `trycloudflare`
  hostname so the whole path can be proven without buying anything. Phase 2
  swaps in a named tunnel on a real domain. The hostname is configuration in
  both phases.
- **Images normally come from CI, with an on-Pi fallback.** GitHub Actions
  builds `linux/arm64` and pushes to GHCR **on pushes to the deployment
  branch**; the Pi pulls. When no image exists for a commit, the Pi builds it
  locally.
- **Key-based access, one key.** A workstation key gives password-free SSH to
  the board. The repository is public, so the board needs no git credential at
  all — no deploy key, no token.

## What the repository lacks today

`compose/develop/backend.Dockerfile`, `frontend.Dockerfile` and
`engine.Dockerfile` all end in `CMD ["tail","-f","/dev/null"]`. The containers
idle with the host checkout bind-mounted and `make dev` execs in to start
`nodemon` and the vite dev server. There is no production bundle, no image that
runs `node src/index.js`, and no composition without the development scaffolding.

That gap is the first half of this module. The second half is getting the result
onto a machine that is not this one.

Three properties of the application shape everything downstream:

- **`VITE_API_URL` is a build-time value.** It is read in more than twenty
  modules, each falling back to `http://localhost:13101`. A bundle built without
  it points every player at their own machine, and fails silently rather than
  loudly.
- **The authority websocket shares the backend's HTTP server.** One origin and
  one port cover REST and websocket alike, and
  `Game.js:379` derives the socket as `API_URL.replace(/^http/, 'ws')` — so an
  `https://` origin yields `wss://` with no code change.
- **The authority is stateful and single-instance.** It holds an in-memory tick
  loop per live world. Exactly one backend container may run, and deploys are a
  stop-then-start, never an overlap.

## Module boundaries

This module is inserted **before** `Hosting E`, which is left as pure hardware
hardening. Two items move out of E, because they are delivery concerns rather
than hardware ones:

| Stays in E | Moves to P |
|---|---|
| PGDATA off the microSD; write reduction; power-loss backup; thermals and bring-up | arm64 images; on-device delivery |

Three Module S items are delivered here rather than separately: the production
frontend build, the production backend image, and the trimmed production
composition. Module S retains the object store, seeding, hardening, reset
command and smoke test, all of which stay target-agnostic.

## Repository layout

```
compose/
  develop/                  existing development stack, untouched
  orangepi/
    docker-compose.yml      production stack
    backend.Dockerfile      npm ci --omit=dev, CMD node src/index.js, non-root
    frontend.Dockerfile     build stage running vite build, static output
    caddy/Caddyfile         single-origin routing
    cloudflared/config.yml  tunnel ingress
    scripts/
      lib.sh                ssh transport, step logging, failure capture
      provision.sh          one-time bootstrap
      deploy.sh             pull-or-build, migrate, restart
      remote.sh             run one compose command on the Pi
    secrets/                gitignored; holds the generated workstation key
```

`compose/orangepi/secrets/` is added to `.gitignore` in the same change that
creates it. The directory holds a generated key, never a committed one.

## The data-safety rule

Provisioning empties `/app`. That is only safe because game data is forbidden
from living there.

- **`ORANGEPI_APP_DIR`** (default `/app`) holds the clone and nothing else. It
  is disposable, and `pi-provision` wipes it without ceremony.
- **`ORANGEPI_DATA_DIR`** (default `/srv/something2`) holds the Postgres volume
  and sprite storage. Provisioning never touches it.
- **`provision.sh` refuses to run** when `DATA_DIR` resolves to a path inside
  `APP_DIR`, after resolving symlinks.

Without that guard, a second provisioning run silently destroys every account
and world on the box — a failure that looks like data corruption rather than
operator error. The same separation makes the eventual move of `PGDATA` to a USB
SSD (Module E) a one-variable change.

## Branch model

Two branches, and the deployment target is never developed on directly.

| Branch | Role |
|---|---|
| `main` | development; everything lands here first |
| `orangepi` | the deployment branch — what the board runs |

Promotion is a pull request from `main` into `orangepi`. That PR is the gate:
nothing reaches a publicly-reachable machine without a human merging it.
`orangepi` only ever *receives* merges; committing to it directly makes it
diverge from `main` and every later promotion conflicts. A branch protection
rule on GitHub is the cheap way to enforce that.

**A consequence that shapes CI.** A GitHub pull request always produces a new
commit SHA — merge-commit, squash and rebase all do, and the PR interface
offers no fast-forward. So a SHA built from `main` will never match the SHA
deployed on `orangepi`, and image builds keyed by commit must therefore
**trigger on `orangepi`**, not on `main`. Building on `main` would leave every
deploy with no matching image and silently fall back to a slow on-board build.

## One key, not two

Access needs a single keypair: a **workstation key**, generated on the
workstation, whose public half lands in the Pi's `authorized_keys` so `make
pi-*` runs without a password.

**The repository is public**, which was confirmed by an anonymous HTTPS clone.
The board therefore needs no deploy key, no token and no git credential of any
kind — it clones read-only over HTTPS. An earlier draft of this design
specified a Pi-generated GitHub deploy key with an HTTPS-plus-token fallback;
both are deleted, and `pi-keygen` keeps only its workstation-key half.

The flip side is worth stating plainly: because the repository is public,
**anything committed to it is world-readable**, which is why the `.env.example`
placeholder secret is rejected by name rather than merely being long.

## Configuration

Added to `.env` and documented in `.env.example` with fake values:

```
ORANGEPI_ADDRESS      host or IP of the board
ORANGEPI_LOGIN        sudo-capable user
ORANGEPI_PASSWORD     used for privileged setup steps
ORANGEPI_SSH_KEY      workstation key path; generated by pi-keygen
ORANGEPI_APP_DIR      default /app
ORANGEPI_DATA_DIR     default /srv/something2
ORANGEPI_BRANCH       the deployment branch; default orangepi
GIT_REPOSITORY        public https clone url
DEPLOY_HOOK_SECRET    HMAC shared secret for the CI-to-Pi deploy call
```

`ORANGEPI_BRANCH` replaces the earlier `GIT_BRANCH`, both to sit with the other
board settings and because it names a deployment target rather than a
development default. `GIT_SSH_URL`, `GIT_USERNAME` and `GIT_TOKEN` are gone with
the deploy key.

**The board's own `.env` lives in `ORANGEPI_DATA_DIR`, not in `ORANGEPI_APP_DIR`.**
This follows directly from the data-safety rule: provisioning empties the app
directory, so an `.env` kept there would be destroyed on every re-provision —
and a regenerated `POSTGRES_PASSWORD` locks the operator out of the existing
database, which presents as a corrupt cluster rather than as a lost file. Its
secrets are generated on the board and never travel from the workstation.

## The four scripts

**`lib.sh`** — shared transport and reporting. One `ssh` invocation style, one
step wrapper emitting `▶ step … ok (2.3s)` or `✗ step … FAILED`, and capture of
remote stderr for any failed step.

**`keygen.sh`** — run first, before provisioning. Idempotent, and it **never
regenerates an existing key**: doing so silently would lock the operator out of
the board.

1. Create the workstation key at `ORANGEPI_SSH_KEY` if absent; skip if present.
2. Install its public half into the Pi's `authorized_keys`, then verify a
   password-free login actually works before reporting success.

That is the whole script. An earlier draft also generated a GitHub deploy key
on the board and asked the operator to paste it into the repository settings;
the repository being public deleted that half entirely.

**`provision.sh`** — idempotent bootstrap, safe to re-run:

1. Verify reachability and that `DATA_DIR` is not inside `APP_DIR`.
2. **Verify the repository is reachable** over anonymous HTTPS. If not, stop
   immediately and say so rather than failing partway through a clone.
3. Configure scoped `NOPASSWD` sudo if not already configured.
4. Install Docker if absent, update it if present; enable the service at boot.
5. Create `DATA_DIR` if missing. Never wipe it.
6. Wipe and recreate `APP_DIR`; clone `GIT_REPOSITORY` at `ORANGEPI_BRANCH`
   over anonymous HTTPS. No credential is involved, so none can leak into the
   board's git config.
7. Pull or build images, run migrations, start the stack.
8. Print the summary and the public URL.

**`deploy.sh`** — the update path: force-fetch and reset to the branch tip, pull
the SHA-tagged image or build locally when none exists, run migrations as their
own step, restart. A failed migration aborts and leaves the previous version
running.

**`remote.sh`** — a thin wrapper running one compose command against the Pi, so
every `pi-*` make target stays a single line.

## Make targets

| Target | Purpose |
|---|---|
| `pi-keygen` | Generate the workstation key if absent and install it on the board; verify password-free login |
| `pi-provision` | Full bootstrap from a bare board to a running, reachable stack |
| `pi-deploy` | Force-pull the branch, rebuild or pull, migrate, restart |
| `pi-up` `pi-down` `pi-restart` `pi-logs` | Remote lifecycle |
| `pi-status` | Container states, health endpoint, disk, memory, tunnel URL |
| `pi-migrate-up` `pi-migrate-status` | Remote migrations |
| `pi-seed-catalogs` `pi-seed-map SPEC=` `pi-reseed-map SPEC=` | Remote seeding |
| `pi-reset` | Wipe, re-migrate, re-seed; requires `CONFIRM=<address>` |
| `pi-shell` `pi-db-shell` | Interactive access |
| `pi-tunnel-url` | Print the current public URL |

The seeding targets reuse the existing `require-spec` guard, so a missing or
misspelled `SPEC` is rejected before anything reaches the network.

`pi-reset` requires `CONFIRM` to equal the configured address. A reset aimed at
the wrong database is the most destructive command in this project; a reviewer
has previously wiped the shared development catalog with an unguarded delete.

## Reporting

Every target prints the steps it performed, their status and their duration,
then a closing summary, and exits non-zero if any step failed. Failed steps
print the captured remote stderr rather than only an exit code — the difference
between knowing something broke and being able to fix it.

## The stack on the Pi

Four containers:

| Service | Role |
|---|---|
| `caddy` | Serves the static bundle; proxies `/api` and `/authority` to the backend. Plain HTTP, no certificates. |
| `backend` | Production image, single instance, `PORT` honoured. |
| `db` | Postgres, data under `ORANGEPI_DATA_DIR`. |
| `cloudflared` | Outbound tunnel to Cloudflare. |

Absent by design: `redis` and `game-engine` (Redis has no references anywhere in
`backend/src`; both belong to the frozen Go engine), `sprite-gen` (multi-gigabyte
image running CPU Stable Diffusion — sprites are generated on a workstation and
published), and any vite dev server.

`caddy` exists because a static bundle has no vite proxy. Today a single tunnel
suffices only because the dev server proxies `/api` and `/authority` through to
the backend; in production that routing has to come from somewhere, and one
reverse proxy on one origin is the smallest thing that provides it.

## Cloudflare, TLS and the domain

**TLS stops being a problem.** The edge presents Cloudflare's certificate for the
zone and `cloudflared` dials outbound to Cloudflare over TLS. The Pi therefore
needs no certificate, no ACME client, no renewal timer, no open ports 80 or 443,
and no router port-forwarding — and it works behind CGNAT. This removes the
Caddy-plus-certbot arrangement that the Oracle and VPS targets in the hosting
design assume.

**A domain is required for a stable hostname.** A named tunnel binds to a
hostname on a zone controlled in Cloudflare, which means owning a domain and
delegating its nameservers. Cloudflare's plan is free; the domain is not, at
roughly ten dollars a year.

Phase 1 therefore uses a `trycloudflare` quick tunnel: no account, no domain, a
working public URL in minutes. Its URL is random and changes on every restart,
and it is explicitly unsuitable as a destination — which is why `pi-tunnel-url`
exists and why the frontend's `VITE_API_URL` is read from configuration at build
time rather than baked into a file. Phase 2 replaces it with a named tunnel and
a stable hostname; nothing else in the stack changes.

## Continuous delivery

A push to **`orangepi`** — that is, a merged promotion PR — runs tests, builds
`linux/arm64`, pushes a SHA-tagged image to GHCR, and then calls a deploy hook
on the Pi through the tunnel with an HMAC signature. A small listener verifies
the signature and runs `deploy.sh`.

The trigger is the deployment branch and not `main` because a pull request
always creates a new commit SHA (see the branch model above), so an image built
from `main` would never match the SHA actually deployed.

**The trigger comes from the Actions workflow after the build, not from a raw
GitHub push webhook.** A push webhook fires before any image exists, so the Pi
would try to deploy a commit that has not been built. When no image is found for
a commit — a fallback build, a manual dispatch — `deploy.sh` builds on the Pi
instead.

Building on the board is the fallback rather than the default because `vite
build` and `npm ci` on four Cortex-A53 cores take on the order of ten to twenty
minutes and compete with the running game for memory and CPU. Pulling a
prebuilt image takes under a minute.

Deploys are not zero-downtime. A restart of roughly thirty seconds is the right
trade at this player count, and the single-instance authority makes blue-green
substantially harder than it is worth.

## Acceptance

The module is done when:

- `make pi-keygen` produces the workstation key, installs it, and proves a
  password-free login — and a second run regenerates nothing.
- `make pi-provision` takes a bare board to a running, publicly reachable stack
  and reports every step it performed.
- The smoke test passes against the public URL from an external network:
  register, log in, join the entry world, move, load a real sprite, and hold two
  simultaneous players.
- A commit pushed to `main` reaches that URL with no manual step.
- `make pi-status` accurately reports a stack that is up, and a stack that is
  down.
- Re-running `make pi-provision` does not destroy existing accounts or worlds.

## Accepted deviation: Postgres on the microSD

The design calls for `PGDATA` to live off the microSD, and that remains the
right target. The board as delivered has **no USB SSD attached**, so the first
deployment runs Postgres on the card, deliberately and with mitigations:

- Docker `json-file` log caps applied **before** any container ran — uncapped
  container logs are the second-largest source of writes after the database.
- Armbian already mounts `/var/log` on zram and uses zram for swap, so two of
  the write-reduction measures were in place before we arrived.
- Card lifetime writes are measured before and after each significant
  operation, so the decision rests on numbers rather than on unease.
- Off-device backups are what actually protects the data, and they are not
  optional here.

This is acceptable because the world is re-seedable and the box is staging by
intent. `ORANGEPI_DATA_DIR` is a single variable, so attaching an SSD later is
a stop, copy, repoint, start — not a migration.

## Risks

- **Cloudflare tunnel terms and the `trycloudflare` service** are stated here
  from knowledge with a May 2026 cutoff. The tunnel fundamentals are stable, but
  the ephemeral quick-tunnel service is a convenience Cloudflare provides
  without guarantees; phase 1 should not be depended on beyond proving the path.
- **The board is not yet confirmed reachable**, and whether Postgres starts on
  the microSD or an SSD is open. Starting on the microSD is acceptable for
  bring-up but is the failure the E module exists to prevent; if the SSD is
  available at the outset, pull that item forward.
- **A single-instance authority plus a stop-start deploy** means every player is
  disconnected on each deploy, and the client does not currently reconnect —
  `Game.js:244` logs that the connection was lost and waits for a reload.
- **The deploy hook is an internet-reachable endpoint.** HMAC verification is
  not optional, and a failure to verify must reject rather than log-and-continue.
