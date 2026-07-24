# Codebase Audit Cycle — Design

**Date:** 2026-07-24
**Status:** Approved
**Topic:** Repeatable audit → browser-verify → file → fix cycle for something2

## Problem

The codebase has grown to ~18k LOC of JavaScript across the REST backend, the Node
realtime authority, the React admin UIs, and the canvas game client, plus ~1.5k LOC
of Python in the sprite-generation tool. It was built slice by slice, each slice
merged on its own merit, with no pass that looked across slices. Nobody has asked
whether the seams between them hold.

Three classes of problem accumulate in exactly that situation:

1. **Structural decay** — duplicated logic across sibling admin panels, files that
   grew past what one person can hold in their head, abstractions kept alive after
   their use case died.
2. **Security gaps** — authorization checked in one route and forgotten in its
   neighbour; the realtime authority trusting values the client can set.
3. **User-logic failures** — flows that pass their unit tests and still break for a
   real user, because the failure lives in the interaction between screens, sockets,
   and the database rather than inside any one function.

Static review finds the first class reliably, the second class often, and the third
class almost never. So this design pairs a static audit with a scripted browser pass
and treats the browser as the arbiter of what is actually exploitable.

## Goals

- Audit the whole live surface against DRY, KISS, YAGNI, SOLID, security, and
  user-use logic failures.
- Verify findings in a real browser against the running stack, not just by reading.
- File **every** finding as its own Plane work item under one epic.
- Package the whole thing as skills so the cycle can be re-run later without
  redesigning it.
- Fix every filed finding, hardest and most dangerous first.

## Non-goals

- `engine/` (Go) is out of scope. It is paused and outdated; auditing it would
  generate tasks against code nobody intends to touch. Removing it from the repo is
  a separate decision, not part of this work.
- No new features. Fixes only.
- No push to any remote and no merge to `main` without explicit approval.

## Scope

| Surface | Path | Approx LOC | Dominant risk |
|---|---|---|---|
| REST + auth | `backend/src` (excl. `authority/`) | ~2.5k | authorization gaps, input validation, SQL construction |
| Realtime authority | `backend/src/authority` | ~2.4k | trusting client-supplied values, duplicate/race exploits |
| React admin | `frontend/src` (excl. `games/*/src/js`) | ~4k | duplicated CRUD, missing error states, stale cache |
| Canvas game | `frontend/src/games/something2/src/js` | ~8k | god objects, coupling, per-frame cost |
| Sprite generation | `sprite-gen/app` | ~1.5k | path traversal, resource exhaustion, unbounded jobs |
| Infrastructure | `compose/`, `Makefile`, `.env`, `backend/migrations` | — | secret handling, exposed ports, migration ordering |

Six lenses are applied to every surface: DRY, KISS, YAGNI, SOLID, security,
user-logic-failure.

## Architecture

A five-phase pipeline over one shared artifact. `docs/audits/2026-07-24/findings.json` is
the single source of truth; Plane mirrors it; commits reference it. Each phase is
independently re-runnable, which is what makes the packaged skills useful rather
than ceremonial.

```
Phase 0  baseline      → stack health, test/lint baseline, DB snapshot
Phase 1  static audit  → findings.json   (6 surfaces × 6 lenses)
Phase 2  browser suite → findings.json   (4 flows; confirms or demotes Phase 1)
Phase 3  plane sync    → Epic "K" + one Task per finding (idempotent)
Phase 4  skills        → 3 composable skills + orchestrator
Phase 5  fix loop      → branch audit-hardening, one commit per task, P0→P3
```

### Finding record

Every finding, from either source, is one object in `findings.json`:

```json
{
  "id": "F-042",
  "surface": "backend/authority",
  "file": "backend/src/authority/loot.js:117",
  "lens": "security",
  "severity": "P0",
  "source": "static",
  "claim": "Loot pickup does not verify the item still belongs to the corpse.",
  "failure_scenario": "Two clients send pickup for the same corpse item within one tick; both receive the item; inventory count exceeds the drop.",
  "proposed_fix": "Claim the row with a conditional UPDATE and treat zero rows affected as already-taken.",
  "verification": "Two browser clients, simultaneous pickup; assert exactly one inventory gain.",
  "fingerprint": "sha1(surface|file_basename|lens|normalized_claim)",
  "plane_id": null,
  "status": "open"
}
```

