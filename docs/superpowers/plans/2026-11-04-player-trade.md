# Player Trade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two nearby players exchange items and gold through stashes, with a first OK that locks and a second OK from both that runs the swap.

**Architecture:** A pure in-memory session machine on the server; items stay with their owner until one DB transaction moves them. The dispatcher freezes inventory frames during a session. The client adds a paired window using the chest window's rules.

**Tech Stack:** Node, raw pg, ws, node:test; canvas client, vitest.

**Spec:** `docs/superpowers/specs/2026-11-04-player-trade-design.md`

## Global Constraints

- Work only in worktree `.worktrees/wt-player-trade`, branch `feat/player-trade`. Never touch the shared checkout. Do not push.
- DB tests: put BOTH vars on the same command line as the run, every time: `TEST_DATABASE_URL=postgres://user:password@localhost:15432/game_db_trade DATABASE_URL=postgres://user:password@localhost:15432/game_db_trade`. Never run a test without them; a bare run mutates the shared dev DB. Never `kill -9` a DB test.
- Trust the exit code of a test run, never the `# fail` line. Do not chain the run with `;`.
- Item rows are moved, never recreated. Ownership predicate lives in the moving statement.
- Every transaction refusal ROLLBACKs; never `return` inside an open BEGIN.
- No new table or migration.
- User-visible strings go through `t()` with an entry in `frontend/src/games/something2/src/js/i18n/uk/panels2.js`. Refusal strings from the server: exact text in the spec.
- Commit subject `type(scope): summary (SOMET-NNN)`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Values: invite radius 120 px, break radius 240 px, invite expiry 30000 ms, invite throttle 3000 ms, confirm delay 1500 ms, stash limit 16, distance check at most 2 Hz.

## Review Focus

- A player double-clicks OK: the first click locks, the second lands on a disabled Confirm and does nothing; the server refuses a confirm before `secondOkAt`.
- Both players send the final confirm at the same moment: settlement runs exactly once (Task 3 test).
- One player disconnects while settlement is awaiting: items end up moved once, the partner gets `tradeEnded`, no crash from a missing live player (Task 2 and Task 3 tests).
- A reconnected session whose mirror was loaded before COMMIT: the mirror update does not duplicate the item (Task 2 test).
- A partner item whose type the viewer has never seen: icon and tooltip still draw (Task 4 test).

---

### Task 1: Session state machine (SOMET-726)

**Files:**
- Create: `backend/src/authority/playerTrade.js`
- Test: `backend/tests/player_trade_session.test.js`

**Interfaces:**
- Produces, all from `createTradeRegistry({ now = Date.now })`. A participant is `{ userId, characterId, name }`. Every call returns `{ ok: true, ... }` or `{ ok: false, reason }` and never throws on bad input:
  - `invite(from, target)` -> `{ ok, expiresInMs }`
  - `respond(targetUserId, accept)` -> `{ ok, accepted, inviterUserId, session? }`
  - `sessionOf(userId)` -> session or null; `isBusy(userId)` -> boolean (session or live invite either way)
  - `setItem(userId, itemId, add)`, `setGold(userId, amount, balance)`, `lock(userId)` -> `{ ok, session }`
  - `confirm(userId)` -> `{ ok, session, settle }`; `settle` is true exactly once, and `phase` is already `settling` when it returns
  - `abort(userId)` -> `{ ok, session, partnerUserId }`, refused during `settling`
  - `finish(sessionId)` removes a session; `expireInvites()` -> list of `{ inviterUserId, targetUserId }` removed
  - `sessions()` iterates live sessions, for the distance check
  - `sideOf(session, userId)`, `partnerOf(session, userId)`
- Exports constants `INVITE_EXPIRY_MS`, `INVITE_THROTTLE_MS`, `CONFIRM_DELAY_MS`, `STASH_LIMIT`, `TRADE_INVITE_RADIUS`, `TRADE_BREAK_RADIUS`.

