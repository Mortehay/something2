# SOMET-121 — Redis state layer for the Node authority: design answer

Status: design only. Nothing here is to be built until the trigger below fires.
Date: 2026-10-31. Supersedes nothing; extends the "Why not Redis" section of
`2026-07-19-phase6-slice3b3b-aoe-ammo-design.md`.

## TL;DR

- Redis is justified **only** by running more than one authority process. Until
  then it adds a copy of state and a failure mode, and removes neither.
- When it comes, Redis holds **coordination state only** — world ownership leases,
  the user→session registry, and pub/sub. It never holds a player-owned value.
- Postgres stays the single source of truth for everything durable. On
  disagreement Postgres wins, because Redis never holds anything that is not
  either rebuildable from Postgres or safe to expire.
- The restart-loss problem the epic mentions is real but is **not** a Redis
  problem: it is the missing SIGTERM drain (`backend/src/authority/server.js`, the
  "KNOWN GAP" note in `close()`). Fix that first and independently.

## Facts this rests on (verified 2026-10-31 against `origin/main` e0ca0226)

- One backend process; `attachAuthority` is called once (`backend/src/index.js:5865`).
  The whole world lives in its `worlds` Map, keyed by world id.
- The Node backend has no Redis client and no `REDIS_URL`. In
  `compose/develop/docker-compose.yml` `REDIS_URL` is set only on `game-engine`
  (frozen Go) and `sprite-gen` (db 1). `compose/orangepi/docker-compose.yml` has no
  Redis service at all, so adopting Redis also adds a container to staging.
- What the authority writes, and how:

| State | Where it lives | Write mode | Lost on crash |
|---|---|---|---|
| Items, ammo, loot claims, gold/trade, XP (`progressionStore.awardXp`), quests, passives, waypoints | Postgres | write-through, transactional; row count is the check (`ammo.js`, loot claim CTE) | nothing |
| Ground items | `world_items` | write-through at drop | nothing (TTL sweep) |
| Player position | `world_players` | write-behind, `flushMs` 30 s + on close | ≤ 30 s of movement |
| Village bind | `player_binds` | write-behind, `BIND_WRITE_MIN_MS` 5 s floor + forced on close | ≤ 5 s |
| Creature position/facing | `world_creatures` | write-behind, `creatureFlushMs` 3 s, dirty set retried | ≤ 3 s of movement |
| HP / mana / stamina, effects, cooldowns, projectiles | memory only | — | all (re-derived on join) |
| World-boss schedule and live boss, dungeon bosses | memory only (`WorldBossManager`) | — | timer restarts |
| User → live session (single-session kick) | memory only (`sessionsByUser`) | — | all (no sessions survive anyway) |

Every write-behind class loses **movement**, never a player-visible resource. That
is the invariant to keep.

## Answers to the epic's five questions

### 1. Sharding the authority across processes

**Partition by world, never within a world.** A world's simulation stays owned by
exactly one process; worlds are already the unit (`worlds` Map, per-world tick, per-world
flush). Cross-process traffic is then limited to:

- **Ownership**: which process simulates world W. A Redis lease
  `authority:world:<id>:owner = <processId>` with a TTL, taken with `SET NX PX`,
  renewed at TTL/3.
- **Routing**: a join for world W reaches the owner. The client already
  reconnects on world transitions, so the join handshake answers "connect to
  process X" instead of the authority proxying frames. No frame-level relay.
- **Session registry**: today's single-session kick is a local Map. Across
  processes it becomes `authority:user:<id>:session` plus a pub/sub "kick"
  message to the process holding the old session.
- **Broadcast invalidation**: admin edits that must reach live worlds (loot tuning,
  catalogs) become a pub/sub message instead of the current per-process re-read.
- **Global schedules**: the world-boss timer becomes lease-owned too (one process
  runs the global scheduler), or it stays per-world if it is per-world by then.

Splitting **one** world across processes (seamless chunk handoff, SOMET-53 at
scale) is out of scope. It needs cross-boundary simulation (creatures chasing
over a seam, AoE spanning two owners), and Redis does not solve that. If one
world outgrows one process, revisit with a separate design.

**Known single-process assumptions to fix with sharding.** Code that is correct
only because one process owns the database must be found and fixed before a
second process runs. One is already documented:
`services/creatureRespawn.js` `enqueueDeficit` is count-then-insert with no lock
and would overshoot to 2× its target with two processes. With world ownership it
stays safe, because only the owner of world W runs it; without ownership it needs
`pg_advisory_xact_lock` keyed by world id. An audit for other count-then-act
paths is the first task of the implementation epic.

