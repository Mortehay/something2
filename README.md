# something2

Real-time 2D MMORPG. Node + Express backend with the authoritative game server
(WebSockets, 60Hz tick, collisions, mob AI) running in-process, Vite + React
client, Postgres + Redis + MinIO.

Everything runs in Docker. You do **not** need Node, Postgres or anything else
installed on the host — only Docker, `make` and `git`.

## Requirements

| | |
|---|---|
| Docker Engine + Compose v2 | `docker compose version` must work (v2 syntax, not `docker-compose`) |
| GNU make | the entrypoint for every command below |
| git | |

Host setup per OS is in [Ubuntu](#ubuntu) and [Windows](#windows) below.

## First run

```bash
git clone git@github.com:Mortehay/something2.git
cd something2
```

**1. Create `.env`.** It is gitignored, so a fresh clone has none, and compose
refuses to start without four of the values. Copy the template:

```bash
cp .env.example .env
```

[.env.example](.env.example) ships working local-dev defaults and explains every
variable. Only these four are required — the rest are optional and documented
where they matter:

```
POSTGRES_PASSWORD  JWT_SECRET  MINIO_ROOT_PASSWORD  SPRITE_GEN_SHARED_SECRET
```

Change them if you like; any values work locally **except `JWT_SECRET`**: the
backend refuses to boot with the shipped placeholder (it is deliberately
rejected, not just too short) — generate a real one with `openssl rand -hex 32`
and put it in `.env`. The ngrok keys are only needed for [Playing over the
internet](#playing-over-the-internet), and the stack starts fine with them
left as-is.

**2. Build and start the containers.**

```bash
make up
```

This starts the containers but **nothing is serving yet** — the images end in
`tail -f /dev/null` on purpose, so a dev server can be restarted without
bouncing the container.

**3. Start the dev servers.**

```bash
make dev          # installs deps, then starts backend + frontend
make dev-status   # confirms what is actually LISTENING
```

The backend applies any pending database migrations on start, so there is no
separate migrate step on a fresh database.

**4. Seed the catalogs and a map.** A fresh database has no tiles, creatures or
worlds, so the game has nothing to render:

```bash
make seed-catalogs             # tiles, biomes, creatures, decorations
make list-specs                # which maps you can seed
make seed-map SPEC=vale-region # seed one — see the note below
make admin-password            # print/set the admin login
```

Seed **one** spec per database. Only one world can be the entry world, and two
specs seeded together leave the second one's worlds unreachable. `vale-region`
is the friendlier start: you spawn inside a village. To switch later, use
`make reseed-map SPEC=<name>` — it clears existing maps first.

Then open **http://localhost:15173**, register an account, and log in.

## Daily use

```bash
make up          # containers up (idle)
make dev         # start backend + frontend dev servers
make dev-status  # what is actually listening
make logs        # tail all container logs
make down        # stop everything
```

`make up`, `make restart` and `make rebuild` all leave the dev servers stopped —
run `make dev` again after any of them.

Database and migrations:

```bash
make db-shell        # psql into game_db
make migrate-up      # apply pending migrations
make migrate-status  # what has actually run
```

Full command reference: [.ai/commands.md](.ai/commands.md).

## Playing over the internet

`make tunnel` publishes the running stack through ngrok so someone else can log
in and play; `make tunnel-stop` closes it again and puts local dev back.

```bash
make tunnel       # public URL + dev servers, prints the address
make tunnel-stop  # close the tunnel, restore the localhost origin
```

Set both keys in `.env` first (they are in [.env.example](.env.example) with
placeholder values):

```
NGROK_AUTHTOKEN=...   # dashboard.ngrok.com → Your Authtoken
NGROK_DOMAIN=...      # the domain ngrok ASSIGNED you, e.g. foo-bar-baz.ngrok-free.dev
```

`make tunnel` checks both are set and stops with a readable message if not, so a
missing key never produces a half-open tunnel.

`NGROK_DOMAIN` must be a domain the account actually owns. On the free plan it is
auto-assigned and cannot be chosen — inventing a name fails with `ERR_NGROK_313`
("only paid plans may create endpoints with custom subdomains"). If you do not
know yours, run the agent with no domain and read it from the log:

```bash
docker compose --project-directory . --env-file .env -f compose/develop/docker-compose.yml \
  --profile tunnel run --rm --no-deps ngrok http frontend:5173 --log=stdout | grep url=
```

**The URL is open to anyone who has it** — registration and the admin panel
included. There is no gate in front of it, so bring it up only while someone is
playing and take it down afterwards.

Free-plan limits worth knowing: one online agent per account (a second tunnel on
the same token fails with `ERR_NGROK_334`), one assigned domain, and a warning
page on the first visit — each player clicks "Visit Site" once per browser, and
the cookie it sets carries through to the API and WebSocket traffic.

How it works: the tunnel points at vite, not the backend. Vite proxies `/api` and
the `/authority` websocket through to the backend, so one tunnel covers all three
surfaces the game needs, and `make tunnel` repoints the client's `VITE_API_URL` at
the public origin (the client calls absolute URLs, so a remote browser left on the
default would call its own machine).

## Production stack (local verification)

`compose/orangepi/` is the production-shaped stack: built images, no bind
mounts, no dev server. It is what the Orange Pi runs, and it can be exercised
on a workstation without any hardware.

    export ORANGEPI_DATA_DIR=/tmp/s2-orangepi-verify
    docker compose --project-directory . --env-file .env \
      -f compose/orangepi/docker-compose.yml up -d --build

Then run the migrations and seed a map with `exec -T backend`, as in the
development stack, and open http://localhost:8080.

Things to know. The frontend defaults to a **same-origin** API base: the
bundle calls relative URLs (`/api/...`), and Caddy is what makes that work,
proxying both `/api/*` and `/authority*` to the backend on the same origin
the tunnel exposes. That is what lets a `trycloudflare` quick tunnel's
random hostname change on every restart without ever needing a rebuild —
nothing about the origin is baked into the bundle. `PUBLIC_URL` is an
optional escape hatch, not something you normally need to set: pass it only
for a split-origin deployment, where the frontend and backend are served
from genuinely different hosts, e.g.

    export PUBLIC_URL=https://api.example.com

Like before, it is baked into the frontend bundle at build time, so changing
it needs `--build`, not just a restart. If you do set it, the build still
refuses to bake in a `localhost`/`127.0.0.1` origin by default — a bundle
built against one would silently point every player at their own machine —
so local verification of the split-origin path has to opt out with
`ALLOW_LOCALHOST_API_URL=1`; a real deployment must **not** set it.
`ORANGEPI_DATA_DIR` is required (the stack refuses to start without it) and
must point **outside** this repository, because provisioning empties the app
directory and would otherwise take Postgres's data with it. And `cloudflared`
sits behind the `tunnel` profile, so starting the stack never opens a public
URL by accident — see the Orange Pi design doc for the tunnel itself.

After editing `compose/orangepi/caddy/Caddyfile`, check routing with:

```bash
make verify-routing
```

This starts real throwaway containers (its own network, its own stub
backend) against the actual Caddyfile and asserts both plain HTTP routing
and a genuine websocket upgrade handshake on `/authority` — a broken proxy
still serves a good-looking page while leaving the game unplayable, so
this is worth running before every deploy, not just after a routing
change.

## Operating the Orange Pi

The board is treated as a production server, not a second development
machine: no bind mounts, no dev server, no `make dev` equivalent. Everything
is driven from the workstation over ssh, and every target reports the steps
it performed, their status and their duration, then exits non-zero if any
step failed.

### First time

Fill in the `Orange Pi REMOTE OPERATION` block in `.env` (see
`.env.example`), then:

```bash
make pi-keygen      # workstation key -> the board's authorized_keys
make pi-provision   # bare board -> running, publicly reachable stack
```

`pi-keygen` never regenerates an existing key — doing that silently would
lock you out of the board — and it verifies a password-free login actually
works rather than trusting that `ssh-copy-id` exited 0. After it succeeds,
`ORANGEPI_PASSWORD` can be blanked; nothing else reads it.

`pi-provision` is idempotent. Everything that can refuse happens before
anything changes: reachability, the data-safety rule, and whether the board
can reach the repository anonymously. So a wrong `.env` costs a ten-second
refusal instead of a half-provisioned board.

### The data-safety rule

Two directories, and the difference between them is load-bearing:

| | |
|---|---|
| `ORANGEPI_APP_DIR` (default `/app`) | the clone, and nothing else. **Emptied on every provision.** |
| `ORANGEPI_DATA_DIR` (default `/srv/something2`) | Postgres's volume and the board's own `.env`. **Never touched by provisioning.** |

`provision.sh` refuses to run when the data directory resolves *inside* the
app directory, after symlinks are resolved on the board. Without that check a
second `make pi-provision` would silently destroy every account and world on
the box — and it would present as database corruption rather than as the
operator error it is.

The board's `.env` lives in the data directory for the same reason. Its
secrets are generated **on the board** and never travel from the workstation,
and an existing value is never rewritten: a regenerated `POSTGRES_PASSWORD`
against an existing volume is an authentication failure that reads like data
loss.

### Day to day

```bash
make pi-status                  # containers, health, disk, memory, tunnel URL
make pi-deploy                  # reset to the branch tip, migrate, restart
make pi-logs                    # follow the board's logs
make pi-up / pi-down / pi-restart
make pi-migrate-up / pi-migrate-status
make pi-seed-catalogs
make pi-seed-map SPEC=vale-region
make pi-shell / pi-db-shell
make pi-tunnel-url              # the current public URL
```

The seeding targets reuse the same `require-spec` guard as their local twins,
so a misspelled `SPEC` is rejected on the workstation before anything reaches
the network.

`make pi-reset CONFIRM=<the board's address>` wipes and re-seeds the board's
database. It requires the address rather than a yes/no answer — a prompt is
answered by reflex, an address is not — and every command in it runs through
the remote transport, so it cannot reach the local development database
whatever you pass it.

### The public URL changes on every tunnel restart

Phase 1 uses a `trycloudflare` quick tunnel: no account, no domain, no
certificate on the board, and it works behind CGNAT because `cloudflared`
dials outward. The cost is that **the hostname is random and changes every
time the tunnel restarts**, and Cloudflare offers it without guarantees.

That is survivable because the bundle addresses the API on the same origin
that served it, so a new hostname never needs a rebuild. It is not free,
though: `make pi-hook-register` has to be re-run after a restart, because the
deploy hook's URL is one of the two Actions secrets. A stable hostname needs a
named tunnel on a domain you own, which is phase 2.

### Delivery from a push

```
main  --(promotion PR)-->  orangepi  --(push)-->  Actions  -->  GHCR  -->  hook  -->  the board
```

Measured on this board: pulling the published arm64 image takes **11
seconds**, against ten to twenty minutes to build the same commit on four
A53 cores. That gap is why the pipeline exists.

`orangepi` is the deployment branch and is never developed on directly; the
promotion PR is the human gate in front of a publicly reachable machine. The
workflow builds `linux/amd64` and `linux/arm64` natively in parallel, joins
them into one manifest under the commit sha, and only then calls the board's
deploy hook — a push webhook would fire before any image existed, and the
board would fall back to a twenty-minute on-board build.

Point Actions at the board once with:

```bash
make pi-hook-register    # sets DEPLOY_HOOK_SECRET and DEPLOY_HOOK_URL via gh
```

Measured on the board rather than estimated: the listener holds about 45 MB
resident, against 548 MB used of 3.9 GB with the whole stack running. (Note
that `docker stats` reports 0B on this Armbian kernel, which has no cgroup
memory accounting -- read `ps` on the board instead.)

The hook verifies an HMAC over the request body, refuses stale requests,
refuses a second deploy while one is running, and runs `deploy.sh` with
nothing from the request in it. It exits rather than starting at all when no
secret is configured.

## Ubuntu

Tested on 22.04 and 24.04. The `docker.io` package in Ubuntu's own repos ships
Compose v1, which this project does not support — install from Docker's
repository instead:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg make git
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
```

Run Docker without `sudo` — otherwise every `make` target needs it, and files
the containers write end up owned by root:

```bash
sudo usermod -aG docker $USER
newgrp docker            # or log out and back in
docker compose version   # should print v2.x
```

Then follow [First run](#first-run).

## Windows

Use **WSL2**. `make` and the shell commands in the Makefile are not available in
PowerShell or `cmd`, and running the stack from a Windows-native path is
noticeably slower.

**1. Install WSL2 and Ubuntu** (PowerShell as Administrator):

```powershell
wsl --install -d Ubuntu
```

Reboot when prompted, then set your Linux username and password.

**2. Install Docker Desktop** and enable WSL2 integration:
Settings → Resources → WSL Integration → enable for your Ubuntu distro. Docker
Desktop provides both `docker` and `docker compose`, so skip Ubuntu's Docker
install steps above — but you still need `make`:

```bash
sudo apt-get update && sudo apt-get install -y make git
```

**3. Clone inside the WSL filesystem**, not under `/mnt/c/`:

```bash
cd ~                 # e.g. /home/<you>/ — NOT /mnt/c/Users/...
git clone git@github.com:Mortehay/something2.git
```

A clone on `/mnt/c` runs through a filesystem translation layer; builds and
file-watching (Vite HMR, nodemon) are far slower and sometimes miss changes.

**4. Keep LF line endings.** The repo has no `.gitattributes`, so a git install
configured with `core.autocrlf=true` will rewrite shell scripts to CRLF and they
will fail inside the Linux containers with confusing `not found` errors:

```bash
git config --global core.autocrlf false
```

Then follow [First run](#first-run) from inside the WSL Ubuntu shell. Open
http://localhost:15173 in your normal Windows browser — WSL2 forwards the port.

## Ports

| Service | URL | Notes |
|---|---|---|
| Frontend (Vite) | http://localhost:15173 | the game client |
| Backend (Express + WebSocket) | http://localhost:13101 | REST API and the realtime authority |
| Postgres | `127.0.0.1:15432` | `game_db`, user `user` |
| Redis | `127.0.0.1:16379` | |
| MinIO | http://localhost:19001 | console; API on `19000` |
| sprite-gen | http://localhost:18100 | local Stable Diffusion, optional |
| ngrok inspector | http://localhost:14040 | only while `make tunnel` is running; loopback-only |

The public tunnel URL is the one `make tunnel` prints — it is not in this table
because it belongs to your ngrok account, not to this project.

## Layout

- `backend/` — Node + Express REST API, the authoritative game server
  (`src/authority/`), Postgres persistence, migrations
- `frontend/` — Vite + React 19 client, canvas game under
  `src/games/something2/`
- `compose/` — Docker build files. `compose/develop/` is the dev stack;
  production composition lands beside it.
- `engine/` — **frozen.** An earlier Go implementation of the game server,
  superseded by the Node authority in `backend/src/authority/`. Nothing in the
  running game uses it. `make up` still starts its container because it remains
  in the compose file; it is inert and safe to ignore.

## More

- [AGENTS.md](AGENTS.md) — index for AI agents and humans alike
- [.ai/context.md](.ai/context.md) — project context
- [.ai/commands.md](.ai/commands.md) — full command reference
- [.ai/stack.md](.ai/stack.md) — tech stack details

## Remote AI image providers

Tile textures and entity sprites can be generated on another machine (a desktop
running Automatic1111 or similar) instead of the local `sprite-gen` container.
This side prepares the request, waits, receives the response and stores it;
**the other machine draws the image or sprite sheet**.

See **[docs/ai-providers.md](docs/ai-providers.md)** for the full round trip —
the exact request that goes out, the response expected back, where the result is
stored, sprite-sheet grids, worked Automatic1111 / OpenAI-compatible templates,
and troubleshooting.
