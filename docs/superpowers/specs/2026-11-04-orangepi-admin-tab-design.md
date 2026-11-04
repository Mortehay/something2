# Orange Pi admin tab: design

Status: draft for approval, 2026-11-04.

## Why

The owner has an Orange Pi Zero3 (`opiz03`) and wants to put the current game on
it, get a link, send that link to players, and watch the board while they play.
All of this is possible today only by knowing a set of `make pi-*` commands, and
ngrok on the board is not possible at all. The tab turns that routine into
buttons on one screen, and adds the live view that does not exist anywhere yet:
system load, network, who is playing, what they are killing, and which bosses are
up.

**Success:** from the workstation's admin panel, without opening a terminal, the
owner can move the board to the latest `main`, press one button for a working
ngrok link, hand it to a tester, and see that tester appear in the player list.

## Goals

**Stage 1: board control and system charts**

- Status line: board online or offline, running commit, commits behind `main`.
- **Update to latest main.**
- **Seed from git**, which never touches players or progress.
- **ngrok**: start, stop, show and copy a working link.
- **Cloudflare**: start, stop, show and copy a working link.
- Result and log of the last action.
- Charts: CPU, memory, disk, ping, network activity.

**Stage 2: players and bosses**

- Players online: name, level, world, time playing this session, mob kills per
  minute, PvP kills per minute, ping.
- Charts: players online, kills per minute (mobs and PvP).
- Boss list: world, dungeon end and dungeon elite bosses, with status.
- Force summon or resummon a boss.

Stage 1 is useful alone and ships first. Stage 2 needs changes inside the game
server, so it is planned as a separate stage.

## Non-goals

- Any board other than the one in `.env`.
- Long-term metric storage. Charts cover recent history only.
- Alerts or notifications.
- Art and audio on the board. The board has no object storage (SOMET-379), so
  world objects stay placeholder boxes. The tab says so rather than appearing
  broken.
- Reseeding maps from this tab. Re-applying a map changes the world players are
  in and needs a backend restart. `make pi-seed-map` remains for that, including
  the one-off step under "First update".
- Minibosses in the boss list (41 of them; can be added later).
- Choosing a version to deploy. The owner decided that Update always means the
  latest `main`. There is no rollback button.
- A named Cloudflare tunnel (SOMET-432, cancelled: needs a purchased domain).

## Anti-goals: a failure even if it technically works

- Anyone holding the public test link can control the board. **The tab's powers
  must not exist on any public surface.**
- Seed from git damages a player's character, items or progress.
- A second copy of deploy logic that drifts from `compose/orangepi/scripts/`.
- The tab shows a link that does not reach the game. A link is shown only after
  `/api/health` answers through it.
- An offline board makes the tab hang rather than saying the board is off.
- Pressing a button restarts Cloudflare as a side effect and silently changes the
  address players hold.

## What exists today (verified 2026-11-04)

- Board reachable over SSH, stack healthy, running `8ff9f91` from 2026-08-22.
- `origin/orangepi` has no commits missing from `origin/main`, and `main` is 1198
  ahead, so a fast-forward is possible. `orangepi-images.yml` and the deploy
  scripts are present on `main`.
- `compose/orangepi/scripts/` holds the deploy, status and remote scripts;
  `lib.sh` holds `pi_ssh`, profiles and tunnel URL logic.
- `tools/git-helper` is a precedent for what this tab needs: a host process with
  a unix socket, a per-start token, an allow-list API, and a backend that proxies
  to it and degrades cleanly when it is down. The dev backend has no git, no SSH
  and only `./backend` and `./.env` mounted.
- `worldBoss.js` has `forceSpawn`, `getStatus` and a despawn path, reachable today
  only as admin websocket messages (`debugWorldBoss`). `dungeonBosses.js` owns
  dungeon boss life and timers and has no force-respawn.
