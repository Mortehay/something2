# Plane bootstrap — audit epic K

Run 2026-07-24, as Task 6 of `docs/superpowers/plans/2026-07-24-codebase-audit-cycle.md`.

## Identifiers

Every later sync needs these. The epic UUID is what `bin/sync.js --epic` takes.

| Thing | Value |
|---|---|
| Workspace slug | `something2` |
| Project | `Something2` / `SOMET`, `5af54080-02ab-4ce8-8473-0b20632e0460` |
| Epic | `K · Codebase audit & hardening` |
| Epic UUID | `2203f08c-47c1-47f0-9e2b-85b6f44908c0` |
| Epic identifier | `SOMET-163` |
| Label | `K · Audit & hardening` |
| Label UUID | `2ac55bc2-0472-4d6f-83a9-44d11b7a723a` |
| Epic work item type | `14e6dccc-3a38-4276-8820-f3e74922d09e` |
| Done state | `e1cbace7-9999-4847-a54b-6d3f248c6dfe` |

Export before syncing:

```bash
export AUDIT_EPIC_ID=2203f08c-47c1-47f0-9e2b-85b6f44908c0
```

## Probe result: REST parenting to an epic WORKS

The plan flagged one unverified assumption — that the REST API can parent an issue
to an epic-typed work item — because roughly ninety tasks depend on it and a
failure would only surface after the first bulk sync. It was probed before
anything else was built on it.

A probe issue was created through `tools/audit/lib/plane.js` (`POST /issues/` with
`parent` and `labels`), then read back through a separate path — a PQL
`childOf("SOMET-163")` query rather than the create response — because the create
response echoing `parent` back is not evidence that the hierarchy was actually
stored.

Result: the probe appeared as a genuine child of `SOMET-163` with the `K ·` label
attached, priority preserved. It was then deleted, and the child list re-queried
and confirmed empty.

```
PROBE_ID=371d5bc3-b40f-42b6-93f4-f5bfe6335855   SEQ=164
childOf("SOMET-163")  →  1 result, label K attached
deleted               →  childOf("SOMET-163")  →  0 results
```

**The MCP fallback described in the plan's Task 6 Step 4 is therefore not needed.**
`bin/sync.js` creates issues over REST for the whole audit.

## Notes for whoever runs this again

- Set the label and epic **name** as plain text. HTML-escaping the ampersand
  produces a literal `K · Codebase audit &amp; hardening` in the title; likewise an
  escaped `description_html` renders as visible `&lt;p&gt;` tags. Both had to be
  corrected here with a follow-up update.
- Cloudflare rejects the default Node user agent with a 403 carrying code 1010.
  `lib/plane.js` sends `curl/8.5.0`. Any ad-hoc request needs it too.
- Modules are disabled in this workspace. Epic + label is the only grouping.
