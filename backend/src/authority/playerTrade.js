'use strict';

// Player-to-player trade: pure session state machine. No DB, no sockets; the
// clock is injected. Settlement and wiring live elsewhere. Sessions are in
// memory only; items stay with their owner until settlement (no escrow).

const INVITE_EXPIRY_MS = 30000;
const INVITE_THROTTLE_MS = 3000;
const CONFIRM_DELAY_MS = 1500;
const STASH_LIMIT = 16;
const TRADE_INVITE_RADIUS = 120;
const TRADE_BREAK_RADIUS = 240;

const refuse = (reason) => ({ ok: false, reason });

function validParticipant(p) {
  return !!p && typeof p === 'object' && p.userId != null;
}

function newSide(p) {
  return {
    userId: p.userId,
    characterId: p.characterId,
    name: p.name,
    itemIds: [],
    gold: 0,
    locked: false,
    confirmed: false,
  };
}

function createTradeRegistry({ now = Date.now } = {}) {
  const invites = new Map(); // inviterUserId -> { inviter, target, at }
  const inviteByTarget = new Map(); // targetUserId -> inviterUserId
  const lastInviteAt = new Map(); // inviterUserId -> ms
  const sessionsById = new Map();
  const sessionByUser = new Map();
  let nextId = 1;

  function dropInvite(inv) {
    invites.delete(inv.inviter.userId);
    inviteByTarget.delete(inv.target.userId);
  }
  const inviteLive = (inv) => now() - inv.at < INVITE_EXPIRY_MS;

  function isBusy(userId) {
    if (sessionByUser.has(userId)) return true;
    const asInviter = invites.get(userId);
    if (asInviter && inviteLive(asInviter)) return true;
    const byTarget = inviteByTarget.get(userId);
    if (byTarget !== undefined) {
      const inv = invites.get(byTarget);
      if (inv && inviteLive(inv)) return true;
    }
    return false;
  }

  function invite(from, target) {
    if (!validParticipant(from) || !validParticipant(target)) return refuse('invalid');
    if (from.userId === target.userId) return refuse('cannot trade with yourself');
    // A stale invite no longer counts as busy; clear it so the maps stay tidy.
    expireInvites();
    if (isBusy(from.userId)) return refuse('you are already trading');
    if (isBusy(target.userId)) return refuse('player is busy');
    const last = lastInviteAt.get(from.userId);
    if (last !== undefined && now() - last < INVITE_THROTTLE_MS) return refuse('too fast');
    const at = now();
    const inv = { inviter: { ...from }, target: { ...target }, at };
    invites.set(from.userId, inv);
    inviteByTarget.set(target.userId, from.userId);
    lastInviteAt.set(from.userId, at);
    return { ok: true, expiresInMs: INVITE_EXPIRY_MS };
  }

  function respond(targetUserId, accept) {
    const inviterId = inviteByTarget.get(targetUserId);
    const inv = inviterId === undefined ? null : invites.get(inviterId);
    if (!inv) return refuse('no invite');
    if (!inviteLive(inv)) {
      dropInvite(inv);
      return refuse('invite expired');
    }
    dropInvite(inv);
    if (!accept) return { ok: true, accepted: false, inviterUserId: inv.inviter.userId };
    const session = {
      id: `t${nextId++}`,
      worldId: inv.inviter.worldId,
      a: newSide(inv.inviter),
      b: newSide(inv.target),
      phase: 'open',
      secondOkAt: null,
    };
    sessionsById.set(session.id, session);
    sessionByUser.set(session.a.userId, session);
    sessionByUser.set(session.b.userId, session);
    return { ok: true, accepted: true, inviterUserId: inv.inviter.userId, session };
  }

  const sessionOf = (userId) => sessionByUser.get(userId) || null;
  const sideOf = (session, userId) =>
    !session ? null : session.a.userId === userId ? session.a : session.b.userId === userId ? session.b : null;
  const partnerOf = (session, userId) =>
    !session ? null : session.a.userId === userId ? session.b : session.b.userId === userId ? session.a : null;

  function editable(userId) {
    const session = sessionOf(userId);
    if (!session) return { err: refuse('not trading') };
    const side = sideOf(session, userId);
    if (session.phase === 'settling') return { err: refuse('settling') };
    if (side.locked) return { err: refuse('already locked') };
    return { session, side };
  }

  function setItem(userId, itemId, add) {
    const { err, side, session } = editable(userId);
    if (err) return err;
    if (typeof itemId !== 'string' && typeof itemId !== 'number') return refuse('invalid item');
    const i = side.itemIds.indexOf(itemId);
    if (add) {
      if (i === -1) {
        if (side.itemIds.length >= STASH_LIMIT) return refuse('trade is full');
        side.itemIds.push(itemId);
      }
    } else {
      if (i === -1) return refuse('item not offered');
      side.itemIds.splice(i, 1);
    }
    return { ok: true, session };
  }

  function setGold(userId, amount, balance) {
    const { err, side, session } = editable(userId);
    if (err) return err;
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) return refuse('invalid gold');
    if (typeof balance !== 'number' || !Number.isFinite(balance) || amount > balance) return refuse('not enough gold');
    side.gold = amount;
    return { ok: true, session };
  }

  function lock(userId) {
    const { err, side, session } = editable(userId);
    if (err) return err;
    const other = partnerOf(session, userId);
    if (other.locked) {
      const empty = (s) => s.itemIds.length === 0 && s.gold === 0;
      if (empty(side) && empty(other)) return refuse('nothing to trade');
      side.locked = true;
      session.phase = 'both_locked';
      session.secondOkAt = now() + CONFIRM_DELAY_MS;
    } else {
      side.locked = true;
    }
    return { ok: true, session };
  }

  function confirm(userId) {
    const session = sessionOf(userId);
    if (!session) return refuse('not trading');
    if (session.phase !== 'both_locked') return refuse('not ready');
    if (now() < session.secondOkAt) return refuse('too soon');
    const side = sideOf(session, userId);
    if (side.confirmed) return refuse('already confirmed');
    side.confirmed = true;
    let settle = false;
    if (session.a.confirmed && session.b.confirmed) {
      session.phase = 'settling';
      settle = true;
    }
    return { ok: true, session, settle };
  }

  function abort(userId) {
    const session = sessionOf(userId);
    if (!session) return refuse('not trading');
    if (session.phase === 'settling') return refuse('settling');
    const partnerUserId = partnerOf(session, userId).userId;
    finish(session.id);
    return { ok: true, session, partnerUserId };
  }

  function finish(sessionId) {
    const session = sessionsById.get(sessionId);
    if (!session) return;
    sessionsById.delete(sessionId);
    if (sessionByUser.get(session.a.userId) === session) sessionByUser.delete(session.a.userId);
    if (sessionByUser.get(session.b.userId) === session) sessionByUser.delete(session.b.userId);
  }

  function expireInvites() {
    const out = [];
    for (const inv of [...invites.values()]) {
      if (inviteLive(inv)) continue;
      dropInvite(inv);
      out.push({ inviterUserId: inv.inviter.userId, targetUserId: inv.target.userId });
    }
    return out;
  }

  const sessions = () => sessionsById.values();

  return {
    invite, respond, sessionOf, isBusy, setItem, setGold, lock, confirm, abort, finish,
    expireInvites, sessions, sideOf, partnerOf,
  };
}

module.exports = {
  createTradeRegistry,
  INVITE_EXPIRY_MS, INVITE_THROTTLE_MS, CONFIRM_DELAY_MS, STASH_LIMIT,
  TRADE_INVITE_RADIUS, TRADE_BREAK_RADIUS,
};