- [ ] **Step 1: Write failing tests.** Names and assertions:
  - `first OK locks and cannot be edited`: after `lock(a)`, `setItem(a,...)` and `setGold(a,...)` are refused, and a second `lock(a)` is refused or a no-op without changing state.
  - `the unlocked partner can still edit after the first OK`: `setItem(b,...)` ok.
  - `there is no way to un-lock`: the registry exposes no `unlock`; only `abort` removes the lock, and it ends the session.
  - `confirm refused until both locked`: `confirm(a)` with only `a` locked is refused.
  - `confirm refused for 1500 ms after both lock`: clock at +1499 refused, +1500 ok.
  - `settle is true once, only after both confirm`: `a` then `b`; `a` gets `settle:false`, `b` gets `settle:true`; a repeat `confirm(b)` is refused and never gives `settle:true`.
  - `abort after own second OK is allowed, before the partner's`.
  - `abort is refused during settling`.
  - `second lock with both stashes empty is refused 'nothing to trade'`; a first lock with an empty stash is allowed; a one-sided gift completes.
  - `stash limit 16`; duplicate add is a no-op; removing an absent id is refused.
  - `gold`: `1.5`, `-1`, `NaN`, `"5"`, `Infinity`, `2**53`, and over balance are refused; `0` and exact balance ok.
  - `invite`: to self refused; busy target refused; second invite while one is live refused; within 3000 ms of the last refused; expired after 30000 ms (`expireInvites` returns it, `respond` refused); a declined invite leaves both not busy; only the target can respond.

- [ ] **Step 2: Run, verify they fail.** Run: `cd backend && node --test tests/player_trade_session.test.js`. Expected: module not found.
- [ ] **Step 3: Implement** with session shape from the spec: `{ id, worldId, a, b, phase: 'open'|'both_locked'|'settling', secondOkAt }`, side `{ userId, characterId, name, itemIds: [], gold: 0, locked: false, confirmed: false }`. `worldId` passed on the `from` participant. No DB or socket imports.
- [ ] **Step 4: Run, verify they pass.** Same command, exit 0.
- [ ] **Step 5: Commit** `feat(trade): session state machine with one-way lock and second OK (SOMET-726)`.

### Task 2: Atomic settlement (SOMET-727)

**Files:**
- Create: `backend/src/services/tradeSettlement.js`
- Test: `backend/tests/trade_settlement_db.test.js` (real DB, follow `account_chest_instance_db.test.js` for fixtures and cleanup)

**Interfaces:**
- Consumes: session shape from Task 1; `usedSlots`, `capacityOf` from `authority/items.js`.
- Produces:
  - `validateOffer(db, characterId, itemId)` -> `{ ok: true, item }` or `{ ok: false, reason }`, unlocked read with the same refusals as settlement, used when offering. `item` is the display shape (below).
  - `settleTrade(pool, entry, session)` -> `{ ok: true, a: Outcome, b: Outcome }` or `{ ok: false, reason }`, where `Outcome` is `{ removedItemIds, addedItems, gold }` and `addedItems` are the live shape: `id, typeId, quantity, soulbound, rarity, itemLevel, enchantLevel, affixes[{affixTypeId,key,label,value,effect}]`. Export `loadAffixes` from `accountChest.js` for this rather than copying it.
  - `applyOutcomeToLive(entry, userId, outcome)`: looks up `entry.world.getPlayer(userId)` fresh; missing player is a no-op; filters removed ids; pushes an added item only if its id is absent; sets `p.gold`.

- [ ] **Step 1: Write failing DB tests.**
  - `swap moves the same rows with identity intact`: a rolled item with rarity, item level, enchant level and 2 affix rows: after settlement same `id`, new `character_id`, same values, affix rows untouched.
  - `gold moves net`: A offers 100, B offers 30: A -70, B +70.
  - `one-sided gift works`.
  - A refusal test for each, asserting every row and both balances unchanged: item no longer owned, worn, stone, stone host, soulbound, receiver has no capacity, not enough gold at settlement.
  - `capacity counts what the receiver gives away`: full receiver giving 1 and getting 1 succeeds.
  - `opposite trades do not deadlock`: two `settleTrade` at once over overlapping users/rows resolve inside 5 s with exactly one winning for the contested item.
  - `live mirror: added item carries affix effect`, `applyOutcomeToLive twice leaves one copy`, `missing player is a no-op`.
- [ ] **Step 2: Run, verify they fail.** Run: `cd backend && TEST_DATABASE_URL=...game_db_trade DATABASE_URL=...game_db_trade node --test tests/trade_settlement_db.test.js`.
- [ ] **Step 3: Implement** the transaction steps listed in the spec's Settlement section, in that order. Settlement does not call `applyOutcomeToLive`; Task 3 does.
- [ ] **Step 4: Run twice** on the scratch DB; both exit 0 (a fail-then-pass or pass-then-fail is a defect).
- [ ] **Step 5: Commit** `feat(trade): atomic settlement moving item rows and gold (SOMET-727)`.

