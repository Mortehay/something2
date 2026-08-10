# Test player account

`1714440161000_seed_test_player.js` can seed a player account for manual
testing. **It does nothing unless you opt in.**

| | |
|---|---|
| username | `testplayer` |
| password | `testplayer-dev-only` |
| role | `player` (never admin) |
| characters | one slot-1 Warrior named `Testwarrior`; seven slots free |

## Enabling it

Add to the repo-root `.env`, then run the migrations:

```
SEED_TEST_USER=1
```

```bash
cd backend && npm run migrate:up
```

The check is against the exact string `1`. `SEED_TEST_USER=0` and
`SEED_TEST_USER=false` are both **off**, which is what you want them to mean.

## Why it is gated

The password above is committed to this repository, so anyone who can read the
repo knows it. The `SEED_TEST_USER` check means the account cannot exist on an
environment that has not explicitly asked for it — a deployment that never sets
the flag has no such user, and there is no way to log in as one.

**Do not set `SEED_TEST_USER=1` anywhere that is reachable from the internet.**

This mirrors how the admin account already works: `1714440025000_users.js`
creates an admin only when `ADMIN_USERNAME` and `ADMIN_PASSWORD` are both set,
and ships no default credentials.

## What it is for

The account exists to exercise the player-facing surfaces added in SOMET-256,
which an admin account cannot exercise honestly — an admin sees the editor
screens and so cannot tell whether the player-only navigation is correct:

- log in, resume at the exact position of the last logout
- the character list, the eight-slot cap, create and delete
- the read-only World Map at `/game/map`, with its fog of war
- the absence of every admin screen

## Removing it

```bash
cd backend && npx node-pg-migrate down 1
```

or delete the row directly — the character and all its state cascade away with
the account. `down` is not gated by the flag, so it works even after the flag
has been unset.
