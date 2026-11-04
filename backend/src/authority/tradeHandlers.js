'use strict';

// SOMET-728. Wires the trade session (playerTrade.js) and the settlement
// (tradeSettlement.js) into the live server: the frame handlers, the freeze, the
// abort triggers and the wait a rejoin needs. server.js only calls in.
//
// Sockets are looked up fresh by user every time, through sessionsByUser, because
// either player may have reconnected. A socket that is no longer its user's current
// one speaks for nobody: a frame still queued on a kicked socket's chain must not act
// on whatever the new session has started.

const { createTradeRegistry, TRADE_INVITE_RADIUS, TRADE_BREAK_RADIUS } = require('./playerTrade');
const { validateOffer, settleTrade, applyOutcomeToLive } = require('../services/tradeSettlement');
const {
  FREEZE_MESSAGE, isFrozenFrame, tradeStateFrame, tradeEndedFrame, tradeInvitedFrame,
} = require('./tradeFrames');

const TICK_CHECK_MS = 500;
const CANNOT_TRADE = 'that player cannot trade right now';
const INVITE_CANCELLED = 'invite cancelled';

const centreDistance = (p, q) => Math.hypot(
  (p.x + p.width / 2) - (q.x + q.width / 2),
  (p.y + p.height / 2) - (q.y + q.height / 2),
);

