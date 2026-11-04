# Player-to-player trade: design

Date: 2026-11-04. Status: decided by the owner where marked, otherwise Claude's call (the owner asked for the
work to run through to Done and will check the calls at the end).

## Why

Players can sell to merchants and store in the account chest, but cannot give, sell or swap anything with each
other. The server has no trade, chat, party or friends. This adds a direct exchange between two characters
standing near each other.

## The exchange (owner's decision)

1. **Fill.** Each player edits their own stash (offer). Both stashes are visible to both, live.
2. **First OK.** A player clicks OK. Their stash locks. It cannot be un-OKed or edited; the only way out is to
   abort the whole exchange.
3. **Other player.** Can keep editing until they click OK, which locks their stash too.
4. **Second OK.** Once both are locked, both players must click OK again. The swap runs after both have.

## Claude's calls

### Goals

- Nothing can be duplicated or lost, whatever the timing or disconnects.
- Nobody can change the deal after the other player's last chance to read it.
- Gold can be offered, which is what makes selling possible. A one-sided gift is allowed; an exchange with both
  stashes empty cannot be locked by the second player (see Refusals).

### Non-goals

Chat, friends, party, trade across distance or worlds, mail or an auction house, trade history UI, stacking
quantities, and any limit on what gold or items may change hands beyond the refusals below.

### Anti-goals

- Items recreated from their type. Trades MOVE the `player_items` row (SOMET-498 lesson: rarity, level and affixes
  are never copied).
- A second OK that can be scored by a double click on the first.

### Starting a trade

- New rebindable action `trade`, default key `T`, listed in `GameSettings.jsx`.
- The target is the player under the cursor if within range, otherwise the nearest player within range. Cursor
  first because a nearest-only rule makes the farther player unreachable (SOMET-487). Left click is not used: it
  attacks, and PvP has no toggle.
- Range `TRADE_INVITE_RADIUS` = 120 px (the existing `INTERACT_RADIUS`), checked by the server from live
  positions. Both must be in the same world, alive, and not already in a trade or invite.
- The target sees a small card: "{name} wants to trade" with Accept (`Y`) and Decline (`N`). It does not open a
  window or take the mouse from the game. It expires after 30 s.
- One outstanding invite per inviter; at most one invite every 3 s per inviter, enforced by the server.
- Names come from `characters.name`; the wire player frame has none today, so the server reads it when the invite
  and the session are created and sends it in the frames.
- On accept, both clients close every other panel and open the trade window.

### Server state

`backend/src/authority/playerTrade.js`: a pure state machine with an injected clock and no DB or socket access.

- Session: `{ id, worldId, a, b, phase, secondOkAt }`, each side `{ userId, characterId, name, itemIds, gold, locked,
  confirmed }`.
- Phases: `open` -> `both_locked` -> `settling` -> ended. `lock` is one-way. `setItem`/`setGold` on a locked side is
  refused. `confirm` is refused unless `both_locked` and `now >= secondOkAt` (`bothLockedAt + 1500 ms`), which is
  the anti-double-click and anti-last-moment-swap rule. A client enables the button at the same moment, but the
  server is the authority.
- Sessions live in memory only. A server restart simply ends them; nothing has moved, because items stay with
  their owner until settlement. There is no escrow.
- Aborting is allowed until settling starts, including after your own second OK. Once `settling` starts, aborts are
  ignored and the settlement's result decides.
- Abort triggers: Abort button, Esc, window X, disconnect, death, world change (`transition`), distance over
  `TRADE_BREAK_RADIUS` = 240 px (checked on the tick at no more than 2 Hz), and a server-side refusal at settlement.
  Everything was still owned by its owner, so abort needs no restoring.

### Inventory freeze during a session

The message dispatcher gets an **allowlist** for a user in a session: `input`, `attack`, `castSkill`, `ping`,
`autoloot` and the `trade*` frames. All others answer `finish the trade first` and do nothing. Allowlist rather than
blocklist so a future inventory handler cannot slip past. This keeps an offered item from being sold, enchanted,
socketed or equipped, and a session's content from changing other than through its own frames. Settlement still
re-validates everything, because the freeze is not the guard against duplication: the transaction is.

Autoloot may still add items and gold may still arrive, which is harmless: settlement checks capacity and balance
at that moment.

### Refusals when offering an item

Same rules and words as the chest, checked by the server against the database:

- not yours; worn (`unequip it first`); a stone (`stones cannot be traded`); hosts a stone (`unsocket the stone first`);
- soulbound (`starting gear cannot be traded`): the SOMET-277 faucet would otherwise reopen by routing starting gear
  through a second account;
- currency-category rows cannot be offered;
- stash limit: 16 items.

