// backend/src/services/passiveTreeStore.js
//
// Every read and write of passive_nodes, passive_edges and character_passives,
// following the same rule progressionStore.js states for player_progression:
// nothing outside this file touches those three tables.
//
// The graph itself is IMMUTABLE at runtime (only `make seed-passive-tree` and
// the admin editor change it), so loadTree caches it in module scope. The
// cache is keyed on nothing and cleared explicitly by the admin route, because
// a per-request read of 1806 nodes + 2142 edges on every join is real work for
// data that changes about once a month.
const { composeStats } = require('./statComposition.js');
const { buildAdjacency, isAllocatable, flattenGrants } = require('./passiveRules.js');
const { getSettings } = require('./gameSettings.js');

// Required lazily inside the functions that need it: progressionStore.js
// requires THIS module back (for composeProgression), and a top-level require
// in both directions resolves to an empty object at load time.
function progressionStore() { return require('./progressionStore.js'); }

let cache = null;
// The adjacency map is derived from `cache.edges` and rebuilt with it rather
// than on every allocation: buildAdjacency over 2142 edges on each click is
// pure waste for a graph that only the seeder and the admin editor change.
let adjacencyCache = null;

async function loadTree(pool) {
  if (cache) return cache;
  const n = await pool.query(
    `SELECT id, key, sector, ring, x, y, kind, label, grants, start_class
       FROM passive_nodes ORDER BY id`,
  );
  const e = await pool.query('SELECT a_id, b_id FROM passive_edges ORDER BY a_id, b_id');
  cache = {
    nodes: n.rows.map((r) => ({
      id: r.id,
      key: r.key,
      sector: r.sector,
      ring: r.ring,
      x: Number(r.x),
      y: Number(r.y),
      kind: r.kind,
      label: r.label,
      grants: r.grants || [],
      start_class: r.start_class,
    })),
    edges: e.rows.map((r) => [r.a_id, r.b_id]),
  };
  cache.byId = new Map(cache.nodes.map((x) => [x.id, x]));
  adjacencyCache = buildAdjacency(cache.edges);
  return cache;
}

// Called by the admin editor after a write. Not a TTL: a stale tree in a
// running world is invisible (the node just grants the old thing), so it has
// to be invalidated by the write rather than waited out.
function invalidateTreeCache() { cache = null; adjacencyCache = null; }

// Resolved from characters.entity_type_id -> entity_types.name ->
// passive_nodes.start_class. Deliberately NOT via entity_types.main_stat:
// main_stat is Group B's column and Group C must not take a dependency on it.
// A class with no start node (legacy `Player`, the not-playable `Ranger`)
// returns null, and every caller refuses rather than defaulting to a sector --
// a default would silently hand a legacy character the Warrior tree.
async function startNodeIdFor(pool, characterId) {
  const r = await pool.query(
    `SELECT p.id
       FROM characters c
       JOIN entity_types e ON e.id = c.entity_type_id
       JOIN passive_nodes p ON p.start_class = e.name
      WHERE c.id = $1`,
    [characterId],
  );
  return r.rows.length ? r.rows[0].id : null;
}

async function loadAllocatedIds(db, characterId) {
  const r = await db.query(
    'SELECT node_id FROM character_passives WHERE character_id = $1 ORDER BY node_id',
    [characterId],
  );
  return r.rows.map((x) => x.node_id);
}

// The composed view of a character's tree: what they have and what it grants.
// The WALLET is not computed here -- it is player_progression.passive_points
// (contract §6.7), which the caller already holds on the row it read.
async function passiveBundle(db, characterId) {
  const ids = await loadAllocatedIds(db, characterId);
  if (ids.length === 0) return { allocatedNodeIds: [], passives: [] };
  const rows = await db.query(
    'SELECT id, label, grants FROM passive_nodes WHERE id = ANY($1::int[]) ORDER BY id',
    [ids],
  );
  return {
    allocatedNodeIds: ids,
    passives: flattenGrants(rows.rows.map((r) => ({ id: r.id, label: r.label, grants: r.grants || [] }))),
  };
}

