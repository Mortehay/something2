---
name: audit-browser
description: Use when verifying something2 in a real browser via Chrome DevTools MCP — running the four audit flows, confirming or demoting static findings, and emitting browser-sourced findings.
---

# Browser Audit

Drive the running stack through four flows and assert on what actually happens.
This phase exists because static review reliably misses the class of bug that only
appears when screens, sockets, and the database interact.

## Preconditions

Check before starting. If any fails, **abort the phase** — do not file connection
errors as findings.

| | Check |
|---|---|
| Frontend | `curl -sf -o /dev/null http://localhost:15173` |
| Backend | `curl -sf -o /dev/null http://localhost:13101/api/health` |
| Containers | `docker ps --filter name=something2 --format '{{.Names}}'` lists frontend, backend, db, redis |

## Credentials

Admin credentials are `ADMIN_USERNAME` and `ADMIN_PASSWORD` from `.env`. Read them
at runtime:

```bash
grep -E '^ADMIN_(USERNAME|PASSWORD)=' .env
```

**Never** write a credential into a finding, a commit, a screenshot description, or
this skill file. Player accounts are registered fresh through the UI.

## Test data policy

The suite has free rein on the dev database, including editing and deleting
existing records, in order to reach real-world states such as deleting a map that
has live players on it. Hand-built dev content may be destroyed; the Phase 0
`pg_dump` is the only recovery path. Confirm that dump exists before Flow B.

## Flow A — auth and authorization

Positive: register a new account, log in, hit `/me`, log out, `logout-all`.

Negative — each of these is a P0 finding if it succeeds:

| Attack | Expected |
|---|---|
| Player token against an admin-only route | `403` |
| `{"role": "admin"}` in the register body | account created as `player` |
| JWT with the signature byte-flipped | `401` |
| JWT with `exp` in the past | `401` |
| Token reused after `logout-all` | `401` |
| Login with a wrong password | `401`, and no token issued |
| Login attempted 20 times in a row | rate limited, not 20 × `401` |

Drive the negative set with `evaluate_script` issuing `fetch` from the page origin,
so cookies and headers match a real client.

## Flow B — admin CRUD

For each of Maps, Tile types, Entity types, Item types:

1. Create with valid input → appears in the list without a manual reload.
2. Create with a duplicate name → a visible error, not a silent failure or a crash.
3. Create with empty required fields → validation blocks it client-side AND the API
   rejects it if called directly.
4. Create with a 10 000-character name → rejected, not truncated silently or 500.
5. Edit → the change is visible in the list and survives a reload.
6. Delete → gone from the list, and any dependent view degrades gracefully rather
   than crashing.
7. Asset upload and sprite-generation trigger → the job is accepted, the UI reflects
   its state, and a failure surfaces as an error rather than a spinner forever.

Watch `list_console_messages` after every step. An uncaught exception during a
normal CRUD operation is at least P1.

## Flow C — game loop

1. Enter the game. Assert the canvas renders and no console errors accumulate.
2. Move in all four directions. Assert the camera follows and position persists.
3. Walk into a wall. Assert collision holds and the player does not tunnel.
4. Take a doorway to another map. Assert the transition completes, tile defs match
   the destination, and the return trip works.
5. Cross a chunk seam. Assert no visual gap and no duplicate entities.
6. Kill the socket (`evaluate_script` closing the WebSocket). Assert the client
   reconnects and state resynchronises rather than silently freezing.
7. Open a second page as a second account on the same map. Assert each sees the
   other move.

## Flow D — combat, items, economy

1. Attack a creature. Assert damage applies and the VFX renders.
2. Die. Assert respawn works and inventory survives per the design.
3. Kill a creature, assert loot drops, pick it up, assert inventory gains exactly one.
4. Equip and unequip. Assert stats change and survive a reload.
5. Buy from a merchant with sufficient gold. Assert gold decreases by the price.
6. Buy with insufficient gold → rejected server-side.

Abuse cases — each is a P0 if it succeeds:

| Attack | Expected |
|---|---|
| Buy with `quantity: -5` | rejected; gold does not increase |
| Sell with a client-supplied price | server price wins |
| Two simultaneous pickups of one drop | exactly one inventory gain |
| Buy an item the merchant does not stock | rejected |
| Equip an item not in inventory | rejected |

## Arbitrating static findings

For every finding already in `findings.json` with `source: 'static'` whose
`verification` names a browser check, run that check.

- Confirmed → leave the severity, append `confirmed in browser` to `verification`.
- Blocked upstream → set `severity: 'P3'` via `store.merge`, record in
  `verification` what actually blocked it, then demote the status with
  `store.setStatus` (the only path that can change `status` — `merge` deliberately
  cannot):

```js
const store = require('./tools/audit/lib/store.js');
const path = 'docs/audits/2026-07-24/findings.json';
const doc = store.load(path);
store.setStatus(doc, 'F-042', 'demoted');
store.save(path, doc);
```

This is the safeguard against an audit that inflates its own severity counts. Use
it honestly: a static P0 that turns out to be unreachable is a *good* outcome to
report, not a loss.

## Flake policy

If a browser assertion fails, retry it once. If the second attempt does not
reproduce, mark the finding `status: 'unverified'` and do not file it. `reconcile`
skips unverified findings by design. An unreproducible finding in the tracker is
worse than no finding.

## Output

- Emit browser findings through `store.merge` with `source: 'browser'`, exactly as
  `audit-static` does.
- Write `docs/audits/2026-07-24/browser-run.md`: per flow, what was asserted, what
  was observed, and which static findings were confirmed or demoted.
- Commit both.
