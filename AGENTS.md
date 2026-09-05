# something2 — Agent Index

Real-time 2D MMORPG. Shared maps with multiple live players. Go game engine handles collisions, pathfinding, and mob/NPC aggression. Postgres for durable state, Redis for live state, websockets for transport.

Claude and Codex follow the same rules. This file is the source of truth for both. Tool-specific config (when added) lives in `.claude/` or `.codex/`.

## Layout

- [backend/](backend/) — Node + Express REST API, Postgres persistence, MinIO. See [backend/package.json](backend/package.json).
- [frontend/](frontend/) — Vite + React 19 client. See [frontend/package.json](frontend/package.json).
- [engine/](engine/) — Go game engine: JWT-authed WebSocket hub, 60Hz tick loop, grid-based collisions, Postgres + Redis stores, 5-min batch flush. See [engine/README.md](engine/README.md).
- [compose/](compose/) — Docker build files. [compose/develop/](compose/develop/) is the dev stack: frontend, backend, game-engine, db, redis, minio.

## Project context

- [.ai/context.md](.ai/context.md) — what this project is and what the engine is for
- [.ai/commands.md](.ai/commands.md) — make / npm / engine commands
- [.ai/stack.md](.ai/stack.md) — versions, services, infra, port convention
- [.ai/styleguides/frontend.md](.ai/styleguides/frontend.md) — React + styled-components + TanStack Query patterns
- [.ai/styleguides/backend.md](.ai/styleguides/backend.md) — Express + pg patterns
- `.ai/decisions/` — architecture decisions go here (created as needed)
- [docs/superpowers/specs/2026-07-24-codebase-audit-cycle-design.md](docs/superpowers/specs/2026-07-24-codebase-audit-cycle-design.md) — the audit cycle; re-run it with the `audit-cycle` skill
- [docs/ai-providers.md](docs/ai-providers.md) — remote AI image providers (SOMET-322): registering a service, template placeholders, pointer syntax, limitations

### Trust note: AI providers

An admin who can register an AI provider can make the **backend** issue HTTP
requests to any host the backend container can reach, with a body they control.
That is inherent to the feature — the image service is a machine on the
operator's own network — so **admin is a trusted role for this feature**, by
design and not by oversight. `backend/src/services/safeFetch.js` removes the
surprises (non-HTTP schemes, credentials in the URL, redirects carrying the
auth token off-origin, unbounded bodies); it deliberately does **not** block
private address ranges, because those are the intended target.

## Quick start

```
make up        # start db + backend + frontend
make logs      # tail logs
make db-shell  # psql into game_db
make down      # stop everything
```

Full command list: [.ai/commands.md](.ai/commands.md).

## Plane workflow

Work is tracked in Plane. The `plane-workflow` skill needs these values; they are
recorded here so no session has to rediscover them (project types are a paid
feature in this workspace, so an "Epic" is a plain work item with children).

```
project_id: 5af54080-02ab-4ce8-8473-0b20632e0460   # "Something2", identifier SOMET
states:
  Backlog:           2ae612a0-91ca-496b-accc-35d45d0861c4
  Todo:              f7c08b74-c3eb-4863-8df5-1baea4b34b6f
  In Progress:       8973a4f6-122a-4cb0-8ada-1fa2d3108635
  To Review:         2a79ba57-87cc-4687-bf58-2ee67024d6c6
  Changes Requested: 54840dc6-536f-4090-9873-496b97753db1
  Done:              e1cbace7-9999-4847-a54b-6d3f248c6dfe
  Cancelled:         a17013e1-aabb-4a25-9afd-284cf511ddd4
definition_of_done: AGENTS.md (this file) — backend `npm test` from backend/,
  frontend `npx vitest run` from frontend/, plus browser verification for any
  change with a UI surface. READ THE EXIT CODE, not the summary line — see
  "Reading a test run" below.
commit_convention: branch `feat/<slug>` or `fix/<slug>`; commit subject
  `type(scope): summary (SOMET-NNN)`; end the message with the Co-Authored-By
  trailer.
```

## Reading a test run

`node --test`'s trailing `# fail` counter **does not count a subtest timeout**.
A real run produced:

```
# tests 3536
# pass 3530
# fail 0        <-- while `not ok 2745 ... testTimeoutFailure` was in the output
```

The process still **exits non-zero**, so CI is safe. What is not safe is a human
or a script reading `# fail`. Two rules:

- **Trust the exit code.** `npm test; echo $?` — and never chain the run with
  `;` into a reporting command, because the chain reports the *last* command's
  status and silently discards the suite's. That is exactly how the run above
  got called green.
- If you must grep, grep for **`^not ok`** and **`testTimeoutFailure`** as well
  as `# fail`. Any one of the three means red.

Recorded because it was believed and reported wrongly once (SOMET-530).

`To Review` and `Changes Requested` were added on 2026-08-03 — before that the
project had no review state, so work jumped from In Progress straight to Done
with nowhere to record evidence.

**Modules are enabled** as of 2026-08-17, verified with `project get_features`
(`modules: true`), and the hosting backlog uses them. This file previously said
they were disabled, which was true when it was written; check the feature flags
rather than trusting either statement. Grouping by a parent work item plus
labels still works and is what the older epics use.
