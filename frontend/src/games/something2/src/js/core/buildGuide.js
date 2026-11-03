// Build Guide logic (pure). A "build" is the game's own suggested path for a class:
// the order to take passive nodes, the hotbar to aim for, what to stat, what to
// wear. The data lives in buildGuides.data.js, keyed by STABLE node keys (database
// ids differ between environments); this module resolves it against the passive
// tree the client actually loaded and works out where the player is on the path.
//
// No canvas, no Game: everything here takes plain values so it can be unit-tested.
import { findShortestPath } from "../systems/passiveTreePanel.js";
import { BUILD_GUIDES } from "./buildGuides.data.js";

// How many steps after the next one are shown as "coming up" in the tree.
export const UPCOMING_STEPS = 5;

// The guide for a class name, or null. Case-insensitive: the class name reaches
// the client from the character row and has always been capitalised, but a lookup
// that depends on that is one data fix away from silently showing nothing.
export function getBuildGuide(className, guides = BUILD_GUIDES) {
  if (!className) return null;
  const want = String(className).trim().toLowerCase();
  for (const [name, g] of Object.entries(guides || {})) {
    if (name.toLowerCase() === want) return g;
  }
  return null;
}

// key -> node id for a tree index, cached per index (an index is rebuilt only
// when the tree is refetched).
const KEY_INDEX = new WeakMap();
function keyToId(index) {
  let m = KEY_INDEX.get(index);
  if (!m) {
    m = new Map();
    for (const n of index.byId.values()) if (n && n.key != null) m.set(n.key, n.id);
    KEY_INDEX.set(index, m);
  }
  return m;
}

// The guide's passive steps resolved to node ids on THIS tree. A key the tree does
// not have (a reseed removed it, version skew) resolves to null and is skipped
// everywhere, rather than breaking the whole plan.
export function resolvePlan(guide, index) {
  if (!guide || !guide.passives || !index || !index.byId) return null;
  const k2i = keyToId(index);
  const steps = guide.passives.steps || [];
  const stepIds = steps.map((s) => (k2i.has(s.key) ? k2i.get(s.key) : null));
  return {
    startId: k2i.has(guide.passives.startKey) ? k2i.get(guide.passives.startKey) : null,
    steps,
    stepIds,
    total: steps.length,
    missing: steps.filter((_, i) => stepIds[i] == null).map((s) => s.key),
  };
}

// Where the player is on the plan.
//   done        steps already allocated
//   total       steps in the plan
//   nextIndex   index (0-based) of the first step not yet allocated, or -1 if none
//   nextStep    that step's {key,label,kind}
//   nextId      the node to click NEXT. Usually the next step itself. If the player
//               wandered off the path so that step is not adjacent to anything they
//               own, it is the first node of the shortest route to it (`detour`).
//   detour      true in that case
//   upcomingIds the next few unallocated steps (nextId's step first)
//   plannedIds  every unallocated step (drawn faintly)
//   upcomingSteps  the next few unallocated steps as {n (1-based), key, label, kind}
//   takenKeys   keys of the plan's steps the player already has
//   offPlan     allocated nodes that are not in the plan
//   complete    nothing left to take
export function buildProgress(plan, index, allocatedIds = [], startNodeId = null) {
  if (!plan) return null;
  const allocated = new Set(allocatedIds || []);
  const stepSet = new Set(plan.stepIds.filter((id) => id != null));
  let done = 0;
  for (const id of plan.stepIds) if (id != null && allocated.has(id)) done += 1;
  let offPlan = 0;
  for (const id of allocated) if (!stepSet.has(id) && id !== startNodeId) offPlan += 1;

  const remainingIdx = [];
  plan.stepIds.forEach((id, i) => { if (id != null && !allocated.has(id)) remainingIdx.push(i); });
  const plannedIds = new Set(remainingIdx.map((i) => plan.stepIds[i]));

  const takenKeys = new Set();
  plan.stepIds.forEach((id, i) => { if (id != null && allocated.has(id)) takenKeys.add(plan.steps[i].key); });
  const upcomingSteps = remainingIdx.slice(0, 12).map((i) => ({
    n: i + 1, key: plan.steps[i].key, label: plan.steps[i].label, kind: plan.steps[i].kind,
  }));

  const out = {
    done, total: plan.total, offPlan, complete: remainingIdx.length === 0, takenKeys, upcomingSteps,
    nextIndex: -1, nextStep: null, nextId: null, detour: false,
    upcomingIds: new Set(), plannedIds, remaining: remainingIdx.length,
  };
  if (out.complete) return out;

  const nextIdx = remainingIdx[0];
  const targetId = plan.stepIds[nextIdx];
  out.nextIndex = nextIdx;
  out.nextStep = plan.steps[nextIdx];

  const owned = new Set([...allocated, startNodeId].filter((x) => x != null));
  const adjacentToOwned = (id) => {
    for (const n of (index.adjacency && index.adjacency.get(id)) || []) if (owned.has(n)) return true;
    return false;
  };
  if (adjacentToOwned(targetId)) {
    out.nextId = targetId;
  } else {
    const path = findShortestPath(index, owned, targetId);
    out.nextId = path.length > 0 ? path[0] : targetId;
    out.detour = path.length > 0 && path[0] !== targetId;
  }
  for (const i of remainingIdx.slice(0, UPCOMING_STEPS)) out.upcomingIds.add(plan.stepIds[i]);
  return out;
}

// Which recommended hotbar skills the player already owns.
export function hotbarStatus(guide, unlockedSkills) {
  const have = unlockedSkills instanceof Set ? unlockedSkills : new Set(unlockedSkills || []);
  return ((guide && guide.hotbar) || []).map((h) => ({ ...h, owned: have.has(h.skillId) }));
}

// The milestone the player is currently working towards (the first whose point
// total they have not reached), or the last one when they are past them all.
export function currentMilestone(guide, allocatedCount) {
  const ms = (guide && guide.passives && guide.passives.milestones) || [];
  if (ms.length === 0) return null;
  return ms.find((m) => allocatedCount < m.points) || ms[ms.length - 1];
}

// Persistence of the "follow this build" switch, per character.
const FOLLOW_KEY = "something2_build_follow";
export function followStorageKey(characterId) {
  return `${FOLLOW_KEY}_${characterId == null ? "anon" : characterId}`;
}
export function loadFollowing(characterId, storage = (typeof localStorage !== "undefined" ? localStorage : null)) {
  try { return storage ? storage.getItem(followStorageKey(characterId)) === "1" : false; } catch { return false; }
}
export function saveFollowing(characterId, on, storage = (typeof localStorage !== "undefined" ? localStorage : null)) {
  try {
    if (!storage) return;
    if (on) storage.setItem(followStorageKey(characterId), "1");
    else storage.removeItem(followStorageKey(characterId));
  } catch { /* storage blocked: the switch just will not persist */ }
}
