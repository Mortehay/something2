// backend/src/services/questRoute.js
//
// "How far is the place where this quest starts?" -- across the WHOLE world
// graph, not just the map the player is standing in. A world is joined to its
// neighbours by compass doorways (a gap in the wall ring, mid-edge) and by
// portals (a tile with explicit coordinates at both ends). The cost of a route
// is the straight-line walking distance inside each world it crosses: from
// where you enter it to where you leave it, summed.
//
// Pure (shortestRoute) + one DB-backed entry point (routeToTargets). The pure
// half is unit-tested without a database.

const TILE = 100; // world px per tile

const OPPOSITE = { N: 'S', S: 'N', E: 'W', W: 'E' };

// Centre of the doorway gap on an edge of a bounded world (px).
function edgeExit(world, edge) {
  const w = Number(world.width), h = Number(world.height);
  if (!(w > 0 && h > 0)) return null;
  switch (edge) {
    case 'N': return { x: Math.floor(w / 2) * TILE + TILE / 2, y: TILE / 2 };
    case 'S': return { x: Math.floor(w / 2) * TILE + TILE / 2, y: h * TILE - TILE / 2 };
    case 'W': return { x: TILE / 2, y: Math.floor(h / 2) * TILE + TILE / 2 };
    case 'E': return { x: w * TILE - TILE / 2, y: Math.floor(h / 2) * TILE + TILE / 2 };
    default: return null;
  }
}

