// backend/tests/passive_tree_routes.test.js
//
// Auth, mount and END-TO-END wiring. The transactional guards are tested in
// passive_tree_allocation_db.test.js against the store; a second copy here
// would be a drifting restatement.
//
// The end-to-end half exists because of the D1 lesson (SOMET-478): a column
// added without a matching entry in an explicit SELECT list produced a
// completely inert feature while every pure-function test stayed green. The
// pure composer and the store are both proven; what is NOT proven by either is
// that a real HTTP request, through the real router, through the real
// resolveCharacter/loadProgression chain, actually carries `effective`,
// `sources`, `modifiers`, `passivePoints`, `allocatedNodeIds` and
// `respecDisabled` out to the client. So it is asserted on a real response.
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
require('./helpers/auth.js');
const { Pool } = require('pg');
const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');
const { loadTree } = require('../src/services/passiveTreeStore.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url
  ? 'no TEST_DATABASE_URL -- refusing to reach a real database'
  : false;

test('the passive-tree router is mounted, and only once', () => {
  const mounts = app._router.stack
    .filter((l) => l.regexp && l.regexp.toString().includes('passive-tree'));
  assert.strictEqual(mounts.length, 1);
});

test('every passive-tree and progression route sits behind an auth guard', () => {
  // A walk that matched nothing would pass vacuously, so the counts are
  // asserted first. Three progression routes now: GET /, POST /passives/:nodeId
  // and POST /respec.
  const routers = app._router.stack.filter((l) => l.name === 'router' && l.handle
    && Array.isArray(l.handle.stack));
  const progression = routers.find((l) => l.handle.stack
    .some((rl) => rl.route && rl.route.path === '/passives/:nodeId'));
  assert.ok(progression, 'could not locate the mounted progression router');
  const layers = progression.handle.stack.filter((rl) => rl.route);
  assert.strictEqual(layers.length, 3,
    `expected exactly 3 progression routes, found ${layers.map((l) => l.route.path).join(', ')}`);
  const unguarded = layers
    .filter((l) => !l.route.stack.some((h) => h.handle && h.handle.isAuthGuard))
    .map((l) => l.route.path);
  assert.deepStrictEqual(unguarded, []);
});

test('passive tree routes reject an anonymous caller', { skip }, async (t) => {
  await t.test('GET /api/passive-tree requires a token', async () => {
    const res = await request(app).get('/api/passive-tree');
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error, 'missing token');
  });

  await t.test('POST /api/progression/passives/:nodeId requires a token', async () => {
    const res = await request(app).post('/api/progression/passives/1').send({ character_id: 1 });
    assert.strictEqual(res.status, 401);
  });

  await t.test('POST /api/progression/respec requires a token', async () => {
    const res = await request(app).post('/api/progression/respec').send({ character_id: 1 });
    assert.strictEqual(res.status, 401);
  });
});