function createTradeHandlers({ pool, worlds, sessionsByUser, send, chainOp, now = Date.now }) {
  const registry = createTradeRegistry({ now });
  const offeredBySession = new Map(); // session id -> Map(item id -> display item), so tradeState reads no DB
  const settlingByUser = new Map(); // userId -> promise of the running settlement; never rejects
  let lastTickCheckAt = -Infinity;

  const isCurrent = (ws) => ws.worldId != null && sessionsByUser.get(ws.userId) === ws;
  const notify = (userId, frame) => {
    const ws = sessionsByUser.get(userId);
    if (ws) send(ws, frame);
  };
  const refuse = (ws, message) => send(ws, { type: 'error', message });
  const endedFor = (userId, reason) => notify(userId, tradeEndedFrame(reason));

  function sendState(session) {
    const entry = worlds.get(session.worldId);
    if (!entry) return;
    const offered = offeredBySession.get(session.id) || new Map();
    for (const side of [session.a, session.b]) {
      notify(side.userId, tradeStateFrame(session, side.userId, offered, entry.world.weapons, now()));
    }
  }

  // Everyone the invite involved other than `userId` hears about it once.
  function dropInvites(userId) {
    for (const { inviterUserId, targetUserId } of registry.dropInvitesOf(userId)) {
      endedFor(inviterUserId === userId ? targetUserId : inviterUserId, INVITE_CANCELLED);
    }
  }

  // Refused once the session is settling: the settlement's result decides then.
  function abortSession(userId, ownReason, partnerReason) {
    const session = registry.sessionOf(userId);
    const r = registry.abort(userId);
    if (!r.ok) return;
    offeredBySession.delete(session.id);
    endedFor(userId, ownReason);
    endedFor(r.partnerUserId, partnerReason);
  }

  function abortFor(userId, ownReason, partnerWords) {
    const side = registry.sideOf(registry.sessionOf(userId), userId);
    if (side) abortSession(userId, ownReason, `${side.name} ${partnerWords}`);
    dropInvites(userId);
  }

  // ---- settlement -----------------------------------------------------------

  function deliver(side, outcome) {
    const ws = sessionsByUser.get(side.userId);
    const entry = ws && worlds.get(ws.worldId);
    if (entry) applyOutcomeToLive(entry, side.userId, outcome);
    if (!ws) return;
    send(ws, tradeEndedFrame(null, outcome, Number(ws.characterId) === outcome.characterId));
    send(ws, { type: 'wallet', gold: outcome.gold });
  }

  const logCompleted = ({ a, b }) => console.log(JSON.stringify({
    event: 'trade_completed',
    a: { characterId: a.characterId, itemIds: a.itemIds, gold: a.gold },
    b: { characterId: b.characterId, itemIds: b.itemIds, gold: b.gold },
  }));

  // Never rejects: the join path and the confirm's chain both wait on it.
  async function settle(session, entry) {
    const { a, b } = session;
    let result;
    try {
      result = await settleTrade(pool, entry, session);
    } catch (err) {
      // A deadlock or any other database error. It rolled back, so nothing moved.
      console.error('trade settlement failed:', err);
      result = { ok: false, reason: 'trade failed' };
    }
    // Apart from the above: a throw from here on must not call a committed trade failed.
    try {
      if (result.ok) {
        deliver(a, result.a);
        deliver(b, result.b);
        logCompleted(session);
      } else {
        endedFor(a.userId, result.reason);
        endedFor(b.userId, result.reason);
      }
    } catch (err) {
      console.error('trade settlement delivery failed:', err);
    } finally {
      registry.finish(session.id);
      offeredBySession.delete(session.id);
      settlingByUser.delete(a.userId);
      settlingByUser.delete(b.userId);
    }
  }

  // ---- frames ---------------------------------------------------------------

  // Both players as they stand right now, or null. Asks of the target's socket too,
  // since a reconnecting target has a stale player and a socket that has not joined.
  function tradePartners(ws, targetId) {
    const entry = worlds.get(ws.worldId);
    if (!entry || targetId == null) return null;
    const me = entry.world.getPlayer(ws.userId);
    const them = entry.world.getPlayer(targetId);
    const targetWs = entry.sockets.get(targetId);
    if (!me || !them || !targetWs || !isCurrent(targetWs) || targetWs.worldId !== ws.worldId) return null;
    if (me.hp <= 0 || them.hp <= 0) return null;
    if (centreDistance(me, them) > TRADE_INVITE_RADIUS) return null;
    return { entry, me, them, targetWs };
  }

  async function characterName(characterId) {
    const r = await pool.query('SELECT name FROM characters WHERE id = $1', [characterId]);
    return r.rows.length ? r.rows[0].name : null;
  }

  // Runs `fn` on this socket's chain for its current session. `fn` re-checks with
  // `stillThis` after any await, because an abort does not wait in the chain.
  function inSession(ws, label, fn) {
    if (!isCurrent(ws)) return;
    chainOp(ws, label, async () => {
      if (!isCurrent(ws)) return;
      const session = registry.sessionOf(ws.userId);
      if (!session) { refuse(ws, 'not trading'); return; }
      await fn(session, () => registry.sessionOf(ws.userId) === session);
    });
  }

  const handlers = {
    tradeInvite(ws, msg) {
      if (!isCurrent(ws)) return;
      const targetId = typeof msg.targetId === 'string' || typeof msg.targetId === 'number'
        ? String(msg.targetId) : null;
      chainOp(ws, 'tradeInvite', async () => {
        if (!isCurrent(ws)) return;
        const before = tradePartners(ws, targetId);
        if (!before) { refuse(ws, CANNOT_TRADE); return; }
        const fromName = await characterName(before.me.characterId);
        const targetName = await characterName(before.them.characterId);
        // Those awaits are long enough for either player to die, move or leave.
        const live = isCurrent(ws) ? tradePartners(ws, targetId) : null;
        if (!live || fromName == null || targetName == null) { refuse(ws, CANNOT_TRADE); return; }
        const worldId = live.entry.worldId;
        const r = registry.invite(
          { userId: ws.userId, characterId: live.me.characterId, name: fromName, worldId },
          { userId: targetId, characterId: live.them.characterId, name: targetName, worldId },
        );
        if (!r.ok) { refuse(ws, r.reason); return; }
        send(live.targetWs, tradeInvitedFrame(fromName, r.expiresInMs));
      });
    },

    // Nothing awaits and leaving drops the invite, so both players are still there.
    tradeRespond(ws, msg) {
      if (!isCurrent(ws)) return;
      const r = registry.respond(ws.userId, msg.accept === true);
      if (!r.ok) { refuse(ws, r.reason); return; }
      if (!r.accepted) { endedFor(r.inviterUserId, 'trade declined'); return; }
      offeredBySession.set(r.session.id, new Map());
      sendState(r.session);
    },

    tradeItem(ws, msg) {
      const add = msg.add === true;
      inSession(ws, 'tradeItem', async (session, stillThis) => {
        const side = registry.sideOf(session, ws.userId);
        let item = null;
        if (add) {
          const offer = await validateOffer(pool, side.characterId, msg.itemId);
          if (!offer.ok) { refuse(ws, offer.reason); return; }
          if (!stillThis()) return;
          item = offer.item;
        }
        const r = registry.setItem(ws.userId, msg.itemId, add);
        if (!r.ok) { refuse(ws, r.reason); return; }
        const offered = offeredBySession.get(session.id);
        if (add) offered.set(msg.itemId, item);
        else offered.delete(msg.itemId);
        sendState(session);
      });
    },

    tradeGold(ws, msg) {
      inSession(ws, 'tradeGold', async (session, stillThis) => {
        // The row, not the live mirror: the rule is the balance at this moment.
        const row = await pool.query('SELECT gold FROM users WHERE id = $1', [ws.userId]);
        if (!stillThis()) return;
        const balance = row.rows.length ? Number(row.rows[0].gold) : 0;
        const r = registry.setGold(ws.userId, msg.amount, balance);
        if (!r.ok) { refuse(ws, r.reason); return; }
        sendState(session);
      });
    },

    // On the chain so it lands after any offer the same client sent before it.
    tradeLock(ws) {
      inSession(ws, 'tradeLock', async (session) => {
        const r = registry.lock(ws.userId);
        if (!r.ok) { refuse(ws, r.reason); return; }
        sendState(session);
      });
    },

    tradeConfirm(ws) {
      inSession(ws, 'tradeConfirm', async () => {
        const r = registry.confirm(ws.userId);
        if (!r.ok) { refuse(ws, r.reason); return; }
        sendState(r.session);
        if (!r.settle) return;
        // `phase` is already `settling`, and from here to the map writes nothing awaits:
        // a rejoin arriving at any later moment finds the promise.
        const run = settle(r.session, worlds.get(r.session.worldId));
        settlingByUser.set(r.session.a.userId, run);
        settlingByUser.set(r.session.b.userId, run);
        await run;
      });
    },

    // Not on the chain: a way out must not wait behind whatever is queued there.
    tradeAbort(ws) {
      if (!isCurrent(ws)) return;
      const side = registry.sideOf(registry.sessionOf(ws.userId), ws.userId);
      if (!side) return;
      abortSession(ws.userId, 'you cancelled the trade', `${side.name} cancelled the trade`);
    },
  };

  return {
    handlers,

    // True when the frame was refused and must not run. Keyed by user, so a second
    // socket of a player in a session is frozen as well.
    refuseIfFrozen(ws, type) {
      if (!registry.sessionOf(ws.userId)) return false;
      if (!isFrozenFrame(type, ws.worldId != null)) return false;
      refuse(ws, FREEZE_MESSAGE);
      return true;
    },

    // The current socket of this user is going. Synchronous, so the caller's first
    // await comes after the partner has been told. Ignored by a session that is settling.
    onLeave(userId) {
      abortFor(userId, 'you left', 'left');
    },

    onDeath(userId) {
      abortFor(userId, 'you died', 'died');
    },

    // Beside every `transition` frame: the player is on their way to another world.
    onWorldChange(userId) {
      abortFor(userId, 'you left', 'left');
    },

    // A rejoin waits for this BEFORE reading the inventory: otherwise a player who
    // dropped during settling loads a copy of the item that has just left, and can
    // equip it. Resolves at once when nothing is settling.
    settled(userId) {
      return settlingByUser.get(userId);
    },

    // On the tick, at most every 500 ms. Must not throw: it runs in a bare setInterval.
    tick() {
      const t = now();
      if (t - lastTickCheckAt < TICK_CHECK_MS) return;
      lastTickCheckAt = t;
      for (const { inviterUserId, targetUserId } of registry.expireInvites()) {
        endedFor(inviterUserId, 'invite expired');
        endedFor(targetUserId, 'invite expired');
      }
      for (const session of [...registry.sessions()]) {
        if (session.phase === 'settling') continue;
        const entry = worlds.get(session.worldId);
        const pa = entry && entry.world.getPlayer(session.a.userId);
        const pb = entry && entry.world.getPlayer(session.b.userId);
        if (pa && pb && centreDistance(pa, pb) <= TRADE_BREAK_RADIUS) continue;
        // A missing player would have been caught by a close; this is the backstop,
        // so no session can outlive its players and freeze the survivor.
        const words = 'you moved too far apart';
        abortSession(session.a.userId, words, words);
      }
    },
  };
}

module.exports = { createTradeHandlers };
