/**
 * WorldAuthorityClient — WebSocket client for the authoritative world sim.
 * Sends movement INPUT (never positions); the server owns authority.
 * Input is throttled to ~inputIntervalMs; the caller buffers the returned
 * {seq,dx,dy,dt} for client-side reconciliation.
 */
export class WorldAuthorityClient {
  constructor({ url, token, onJoined, onState, onError, onClose, onCreatures, onKicked, onItems, onPicked, onDropped, onAttackRefused, onTransition, onFrame, onWaypointActivated, onTeleport, onWallet, onShop, onBought, onSold, onBank, onTradeInvited, onTradeState, onTradeEnded, onDeposited, onWithdrawn, onProgression, onQuestProgress, onQuestNode, onAchievement, onChests, onChestOpened, onVfx, onEnchanted, onSkillUpgraded, onGemBought, onGemsImported, onScrollsBought, onWorldBossStatus, onAnnouncement, onDps, onSynergy, onSkillRefused, onParty, onPartyInvite, onPartyError, inputIntervalMs = 50, now = () => performance.now() }) {
    this.url = url;
    this.token = token;
    this.onJoined = onJoined || (() => {});
    this.onState = onState || (() => {});
    this.onError = onError || ((e) => console.error('WorldAuthorityClient:', e));
    this.onClose = onClose || (() => {});
    this.onCreatures = onCreatures || (() => {});
    this.onKicked = onKicked || (() => {});
    this.onItems = onItems || (() => {});
    this.onPicked = onPicked || (() => {});
    this.onDropped = onDropped || (() => {});
    this.onWallet = onWallet || (() => {});
    // Weapon enchanting: the result of a scroll (`enchanted`), and a bought skill level
    // (`skillUpgraded`). Both are one-off replies to a request this client sent.
    this.onEnchanted = onEnchanted || (() => {});
    this.onSkillUpgraded = onSkillUpgraded || (() => {});
    // Skill gems are owned by the server: `gemBought` answers a purchase, `gemsImported`
    // answers the one-time claim of the gems this browser used to keep for itself.
    this.onGemBought = onGemBought || (() => {});
    this.onGemsImported = onGemsImported || (() => {});
    // The smith sold scrolls: the whole stack as it now stands, plus what it cost.
    this.onScrollsBought = onScrollsBought || (() => {});
    this.onShop = onShop || (() => {});
    this.onBought = onBought || (() => {});
    this.onSold = onSold || (() => {});
    this.onWorldBossStatus = onWorldBossStatus || (() => {});
    this.onAnnouncement = onAnnouncement || (() => {});
    this.onDps = onDps || (() => {});
    this.onSynergy = onSynergy || (() => {});
    this.onSkillRefused = onSkillRefused || (() => {});
    // SOMET-310 — the account chest. `onBank` is the whole chest (the server
    // re-sends it after every move, so the panel never reconciles a delta);
    // `onDeposited`/`onWithdrawn` update the INVENTORY mirror instead, and are
    // separate frames because they must land whether or not the panel is open.
    this.onBank = onBank || (() => {});
    // Player-to-player trade. `onTradeInvited` reaches the target only;
    // `onTradeState` is the whole session view for either side (never a delta);
    // `onTradeEnded` ends a session, and also reports how an invite ended.
    this.onTradeInvited = onTradeInvited || (() => {});
    this.onTradeState = onTradeState || (() => {});
    this.onTradeEnded = onTradeEnded || (() => {});
    this.onDeposited = onDeposited || (() => {});
    this.onWithdrawn = onWithdrawn || (() => {});
    // SOMET-372 -- WORLD chests, not the account chest above. `onChests` is
    // the AOI snapshot the server pushes on the creature/item cadence (whole
    // list, never a delta, same rule as onCreatures/onItems); `onChestOpened`
    // is the one-off reply to sendOpenChest and carries the loot rows. XP does
    // NOT come through it -- the server sends a separate `progression` frame
    // for chest XP precisely so it lands on the handler kills already use.
    this.onChests = onChests || (() => {});
    this.onChestOpened = onChestOpened || (() => {});
    // SOMET-482 -- a one-shot PRESENTATION frame, not world state: it carries a
    // name and a position and nothing else, it is never resent, and dropping
    // one costs a puff and nothing more. Unlike onItems/onCreatures there is no
    // "full list" contract to keep in step.
    this.onVfx = onVfx || (() => {});
    this.onParty = onParty || (() => {});
    this.onPartyInvite = onPartyInvite || (() => {});
    this.onPartyError = onPartyError || (() => {});
    this.onAttackRefused = onAttackRefused || (() => {});
    this.onTransition = onTransition || (() => {});
    // Any frame at all: the socket is alive even if the one awaited has not arrived.
    this.onFrame = onFrame || (() => {});
    // SOMET-292 sends this frame; SOMET-293 is the first thing to listen. Without
    // a case here it fell through to the `default` warn -- a lit waypoint that the
    // travel popup never heard about, so the list kept saying "not discovered"
    // until a reload.
    this.onWaypointActivated = onWaypointActivated || (() => {});
    // Teleport cast frames (teleportCastStarted / teleportReady / teleportCancelled),
    // all delivered as one callback with the raw frame.
    this.onTeleport = onTeleport || (() => {});
    // Pushed on XP gain, level-up and death (SOMET-242); the join payload's
    // own `progression` field arrives on `onJoined` instead, same split as
    // `gold` (joined) vs `wallet` (onWallet) above.
    this.onProgression = onProgression || (() => {});
    this.onQuestProgress = onQuestProgress || (() => {});
    this.onQuestNode = onQuestNode || (() => {});
    this.onAchievement = onAchievement || (() => {});
    this.inputIntervalMs = inputIntervalMs;
    this.now = now;

    this.ws = null;
    this.connected = false;
    this.joined = false;
    // Set by disconnect(): once we intentionally tear a socket down, its
    // graceful close() may still be in flight, so late frames (notably a
    // 'kicked' the server sends when our own reconnect trips the single-session
    // guard) can still arrive. This flag makes the message handler drop them so
    // a self-inflicted kick can't corrupt an intentional reconnect.
    this._closed = false;
    this.worldId = null;
    this._seq = 0;
    this._accumDt = 0;
    this._lastSentAt = -Infinity;
  }

