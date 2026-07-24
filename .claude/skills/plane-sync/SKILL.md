---
name: plane-sync
description: Use when pushing something2 audit findings into Plane as work items, or closing Plane tasks as findings are fixed. Idempotent by fingerprint.
---

# Plane Sync

Mirror `findings.json` into Plane. One finding, one task, forever — re-running the
audit updates its tasks instead of duplicating them.

## Constants

- Project `Something2` / `SOMET`, UUID `5af54080-02ab-4ce8-8473-0b20632e0460`
- Workspace slug `something2`
- Epic and label UUIDs: read from `docs/audits/2026-07-24/plane-bootstrap.md`
- Priority map: `P0→urgent`, `P1→high`, `P2→medium`, `P3→low`
- Done state: `e1cbace7-9999-4847-a54b-6d3f248c6dfe`

Two operational facts that cost time when forgotten:

- **Cloudflare rejects the default Node/Python User-Agent** with a 403 carrying
  error code 1010. The client sends `curl/8.5.0`. If you write an ad-hoc request,
  send one too.
- **The modules feature is disabled** in this workspace. Grouping is Epic + Label.
  Do not try to create a module.

## Running a sync

Always dry-run first. The dry run is how you catch a bad merge before it becomes
ninety wrong tasks:

```bash
cd tools/audit
node bin/sync.js --findings ../../docs/audits/2026-07-24/findings.json \
  --epic "$AUDIT_EPIC_ID" --dry-run
```

Read the counts. `created` on a first run should equal the number of findings with
status other than `unverified`. `created` on any later run should be zero unless
new findings were genuinely added.

Then run for real by dropping `--dry-run`. The tool writes `plane_id` back into
`findings.json`; **commit that file afterwards** — it is what makes the next sync
idempotent.

## Closing a task

Set the finding's `status` to `fixed` with `store.setStatus` — this is the only
sanctioned way to change `status`; `store.merge` deliberately excludes it so a
re-audit cannot silently reset a fixed finding back to open:

```js
const store = require('./tools/audit/lib/store.js');
const path = 'docs/audits/2026-07-24/findings.json';
const doc = store.load(path);
store.setStatus(doc, 'F-042', 'fixed');
store.save(path, doc);
```

Then sync. `reconcile` patches the issue to the Done state. Do not close tasks by
hand in the Plane UI — `findings.json` is the source of truth, and a hand-closed
task will be reopened in spirit by the next sync's drift check.

## Recovering from a partial sync

A sync interrupted mid-run leaves some findings with a `plane_id` and some without.
This is safe: re-run it. Findings that already have an id are skipped or patched;
findings without one are created.

If the API returns a 403 with `1010`, the User-Agent is wrong. If it returns 401,
the key in `.mcp.json` has rotated.

## Never

- Never file a finding with `status: 'unverified'`. `reconcile` already skips them.
- Never edit a task's title or body in the Plane UI; the drift check will overwrite it.
- Never commit the API key.