test('the composed progression bundle survives the whole HTTP path', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url, max: 4 });
  const made = [];
  __setPool(pool);
  t.after(async () => {
    if (made.length) await pool.query('DELETE FROM users WHERE id = ANY($1)', [made]);
    await pool.end();
  });

  const tag = `passroutes-${process.pid}-${Date.now()}`;
  const u = await pool.query(
    "INSERT INTO users (username, password_hash, role, gold) VALUES ($1, 'x', 'player', 100000) RETURNING id",
    [tag],
  );
  const userId = u.rows[0].id;
  made.push(userId);
  const c = await pool.query(
    `INSERT INTO characters (user_id, slot, name, entity_type_id)
     SELECT $1, 1, $2, e.id FROM entity_types e WHERE e.name = 'Warrior' RETURNING id`,
    [userId, tag],
  );
  const characterId = c.rows[0].id;
  await pool.query(
    'INSERT INTO player_progression (character_id, level, passive_points) VALUES ($1, 10, 5)',
    [characterId],
  );
  const auth = {
    Authorization: `Bearer ${signToken({
      userId, username: tag, role: 'player', tokenVersion: 1,
    })}`,
  };

  const tree = await loadTree(pool);
  const adjacent = tree.nodes.find((x) => x.key === 'strength-r1-0-8').id;

  await t.test('GET /api/passive-tree ships the whole graph and a version', async () => {
    const res = await request(app).get('/api/passive-tree').set(auth);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.nodes.length, 1806);
    assert.strictEqual(res.body.edges.length, 2142);
    assert.strictEqual(res.body.version, '1806:2142');
    // The node shape the overlay draws from -- an omitted x/y or grants would
    // leave T8 with an unrenderable graph and no test to say so.
    const start = res.body.nodes.find((x) => x.key === 'start-strength');
    assert.strictEqual(start.start_class, 'Warrior');
    assert.strictEqual(typeof start.x, 'number');
    assert.strictEqual(typeof start.y, 'number');
    assert.ok(Array.isArray(res.body.nodes[0].grants));
  });

  await t.test('GET /api/progression carries the composed bundle and the respec quote', async () => {
    const res = await request(app).get('/api/progression').query({ character_id: characterId }).set(auth);
    assert.strictEqual(res.status, 200);
    // Contract §6.2 -- the object consumers render.
    assert.deepStrictEqual(res.body.effective, {
      strength: 5, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5,
    });
    assert.deepStrictEqual(res.body.sources.strength, { base: 5, tree: 0, gear: 0 });
    // NOT empty since SOMET-471/472: a Warrior's free start node grants
    // physical +3, and SOMET-472 made passiveBundle actually read start-node
    // grants (they were correct in the database and reaching nothing before
    // that). Asserted by VALUE rather than relaxed to a length, so a start
    // grant that silently changes or disappears still fails here.
    assert.deepStrictEqual(res.body.modifiers, [
      { source: 'tree', label: 'Warrior', kind: 'damage', detail: 'physical', value: 3 },
    ]);
    assert.strictEqual(res.body.passivePoints, 5);
    assert.deepStrictEqual(res.body.allocatedNodeIds, []);
    // Contract §6.4 -- T8's predicate, computed server-side. 100000 gold
    // against 50 x level 10 = 500.
    assert.strictEqual(res.body.respecCost, 500);
    assert.strictEqual(res.body.gold, 100000);
    assert.strictEqual(res.body.respecDisabled, false);
    // The same fields ride INSIDE `progression` too, which is the shape the
    // websocket frame carries (Game.js keeps msg.progression and drops every
    // sibling).
    assert.strictEqual(res.body.progression.passivePoints, 5);
    assert.deepStrictEqual(res.body.progression.effective, res.body.effective);
  });

  await t.test('POST /api/progression/passives/:nodeId allocates and the next GET reflects it', async () => {
    const res = await request(app).post(`/api/progression/passives/${adjacent}`)
      .set(auth).send({ character_id: characterId });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.progression.allocatedNodeIds, [adjacent]);
    assert.strictEqual(res.body.progression.passivePoints, 4);
    assert.ok(res.body.stats.maxHp > 0, 'the response carries the derived bundle');

    // The read path, separately: a write that only looked right in its own
    // response is the inert-feature shape D1 found.
    const after = await request(app).get('/api/progression').query({ character_id: characterId }).set(auth);
    assert.deepStrictEqual(after.body.allocatedNodeIds, [adjacent]);
    assert.strictEqual(after.body.passivePoints, 4);
    // TWO now: the Warrior's start-node grant plus the node just allocated.
    // Both are 'tree'; the start grant is the damage one, so assert the
    // allocated node actually ADDED something rather than just counting.
    assert.strictEqual(after.body.modifiers.length, 2);
    assert.ok(after.body.modifiers.every((m) => m.source === 'tree'));
    assert.ok(
      after.body.modifiers.some((m) => m.kind === 'damage' && m.detail === 'physical'),
      'the free start-node grant is still present after allocating',
    );
  });

  await t.test('an unreachable node is refused with the store reason, not a 500', async () => {
    const far = tree.nodes.find((x) => x.key === 'wisdom-r1-0-8').id;
    const res = await request(app).post(`/api/progression/passives/${far}`)
      .set(auth).send({ character_id: characterId });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'node is not reachable yet');
  });

  await t.test('POST /api/progression/respec clears the allocation and returns the new gold', async () => {
    const res = await request(app).post('/api/progression/respec')
      .set(auth).send({ character_id: characterId });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.progression.allocatedNodeIds, []);
    assert.strictEqual(res.body.progression.passivePoints, 5, 'the spent point comes back');
    assert.strictEqual(res.body.gold, 100000 - 500);
  });

  await t.test('a respec the caller cannot afford reports respecDisabled before it 402s', async () => {
    // Contract §6.4 again, from the other side: the predicate has to flip
    // BEFORE the click, or the overlay offers a button that always 402s --
    // exactly the RESPEC_BASE drift CharacterSheet.jsx's F2 header describes.
    await pool.query('UPDATE users SET gold = 10 WHERE id = $1', [userId]);
    const quote = await request(app).get('/api/progression').query({ character_id: characterId }).set(auth);
    assert.strictEqual(quote.body.gold, 10);
    assert.strictEqual(quote.body.respecCost, 500);
    assert.strictEqual(quote.body.respecDisabled, true);

    const res = await request(app).post('/api/progression/respec')
      .set(auth).send({ character_id: characterId });
    assert.strictEqual(res.status, 402);
    assert.strictEqual(res.body.error, 'not enough gold');
    assert.strictEqual(res.body.cost, 500);
  });
});
