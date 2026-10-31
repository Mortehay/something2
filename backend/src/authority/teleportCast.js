// Teleport cast: a 2.5s channel started with T that, once it completes, lets
// the character pick ANY portal they have lit (the travel frame then skips the
// "stand on a lit portal" rule for one trip).
//
// PURE and clock-injected, like lifeCost.js: the caller owns the player object
// and the DB, this module owns the rules, so each can be tested without a
// socket. The authority is the only judge -- the client draws a cast bar for
// feedback, but a client that never waits still gets nothing: the ticket below
// is only ever issued by `checkCast` returning 'ready'.
const { lifeCostFor, canPayLife } = require('../services/lifeCost.js');

const CAST_MS = 2500;
// How long the "choose a destination" ticket stays valid after the cast.
const TICKET_MS = 60000;
// Mana the cast costs (a Cultist pays the life-cost equivalent, as for skills).
const MANA_COST = 30;
// Pixels of drift that count as "moved" (absorbs float noise, not a step).
const MOVE_EPS = 6;

const NO_SAVED_POINT = 'Немає збереженої точки телепортації!';

// null when affordable, else the pool that refused. Mirrors world.js's
// resourceRefusal so the Cultist's HP-for-mana rule applies here too.
function resourceRefusal(p) {
  if (p.usesLifeCost) {
    const mult = p.stats && p.stats.lifeCostMultiplier;
    return canPayLife(p.hp, lifeCostFor(MANA_COST, mult)) ? null : 'life';
  }
  return p.mana < MANA_COST ? 'mana' : null;
}

// Called only after resourceRefusal returned null (same adjacency rule as
// world.js's spendResources).
function spend(p) {
  if (p.usesLifeCost) p.hp -= lifeCostFor(MANA_COST, p.stats && p.stats.lifeCostMultiplier);
  else p.mana -= MANA_COST;
}

function isCasting(p) {
  return !!p._teleportCast;
}

function beginCast(p, now) {
  p._teleportCast = { startedAt: now, x: p.x, y: p.y, hp: p.hp };
}

function cancelCast(p) {
  const was = !!p._teleportCast;
  p._teleportCast = null;
  return was;
}

// One tick of an active cast. Returns:
//   null     still channelling (or not casting)
//   'moved'  the player walked / was pushed
//   'hurt'   hp dropped since the last check (damage)
//   'poor'   cannot pay at completion (mana drained meanwhile)
//   'ready'  complete: resources were spent and a ticket issued
function checkCast(p, now) {
  const c = p._teleportCast;
  if (!c) return null;
  if (Math.hypot(p.x - c.x, p.y - c.y) > MOVE_EPS) { p._teleportCast = null; return 'moved'; }
  if (p.hp < c.hp - 1e-6) { p._teleportCast = null; return 'hurt'; }
  c.hp = p.hp; // regen may raise it; only a DROP interrupts
  if (now - c.startedAt < CAST_MS) return null;
  p._teleportCast = null;
  if (resourceRefusal(p)) return 'poor';
  spend(p);
  p._teleportTicketUntil = now + TICKET_MS;
  return 'ready';
}

function ticketValid(p, now) {
  return typeof p._teleportTicketUntil === 'number' && now < p._teleportTicketUntil;
}

function consumeTicket(p) {
  p._teleportTicketUntil = 0;
}

module.exports = {
  CAST_MS, TICKET_MS, MANA_COST, MOVE_EPS, NO_SAVED_POINT,
  resourceRefusal, spend, isCasting, beginCast, cancelCast, checkCast, ticketValid, consumeTicket,
};
