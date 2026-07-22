# Villages & Economy — Design Spec

**Epic:** SOMET-145 · Date: 2026-07-22 · Status: design (pending user review)

## Summary

Villages are admin-authored safe regions **inside bounded maps** (the live chunked
`worlds` system). A village supplies a bind/respawn point, is walled with a single
gated entrance, spawns no hostile creatures inside its footprint, and is guarded by
two powerful faction guards that hold the gate against hostiles. Layered on top is a
gold economy: hostile creatures drop gold scaled by toughness, players carry an
account-wide gold wallet, and a village merchant buys and sells equipment with a
time-limited buyback of player-sold items.

This builds entirely on merged substrate — bounded worlds + `stampBounds`,
`placeMapCreatures`, the loot/drops pipeline, `resolveDeaths` respawn-at-spawn, and
the Linked Maps entry-map seam (`worlds.is_entry`/`entry_spawn`). The first village's
spawn supplies the entry map's `entry_spawn`.

## Goals / Non-goals

**Goals**
- Admin can place a village (position, size, gate side, spawn tile) on a bounded map
  via the Maps tab.
- Villages stamp `wooden_wall` (non-walkable) + `village_gate` (walkable) tiles; no
  hostile creatures spawn inside the village box.
- A player who enters a village binds to it; on death they respawn at that village.
- Two `guard`-faction creatures defend the gate: they target the nearest hostile
  creature within range and chase it within a leash of their gate post, then return.
- Hostile creatures drop a gold ground-item scaled by toughness; picking it up credits
  an account-wide `users.gold` wallet.
- A village merchant sells a base catalog and buys player equipment for gold; sold
  items are held as buyback stock for N days at the sold price, repurchasable by anyone
  (base catalog never expires).

**Non-goals (YAGNI)**
- No village ownership, upgrades, taxes, or population simulation.
- No quest/dialogue system — the merchant is the only interactive NPC.
- No inter-village trade, banking, or gold transfer between players.
- No guard respawn economy or guard leveling — guards are static, tough, non-looting.
- No multiple merchants per village, no merchant inventory restock timers beyond
  buyback expiry.

## Architecture & substrate mapping

| Need | Reuse | Net-new |
|---|---|---|
| Village footprint tiles | `stampBounds` overlay pattern in `mapService.generateRegion` | `stampVillage` (interior box, wall ring + one gate gap) |
| No hostile spawn in village | `placeMapCreatures` rejection sampler | add "inside any village box" to the reject predicate |
| Bind + respawn | `resolveDeaths` teleports to frozen `p.spawn`; `world_players` persistence | auto-bind updates `p.spawn` + persists a bind row |
| Guards | `tickCreatures` aggro/leash/chase | faction-aware targeting + creature-targets-creature + home anchor |
| Gold drop | `commitCreatureDeath` → `spawnDrops` → `world_items` | reserved `gold` item type; toughness formula; wallet-credit on pickup |
| Wallet | `users` table (account-wide home, like `player_items`) | `users.gold` column + load/persist/broadcast |
| Merchant | `equip`/`drop` handler shape (validate → mutate → reply/error) | `interact`/`buy`/`sell` messages; `merchant_stock` table; merchant entity |

Four slices, sequential: **A** village & safe spawn, **B** gate guards, **C** gold
economy, **D** merchant & buyback. Each is independently shippable. A unblocks the
entry-spawn seam; C unblocks D.

## Data model (new)

**`villages`** (one row per village; a bounded world may hold several)
- `id` uuid pk
- `world_id` uuid not null references `worlds(id)` on delete cascade
- `min_row`, `min_col` int not null — top-left tile of the box
- `width`, `height` int not null — box size in tiles, each in `[3, 8]` for width and
  `[3, 6]` for height (≤ 8×6 keeps the village ≤ ¼ of the fixed 1280×720 view)
- `gate_edge` char(1) not null check in (`N`,`E`,`S`,`W`) — wall side with the gate gap
- `spawn_x`, `spawn_y` real not null — bind/respawn point in pixels (interior tile
  center)
- `merchant_x`, `merchant_y` real null — merchant NPC position (interior tile near the
  gate); null = no merchant in this village (Slice D)
- index on `world_id`

**`player_binds`** (single cross-world home bind per account — decision 1)
- `user_id` int pk references `users(id)` on delete cascade
- `world_id` uuid not null references `worlds(id)` on delete cascade
- `x`, `y` real not null — respawn point in pixels
- On death, `resolveDeaths` respawns the player at their bind. A player has exactly one
  home village at a time; entering a different village overwrites the row.

**`entity_types`** additions
- `faction` text not null default `'hostile'` — `'hostile'` | `'guard'`
- `gold_min` int not null default 0, `gold_max` int not null default 0 — gold-drop
  range (0/0 = drops no gold; guards stay 0)

**`world_creatures`** additions
- `home_x`, `home_y` real null — leash anchor. Null preserves today's behavior
  (leash-from-self). Guards get their gate post here.

**`users`** addition
- `gold` int not null default 0 — account-wide wallet