### Task 3: Authority wiring (SOMET-728)

**Files:**
- Modify: `backend/src/authority/server.js`
- Create: `backend/src/authority/tradeFrames.js` (frame builders and the allowlist, pure)
- Test: `backend/tests/trade_frames.test.js`, `backend/tests/authority_trade_integration.test.js` (real server + DB + two raw ws clients, follow `authority_chests_broadcast_integration.test.js`)

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces wire frames exactly per the spec's Wire protocol section; `TRADE_ALLOWED_FRAMES` set; `tradeStateFrame(session, viewerUserId, itemsById, typesById, nowMs)`.

Decisions:
- Registry is one per server. Dispatcher check goes right before `messageHandlers[msg.type]`: a user with a session and a frame not in `TRADE_ALLOWED_FRAMES` gets `{type:'error', message:'finish the trade first'}` and nothing runs. Verify the real handler names of equip/unequip while building the test: the test iterates `Object.keys(messageHandlers)` minus the allowlist and asserts each is refused.
- `tradeConfirm` runs in `chainOp`, calling `confirm` synchronously first; on `settle:true` it runs `settleTrade`, `applyOutcomeToLive` for both, sends each `tradeEnded`, `wallet`, logs one line, then `finish`. `finish` runs in a `finally` so a thrown settlement ends the session with `reason: 'trade failed'`.
- `tradeItem` add runs `validateOffer` and caches the display item on the session (`itemsById`) so `tradeState` reads no DB.
- Name lookup: `SELECT name FROM characters WHERE id = $1`, once on invite for each side.
- `tradeInvite` checks both alive, same world, live distance ≤ 120 px between player centres. Unknown or distant ids give one generic reason `that player cannot trade right now`.
- Abort triggers: `ws.on('close')` before the first await; `onPlayerDeath` synchronously; `relocate`/`transition` send and the `travel` path; a world-tick check at most every 500 ms for distance and expired invites. Close during `settling` must not abort.
- Partner gets `tradeEnded {completed:false, reason}` with reasons `{name} cancelled the trade`, `{name} left`, `{name} died`, `you moved too far apart`.

- [ ] **Step 1: Write failing tests.**
  - Pure: `every handler except the allowlist is frozen`, built from the real handler list.
  - Integration, each with two ws clients: `full trade moves items and gold, both get tradeEnded completed`; `forged itemId belonging to the partner is refused`; `distant target refused`; `sell during a session answers finish the trade first and the item is not sold`; `close mid-session ends it, partner told, nothing moved`; `both confirm in the same tick settles once`; `close during settling still moves once and partner gets tradeEnded`; `walking beyond 240 px aborts`; `partner frame carries type row and affixes`.
- [ ] **Step 2: Run, verify they fail** with both DB vars on the line.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run twice,** both exit 0. Then run `tests/trade.test.js tests/account_chest.test.js` for regressions.
- [ ] **Step 5: Commit** `feat(trade): authority frames, inventory freeze and abort triggers (SOMET-728)`.

### Task 4: Client trade window (SOMET-729)

**Files:**
- Create: `frontend/src/games/something2/src/js/systems/tradeWindow.js` (`layoutTradeWindow`, `drawTradeWindow`, `tradeButtonState`), `systems/tradeGoldField.js` (pure text-field reducer)
- Modify: `systems/pairedDrop.js`, `systems/storageWindows.js` (`drawPairedOverlay` accepts `tradeitem` drags), `core/Game.js`, `net/WorldAuthorityClient.js`, `pairedWindowHud.jsx` if it reads the kinds, `i18n/uk/panels2.js`
- Test: `systems/__tests__/tradeWindow.test.js`, `systems/__tests__/tradeGoldField.test.js`, additions to `pairedDrop` tests

**Interfaces:**
- Consumes: `tradeState` and `tradeEnded` frames from Task 3.
- Produces: client methods `sendTradeInvite(targetId)`, `sendTradeRespond(accept)`, `sendTradeItem(itemId, add)`, `sendTradeGold(amount)`, `sendTradeLock()`, `sendTradeConfirm()`, `sendTradeAbort()`; callbacks `onTradeInvited`, `onTradeState`, `onTradeEnded`; Game state `tradeOpen`, `trade` (last frame), `tradeInvite`; `_pairedKind()` returns `'trade'`. Task 5 calls `sendTradeInvite`, `sendTradeRespond` and reads `tradeInvite`.
- `layoutTradeWindow({ trade, types, goldField, nowMs })` -> same frame shape as `layoutChestWindow` with `kind: 'trade'`, `theirCells`, `myCells` (8x2), `okButton`, `abortButton`, `goldRect`, and hit kinds `tradeitem`, `tradeok`, `tradeabort`, `tradegold`, `winclose`.
- `tradeButtonState(trade, nowMs)` -> `{ label, enabled }`.