  // SOMET-260: the authority refuses any join without a character_id, and does
  // NOT fall back to "the account's first character" -- a silent default would
  // turn a client bug into a successful join as somebody else's character. So
  // this throws rather than opening a socket it knows will be refused: a
  // rejected join surfaces as a bare "unknown character" toast with nothing
  // actionable in it, which is worse than failing here.
  connect(worldId, characterId) {
    if (!Number.isInteger(Number(characterId))) {
      throw new Error('connect() requires a character id');
    }
    this._closed = false;
    this.worldId = worldId;
    this.characterId = Number(characterId);
    const sep = this.url.includes('?') ? '&' : '?';
    const wsUrl = `${this.url}${sep}token=${encodeURIComponent(this.token)}`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    this.ws.addEventListener('open', () => {
      this.connected = true;
      this._send({ type: 'join', world_id: worldId, character_id: this.characterId });
    });
    this.ws.addEventListener('message', (event) => {
      // Drop anything that lands after an intentional disconnect — the socket
      // is being replaced and its late frames are no longer ours to act on.
      if (this._closed) return;
      this.onFrame();
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      this._handleMessage(msg);
    });
    this.ws.addEventListener('error', () => this.onError(new Error('websocket error')));
    this.ws.addEventListener('close', (ev) => {
      // A reconnect replaces this.ws; a late close from the socket it replaced
      // must not mark the new one dead or fire a second onClose.
      if (this.ws && this.ws !== ws) return;
      this.connected = false; this.joined = false;
      // Second arg: whether THIS close was self-inflicted (disconnect()
      // already set _closed before calling ws.close()) vs. the socket just
      // dying under us — callers need that distinction to tell a deliberate
      // teardown (doorway transition, kick, unmount) apart from a fatal,
      // unannounced drop that otherwise leaves them silently stuck (F-028).
      this.onClose(ev, this._closed);
    });
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'joined': this.joined = true; this.onJoined(msg); break;
      case 'state': this.onState(msg); break;
      case 'pong': break;
      case 'creatures': this.onCreatures(msg); break;
      case 'kicked': this.onKicked(msg); break;
      case 'items': this.onItems(msg); break;
      case 'picked': this.onPicked(msg); break;
      case 'dropped': this.onDropped(msg); break;
      case 'wallet': this.onWallet(msg); break;
      case 'enchanted': this.onEnchanted(msg); break;
      case 'skillUpgraded': this.onSkillUpgraded(msg); break;
      case 'gemBought': this.onGemBought(msg); break;
      case 'gemsImported': this.onGemsImported(msg); break;
      case 'scrollsBought': this.onScrollsBought(msg); break;
      case 'shop': this.onShop(msg); break;
      case 'bought': this.onBought(msg); break;
      case 'sold': this.onSold(msg); break;
      case 'bank': this.onBank(msg); break;
      case 'tradeInvited': this.onTradeInvited(msg); break;
      case 'tradeState': this.onTradeState(msg); break;
      case 'tradeEnded': this.onTradeEnded(msg); break;
      case 'deposited': this.onDeposited(msg); break;
      case 'withdrawn': this.onWithdrawn(msg); break;
      // SOMET-494. Sent to this socket alone when an attack was refused because
      // the player cannot PAY for it (mana / life / stamina) -- never for a
      // cooldown, which under a held button would arrive many times a second
      // and means nothing more than "not yet". Nothing local needs rolling
      // back: the server spent nothing and consumed no cooldown.
      case 'attackrefused': this.onAttackRefused(msg); break;
      case 'transition': this.onTransition(msg); break;
      case 'waypointActivated': this.onWaypointActivated(msg); break;
      case 'teleportCastStarted':
      case 'teleportReady':
      case 'teleportCancelled': this.onTeleport(msg); break;
      case 'progression': this.onProgression(msg); break;
      case 'questProgress': this.onQuestProgress(msg); break;
      case 'questNode': this.onQuestNode(msg); break;
      case 'achievement': this.onAchievement(msg); break;
      case 'chests': this.onChests(msg); break;
      case 'chestOpened': this.onChestOpened(msg); break;
      case 'vfx': this.onVfx(msg); break;
      case 'party': this.onParty(msg.party || null); break;
      case 'partyInvite': this.onPartyInvite(msg); break;
      case 'partyError': this.onPartyError(msg); break;
      case 'world_boss_status': this.onWorldBossStatus(msg); break;
      case 'announcement': this.onAnnouncement(msg); break;
      case 'dps': this.onDps(msg); break;
      case 'synergy': this.onSynergy(msg); break;
      case 'skillRefused': this.onSkillRefused(msg); break;
      case 'error': {
        // Tag so callers can tell a server-issued protocol rejection (e.g.
        // "unequip it first") apart from a raw transport failure below —
        // only the former carries a message worth showing the player.
        const err = new Error(msg.message || 'authority error');
        err.isServerRejection = true;
        err.serverMessage = msg.message || null;
        this.onError(err);
        break;
      }
      default: console.warn('WorldAuthorityClient: unknown msg', msg.type);
    }
  }

  // Returns {sent, seq?, dx?, dy?, dt?, inputs?}. dt is the seconds accumulated since the
  // previous actual send (so replay during reconciliation uses the real dt).
  sendInput(dx, dy, dt, sprint = false) {
    if (!this.connected) {
      this._accumDt += dt;
      return { sent: false };
    }
    const now = this.now();
    // A change of sprint is flushed like a change of direction: the accumulated time
    // must be sent (and replayed) at the speed it was actually travelled.
    const dirChanged = (this._lastDx !== undefined
      && (dx !== this._lastDx || dy !== this._lastDy || !!sprint !== !!this._lastSprint));
    const inputs = [];

    // If direction changed and we accumulated dt while moving in the previous direction,
    // flush that previous movement first so the authority and client replay do not drop the distance traveled!
    if (dirChanged && this._accumDt > 0 && (this._lastDx !== 0 || this._lastDy !== 0)) {
      const flushSeq = ++this._seq;
      const flushDt = this._accumDt;
      this._send({ type: 'input', seq: flushSeq, dx: this._lastDx, dy: this._lastDy, dt: flushDt, sprint: !!this._lastSprint });
      inputs.push({ seq: flushSeq, dx: this._lastDx, dy: this._lastDy, dt: flushDt, sprint: !!this._lastSprint });
      this._accumDt = 0;
    }

    this._accumDt += dt;

    if (!dirChanged && (now - this._lastSentAt < this.inputIntervalMs)) {
      if (inputs.length === 0) return { sent: false };
      return {
        sent: true,
        seq: inputs[inputs.length - 1].seq,
        dx: inputs[inputs.length - 1].dx,
        dy: inputs[inputs.length - 1].dy,
        dt: inputs[inputs.length - 1].dt,
        inputs,
      };
    }

    const seq = ++this._seq;
    const sentDt = this._accumDt;
    this._send({ type: 'input', seq, dx, dy, dt: sentDt, sprint: !!sprint });
    this._lastSentAt = now;
    this._lastDx = dx;
    this._lastDy = dy;
    this._lastSprint = !!sprint;
    this._accumDt = 0;
    inputs.push({ seq, dx, dy, dt: sentDt, sprint: !!sprint });

    return {
      sent: true,
      seq,
      dx,
      dy,
      dt: sentDt,
      inputs,
    };
  }

  ping() { this._send({ type: 'ping' }); }

  sendAttack(ax, ay) { this._send({ type: 'attack', ax, ay }); }

  sendCastSkill(skillId, targetX, targetY, ax, ay) {
    return this._send({ type: 'castSkill', skillId, targetX, targetY, ax, ay });
  }

  // Party (backend/src/authority/partyService.js). Plain sends: the server is the
  // only judge of whether any of them is allowed, and answers with partyError.
  sendPartyInvite(targetId) { return this._send({ type: 'partyInvite', targetId }); }
  sendPartyAccept() { return this._send({ type: 'partyAccept' }); }
  sendPartyDecline() { return this._send({ type: 'partyDecline' }); }
  sendPartyLeave() { return this._send({ type: 'partyLeave' }); }
  sendPartyKick(targetId) { return this._send({ type: 'partyKick', targetId }); }
  sendPartyLeader(targetId) { return this._send({ type: 'partyLeader', targetId }); }
  sendPartyLoot(mode) { return this._send({ type: 'partyLoot', mode }); }

  sendEquip(itemId, slot) { this._send({ type: 'equip', itemId, slot }); }

  sendUnequip(slot) { this._send({ type: 'unequip', slot }); }

  sendPickup() { this._send({ type: 'pickup' }); }
  sendDrop(itemId) { this._send({ type: 'drop', itemId }); }
  // Spend one enchant scroll (`scrollId`, a player_items id) on a weapon (`itemId`).
  // The server rolls the dice; the answer arrives as an `enchanted` frame.
  sendEnchant(scrollId, itemId) { return this._send({ type: 'enchant', scrollId, itemId }); }
  // Buy the next level of a skill with gold; answered by `skillUpgraded`.
  sendUpgradeSkill(skillId) { return this._send({ type: 'upgradeSkill', skillId }); }
  // Buy a skill gem from the merchant next to you; answered by `gemBought` (or an error).
  sendBuyGem(skillId) { return this._send({ type: 'buyGem', skillId }); }
  // Buy `quantity` enchant scrolls from the village smith next to you; answered by `scrollsBought`.
  sendBuyScrolls(quantity, kind = 'standard') { return this._send({ type: 'buyScrolls', quantity, kind }); }
  // Claim, once, the gems this browser remembered from before the server owned them.
  sendImportGems(skillIds) { return this._send({ type: 'importGems', skillIds }); }
  sendAutoLoot(on) { return this._send({ type: 'autoloot', on: on === true }); }
  sendInteract() { this._send({ type: 'interact' }); }
  sendBuy(stockId) { this._send({ type: 'buy', stockId }); }
  sendSell(itemId) { this._send({ type: 'sell', itemId }); }

  // SOMET-310. No villageId on any of the three: the server re-resolves the
  // bank post from its own copy of the player's position on every frame, so
  // there is deliberately nothing here for a forged frame to point at a bank
  // the player is not standing next to. `deposit` carries a player_items id,
  // `withdraw` an account_items id -- different tables, and each is checked
  // against its own ownership predicate server-side.
  sendOpenBank() { return this._send({ type: 'openbank' }); }
  sendDeposit(itemId) { return this._send({ type: 'deposit', itemId }); }
  // Trade. The server holds the session; none of these wait on a reply (a no-op
  // edit and a frame whose session ended while queued get none).
  sendTradeInvite(targetId) { return this._send({ type: 'tradeInvite', targetId }); }
  sendTradeRespond(accept) { return this._send({ type: 'tradeRespond', accept: accept === true }); }
  sendTradeItem(itemId, add) { return this._send({ type: 'tradeItem', itemId, add: add === true }); }
  sendTradeGold(amount) { return this._send({ type: 'tradeGold', amount }); }
  sendTradeLock() { return this._send({ type: 'tradeLock' }); }
  sendTradeConfirm() { return this._send({ type: 'tradeConfirm' }); }
  sendTradeAbort() { return this._send({ type: 'tradeAbort' }); }
  sendWithdraw(itemId) { return this._send({ type: 'withdraw', itemId }); }

  // World chests (SOMET-372). No chest id, for the same reason `interact` and
  // the bank sends carry no target: the server proximity-picks the nearest
  // chest within its own INTERACT_RADIUS from its own copy of the player's
  // position, so there is nothing here for a forged frame to point at a chest
  // the player is nowhere near. A refusal comes back as a normal `error`
  // frame ("no chest nearby"), which the caller already surfaces as a toast.
  sendOpenChest() { return this._send({ type: 'openchest' }); }

  // Waypoint travel (SOMET-293). A destination id and nothing else: the server
  // works out where the player is standing from its own copy of the position,
  // so there is deliberately no origin on this frame for a forged one to set.
  // The reply is either an `error` or a `transition`, both of which already have
  // handlers -- travel needs no arrival path of its own.
  sendTravel(waypointId) { return this._send({ type: 'travel', waypointId }); }

  // Teleport cast: start (T) and cancel. Neither carries data; the server owns
  // the clock, the interrupt rules and the resource check.
  sendTeleportCast() { return this._send({ type: 'teleportCast' }); }
  sendTeleportCancel() { return this._send({ type: 'teleportCancel' }); }

  disconnect() {
    // Mark closed BEFORE close() so any frame still queued on the socket is
    // ignored by the message handler rather than dispatched to callbacks.
    this._closed = true;
    if (this.ws) { try { this.ws.close(); } catch { /* already closed */ } this.ws = null; }
    this.connected = false; this.joined = false;
  }

  // Returns whether the frame actually went out. Callers that mirror
  // server-owned state locally must not update that mirror on a false return:
  // a dropped frame means the server never heard the intent, and no later
  // `state` frame will arrive on a dead socket to correct the mirror.
  _send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }
}