Gold: integer, 0 or more, no more than the offerer's balance when set. Non-integer, negative, NaN and overflow are
refused.

Second lock with both stashes empty is refused (`nothing to trade`).

### Settlement

`backend/src/services/tradeSettlement.js`, one transaction:

1. Lock both `users` rows, `ORDER BY id`, `FOR NO KEY UPDATE`, then all offered `player_items` rows, `ORDER BY id`,
   `FOR UPDATE`. This order prevents a deadlock between two settlements. `sellItem` locks item before user, so the
   two could only cycle if the same user sold an offered item during settlement, which the freeze blocks; if it
   ever happened, Postgres aborts one, nothing moves, and the session ends with `trade failed`.
2. Re-check for every item: `character_id` still the offerer's, not in `player_equipment`, not a stone or stone
   host, not soulbound.
3. Capacity for each side: used - given + received, where given and received count as `usedSlots` counts them,
   against that character's live capacity. A side that does not grow is never refused, so an over-cap character can
   still give items away.
4. Gold with guarded updates (`WHERE gold >= $n`), debit and credit net per user.
5. `UPDATE player_items SET character_id = <receiver> WHERE id = ANY(...) AND character_id = <giver>`; `rowCount` must
   equal the count offered.
6. Any refusal rolls back and ends the session with the reason; nothing has moved.
7. COMMIT, then update the live mirrors of whichever players are currently online, looked up fresh by `userId`
   (either may have reconnected). Mirror updates are idempotent by item id. Received items take the full live
   shape, including affixes with `effect` and `label` (see `loadAffixes`), so the item is not inert until a reconnect.
8. Re-derive stats is not needed for worn gear (none moves) but capacity and gold frames are sent.
9. One structured log line per completed trade (both character ids, item ids, gold). No new table.

No migration is needed: `player_items.character_id` moving between characters is already what the holder constraint
allows, and the tables referencing the row (equipment, affixes, stone instances) are either refused or travel with
the item id.

A player who reconnects while their session is settling waits for the settlement before their inventory is read, so
the new session can never load a copy of an item that has just left.

A completed trade counts once: the settlement starts on the `confirm` that completes both, from that socket's
`chainOp`; `phase = settling` is set synchronously before the first await.

### Wire protocol

Client to server: `tradeInvite {targetId}`, `tradeRespond {accept}`, `tradeItem {itemId, add}`, `tradeGold {amount}`,
`tradeLock`, `tradeConfirm`, `tradeAbort`.

Server to client: `tradeInvited {fromName, expiresInMs}`, `tradeState {partnerName, phase, mine, theirs,
confirmOpensInMs}`, `tradeEnded {completed, reason, removedItemIds, addedItems, gold}`.

A side in `tradeState` is `{items, gold, locked, confirmed}`. Each item carries everything a tooltip and icon need
for an item the viewer does not own: rarity, item level, enchant level, affixes and the item's **type row**, because
`inventory.types` on the viewer's client may not contain the partner's item type.

### Window

Layout C from the chest work: a 408x480 window at the paired position, full inventory beside it, Game flag `tradeOpen`
following the paired-window rules (`_pairedKind()` returns `trade`; `inventoryOpen` never set).

From top: title `Trade with {name}` and X; their stash (8x2 grid, read-only) with a status label; their gold; your
stash (8x2 grid); your gold field; status line; buttons OK and Abort.

- Drag from inventory to your stash adds. Drag from your stash to the inventory removes. Client refuses worn items with
  the existing hint; server stays the authority.
- Gold: click the field, type digits, Backspace, Enter or blur commits. Keys go only to the field while it has focus.
- Button text by phase: `OK` -> `Waiting for {name}` (disabled) -> `Confirm` (disabled during the 1.5 s, then enabled) ->
  `Waiting for {name}` (disabled).
- Status words for each side: `Editing`, `Locked`, `Confirmed`.
- Locked stashes draw a green border; a stash edited by the partner flashes for 1 s.
- Hover shows the item tooltip with compare lines, same as merchant.
- All strings go through `t()` and get Ukrainian entries.
- Outcome toast: `Trade complete`, or the reason it ended.
- Reuses `storageWindows.js` drawing and `pairedDrop.js` rules; HUD buttons and minimap hide through
  `pairedWindowHud.jsx` as with the chest.

## Constraints

- Canvas game: pure layout and draw functions, Game turns hit areas into frames, server is the authority.
- Raw pg; one transaction; ownership predicate in the moving statement.
- Shared dev DB is never mutated by tests: `TEST_DATABASE_URL` and `DATABASE_URL` both point at a scratch DB.
- Headless Chrome only with `--mute-audio`.

## Left to the builder

File layout inside the frontend, exact pixel layout within the window, and the toast mechanism (reuse what the chest
uses).