// Where a player lands in `world` after leaving through `edge` of the world
// next door: one tile inside the OPPOSITE edge (mapService.arrivalPoint).
function arrivalAfter(world, edgeLeft) {
  const w = Number(world.width), h = Number(world.height);
  if (!(w > 0 && h > 0)) return null;
  const midCol = Math.floor(w / 2), midRow = Math.floor(h / 2);
  switch (OPPOSITE[edgeLeft]) {
    case 'N': return { x: midCol * TILE + TILE / 2, y: 1 * TILE + TILE / 2 };
    case 'S': return { x: midCol * TILE + TILE / 2, y: (h - 2) * TILE + TILE / 2 };
    case 'W': return { x: 1 * TILE + TILE / 2, y: midRow * TILE + TILE / 2 };
    case 'E': return { x: (w - 2) * TILE + TILE / 2, y: midRow * TILE + TILE / 2 };
    default: return null;
  }
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Dijkstra over (world, entry point) states.
//   worlds   Map<worldId, { id, name, width, height }>
//   links    [{ from_world_id, to_world_id, edge, from_x, from_y, to_x, to_y }]
//   from     { worldId, x, y }
//   targets  [{ worldId, x, y, label }]
// Returns null when no target is reachable, else
//   { totalPx, first, restPx, sameWorld, target, hops: [worldName...] }
// where `first` is the point to walk to NOW (the first exit, or the target
// itself when it is in this very world) and restPx is the distance beyond it,
// so a caller can keep the live total = |player - first| + restPx as the
// player moves, without asking again.
function shortestRoute({ worlds, links, from, targets }) {
  const out = new Map();
  for (const l of links) {
    if (!out.has(l.from_world_id)) out.set(l.from_world_id, []);
    out.get(l.from_world_id).push(l);
  }
  const key = (worldId, p) => `${worldId}|${Math.round(p.x)},${Math.round(p.y)}`;
  const states = new Map();
  const start = { worldId: from.worldId, pos: { x: from.x, y: from.y }, d: 0, prev: null, exit: null, done: false };
  states.set(key(start.worldId, start.pos), start);

  let best = null;
  for (;;) {
    let cur = null;
    for (const s of states.values()) if (!s.done && (cur === null || s.d < cur.d)) cur = s;
    if (cur === null) break;
    cur.done = true;
    if (best && cur.d >= best.total) break; // nothing cheaper can follow

    for (const t of targets) {
      if (t.worldId !== cur.worldId) continue;
      const total = cur.d + dist(cur.pos, t);
      if (!best || total < best.total) best = { total, state: cur, target: t };
    }

    const world = worlds.get(cur.worldId);
    for (const l of out.get(cur.worldId) || []) {
      const to = worlds.get(l.to_world_id);
      if (!world || !to) continue;
      let exit; let arrive;
      if (l.edge === 'PORTAL') {
        if (![l.from_x, l.from_y, l.to_x, l.to_y].every((n) => Number.isFinite(Number(n)))) continue;
        exit = { x: Number(l.from_x), y: Number(l.from_y) };
        arrive = { x: Number(l.to_x), y: Number(l.to_y) };
      } else {
        exit = edgeExit(world, l.edge);
        arrive = arrivalAfter(to, l.edge);
        if (!exit || !arrive) continue; // an unbounded world has no doorways
      }
      const d = cur.d + dist(cur.pos, exit);
      const k = key(l.to_world_id, arrive);
      const known = states.get(k);
      if (!known || d < known.d) {
        states.set(k, { worldId: l.to_world_id, pos: arrive, d, prev: cur, exit, done: false });
      }
    }
  }
  if (!best) return null;

  // Walk back to the first state after the start: its `exit` is the first leg.
  const chain = [];
  for (let s = best.state; s; s = s.prev) chain.push(s);
  chain.reverse(); // chain[0] is the start
  const hops = chain.map((s) => (worlds.get(s.worldId) || {}).name || s.worldId);
  const sameWorld = chain.length === 1;
  const first = sameWorld ? { x: best.target.x, y: best.target.y } : chain[1].exit;
  const firstPx = dist(start.pos, first);
  return {
    totalPx: best.total,
    first,
    restPx: Math.max(0, best.total - firstPx),
    sameWorld,
    target: best.target,
    hops,
  };
}

// --- DB-backed ------------------------------------------------------------

const cache = new Map();
async function cached(k, ttlMs, load) {
  const hit = cache.get(k);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = await load();
  cache.set(k, { value, until: Date.now() + ttlMs });
  return value;
}

async function loadGraph(pool) {
  return cached('graph', 60000, async () => {
    const w = await pool.query('SELECT id, name, width, height FROM worlds');
    const l = await pool.query(
      'SELECT from_world_id, to_world_id, edge, from_x, from_y, to_x, to_y FROM map_links',
    );
    return { worlds: new Map(w.rows.map((r) => [r.id, r])), links: l.rows };
  });
}

// Every village (with its quest giver post and spec key), across all worlds.
async function loadVillages(pool) {
  return cached('villages', 60000, async () => {
    const { fetchVillages } = require('./villages.js');
    const ws = await pool.query('SELECT DISTINCT world_id FROM villages');
    const out = [];
    for (const { world_id: worldId } of ws.rows) {
      for (const v of await fetchVillages(pool, worldId)) out.push({ worldId, village: v });
    }
    return out;
  });
}

// `wanted`: { specKeys: [..], nodeGroup?: string }. Targets are the quest giver
// of each matching village (or, for a node group, the nodes themselves). When
// nothing matches (the authored village is not in this database) the nearest
// quest giver anywhere is used, so the tracker still points somewhere useful.
async function routeToTargets(pool, from, wanted) {
  const { worlds, links } = await loadGraph(pool);
  const villages = await loadVillages(pool);
  const { villageQuestNodes } = require('./questNodes.js');

  const giver = ({ worldId, village: v }) => ({
    worldId, x: v.questGiverX, y: v.questGiverY,
    label: (worlds.get(worldId) || {}).name || 'Quest giver',
  });
  const specs = new Set(wanted.specKeys || []);
  let pool_ = villages.filter((e) => e.village.specKey && specs.has(e.village.specKey));

  let targets;
  if (wanted.nodeGroup && pool_.length) {
    targets = pool_.flatMap((e) => villageQuestNodes(e.village)
      .filter((n) => n.group === wanted.nodeGroup)
      .map((n) => ({ worldId: e.worldId, x: n.x, y: n.y, label: (worlds.get(e.worldId) || {}).name })));
  }
  if (!targets || targets.length === 0) {
    if (pool_.length === 0) pool_ = villages;
    targets = pool_.filter((e) => e.village.questGiverX != null).map(giver);
  }
  const route = shortestRoute({ worlds, links, from, targets });
  if (!route) return { found: false };
  return {
    found: true,
    sameWorld: route.sameWorld,
    first: route.first,
    restPx: route.restPx,
    totalPx: route.totalPx,
    hops: route.hops,
    placeName: route.target.label || route.hops[route.hops.length - 1],
    exact: pool_ !== villages,
  };
}

function clearRouteCache() { cache.clear(); }

module.exports = { shortestRoute, routeToTargets, edgeExit, arrivalAfter, clearRouteCache, TILE };

// What the tracker should point at for one quest, given the character's row
// (null when the quest has not been accepted):
//   accept   -> the quest giver, to take it
//   gather   -> the nodes (villages that host the group) while collecting
//   turn_in  -> the quest giver, once the objective is met
//   hunt     -> where the targets are: clusters of the creature, of any creature, or the bosses
//   climb    -> the next Spire floor
//   done     -> nothing
function questTarget(quest, cq) {
  if (cq && cq.status === 'completed') return { mode: 'done' };
  const giver = { specKeys: quest.village_key ? [quest.village_key] : [] };
  if (!cq) return { mode: 'accept', ...giver };
  const target = Number(quest.target_count) || 1;
  const turnInOnly = quest.objective_type === 'manual' || quest.objective_type === 'choice';
  if (turnInOnly || Number(cq.progress_count) >= target) return { mode: 'turn_in', ...giver };
  if (quest.objective_type === 'interact') {
    const { CATALOG } = require('./questNodes.js');
    const hosts = Object.entries(CATALOG)
      .filter(([, groups]) => groups.some(([g]) => g === quest.target_key))
      .map(([spec]) => spec);
    return { mode: 'gather', specKeys: hosts, nodeGroup: quest.target_key };
  }
  if (quest.objective_type === 'floor') return { mode: 'climb', nextFloor: Math.min(Number(quest.target_count) || 25, (Number(cq.progress_count) || 0) + 1) };
  // kill / kill_any / boss: no fixed place, but there ARE places where it can be done.
  return { mode: 'hunt', kind: quest.objective_type, key: quest.target_key || null };
}

module.exports.questTarget = questTarget;

// --- Hunting and climbing -------------------------------------------------

const CELL_PX = 1600; // 16 tiles: a "hunting ground" is a cluster this big

// Where creatures actually are, as cluster centres (world_creatures). `type`
// null = any creature. A cluster needs `minCount` creatures so a lone straggler
// does not become a destination.
async function creatureClusters(pool, type, minCount) {
  return cached(`clusters|${type}|${minCount}`, 60000, async () => {
    const r = await pool.query(
      `SELECT c.world_id, round(avg(c.x))::int AS x, round(avg(c.y))::int AS y, count(*)::int AS n
         FROM world_creatures c
        WHERE ($1::text IS NULL OR c.type = $1) AND c.home_x IS NULL
        GROUP BY c.world_id, floor(c.x / ${CELL_PX}), floor(c.y / ${CELL_PX})
       HAVING count(*) >= $2`,
      [type, minCount],
    );
    return r.rows;
  });
}

async function bossPosts(pool) {
  return cached('bossPosts', 60000, async () => {
    const fixed = await pool.query(
      `SELECT id AS world_id, (dungeon_boss->>'x')::int AS x, (dungeon_boss->>'y')::int AS y,
              dungeon_boss->>'entity' AS label
         FROM worlds WHERE dungeon_boss IS NOT NULL`,
    );
    const roaming = await pool.query(
      `SELECT c.world_id, round(avg(c.x))::int AS x, round(avg(c.y))::int AS y, max(c.type) AS label
         FROM world_creatures c JOIN entity_types e ON e.name = c.type
        WHERE e.boss_tier IS NOT NULL GROUP BY c.world_id`,
    );
    return [...fixed.rows, ...roaming.rows];
  });
}

// Targets for a `hunt` or `climb` target descriptor (see questTarget).
async function huntTargets(pool, target) {
  const { worlds } = await loadGraph(pool);
  const nameOf = (id) => (worlds.get(id) || {}).name || 'somewhere';
  if (target.mode === 'climb') {
    const row = [...worlds.values()].find((w) => w.name === `Spire of Trials: Floor ${target.nextFloor}`);
    if (!row) return { targets: [], label: 'the Spire of Trials' };
    return {
      targets: [{ worldId: row.id, x: Math.floor((row.width || 96) / 2) * TILE + TILE / 2, y: Math.floor((row.height || 96) / 2) * TILE + TILE / 2, label: row.name }],
      label: `Spire floor ${target.nextFloor}`,
    };
  }
  if (target.kind === 'boss') {
    const posts = await bossPosts(pool);
    return { targets: posts.map((p) => ({ worldId: p.world_id, x: p.x, y: p.y, label: nameOf(p.world_id) })), label: 'boss' };
  }
  const type = target.kind === 'kill' ? target.key : null;
  let rows = await creatureClusters(pool, type, type ? 1 : 8);
  if (rows.length === 0 && !type) rows = await creatureClusters(pool, null, 1);
  return {
    targets: rows.map((r) => ({ worldId: r.world_id, x: r.x, y: r.y, label: nameOf(r.world_id), n: r.n })),
    label: type || 'creatures',
  };
}

async function routeToHunt(pool, from, target) {
  const { worlds, links } = await loadGraph(pool);
  const { targets, label } = await huntTargets(pool, target);
  const route = targets.length ? shortestRoute({ worlds, links, from, targets }) : null;
  if (!route) return { found: false, huntLabel: label };
  return {
    found: true,
    sameWorld: route.sameWorld,
    first: route.first,
    restPx: route.restPx,
    totalPx: route.totalPx,
    hops: route.hops,
    placeName: route.target.label || route.hops[route.hops.length - 1],
    huntLabel: label,
    // How many creatures live at the destination, for "(12 here)" style hints.
    count: route.target.n || null,
  };
}

module.exports.routeToHunt = routeToHunt;
module.exports.creatureClusters = creatureClusters;
