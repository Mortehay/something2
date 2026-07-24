---
name: audit-static
description: Use when auditing a something2 code surface against DRY, KISS, YAGNI, SOLID, security, and user-logic-failure lenses, and emitting findings into the audit findings file.
---

# Static Audit

Audit one surface at a time against six lenses. Emit findings that a fixer can act
on without re-deriving your reasoning.

## Surfaces

| Name | Path | Dominant risk |
|---|---|---|
| `backend-api` | `backend/src` excluding `authority/` | authorization gaps, input validation, SQL construction |
| `backend-authority` | `backend/src/authority` | trusting client-supplied values, duplicate/race exploits |
| `frontend-admin` | `frontend/src` excluding `games/*/src/js` | duplicated CRUD, missing error states, stale cache |
| `frontend-game` | `frontend/src/games/something2/src/js` | god objects, coupling, per-frame cost |
| `sprite-gen` | `sprite-gen/app` | path traversal, resource exhaustion, unbounded jobs |
| `infra` | `compose/`, `Makefile`, `.env`, `backend/migrations` | secret handling, exposed ports, migration ordering |

`engine/` is out of scope. It is paused and outdated. Never audit it.

## Lenses

Apply all six to the surface. For each, the question is not "is this principle
violated" but "what breaks because of it".

- **dry** — logic duplicated across call sites. Only report it where the copies have
  already drifted or where a change would have to be made in every copy to be
  correct. Two similar-looking functions that serve different purposes are not a
  DRY violation.
- **kiss** — complexity with no payer. A layer of indirection nobody uses, a
  configuration knob nobody sets, control flow that is harder to follow than the
  problem is hard.
- **yagni** — code kept alive for a use case that never arrived. Dead parameters,
  unreachable branches, abstractions with exactly one implementation and no second
  one in prospect.
- **solid** — responsibilities that should be separable and are not, in a way that
  blocks a change someone actually wants to make. A file being long is not itself a
  finding; a file being long *because* two unrelated concerns are interleaved is.
- **security** — authorization, authentication, input validation, injection,
  secrets, and trust boundaries. In `backend-authority`, the standing question is
  "what happens if the client lies about this value".
- **user-logic** — the flow is individually correct and collectively wrong. Missing
  error states, unreachable recovery, state that desynchronises between screens,
  operations that are not idempotent under retry.

## The verification bar

**Every finding must state a concrete failure scenario: a specific input or state
producing a specific wrong outcome.**

A finding whose entire content is "this violates the single-responsibility
principle", with no consequence attached, is recorded at `P3` and never higher.
This is enforced mechanically — `validate()` rejects a thin `failure_scenario` on
any finding above P3 — but the mechanism only catches the laziest cases. Hold the
line yourself.

This project has already shipped twelve vacuous tests: assertions that could not
fail. An audit that files unfalsifiable findings is the same failure wearing a
different hat, and it is worse than filing nothing, because it looks like progress.

Before emitting a finding, ask: *if someone disputed this, what would I show them?*
If the answer is "the code, and my opinion of it", it is P3.

## Severity

| | Meaning |
|---|---|
| `P0` | Security hole, data loss, or crash reachable by a user. |
| `P1` | A user flow produces a wrong result or dead-ends. |
| `P2` | Structural problem with a demonstrated cost. |
| `P3` | Structural observation with no demonstrated consequence. |

Severity controls order, not inclusion. P3 findings are filed and fixed like any
other; they are simply worked last.

Do not claim `P0` for something you have not traced to a reachable entry point. If
you believe a gap is exploitable but have not proven it, file it at your honest
severity and set `verification` to the browser check that would prove it — the
browser phase will confirm or demote it.

## Emitting findings

Append to `docs/audits/2026-07-24/findings.json` via the store, which assigns ids,
computes fingerprints, and rejects invalid findings:

```js
const store = require('./tools/audit/lib/store.js');
const path = 'docs/audits/2026-07-24/findings.json';
const { doc, added, updated } = store.merge(store.load(path), [
  {
    surface: 'backend-api',
    file: 'backend/src/index.js:412',
    lens: 'security',
    severity: 'P0',
    source: 'static',
    claim: 'DELETE /maps/:id has no admin guard.',
    failure_scenario: 'A logged-in player calls DELETE /maps/3 and the map is removed for everyone on it.',
    proposed_fix: 'Wrap the route in requireAdmin(pool), matching POST /maps.',
    verification: 'Call DELETE /maps/:id with a player token; expect 403 and the map still present.',
  },
]);
store.save(path, doc);
console.log({ added, updated });
```

`merge` throws on an invalid finding. A throw is the schema telling you the finding
is not yet good enough to file — fix the finding, not the schema.

## Procedure

1. Read the surface. For a large surface, read it in coherent chunks (a module, a
   route group, a system) rather than file-by-file — most findings live between
   files, not inside one.
2. For each lens, sweep the surface and note candidates.
3. For each candidate, construct the failure scenario. Candidates that cannot get
   one are either P3 or dropped.
4. Emit via `store.merge`. Re-running on a surface updates its existing findings
   rather than duplicating them.
5. Commit `findings.json` with a message naming the surface and the count.

## Scoping

Invoked with a surface name, audit only that surface. Invoked with no argument,
audit all six in the table order.
