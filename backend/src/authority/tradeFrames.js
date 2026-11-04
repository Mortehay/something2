'use strict';

// SOMET-728. The wire shapes of a player-to-player trade and the freeze list. Pure.

const TRADE_FRAMES = [
  'tradeInvite', 'tradeRespond', 'tradeItem', 'tradeGold', 'tradeLock', 'tradeConfirm', 'tradeAbort',
];

// What a player in a session may still send. An allowlist on purpose: an inventory
// handler added later is frozen without anybody having to remember this file.
const TRADE_ALLOWED_FRAMES = new Set(['input', 'attack', 'castSkill', 'ping', 'autoloot', ...TRADE_FRAMES]);

const FREEZE_MESSAGE = 'finish the trade first';

// `joined` is whether this socket has entered a world. A socket that has not is a
// reconnect of a player whose session is still running, and its `join` has to get
// through: refusing it would strand them, and it is what waits for the settlement.
function isFrozenFrame(type, joined) {
  if (type === 'join' && !joined) return false;
  return !TRADE_ALLOWED_FRAMES.has(type);
}

// `type` is the row itself, because the viewer's client may not hold the item type
// of something they do not own.
function frameItems(side, itemsById, typesById) {
  const out = [];
  for (const id of side.itemIds) {
    const item = itemsById.get(id);
    if (item) out.push({ ...item, type: typesById.get(item.typeId) || null });
  }
  return out;
}

function frameSide(side, itemsById, typesById) {
  return {
    items: frameItems(side, itemsById, typesById),
    gold: side.gold,
    locked: side.locked,
    confirmed: side.confirmed,
  };
}

function tradeStateFrame(session, viewerUserId, itemsById, typesById, nowMs) {
  const viewerIsA = session.a.userId === viewerUserId;
  const mine = viewerIsA ? session.a : session.b;
  const theirs = viewerIsA ? session.b : session.a;
  return {
    type: 'tradeState',
    partnerName: theirs.name,
    phase: session.phase,
    mine: frameSide(mine, itemsById, typesById),
    theirs: frameSide(theirs, itemsById, typesById),
    confirmOpensInMs: session.phase === 'both_locked' ? Math.max(0, session.secondOkAt - nowMs) : null,
  };
}

// A trade that did not complete has nothing to apply: `reason` alone, and `gold` null.
// A completed one lists items only when `sameCharacter`: gold is the account's, but a
// player back on another character of the account must not gain or lose these rows.
function tradeEndedFrame(reason, outcome = null, sameCharacter = false) {
  if (!outcome) {
    return { type: 'tradeEnded', completed: false, reason, removedItemIds: [], addedItems: [], gold: null };
  }
  return {
    type: 'tradeEnded',
    completed: true,
    reason: null,
    removedItemIds: sameCharacter ? outcome.removedItemIds : [],
    addedItems: sameCharacter ? outcome.addedItems : [],
    gold: outcome.gold,
  };
}

const tradeInvitedFrame = (fromName, expiresInMs) => ({ type: 'tradeInvited', fromName, expiresInMs });

module.exports = {
  TRADE_ALLOWED_FRAMES, FREEZE_MESSAGE, isFrozenFrame, tradeStateFrame, tradeEndedFrame, tradeInvitedFrame,
};