// One point per node. Two guards, and they are different in kind:
//
//   * The POINT is spent in the UPDATE's own WHERE clause
//     (`passive_points >= 1`), the same shape the retired allocateStat used --
//     Postgres serialises the UPDATE, so exactly one of two concurrent
//     requests can match.
//   * REACHABILITY is a read-then-write pair and cannot live in a WHERE, so it
//     runs inside a transaction holding the player_progression row lock. That
//     is the same SELECT ... FOR UPDATE contract awardXp already documents,
//     and it also serialises the two allocations against each other, so the
//     second one sees the first's node when deciding what is adjacent.
async function allocateNode(pool, characterId, nodeId) {
  const id = Math.floor(Number(nodeId));
  if (!Number.isInteger(id) || id < 1) return { ok: false, reason: 'invalid node' };

  const [tree, startNodeId] = await Promise.all([
    loadTree(pool),
    startNodeIdFor(pool, characterId),
  ]);
  const node = tree.byId.get(id);
  if (!node) return { ok: false, reason: 'unknown node' };
  // Checked BEFORE the null-start refusal: "you asked for a start node" is the
  // more specific and more useful answer, and it is true regardless of class.
  if (node.kind === 'start') return { ok: false, reason: 'start node is granted, not allocated' };
  if (startNodeId == null) return { ok: false, reason: 'class has no passive start node' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The row lock, not the row: nothing here reads a progression field. It
    // also lazily creates the row, so a character that has never been loaded
    // still has something for the UPDATE below to match.
    await progressionStore().loadProgression(client, characterId, { forUpdate: true });
    const allocated = await loadAllocatedIds(client, characterId);
    if (allocated.includes(id)) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'already allocated' };
    }
    if (!isAllocatable(id, allocated, adjacencyCache, startNodeId)) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'node is not reachable yet' };
    }
    // The wallet check is the WHERE clause, not a read-then-write pair.
    const spend = await client.query(
      `UPDATE player_progression
          SET passive_points = passive_points - 1, updated_at = now()
        WHERE character_id = $1 AND passive_points >= 1
      RETURNING passive_points`,
      [characterId],
    );
    if (spend.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'no passive points' };
    }
    await client.query(
      'INSERT INTO character_passives (character_id, node_id) VALUES ($1, $2)',
      [characterId, id],
    );
    const after = await loadAllocatedIds(client, characterId);
    await client.query('COMMIT');
    return { ok: true, allocatedNodeIds: after, passivePoints: Number(spend.rows[0].passive_points) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// All-or-nothing (spec §5.4). Takes BOTH ids for the same reason the old
// progressionStore.respec did: the allocation reset is per-CHARACTER, the gold
// that pays for it is per-ACCOUNT.
//
// NOT IN THIS TASK: spec §7's "items that no longer qualify are auto-unequipped
// into the backpack, and the respec is refused if the backpack has no room".
// T10's equipment requirements layer that policy on top of this function.
async function respecPassives(pool, userId, characterId) {
  const settings = await getSettings(pool, ['respec_base_gold']);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const progression = await progressionStore().loadProgression(client, characterId, { forUpdate: true });
    const cost = Number(settings.respec_base_gold) * progression.level;
    // Gold moves first, guarded in its own WHERE. If it does not move the whole
    // transaction rolls back -- a failed payment must never yield a free respec.
    const g = await client.query(
      'UPDATE users SET gold = gold - $2 WHERE id = $1 AND gold >= $2 RETURNING gold',
      [userId, cost],
    );
    if (g.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'not enough gold', cost };
    }
    const cleared = await client.query(
      'DELETE FROM character_passives WHERE character_id = $1 RETURNING node_id', [characterId],
    );
    // Refund exactly what was spent -- the count of rows this DELETE actually
    // removed, not a recomputation from the level. T2 also refunds pre-epic
    // stat points into this column, so a level-derived figure would either
    // destroy those or mint them a second time.
    const refunded = await client.query(
      `UPDATE player_progression
          SET passive_points = passive_points + $2, updated_at = now()
        WHERE character_id = $1
      RETURNING passive_points`,
      [characterId, cleared.rowCount],
    );
    await client.query('COMMIT');
    return {
      ok: true,
      cost,
      gold: Number(g.rows[0].gold) || 0,
      allocatedNodeIds: [],
      refunded: cleared.rowCount,
      passivePoints: Number(refunded.rows[0].passive_points),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// What a respec would cost this character right now. Contract §6.4: T8 needs a
// `respecDisabled` predicate, and the ONE thing that must not happen is the
// client recomputing `respec_base_gold x level` locally -- that is exactly the
// RESPEC_BASE drift CharacterSheet.jsx's F2 header describes, where raising
// the setting server-side left the button enabled and every click 402ing.
// So the cost, the gold it is compared against and the verdict all ship from
// here.
async function respecQuote(pool, userId, level) {
  const settings = await getSettings(pool, ['respec_base_gold']);
  const cost = Number(settings.respec_base_gold) * Number(level || 1);
  const g = await pool.query('SELECT gold FROM users WHERE id = $1', [userId]);
  const gold = g.rows.length ? Number(g.rows[0].gold) || 0 : 0;
  return { respecCost: cost, gold, respecDisabled: gold < cost };
}

// The composed progression row every push site sends. `base` is the class-base
// snapshot the six frozen stat columns hold (spec §3.3 / contract §6.1 -- every
// class bases at 5); `gear` is [] until Group D T12 lands the affix instances,
// and is passed explicitly rather than omitted so the seam is visible rather
// than forgotten.
//
// TWO VIEWS OF THE SAME SIX NUMBERS, on purpose:
//
//   * `effective` is the object contract §6.2 requires, and is what every
//     client renders. It is never re-summed from `sources`.
//   * The six TOP-LEVEL keys carry the same effective numbers. That is what
//     lets derivePlayerStats(progression) keep working unchanged at all of
//     its existing call sites -- it reads exactly those six names
//     (playerStats.js:41-60). Leaving the raw snapshot there instead would
//     make every derived number in the game ignore the tree, silently.
//
// The raw snapshot is still reachable, as `sources.<stat>.base`.
async function composeProgression(db, characterId, row) {
  const bundle = await passiveBundle(db, characterId);
  const composed = composeStats({ base: row, passives: bundle.passives, gear: [] });
  const effective = {
    strength: composed.strength,
    dexterity: composed.dexterity,
    constitution: composed.constitution,
    intelligence: composed.intelligence,
    wisdom: composed.wisdom,
    charisma: composed.charisma,
  };
  return {
    ...row,
    ...effective,
    effective,
    // The wallet is the column T2 owns (contract §6.7), read straight off the
    // row -- never recomputed here.
    passivePoints: Number(row.passive_points) || 0,
    allocatedNodeIds: bundle.allocatedNodeIds,
    sources: composed.sources,
    modifiers: composed.modifiers,
    rules: composed.rules,
  };
}

module.exports = {
  loadTree,
  invalidateTreeCache,
  startNodeIdFor,
  loadAllocatedIds,
  passiveBundle,
  allocateNode,
  respecPassives,
  respecQuote,
  composeProgression,
};
