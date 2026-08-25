const test = require('node:test');
const assert = require('node:assert');

// Sets JWT_SECRET before any token is signed/verified.
require('./helpers/auth.js');
const request = require('supertest');

const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');

// ---------------------------------------------------------------------------
// GET /api/worlds and GET /api/worlds/:id (SOMET-276).
//
// Previously: NO guard at all -- SELECT * FROM worlds to anyone with no
// token whatsoever. That defeats the fog-of-war design GET /api/player/
// world-map (SOMET-263) deliberately builds: an unvisited neighbour there
// comes back as a bare { id, unvisited: true } stub specifically so a player
// can't learn what's behind an unexplored door.
//
// Fix: requireAuth (playerGuard) on both routes -- NOT adminGuard, which
// would 403 every real player -- then a response projected on req.user.role.
// Admin: unchanged, full SELECT * shape. Player: { id, chunk_size, is_entry }
// for every world (both are load-bearing for the client regardless of
// visited status -- see index.js's comment on projectWorldForPlayer), plus
// the full row for worlds the requesting CHARACTER has actually visited.
//
// Style mirrors player_world_map_routes.test.js's route-guard walk and
// worlds.test.js / worldsAdminRoutes.test.js's mockPool -- no real database
// needed since the projection logic lives entirely in index.js.
// ---------------------------------------------------------------------------

test('both GET /api/worlds and GET /api/worlds/:id are behind requireAuth, not requireAdmin', () => {
  const stack = app._router && app._router.stack;
  assert.ok(stack, 'could not locate the app router stack');
  for (const path of ['/api/worlds', '/api/worlds/:id']) {
    const layer = stack.find((l) => l.route && l.route.path === path
      && l.route.methods && l.route.methods.get);
    assert.ok(layer, `GET ${path} is not registered`);
    assert.ok(
      layer.route.stack.some((h) => h.handle && h.handle.isAuthGuard),
      `GET ${path} must not be reachable without a token`,
    );
    // Specifically NOT the admin guard: every player hits this route on
    // login/auto-join, and adminGuard here would 403 all of them.
    assert.ok(
      !layer.route.stack.some((h) => h.handle && h.handle.isAdminGuard),
      `GET ${path} must not require an admin role`,
    );
  }
});

function token(role, userId = 1, tokenVersion = 1) {
  return signToken({ userId, username: `u${userId}`, role, tokenVersion });
}

function bearer(t) {
  return ['Authorization', `Bearer ${t}`];
}

// mockPool dispatch that answers: the auth guard's user lookup (role-aware,
// unlike helpers/auth.js's admin-only fixture), ownedCharacter's ownership
// check, listVisited's per-character query, and the two worlds SELECTs the
// routes themselves issue.
function mockPool({
  role = 'player', tokenVersion = 1, worldRows = [], ownedCharacters = [], visited = {},
} = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM users WHERE id/i.test(sql) && /token_version/i.test(sql)) {
        return { rows: [{ token_version: tokenVersion, role }] };
      }
      // SOMET-486 gave ownedCharacter a LEFT JOIN onto entity_types for the
      // class base pools, so the old `FROM characters WHERE ...` literal no
      // longer matches and every request through it 500'd. Keyed on the WHERE
      // clause, which is the part that carries this query's meaning, rather
      // than on the FROM line -- a matcher pinned to the exact column list is
      // the fixture shape this repo keeps rediscovering.
      if (/FROM characters\b/i.test(sql) && /\.?id\s*=\s*\$1 AND c?\.?user_id\s*=\s*\$2/i.test(sql)) {
        const [id, userId] = params;
        const match = ownedCharacters.find(
          (c) => String(c.id) === String(id) && String(c.userId) === String(userId),
        );
        // max_hp/max_mana ride the real row now; nothing on this route reads
        // them, but omitting them would make the fixture describe a shape the
        // service can no longer receive.
        return { rows: match
          ? [{ id: match.id, entity_type_id: match.entityTypeId ?? 1, max_hp: 100, max_mana: 100 }]
          : [] };
      }
      if (/FROM character_visited_worlds WHERE character_id\s*=\s*\$1/i.test(sql)) {
        const [characterId] = params;
        const ids = visited[characterId] || [];
        return { rows: ids.map((worldId) => ({ world_id: worldId })) };
      }
      if (/SELECT \* FROM worlds ORDER BY created_at DESC/i.test(sql)) {
        return { rows: worldRows };
      }
      if (/SELECT \* FROM worlds WHERE id\s*=\s*\$1/i.test(sql)) {
        const [id] = params;
        const row = worldRows.find((w) => String(w.id) === String(id));
        return { rows: row ? [row] : [] };
      }
      throw new Error(`unexpected query in worlds_auth_projection.test.js mockPool: ${sql}`);
    },
  };
}

// Every column GET /api/worlds currently returns (see the ticket's own
// reproduction list), so the admin-unchanged and player-visited assertions
// below are checked against the REAL column set, not a trimmed fixture.
const VISITED_WORLD = {
  id: 'w1', name: 'Old Trailhead', seed: 42, chunk_size: 64, width: 40, height: 40,
  creature_count: 5, allowed_creature_types: ['goblin'], is_entry: true,
  entry_spawn: { x: 100, y: 100 }, biomes: ['Meadow'], biome_cell: 0,
  graph_x: 0, graph_y: 0, level_min: 1, level_max: 3, density: 'normal',
  allows_fast_travel: true, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
};
const UNVISITED_WORLD = {
  id: 'w2', name: 'Secret Grove', seed: 99, chunk_size: 32, width: 20, height: 20,
  creature_count: 2, allowed_creature_types: [], is_entry: false,
  entry_spawn: null, biomes: [], biome_cell: 0,
  graph_x: 1, graph_y: 0, level_min: 5, level_max: 8, density: 'sparse',
  allows_fast_travel: false, created_at: '2026-01-02T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z',
};
const WORLD_ROWS = [VISITED_WORLD, UNVISITED_WORLD];