`status` is one of `open`, `fixed`, `unverified`, `demoted`.

### Severity

| | Meaning |
|---|---|
| **P0** | Security hole, data loss, or crash reachable by a user. |
| **P1** | A user flow produces a wrong result or dead-ends. |
| **P2** | Structural problem with a demonstrated cost — duplicated logic that has already drifted, a file whose size blocks safe change. |
| **P3** | Structural observation with no demonstrated consequence. |

Severity controls order, not inclusion. P3 findings are filed as tasks and fixed
like every other band — they are simply worked last, after everything with a
demonstrated consequence is closed.

## Phase 0 — Baseline

Record the ground truth before changing anything, so no pre-existing failure gets
misattributed to a fix later.

- Confirm the stack responds: frontend `localhost:15173`, backend `localhost:13101`.
- Run `backend` and `frontend` test suites and ESLint. Record every currently
  failing test by name in `docs/audits/2026-07-24/baseline.md`.
- `pg_dump` the dev database to the session scratchpad.

The dump matters because the browser suite has free rein on the dev database
(decided below) and may destroy hand-built dev content. It is a parachute, not a
restore step in the pipeline; restoring is a manual decision.

## Phase 1 — Static audit

Each surface is audited independently so the work fits in one context at a time.
Each of the six lenses is applied to each surface.

**The verification bar.** Every finding must state a concrete failure scenario:
specific input or state producing a specific wrong outcome. A finding whose entire
content is "this violates the single-responsibility principle", with no consequence
attached, is recorded at P3 and never higher. This gate exists because this project
has already shipped twelve vacuous tests — assertions that could not fail — and the
same failure mode in an audit produces a task list that looks thorough and fixes
nothing.

Findings are deduplicated by fingerprint before they leave Phase 1.

## Phase 2 — Browser suite

Scripted act-then-assert sequences driven through Chrome DevTools MCP against
`localhost:15173`. Admin credentials are read from `.env` (`ADMIN_USERNAME` /
`ADMIN_PASSWORD`) and never written into the skill files or the audit output.

**Flow A — auth and authorization.** Register, login, wrong password, `logout-all`,
`/me`. Then the negative set: a player token against admin routes; `role` injected
into the register body; an expired token; a tampered JWT signature; a token used
after `logout-all`.

**Flow B — admin CRUD.** Maps, tile types, entity types, item types. Create, edit,
delete. Duplicate names, empty input, oversized input. Asset upload and the
sprite-generation trigger. Cache staleness after a mutation.

**Flow C — game loop.** Spawn, movement, collision, doorway transition between maps,
chunk seam continuity, socket drop and reconnect, two clients on one map observing
each other.

**Flow D — combat, items, economy.** Attack, death, respawn, loot drop and pickup,
inventory, equipment, merchant buy/sell/buyback. Abuse cases: negative quantity,
tampered price, simultaneous double-pickup, purchase with insufficient gold.

Each step asserts on console errors, network status codes, and DOM or canvas state.

**Phase 2 also arbitrates Phase 1.** A static finding claiming exploitability is
re-tested here. If the exploit is blocked upstream, the finding is demoted with the
evidence recorded rather than filed as a false emergency. This is the safeguard
against an audit that inflates its own severity counts.

Test data policy: the suite has free rein on the dev database, including editing and
deleting existing records, in order to reach real-world states such as deleting a
map with live players on it. Existing hand-built dev content may be destroyed; the
Phase 0 dump is the only recovery path.

## Phase 3 — Plane sync

Project `SOMET` (`5af54080-02ab-4ce8-8473-0b20632e0460`).

- Create label `K · Audit & hardening`, continuing the existing `A ·` … `J ·`
  convention.