**`merchant_stock`**
- `id` uuid pk
- `world_id` uuid not null references `worlds(id)` on delete cascade
- `village_id` uuid not null references `villages(id)` on delete cascade
- `item_type_id` uuid not null references `entity_types(id)`
- `price` int not null — buy price in gold
- `seller_user_id` int null references `users(id)` — null = base catalog (never
  expires), non-null = player buyback row
- `expires_at` timestamptz null — null = never; buyback rows = now + N days
- `quantity` int not null default 1
- index on `(village_id)`

Reserved **gold item type**: one `entity_types` row (`is_creature = false`) named
`gold`, referenced by a resolved id constant. Gold ground-items are `world_items` rows
of this type with `quantity = amount`.

## Slice A — Village & safe spawn

**Tiles.** New tile kinds `wooden_wall` (walkable = false) and `village_gate`
(walkable = true), registered like `map_wall`/`map_doorway`.

**Stamping.** Pure `stampVillage(grid, rMin, cMin, chunkRows, chunkCols, village)` —
generalizes `stampBounds` to an interior box: writes `wooden_wall` around the box
perimeter within the chunk's coordinate window, punches a 1-tile `village_gate` gap on
`gate_edge` (centered on that edge). Interior tiles are left as generated terrain.
Applied in `generateRegion` after biomes and after `stampBounds`, once per village whose
box intersects the chunk. Villages load alongside bounds in `loadWorld`
(`fetchVillages(worldId)`), threaded into the `ServerMap` config so `generateChunk`
sees them.

**Safe spawn.** `placeMapCreatures` gains a `noSpawnBoxes` param (the world's village
boxes); its rejection predicate rejects any tile inside a village box (in addition to
wall/doorway/non-walkable). Guards (Slice B) are placed separately, not by this sampler.

**Bind on enter.** In the authority tick, reuse the doorway-detection position check:
when a player's tile falls inside a village box they are not yet bound to, set
`p.spawn = { x: village.spawn_x, y: village.spawn_y }` and upsert their `player_binds`
row (`user_id`, this `world_id`, `spawn_x`, `spawn_y`). `resolveDeaths` already respawns
at `p.spawn`, so death → village respawn works with no change to death handling. At join,
`loadSpawn`/`addPlayer` seeds `p.spawn` from `player_binds` if a row exists (so a bound
player who reconnects still respawns home). Cross-world respawn — dying in world X when
bound to world Y — routes through the same reconnect-teleport path Linked Maps uses; if
that proves out of scope for Slice A, respawn falls back to the current world's spawn and
a follow-up wires the cross-world hop.

**Entry seam.** The Maps tab lets the admin mark a village's spawn as the map's
`entry_spawn` (writes `worlds.entry_spawn`), closing the Linked Maps seam.

**Admin UI.** Maps tab gains a village editor per world: list villages, add
(min_row/min_col/width/height/gate_edge/spawn tile), delete. Routes:
`GET/POST/DELETE /api/worlds/:id/villages` (adminGuard). A village add/change
invalidates world chunks + preview cache + evicts the authority world (reuse
`invalidateWorld`).

**Tests.** `stampVillage` (wall ring, single gate gap on the right edge, interior
untouched, box clipped to chunk window); `placeMapCreatures` rejects village-box tiles;
bind-on-enter sets `p.spawn`; routes via mock pool. Browser: place a village, verify
walls/gate render, player blocked at walls / passes gate, no creatures inside, die →
respawn at village.

## Slice B — Gate guards

**Faction + anchor.** `entity_types.faction` and `world_creatures.home_x/home_y`.

**Placement.** When a village is created/loaded, spawn two `guard`-faction creatures
at the two gate-post tiles (either side of the gate gap), with `home_x/home_y` = the
gate post pixel position. Guards are a designated tough `entity_type`
(high hp/defense, `gold_min/max = 0`).

**Faction-aware targeting.** `tickCreatures` splits by faction:
- **hostile** (default): today's logic — target nearest player within `AGGRO_RADIUS`,
  leash to `home` if set else self.
- **guard**: target the nearest **hostile creature** within `AGGRO_RADIUS` of the
  guard; chase toward it but never beyond `LEASH_RADIUS` of `home` (the gate post);
  when the target dies, flees, or leaves leash range, return to `home`. Guards deal
  contact damage to their target creature (creature-vs-creature damage — new; hostiles
  still only damage players).

This is the one genuinely new AI capability: `_target` may key a creature id (guards)
as well as a user id (hostiles). Keep them distinct (`_targetKind: 'player' | 'creature'`).

**Tests.** Pure target-selection: guard picks nearest hostile in range; ignores players;
won't chase past leash; returns home when target gone. Hostile unchanged (regression).
Browser: hostile wanders toward gate → guards intercept, kill it, return to posts;
guards ignore the player.

## Slice C — Gold economy

**Wallet.** `users.gold`. Loaded at join into the player state (`p.gold`), sent in the
`joined` frame and in `state` broadcasts. Persisted on every change inside the same
path that mutates it (pickup credit; Slice D buy/sell) — write-through to
`users.gold`.