- Kills surface as `{ id, killerUserId }` arrays from the world and projectile
  ticks. Nothing counts them per player. PvP damage is dealt directly in the
  server's PvP branch.
- Nothing records when a player connected. The websocket layer already sends a
  protocol ping to each socket and handles the pong.
- `docker stats` reports 0 on this board's kernel, so per-process measurement must
  use `ps` or `/proc`.
- The frontend has no chart library.

## How it works: decided by the owner

- The tab lives in the admin panel, in the layout below.
- The board is the one set by `ORANGEPI_*` in `.env`.
- **Update means the latest `main`.**
- The player and boss features described in Goals, including force resummon.
- **The board runs the same maps as the laptop.**
- **In Seed from git, git wins** when a catalog row on the board differs from git.
- **Update may change characters.** The board is a test board (1 account, 1 character
  on 2026-11-04). The confirm dialog warns about this and the backup is the way back.
  No extra protection or testing on a copy of the board's data is required.

### Layout (the owner chose this)

Status line across the top. Left column: Game version, ngrok link, Cloudflare
link, Last action. Right: a grid of charts. Below, full width: Players online,
then Bosses. Mockup:
`.superpowers/brainstorm/299145-1793810688/content/board-tab-layout-v2.html`
(local, not committed). Controls and charts stay in view together so the owner
can watch the board react.

## How it works: the builder's calls, recommended by this design

These were played back to the owner without objection, but are not the owner's
explicit decisions. Change one only with a reason.

### Where it runs

The tab works only on the workstation, never in the admin panel served by the
board:

```
browser -> dev backend (admin only) -> host helper -> ssh -> board
```

- **Host helper** (`tools/pi-helper`, started with `make pi-helper`), modelled on
  `tools/git-helper`: unix socket, per-start token, fixed allow-list, no free-form
  commands or arguments from the request. It runs as the host user, so it holds
  the SSH key and `.env`, and calls the existing scripts. **This replaces the
  earlier idea of mounting the SSH key in the backend container.**
- **Backend routes** under `/api/board`, all behind `adminGuard`, mounted only when
  an explicit env flag is set in the dev compose file and never in
  `compose/orangepi`. On the board, the routes do not exist.
- If the helper is down, the tab says so and shows the command to start it.
- Passwords, tokens and keys never appear in responses or logs shown in the tab.
- Separate from `git-helper` because deploys run for many minutes, while that
  helper's operations have a 120 s deadline.

### Update to latest main

1. Confirm first. The dialog gives the number of players who will be disconnected
   (once Stage 2 exists) and the number of commits the board will jump, and warns
   that an update can change characters and that the backup is the way back. Every
   deploy runs `seed-passive-tree.js --force`, which removes points spent on pruned
   nodes, and migrations may change characters too.
2. Back up the board's database, reusing `backup.sh`. A failed backup stops the
   update.
3. `git fetch`, check that `origin/orangepi` is an ancestor of `origin/main`, then
   push `origin/main` to `refs/heads/orangepi`. **Never forced.** Any divergence
   stops with a clear message. This never touches the local checkout, because
   other sessions share it.
4. CI builds the images, which takes as long as it takes. The tab shows the
   current step and CI run state.
5. Deploy. The CI hook deploys if Cloudflare is up. If it has not landed once the
   images exist, because the tunnel is stopped or the hook is unavailable, the
   helper runs `deploy.sh` over SSH.
6. Done when the board reports the target commit and `/api/health` answers.

Required changes:

- One deploy at a time on the board **regardless of entry point**, since the hook's
  in-flight flag does not cover an SSH deploy. Use a lock on the board that both
  paths respect, and a deploy that finds the board already at the target and healthy
  exits without restarting anything.
- A deploy must not start a tunnel the owner has stopped (see Tunnels).

The first press jumps 1198 commits and is the real test of this path. Expect
problems on the board that the design cannot predict, and treat them as bugs to
fix in the implementation stage.

### First update: bring the board's maps in line with the laptop

