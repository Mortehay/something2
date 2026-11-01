'use strict';

// A practice target at the entry-world spawn, for measuring your own damage.
//
// It is a creature in the ordinary sim (so every attack, skill, projectile and
// area already hits it) flagged `isDummy`. Three places know the flag:
//   - damage.js applyDamage hands every PLAYER hit to recordHit() and then
//     refuses to let the hit lower its hp, so it can never die;
//   - creatures.js tick() skips it (no AI, no attacks, no movement), and
//     getDirty()/pruneInactive() leave it alone (it has no world_creatures row);
//   - snapshotAOI sends its name so the client can label it.
// Damage dealt to it by anything that is not a player is ignored.
//
// Stats are kept per attacker as a "session": hits close together belong to one
// session, a pause longer than IDLE_RESET_MS starts the next from zero.

const DUMMY_TYPE = 'Training Dummy';
const DUMMY_MAX_HP = 1000000;
const IDLE_RESET_MS = 6000;   // a pause this long ends a session
const WINDOW_MS = 5000;       // "current DPS" looks at the last 5 seconds
// First choice: on the flat stone strip north-east of the Vale Crossing spawn
// (picked on a screenshot); the rest are fallbacks for worlds where it is blocked.
const SPAWN_OFFSETS = [[296, -384], [300, 0], [-300, 0], [0, 300], [0, -300], [450, 150], [-450, 150], [150, 450], [-150, -450]];

function newSession(now) {
  return { start: now, last: now, total: 0, hits: 0, max: 0, recent: [] };
}

// Called from applyDamage for every hit a player lands on the dummy.
function recordHit(dummy, amount, userId, now) {
  const t = Number.isFinite(now) ? now : 0;
  if (!dummy.sessions) dummy.sessions = new Map();
  let s = dummy.sessions.get(userId);
  if (!s || t - s.last > IDLE_RESET_MS) {
    s = newSession(t);
    dummy.sessions.set(userId, s);
  }
  s.last = t;
  s.total += amount;
  s.hits += 1;
  if (amount > s.max) s.max = amount;
  s.recent.push([t, amount]);
  // Drop what has left the window (keeps the array tiny).
  const cutoff = t - WINDOW_MS;
  let i = 0;
  while (i < s.recent.length && s.recent[i][0] < cutoff) i += 1;
  if (i > 0) s.recent.splice(0, i);
}

// The numbers shown to the player at world time `now`.
function sessionStats(s, now) {
  const t = Number.isFinite(now) ? now : s.last;
  const cutoff = t - WINDOW_MS;
  let recentSum = 0;
  for (const [rt, amt] of s.recent) if (rt >= cutoff) recentSum += amt;
  // Early in a session the window is shorter than 5 s: divide by what has
  // actually elapsed (at least one second) so the first swings are not diluted.
  const windowSec = Math.max(1, Math.min(WINDOW_MS, t - s.start) / 1000);
  const activeSec = Math.max(1, (s.last - s.start) / 1000);
  return {
    dps: Math.round(recentSum / windowSec),
    avg: Math.round(s.total / activeSec),
    total: Math.round(s.total),
    hits: s.hits,
    max: Math.round(s.max),
    secs: Math.round(activeSec * 10) / 10,
  };
}

// Sessions that are still live at `now` (hit within IDLE_RESET_MS), as
// [userId, stats]. Frames stop once a session goes idle, and the client keeps
// the last numbers on screen for a while.
function liveSessions(dummy, now) {
  const out = [];
  if (!dummy || !dummy.sessions) return out;
  for (const [userId, s] of dummy.sessions) {
    if (now - s.last <= IDLE_RESET_MS) out.push([userId, sessionStats(s, now)]);
  }
  return out;
}

function findDummy(creatures) {
  for (const c of creatures.creatures.values()) if (c.isDummy) return c;
  return null;
}

// Puts the dummy a few tiles from the entry spawn, on the first free spot.
// Returns the creature, or null for a world that has no entry spawn.
function placeDummy(entry) {
  const row = entry && entry.row;
  const es = row && row.is_entry ? row.entry_spawn : null;
  if (!es || !Number.isFinite(es.x) || !Number.isFinite(es.y)) return null;
  const sim = entry.world.creatures;
  const existing = findDummy(sim);
  if (existing) return existing;
  const map = entry.world.map;
  const free = (x, y) => !map || typeof map.isWalkable !== 'function'
    || [[0, 0], [48, 0], [0, 48], [48, 48]].every(([dx, dy]) => map.isWalkable(x + dx, y + dy));
  let at = null;
  for (const [dx, dy] of SPAWN_OFFSETS) {
    if (free(es.x + dx, es.y + dy)) { at = { x: es.x + dx, y: es.y + dy }; break; }
  }
  if (!at) at = { x: es.x + SPAWN_OFFSETS[0][0], y: es.y + SPAWN_OFFSETS[0][1] };
  sim.addCreatures([{
    id: `dummy:${entry.worldId}`, type: DUMMY_TYPE, name: DUMMY_TYPE,
    x: at.x, y: at.y, hp: DUMMY_MAX_HP, level: 1, damage: 0, color: '#b45309', faction: 'hostile',
  }]);
  const c = sim.get(`dummy:${entry.worldId}`);
  if (!c) return null;
  c.isDummy = true;
  c.hp = c.maxHp = DUMMY_MAX_HP;
  c.dirty = false;
  return c;
}

module.exports = {
  DUMMY_TYPE, DUMMY_MAX_HP, IDLE_RESET_MS, WINDOW_MS,
  recordHit, sessionStats, liveSessions, findDummy, placeDummy,
};