- [ ] **Step 1: Write failing tests.**
  - `tradeButtonState` walks: open unlocked -> `OK` enabled; mine locked, theirs not -> `Waiting for {name}` disabled; both locked, `confirmOpensInMs` not elapsed -> `Confirm` disabled; elapsed -> `Confirm` enabled; mine confirmed -> `Waiting for {name}` disabled.
  - Layout: a partner item with a type row in the frame and none in `types` has `cell.type` set and no hit area of a draggable kind; 16 items each side fit; locked side has no `tradeitem` hit areas on my cells; all cells inside the panel; buttons inside the panel.
  - `resolvePairedDrop`: inventory item onto window -> `{action:'offer', id}` with hint; worn -> refuse; `tradeitem` onto inventory -> `{action:'unoffer', id}`; when mine is locked, no drop action; an item already offered is not offered twice.
  - Gold reducer: digits append, non-digits ignored, Backspace, cap at 15 digits, Enter returns commit, empty commits 0, leading zeros collapse.
  - Source gate on `Game.js`: every `tradeabort`/`winclose` path calls `sendTradeAbort`; `_otherPanelOpen` covers `tradeOpen`.
- [ ] **Step 2: Run, verify they fail.** Run: `cd frontend && npx vitest run src/games/something2/src/js/systems/__tests__/tradeWindow.test.js`.
- [ ] **Step 3: Implement.** Frames arriving after the window closed locally must not reopen it (same gating as `_bankRequestedAt`); `tradeEnded` carrying `removedItemIds`/`addedItems`/`gold` updates the inventory mirror even when the window is closed. Partner item types go into a local map merged for tooltips, not into `inventory.types`. Focused gold field consumes keydown before hotkeys; Esc with the field focused only blurs. Drag cancels on lost release like the other windows.
- [ ] **Step 4: Run** the related tests and then `cd frontend && npx vitest run`; exit 0.
- [ ] **Step 5: Commit** `feat(trade): client window with stashes, gold and two-stage OK (SOMET-729)`.

### Task 5: Invite flow (SOMET-730)

**Files:**
- Create: `frontend/src/games/something2/src/js/systems/tradeInvite.js` (`pickTradeTarget`, `layoutInviteCard`, `drawInviteCard`)
- Modify: `core/Game.js`, `frontend/src/games/something2/GameSettings.jsx`, `systems/RenderSystem.js` (draw card), `i18n/uk/panels2.js`, keybind defaults where `openChest` is defined
- Test: `systems/__tests__/tradeInvite.test.js`

**Interfaces:**
- Consumes: `sendTradeInvite`, `sendTradeRespond`, `tradeInvite` from Task 4.
- `pickTradeTarget({ me, remotePlayers, hoverKey, radius = 120 })` -> player id or null. `hoverKey` is `p:<id>` from `renderSystem._inspectHoverKey`; note that key is only computed with inspect on, so if it is off use a direct hit-test helper from `inspect.js` on the cursor.

- [ ] **Step 1: Write failing tests.** `cursor target wins over a nearer player`; `cursor target out of range falls to nearest in range`; `nobody in range is null`; `a dead remote is skipped`; card layout inside the canvas at the top centre with a long name clipped; source gate: `trade` key is in the settings list with default `t`; `y`/`n` act only while `tradeInvite` is live, and otherwise fall through to their normal binding.
- [ ] **Step 2: Run, verify they fail.**
- [ ] **Step 3: Implement.** T while any panel is open does nothing. Card click Accept/Decline works; the card expires on the client at `expiresInMs`. No target gives toast `No player nearby`. Refusals show as the existing error toast.
- [ ] **Step 4: Run** `cd frontend && npx vitest run`; exit 0.
- [ ] **Step 5: Commit** `feat(trade): T key invite and accept card (SOMET-730)`.

### Task 6: Two-browser verification (SOMET-731)

Run by the controller, not a subagent: two muted Chromes on a stack from this worktree on `game_db_trade`, walking the ticket's checklist, with screenshots. Defects found return to the owning task's code with a regression test.