**Gold formula.** On `commitCreatureDeath`, in addition to the existing loot roll, if
the creature's `gold_max > 0` spawn one gold ground-item at the corpse with
`quantity = rngInt(gold_min, gold_max)` seeded from creature id + tick (deterministic,
per the no-`Math.random` house rule → use the existing rng helper). `gold_min/max` are
authored per `entity_type` (toughness-tuned by the designer), so "scaled by toughness"
is data, not a hardcoded hp formula.

**Pickup credit.** In the pickup / auto-loot path, special-case the reserved `gold`
item type: instead of inserting into `player_items`, add `quantity` to `p.gold`,
write-through to `users.gold`, delete the `world_items` row, and broadcast the new
balance. All other items unchanged.

**HUD.** Client shows the gold balance from `joined`/`state`.

**Tests.** Gold formula range + determinism; `commitCreatureDeath` spawns a gold item
when `gold_max > 0` and none when `0`; pickup of a gold item credits wallet + deletes
world_item + does NOT touch inventory; pickup of a normal item unchanged (regression).
Browser: kill creature → gold item on ground → walk over → balance rises, inventory
unchanged.

## Slice D — Merchant & buyback

**Merchant entity.** One merchant per village, positioned at an interior tile near the
gate, stored on the `villages` row as `merchant_x/merchant_y` (decision 4). Rendered as
a static non-hostile NPC.

**Messages** (mirror the `equip`/`drop` validate → mutate → reply/error shape):
- `interact { merchantId }` → server replies `shop { catalog, buyback }` where
  `catalog` = base-catalog `merchant_stock` rows for the village and `buyback` = the
  village's non-expired player-sold rows.
- `buy { stockId }` → validate player is near the merchant and has `price` gold;
  deduct gold (write-through), grant the item to `player_items`, delete/decrement the
  stock row; reply `bought` + new balance, or `error`.
- `sell { itemId }` → validate the player owns the item and is near the merchant;
  remove from `player_items`, credit a sell price (a fraction of the item's value),
  insert a `merchant_stock` buyback row (`seller_user_id = user`, `price = sell price`,
  `expires_at = now + N days`, `quantity = 1`); reply `sold` + new balance.

**Buyback.** A buyback row is just a `merchant_stock` row with a non-null
`seller_user_id`; anyone can `buy` it at its stored `price`. Base-catalog rows have
`seller_user_id = null` and `expires_at = null`.

**Expiry.** Expired buyback rows are filtered out on read (`expires_at > now()` or
null) and swept lazily (a `DELETE WHERE expires_at < now()` on shop open). No cron.

**Proximity.** `buy`/`sell`/`interact` require the player within an interact radius of
the merchant (reuse `CONTACT_RANGE`-style distance check).

**Tests.** `interact` returns catalog + non-expired buyback; `buy` deducts gold + grants
item + removes stock; `buy` with insufficient gold → error, no mutation; `sell` removes
item + credits gold + inserts expiring buyback row; expired rows excluded from shop.
Browser: open merchant, buy an item (gold drops, item appears), sell it (gold rises,
buyback row appears), buy it back at the sold price.

## Error handling

- All new routes use `adminGuard` (village CRUD) and validate body shape; reject
  out-of-range box dims (width `[3,8]`, height `[3,6]`), gate gap that doesn't fit,
  spawn tile outside the box.
- `buy`/`sell`/`interact` validate ownership, gold sufficiency, and proximity
  server-side; the client cannot be trusted. Insufficient-gold / not-near / stale-stock
  all reply `error` with a reason, no state change.
- Village box must fit inside the world bounds (if the world is bounded) and not
  overlap another village — validated on create.
- Wallet writes are write-through and clamped ≥ 0; a failed persist logs and does not
  desync `p.gold` from `users.gold` (persist before broadcasting the new balance).

## Testing strategy

Pure functions unit-tested (`stampVillage`, no-spawn rejection, gold formula, guard
target selection, buyback pricing/expiry filter). Routes via the existing mock-pool
pattern. Authority behaviors (bind, respawn, guard aggro, gold pickup, buy/sell)
browser-verified against the running authority using the established WS-client method.
Regression: hostile targeting, normal item pickup, and existing loot drops must be
unchanged.

## Slice order & dependencies

**A → B → C → D.**
- A is self-contained (village substrate + bind/respawn + entry seam).
- B depends on A (needs the `villages` row + gate posts).
- C is independent of A/B but shipped after (wallet + gold drop + pickup).
- D depends on C (merchant transacts in gold) and A (merchant lives in a village).

## Resolved Decisions (approved 2026-07-22)

1. **Bind persistence** → dedicated `player_binds` table keyed by `user_id` (single
   cross-world home bind). Auto-bind on enter.
2. **Village box cap** → width `[3,8]` × height `[3,6]` tiles (≤ 8×6, ≤ ¼ screen).
3. **Gold scaling** → `gold_min/gold_max` columns authored per `entity_type`
   (designer-tuned); no hp-derived formula.
4. **Merchant storage** → `merchant_x/merchant_y` columns on `villages` (one merchant
   per village).
5. **Sell price / buyback hold** → sell = 50% of the item's base value; buyback held
   N = **3 days** at the sold price.
