---
name: audit-cycle
description: Use when running or re-running the full something2 audit — baseline, static audit, browser verification, Plane sync, and the fix loop. Accepts an optional surface name to scope the run.
---

# Audit Cycle

Sequences `audit-static`, `audit-browser`, and `plane-sync`, and owns the gates
between them. This skill holds no audit logic of its own — if you find yourself
adding a lens or a flow here, it belongs in the skill that owns that phase.

## Phases

```
0  baseline      → stack health, test/lint baseline, DB snapshot
1  static audit  → audit-static, per surface
2  browser suite → audit-browser, four flows, arbitrates phase 1
3  plane sync    → plane-sync, dry-run then real
4  fix loop      → branch audit-hardening, one commit per task, P0→P3
```

## Gates

Do not cross a gate until its condition holds. Each exists because skipping it
produces work that has to be redone.

| Gate | Condition |
|---|---|
| 0 → 1 | `baseline.md` exists and records every currently-failing test by name. Without it, a pre-existing failure gets blamed on a fix. |
| 1 → 2 | Every finding passes `validate()`. Run the validator; do not eyeball it. |
| 2 → 3 | Every static finding whose `verification` names a browser check has been run and is confirmed or demoted. |
| 3 → 4 | A second `--dry-run` sync reports `created: 0`. If it does not, the file was mutated after the real sync and the tracker is already drifting. |

## Phase 0 — baseline

```bash
cd backend && npm test 2>&1 | tail -30
cd ../frontend && npm test 2>&1 | tail -30
cd ../frontend && npm run lint 2>&1 | tail -30
docker exec something2-sprite-gen-1 pytest -q 2>&1 | tail -20
```

Record every failure by name in `docs/audits/2026-07-24/baseline.md`. Then snapshot
the database:

```bash
AUDIT_DUMP="${AUDIT_DUMP:-/tmp/something2-audit/game_db-pre-audit.sql}"
mkdir -p "$(dirname "$AUDIT_DUMP")"
docker exec something2-db-1 pg_dump -U user game_db > "$AUDIT_DUMP"
wc -c "$AUDIT_DUMP"   # sanity-check: must be well above 1000 bytes
```

The browser phase has free rein on this database. The dump is the only recovery
path for hand-built dev content.

## Phase 1 — static audit

Invoke `audit-static` once per surface, committing after each. Six surfaces:
`backend-api`, `backend-authority`, `frontend-admin`, `frontend-game`,
`sprite-gen`, `infra`.

Validate before leaving the phase:

```bash
cd tools/audit && node -e "
const store = require('./lib/store.js');
const { validate } = require('./lib/finding.js');
const doc = store.load('../../docs/audits/2026-07-24/findings.json');
const bad = doc.findings.filter((f) => validate(f).length);
for (const f of bad) console.log(f.id, validate(f).join('; '));
console.log('findings:', doc.findings.length, 'invalid:', bad.length);
process.exit(bad.length ? 1 : 0);
"
```

## Phase 2 — browser suite

Invoke `audit-browser`. Abort the phase rather than filing findings if the stack is
not responding.

## Phase 3 — Plane sync

Invoke `plane-sync`. Dry-run, read the counts, then run for real, then commit
`findings.json` with its new `plane_id` values.

## Phase 4 — fix loop

See the fix loop section of the implementation plan at
`docs/superpowers/plans/2026-07-24-codebase-audit-cycle.md`. In short: branch
`audit-hardening`, work P0 → P3, one commit per Plane task, failing test first
where testable, full suite green before crossing a severity band.

## Scoping

`/audit-cycle backend-api` runs phases 1 and 3 for that surface only, skipping the
baseline and the browser suite. Use it after fixing a surface to confirm the
findings closed.

`/audit-cycle` with no argument runs everything.

## Re-running later

The cycle is designed to be re-run against a changed codebase. Fingerprints are
computed from surface, the full file path with its trailing line number stripped, lens,
and normalised claim — moving a file to a different directory changes its fingerprint
(the full path is part of it), but a fix that only shifts *line numbers* within the same
file does not resurrect its own finding as a new one. Re-running produces: new findings
created, changed findings patched, fixed findings closed.

Fingerprint dedupe is exact-claim matching underneath the normalisation (case,
punctuation, whitespace only) — it is stable across line-number churn and cosmetic
rewording, but NOT across a genuine re-description of the same defect. An LLM-driven
re-audit that describes an existing bug in different words will not match the old
fingerprint and will look like a new finding. `store.merge` warns about this (a
`suspected` near-duplicate: same surface+file+lens, different fingerprint) rather than
silently duplicating, but it does not catch every case. On a re-run, check the
dry-run's `created` count against your expectation and read any near-duplicate
warnings before trusting the sync.