Updating does not change maps, so this is a one-off step, run from a terminal and
documented in the README, right after the first update:

```
make pi-seed-map SPEC=p5-descent
make pi-seed-map SPEC=vale-region   # LAST: p5-descent takes the entry world otherwise
make pi-restart                     # leaves cloudflared alone
```

The laptop's database holds all of `vale-region` and `p5-descent`, none of
`spire-of-trials`, and Vale Crossing is the entry world. `backend/seeds/sync/maps.json`
lists the same two specs. Those specs account for 100 of the laptop's 135 worlds. The
builder must find out what the other 35 are, and whether testers would miss them, before
treating the board as matching.

Afterwards the board should have the 6 dungeon boss placements the laptop has (The
Catacombs, The Emberhive and The Umbral Gate, each with Elite and End), and Vale Crossing
as the entry world. Stage 2's dungeon boss verification depends on this.

### Seed from git

The rule is **players and progress are never changed.** Wiping test data is
deliberately not offered; `make pi-reset` remains for that.

**Git wins.** The engine cannot tell who changed a row that has no baseline, and nothing
has run `seed-sync` on the board before, so the first press will find many such rows. The
tab runs it with `--resolve=git`, and the preview states how many rows will be overwritten.
Balance changes made directly on the board are lost when you confirm.

- Applies the seed data in the commit the board is running, not the workstation's
  checkout.
- Runs `seed-catalogs` and `seed-sync` for these groups: `tile_types`, `items`,
  `attack_effects`, `aura_effects`, `creature_behaviors`, `entities`, `biomes`,
  `skill_tree`, `progression`, `quests`.
- Also seeds `ai_providers`, because 357 `ai_provider_id` values in `tile_types` and
  `entities` pin a provider, and the seed engine refuses a whole group when a reference
  cannot resolve (`missing_ref`). This is harmless: `auth_token` is a secret column and
  is never exported, and the board generates no art, so those LAN addresses go unused.
  The builder must confirm that nothing on the board starts generation because these
  rows exist.
- Excludes `ai_provider_templates`, `art`, `audio` (no storage on the board), and `maps`
  (non-goal).
- **Shows a preview before writing**: per group, how many rows will be added,
  changed and removed. Removal of a row that characters still reference stays
  blocked, as the seed engine already does.
- Warns if the backend needs a restart for the change to take effect, and offers it.
  That restart must never include `cloudflared`.

The builder must confirm that each included group writes only catalog tables, with
a before-and-after count of player tables on a scratch database.

### Tunnels

- **ngrok** becomes a new optional service in `compose/orangepi`, in its own profile
  with a pinned image, pointing at `caddy:80`. It is off by default, and starting the
  stack must never open it (the compose file already states that rule). Its settings
  reach the board's `.env` in the data directory.
- **Desired state is recorded on the board** per tunnel, in the data directory. Deploy
  and `pi-up` honour it. Today `deploy.sh` always starts `cloudflared` and `pi_profiles`
  always includes it, so a stopped Cloudflare link would return on the next update.
  With no recorded state, Cloudflare counts as on, so current behaviour is unchanged.
- **A link appears only after `/api/health` answers through it.**
- **Stopping Cloudflare warns first:** starting it again gives a new address, the old
  link dies, and CI's deploy hook breaks until repaired. Starting it runs the existing
  repair (`reconcile-url.sh`), so the published page and hook URL follow. The builder
  must confirm the 10-minute reconcile timer does not undo or complain about a
  deliberate stop.
- **ngrok errors in plain words.** The free account allows one agent on its domain, so
  `make tunnel` on the workstation causes `ERR_NGROK_334` on the board. The tab says
  that, rather than showing the raw code. Never stop auto-orbit's ngrok to fix this: it
  is another project, on another account.
- Testers on a free ngrok domain see ngrok's warning page on first visit. The builder
  must test a fresh browser through the link, including the game's websocket.