test('unauthenticated requests are refused for both routes', async () => {
  __setPool(mockPool({ worldRows: WORLD_ROWS }));
  const list = await request(app).get('/api/worlds');
  assert.equal(list.status, 401);
  const single = await request(app).get('/api/worlds/w1');
  assert.equal(single.status, 401);
});

test('an admin token gets the full, unprojected rows -- unchanged from before the fix', async () => {
  __setPool(mockPool({ role: 'admin', worldRows: WORLD_ROWS }));
  const adminToken = token('admin');

  const list = await request(app).get('/api/worlds').set(...bearer(adminToken));
  assert.equal(list.status, 200);
  assert.deepEqual(list.body, WORLD_ROWS);

  const single = await request(app).get('/api/worlds/w2').set(...bearer(adminToken));
  assert.equal(single.status, 200);
  assert.deepEqual(single.body, UNVISITED_WORLD);
});

test('an admin token gets the full projection even if it happens to pass character_id', async () => {
  // The parameter is irrelevant for an admin caller -- role wins outright.
  __setPool(mockPool({ role: 'admin', worldRows: WORLD_ROWS }));
  const adminToken = token('admin');
  const res = await request(app).get('/api/worlds').query({ character_id: 999 }).set(...bearer(adminToken));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, WORLD_ROWS);
});

test('a player token with a character_id gets full data for a visited world and minimal fields for an unvisited one', async () => {
  __setPool(mockPool({
    role: 'player',
    worldRows: WORLD_ROWS,
    ownedCharacters: [{ id: 5, userId: 1 }],
    visited: { 5: ['w1'] },
  }));
  const playerToken = token('player', 1);

  const list = await request(app).get('/api/worlds').query({ character_id: 5 }).set(...bearer(playerToken));
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 2);

  const visited = list.body.find((w) => w.id === 'w1');
  assert.deepEqual(visited, VISITED_WORLD, 'a visited world must come back as the full row');

  const unvisited = list.body.find((w) => w.id === 'w2');
  assert.deepEqual(
    Object.keys(unvisited).sort(), ['chunk_size', 'id', 'is_entry'],
    'an unvisited world must expose ONLY id/chunk_size/is_entry -- no other key, not even as null',
  );
  assert.equal(unvisited.chunk_size, UNVISITED_WORLD.chunk_size);
  assert.equal(unvisited.is_entry, UNVISITED_WORLD.is_entry);
  // The property this test exists to guard is negative and field-shaped: no
  // amount of "the object doesn't have a .name" catches a leak through some
  // OTHER key, so also assert against the whole serialised body.
  assert.doesNotMatch(JSON.stringify(unvisited), /Secret Grove|99/,
    "the unvisited world's name/seed must not appear anywhere in its projected row");

  // Same split, single-world route.
  const visitedSingle = await request(app).get('/api/worlds/w1').query({ character_id: 5 }).set(...bearer(playerToken));
  assert.equal(visitedSingle.status, 200);
  assert.deepEqual(visitedSingle.body, VISITED_WORLD);

  const unvisitedSingle = await request(app).get('/api/worlds/w2').query({ character_id: 5 }).set(...bearer(playerToken));
  assert.equal(unvisitedSingle.status, 200);
  assert.deepEqual(Object.keys(unvisitedSingle.body).sort(), ['chunk_size', 'id', 'is_entry']);
});

test('a player token with no character_id gets the minimal projection for every world (safe default)', async () => {
  __setPool(mockPool({ role: 'player', worldRows: WORLD_ROWS }));
  const playerToken = token('player', 2);

  const res = await request(app).get('/api/worlds').set(...bearer(playerToken));
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
  for (const world of res.body) {
    assert.deepEqual(Object.keys(world).sort(), ['chunk_size', 'id', 'is_entry']);
  }
  assert.doesNotMatch(JSON.stringify(res.body), /Old Trailhead|Secret Grove/,
    'omitting character_id must never fall back to leaking any world\'s name');
});

test('a character_id belonging to another account is a 403, not a leak or a 404', async () => {
  __setPool(mockPool({
    role: 'player',
    worldRows: WORLD_ROWS,
    ownedCharacters: [{ id: 5, userId: 999 }], // owned by a DIFFERENT user
  }));
  const attackerToken = token('player', 1);

  const res = await request(app).get('/api/worlds').query({ character_id: 5 }).set(...bearer(attackerToken));
  assert.equal(res.status, 403);
  assert.doesNotMatch(JSON.stringify(res.body), /Old Trailhead|Secret Grove/,
    'a refused request must not return any part of the world list');
});

test('a nonexistent character_id is also a 403 -- indistinguishable from "not yours", never a 404', async () => {
  __setPool(mockPool({ role: 'player', worldRows: WORLD_ROWS, ownedCharacters: [] }));
  const playerToken = token('player', 1);
  const res = await request(app).get('/api/worlds').query({ character_id: 999999 }).set(...bearer(playerToken));
  assert.equal(res.status, 403);
});