- Create an epic `K · Codebase audit & hardening` using the `Epic` work item type
  (`14e6dccc-3a38-4276-8820-f3e74922d09e`). Modules are disabled in this workspace,
  so the epic plus label is the grouping mechanism.
- Create **one Task per finding**, with `parent` set to the epic. Priority maps
  `P0→urgent, P1→high, P2→medium, P3→low`. The body carries claim, `file:line`,
  failure scenario, proposed fix, and verification step.

**Idempotency.** Sync matches on `fingerprint`. A match updates the existing task; no
match creates one; a finding marked `fixed` and verified closes its task. Without
this, the second run of the cycle produces a duplicate of every task from the first.
The `plane_id` written back into `findings.json` also makes a partially-completed
sync resumable after an API failure.

## Phase 4 — Skills

Three independently invocable skills plus a thin orchestrator:

```
.claude/skills/audit-static/    lens checklist, surface map, finding schema, verification bar
.claude/skills/audit-browser/   MCP flow scripts, selectors, credential source, assertion patterns
.claude/skills/plane-sync/      epic and label mapping, priority mapping, fingerprint dedupe, transitions
.claude/skills/audit-cycle/     orchestrator: sequences the three, owns the phase gates
```

Each of the three does one job and can be run alone — re-run only the browser suite
against a fix, or sync a findings file produced elsewhere. The orchestrator holds no
audit logic of its own; it sequences and gates. It accepts a surface argument so the
cycle can be scoped: `/audit-cycle backend`.

## Phase 5 — Fix loop

Branch `audit-hardening` off `main`. Work tasks in severity order P0 → P1 → P2 → P3,
grouped by surface within each band so related edits stay together.

For each task:

1. Write a failing test that reproduces the failure scenario, where the finding is
   testable.
2. Apply the fix.
3. Run the targeted tests.
4. Re-run the relevant browser check for any finding whose failure scenario is a UI
   or flow behaviour.
5. Commit as `fix(scope): summary [SOMET-NNN]`.
6. Move the Plane task to Done with the commit SHA in a comment.

The full suite must be green before crossing into the next severity band.

Nothing is pushed to a remote and nothing is merged into `main` without explicit
approval.

## Error handling

- **Pre-existing test failures** are recorded in Phase 0 and never attributed to a
  fix.
- **Browser flake**: retry once. Still failing to reproduce means the finding is
  marked `unverified` and is not filed. An unreproducible finding in the tracker is
  worse than no finding.
- **Plane API failure mid-sync**: `plane_id` in `findings.json` makes the sync
  resumable from where it stopped.
- **A fix that breaks a test**: revert that single commit, reopen the Plane task with
  the failure recorded, and continue to the next task. One bad fix does not stall
  the loop.
- **The stack is down** at Phase 2: the browser phase aborts rather than filing
  connection errors as findings.

## Testing

The audit's own output is held to the same standard as the code it examines.

- Each P0 and P1 fix ships with a regression test, or a documented browser re-check
  where the behaviour is not unit-testable.
- The skills get a smoke run before they are trusted: invoke `audit-static` scoped to
  a single small file and confirm it emits schema-valid findings; invoke `plane-sync`
  twice against the same findings file and confirm the second run creates nothing.
- The browser suite is checked against a known-good flow first, to confirm it can
  pass, before its failures are believed.

## Scale and resumability

One task per finding with a mandate to fix everything will span multiple sessions.
The design is resumable by construction: `findings.json` plus Plane state let any
later session pick up at the next open task without re-deriving anything. Phases 1
through 3 are expected to complete in a single session; the fix loop runs long.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Audit scope | backend, frontend, sprite-gen, infra | `engine/` is paused and outdated |
| Finding volume | File everything, fix everything | User's explicit call, cost stated |
| Task granularity | One Plane task per finding | Maximum tracker fidelity |
| Skill shape | Three composable skills + orchestrator | Each phase re-runnable alone |
| Git strategy | One branch, one commit per task | Readable history without 100+ branches |
| Test data | Free rein on dev DB | Reaches real-world states; Phase 0 dump is the parachute |