### Charts

- The helper samples the board every 15 s over one reused SSH connection, with minimal
  load: `/proc/stat`, `/proc/meminfo`, `/proc/net/dev`, `df`, and connection count.
- Network: in and out per second, per real interface, plus open connections.
- Ping: board round trip from the workstation, and response time of `/api/health`
  through whichever tunnel is on. These answer different questions: is the board slow,
  or is the path to it slow.
- History: kept in the helper's memory for 6 hours, with a 15 min / 1 h / 6 h selector.
  Lost if the helper restarts. No database.
- Charts are small hand-written SVG; no chart library for six line charts. Follow the
  `dataviz` skill and the `--s2-*` tokens, in both light and dark.
- A gap in a line means no data. An offline board must not draw as zero.

### Players and bosses (Stage 2)

**Access.** The live data lives inside the game server's process, so the board's backend
needs a small new internal listener. It binds to **loopback inside the container, on a
port Caddy does not proxy**, so no public route exists. The helper reaches it with
`docker compose exec` over SSH. Admin login tokens are not involved.

**Player stats** are in-memory, per session, reset on restart or reconnect. No migration.

- Connect time recorded on join.
- A mob kill or PvP kill is counted once per kill, from the code paths that already
  report a killer. Projectile and area kills must count. **Verify with a real fight in
  a browser**, since this project has a history of counters wired to only one of two
  paths.
- Rate is kills divided by minutes played this session.
- Ping per player comes from the existing websocket protocol ping and pong.

**Boss list.** Built from who owns the boss's life, not from catalog rows alone. Each world
boss in the catalog (`boss_tier = 'world'`, currently 4) gets one row, handled by
`WorldBossManager`. Each dungeon boss **placement** gets one row (`worlds.dungeon_boss`),
handled by `DungeonBossManager`, because that state is per world and one boss can be placed
in several worlds. A boss that is both, such as Gorgon, appears once per owner. Status is
alive with HP and fighters, dead with time until return, or not spawned with next rotation.
With the laptop's maps, that is 4 world boss rows and 6 dungeon rows.

**Force summon.**

- **Summon or resummon always asks to confirm**, naming the boss and the players in that
  world.
- A live boss is replaced at full health. Only one world boss runs at a time, so
  summoning another replaces the current one; the dialog says so.
- World bosses: reuse the manager's despawn and `forceSpawn` by name, with announcements
  as usual.
- Dungeon bosses: add a force-respawn to `dungeonBosses.js`. It must remain the single
  owner of that boss's life. Bosses in an unloaded dungeon show as such, and the action is
  disabled or explained rather than appearing to succeed.

## Left to the builder

- Exact helper API, polling interval of the tab, route names and flag name.
- Locking mechanism for deploys.
- How helper sampling is paused when no tab has asked for data recently, if measured load
  matters. Board load from sampling should be measured and reported.
- Whether the sidebar entry is hidden or explanatory when the flag is off.
- Plane tickets: file an epic with one child per slice during planning.

## Verification

- Project definition of done: backend `npm test` and frontend `npx vitest run`, reading
  exit codes, with `TEST_DATABASE_URL` set to a scratch database. Never mutate the shared
  dev database.
- Browser verification on the real board, not only stubs, with Chrome muted:
  - Update, from the old version to latest `main`.
  - Seed preview and apply, with player tables identical before and after.
  - ngrok link opened in a fresh browser, played end to end from outside the workstation's
    localhost, including the websocket.
  - Cloudflare stop and start, then a deploy, confirming the stopped state survives.
  - Board powered off, or unreachable: the tab reports it quickly and the charts show a gap.
  - Helper stopped: the tab shows the start command.
  - The board's own admin panel and public link: `/api/board` and the internal listener
    are not reachable.
- Stage 2: a real fight (melee, projectile and PvP) moves the right counters, and every
  boss type can be summoned, seen in game, killed and resummoned.