**Do not** mirror per-tick simulation state (positions, HP) into Redis for other
processes to read. Ownership, not sharing, is the model.

### 2. Restart recovery without replaying Postgres

There is no replay to avoid. A restart **loads** current rows (`world_creatures`,
`world_items`, `world_players`), which is cheap and already correct. The real
loss is the write-behind windows above plus all memory-only state, and the cause
is that `index.js` installs no SIGTERM/SIGINT drain, so `terminate()` does not
await the close handlers that would `persist`/`flushBind`.

Decision: **no Redis snapshot for restart recovery.** Instead, a separate
Redis-independent ticket: an awaited shutdown drain (stop accepting joins → final
`persist` + forced `flushBind` per player → `flushAndPrune` per world → close
the pool). That closes the movement gap on every planned restart. Memory-only
combat state (HP, effects, cooldowns) is deliberately not durable; making it
survive a restart is a gameplay decision, not an infrastructure one.

### 3. What lives where, and who wins on disagreement

- **Postgres**: everything that is durable or player-owned. Unchanged from today.
- **Redis**: only keys that are either (a) expirable with a TTL and safe to lose
  (leases, session registry) or (b) transient messages (pub/sub). No Redis key is
  ever the only copy of anything.
- **Disagreement**: Postgres wins by construction, because the two never hold
  the same fact. Lint for it in review: a PR that writes a player resource to
  Redis is rejected. Caching a Postgres read in Redis is also out; the
  single owning process already caches it in memory.

### 4. Behaviour when Redis is unavailable

**Fail closed on ownership, keep serving what is safely owned.**

- A process that cannot **renew** a lease stops simulating that world and
  disconnects its players before the lease can expire. Self-evict at ~2/3 TTL;
  never run past TTL. Two owners of one world is worse than downtime: both would
  flush creature rows and both would run death/loot.
- A process cannot take **new** ownership without Redis, so joins to un-owned
  worlds are refused with a retryable error.
- Session kicks and invalidation pub/sub degrade to local-only. That is
  acceptable for the duration because each world still has a single owner.
- There is no "degrade to Postgres" mode for leases. If one is wanted later,
  Postgres advisory locks (already used in production by
  `services/seedSync/txn.js`) are the fallback primitive, but then Redis is
  redundant and the design should pick one, not both.

Durable writes remain safe even in a brief overlap: they are transactional
Postgres statements whose row count is the check (a loot claim or an ammo spend
can succeed once). The worst a double owner can do is overwrite creature
positions, not duplicate items.

### 5. Flush semantics

Rule, binding on any future Redis work: **no player-visible resource is ever
write-behind.** Items, ammo, currency, XP, quest progress, and claims stay
write-through, transactional, with the row-count-as-check pattern. Write-behind is
allowed only for state whose loss costs movement (positions, binds, creature
positions), and every such path keeps the existing "dirty survives a failed
write" retry (`flushAndPrune`, `flushBind`). Redis must not add a third hop to
any of these. The mirrored-`autoLoot`-flag bug class (3b-2b) is what this rule
exists to prevent.

## Trigger: when to open implementation

Open an implementation epic only when **all** hold:

1. A decision has been made to run ≥ 2 authority processes, backed by
   measurement. One example is tick duration that regularly overruns the 50 ms
   `tickMs` budget at real load, and that per-world optimisation cannot fix.
2. The shutdown drain (below) has shipped, so restart loss is not being used as
   the justification.
3. Staging (Orange Pi) has a plan for the extra Redis container.

Until then, keep `ammo.js`'s "Why not Redis" note and this doc as the answer to
"should X go in Redis?".

## Work this implies

- **Now, Redis-independent (recommended ticket):** awaited SIGTERM/SIGINT drain
  in `index.js` → authority `close()`; closes the "KNOWN GAP" in `server.js`.
- **On trigger:** (0) audit count-then-act paths that assume one process (starting with `creatureRespawn.enqueueDeficit`); (a) Redis client + `REDIS_URL` for backend in both compose
  files; (b) world-ownership lease + self-evict; (c) join routing to the owner;
  (d) cross-process session registry + kick; (e) pub/sub invalidation; (f) global
  scheduler lease. Each is a separate ticket, in that order.
