// backend/tests/passive_nodes_admin_routes.test.js
//
// Real-HTTP, real-DB guards for the admin passive-node browser and editor
// (SOMET-477). Modelled on creature_behaviors_api_db.test.js: a real pg Pool
// swapped into the app via __setPool, disposable users created and dropped per
// run, and the whole file gated on TEST_DATABASE_URL so a bare `npm test`
// never reaches a real database.
//
// WHY SO MUCH OF THIS IS NEGATIVE-INPUT TESTING. A validator that accepts
// everything passes every test that only ever feeds it valid input, and a
// typo'd grant ("strenght") is stored happily, renders normally in the admin
// list, and grants NOTHING at runtime -- the single most common failure shape
// in this epic. So the interesting assertions below are the rejections.
//
// SAFETY: the one node this file edits (`strength-r2-0-0`) is captured before
// and restored in a t.after, and every user/character fixture is dropped by
// id. Nothing here deletes a catalog row.
require('./helpers/auth.js'); // sets JWT_SECRET before any token is signed
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { Pool } = require('pg');
const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');
const { loadTree, invalidateTreeCache } = require('../src/services/passiveTreeStore.js');
const {
  withAdvisoryLock, PASSIVE_TREE_LOCK_KEY, PASSIVE_TREE_LOCK_WAIT_MS,
} = require('./helpers/advisoryLock.js');
const { seedPassiveTree } = require('../scripts/seed-passive-tree.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url
  ? 'no TEST_DATABASE_URL -- refusing to mutate a real database (this test writes passive_nodes)'
  : false;

// The node this file edits. Deliberately NOT `strength-r1-0-0`, which
// passive_tree_seed_db.test.js already edits, and not a start node.
const TARGET_KEY = 'strength-r2-0-0';

async function makeUser(pool, role, tag) {
  const username = `passnode-${role}-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const r = await pool.query(
    'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, token_version',
    [username, 'x', role],
  );
  return { id: r.rows[0].id, username, role, tokenVersion: r.rows[0].token_version };
}

function bearer(u) {
  return signToken({
    userId: u.id, username: u.username, role: u.role, tokenVersion: u.tokenVersion,
  });
}

test('passive node admin routes', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 4000, max: 4 });
  __setPool(pool);
  t.after(async () => { await pool.end().catch(() => {}); });

  const adminUser = await makeUser(pool, 'admin', 'a');
  const playerUser = await makeUser(pool, 'player', 'p');
  t.after(async () => {
    await pool.query('DELETE FROM users WHERE id = ANY($1::int[])',
      [[adminUser.id, playerUser.id]]).catch(() => {});
  });
  const admin = bearer(adminUser);
  const player = bearer(playerUser);

  const target = await pool.query(
    'SELECT id, label, kind, grants FROM passive_nodes WHERE key = $1', [TARGET_KEY]);
  assert.strictEqual(target.rowCount, 1,
    `${TARGET_KEY} must exist -- has the scratch database been seeded with seed-passive-tree?`);
  const id = target.rows[0].id;
  const original = target.rows[0];
  t.after(async () => {
    await pool.query(
      'UPDATE passive_nodes SET label = $2, kind = $3, grants = $4::jsonb WHERE id = $1',
      [id, original.label, original.kind, JSON.stringify(original.grants)],
    ).catch(() => {});
    invalidateTreeCache();
  });

  await t.test('the list is admin-only', async () => {
    assert.strictEqual((await request(app).get('/api/passive-nodes')).status, 401);
    const asPlayer = await request(app).get('/api/passive-nodes').set('Authorization', `Bearer ${player}`);
    assert.strictEqual(asPlayer.status, 403);
    assert.strictEqual(asPlayer.body.error, 'admin role required');
  });

  await t.test('the update is admin-only', async () => {
    const anon = await request(app).put(`/api/passive-nodes/${id}`)
      .send({ label: 'nope', kind: 'minor', grants: [] });
    assert.strictEqual(anon.status, 401);
    const res = await request(app).put(`/api/passive-nodes/${id}`)
      .set('Authorization', `Bearer ${player}`)
      .send({ label: 'nope', kind: 'minor', grants: [] });
    assert.strictEqual(res.status, 403);
    // The write must not have happened.
    const row = await pool.query('SELECT label FROM passive_nodes WHERE id = $1', [id]);
    assert.notStrictEqual(row.rows[0].label, 'nope');
  });

  await t.test('lists a page at a time and reports the unpaged total', async () => {
    const res = await request(app).get('/api/passive-nodes?limit=25')
      .set('Authorization', `Bearer ${admin}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.nodes.length, 25);
    assert.strictEqual(res.body.total, 1806);
    assert.deepStrictEqual(Object.keys(res.body.nodes[0]).sort(),
      ['grants', 'id', 'key', 'kind', 'label', 'ring', 'sector', 'start_class', 'x', 'y']);
  });

  await t.test('offset walks the same ordering without repeating or skipping a row', async () => {
    // AC1's real content: 1806 rows must not arrive in one pass, and the pages
    // must tile. A LIMIT with no ORDER BY, or an offset the route ignores,
    // both fail here rather than in the browser at page 12.
    const head = (await request(app).get('/api/passive-nodes?limit=10&offset=0')
      .set('Authorization', `Bearer ${admin}`)).body.nodes;
    const next = (await request(app).get('/api/passive-nodes?limit=10&offset=10')
      .set('Authorization', `Bearer ${admin}`)).body.nodes;
    const wide = (await request(app).get('/api/passive-nodes?limit=20&offset=0')
      .set('Authorization', `Bearer ${admin}`)).body.nodes;
    assert.strictEqual(next.length, 10);
    assert.deepStrictEqual([...head, ...next].map((n) => n.key), wide.map((n) => n.key));
    assert.strictEqual(new Set(wide.map((n) => n.id)).size, 20);
  });

  await t.test('caps the page size so a client cannot ask for the whole table', async () => {
    const res = await request(app).get('/api/passive-nodes?limit=99999')
      .set('Authorization', `Bearer ${admin}`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.nodes.length <= 200,
      `expected the limit to be capped, got ${res.body.nodes.length} rows`);
    assert.strictEqual(res.body.total, 1806);
  });

  await t.test('filters by sector, by kind and by a key/label search', async () => {
    const bySector = await request(app).get('/api/passive-nodes?sector=charisma&limit=5')
      .set('Authorization', `Bearer ${admin}`);
    assert.strictEqual(bySector.body.total, 296);
    assert.deepStrictEqual([...new Set(bySector.body.nodes.map((n) => n.sector))], ['charisma']);

    const byKind = await request(app).get('/api/passive-nodes?kind=keystone&limit=100')
      .set('Authorization', `Bearer ${admin}`);
    assert.strictEqual(byKind.body.total, 30);
    assert.deepStrictEqual([...new Set(byKind.body.nodes.map((n) => n.kind))], ['keystone']);

    const bySearch = await request(app).get('/api/passive-nodes?search=start-')
      .set('Authorization', `Bearer ${admin}`);
    assert.strictEqual(bySearch.body.total, 6);

    const combined = await request(app)
      .get('/api/passive-nodes?sector=charisma&kind=keystone&limit=100')
      .set('Authorization', `Bearer ${admin}`);
    assert.strictEqual(combined.body.total, 5);
  });

  await t.test('a search string is parameterised, not interpolated', async () => {
    // If this reaches the database as SQL the request 500s or the total is
    // wrong; either way the assertion below fails rather than the table drops.
    const res = await request(app).get(`/api/passive-nodes?search=${encodeURIComponent("%' OR '1'='1")}`)
      .set('Authorization', `Bearer ${admin}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.total, 0);
  });

  await t.test('a LIKE wildcard in the search is matched literally', async () => {
    // Parameterising a query does NOT escape `%` and `_` -- they are pattern
    // syntax inside ILIKE, not SQL syntax. A bare `%` typed into the search box
    // would otherwise match every row and read as "search is broken". An
    // ESCAPED `%` finds only the labels that literally contain one ("+35% fire
    // damage"); an UNESCAPED one is a wildcard and finds them all.
    //
    // The expected count is COUNTED, not written down. It used to be the
    // literal 13, which is authored content: adding one node whose label
    // mentions a percentage broke this test with "14 !== 13", a failure that
    // says nothing about escaping and everything about the tree having grown.
    //
    // The oracle is deliberately JavaScript's `includes`, not another LIKE:
    // `includes` has no pattern syntax at all, so it cannot share the very bug
    // under test. Counting with `LIKE '%\\%%'` would be comparing the query
    // against a restatement of itself.
    const allLabels = (await pool.query('SELECT label FROM passive_nodes')).rows;
    const literalPct = allLabels.filter((r) => String(r.label).includes('%')).length;
    assert.ok(literalPct > 0 && literalPct < allLabels.length,
      `the discrimination needs some-but-not-all labels to contain a literal % `
      + `(got ${literalPct} of ${allLabels.length})`);

    const pct = await request(app).get(`/api/passive-nodes?search=${encodeURIComponent('%')}`)
      .set('Authorization', `Bearer ${admin}`);
    assert.strictEqual(pct.body.total, literalPct);
    assert.notStrictEqual(pct.body.total, allLabels.length,
      'an unescaped % matched every row -- the wildcard is reaching ILIKE as pattern syntax');
    const underscore = await request(app).get(`/api/passive-nodes?search=${encodeURIComponent('start_strength')}`)
      .set('Authorization', `Bearer ${admin}`);
    assert.strictEqual(underscore.body.total, 0,
      'start_strength must not match start-strength: `_` is a single-character wildcard');
  });

  await t.test('an unknown sector or kind filter is ignored rather than 500ing', async () => {
    const res = await request(app).get('/api/passive-nodes?sector=nowhere&kind=legendary&limit=1')
      .set('Authorization', `Bearer ${admin}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.total, 1806);
  });

  await t.test('updates label, kind and grants', async () => {
    const res = await request(app).put(`/api/passive-nodes/${id}`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ label: 'Retuned', kind: 'notable', grants: [{ type: 'stat', stat: 'strength', value: 11 }] });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.label, 'Retuned');
    assert.strictEqual(res.body.kind, 'notable');
    assert.deepStrictEqual(res.body.grants, [{ type: 'stat', stat: 'strength', value: 11 }]);

    // Read back through a second connection: a route that answers from its own
    // request body rather than the RETURNING row would pass the three
    // assertions above while writing nothing.
    const row = await pool.query('SELECT label, kind, grants FROM passive_nodes WHERE id = $1', [id]);
    assert.strictEqual(row.rows[0].label, 'Retuned');
    assert.strictEqual(row.rows[0].kind, 'notable');
    assert.deepStrictEqual(row.rows[0].grants, [{ type: 'stat', stat: 'strength', value: 11 }]);
  });

  await t.test('a saved edit is visible to the running server without a restart', async () => {
    // passiveTreeStore caches the whole graph in module scope. Without
    // invalidateTreeCache() on the write path the save succeeds, the admin sees
    // the new value in the form, and every live world keeps granting the old
    // one until the process restarts -- inert, and green under every test that
    // only reads the table back. Priming the cache FIRST is what makes this
    // assertion mean anything.
    invalidateTreeCache();
    const primed = await loadTree(pool);
    assert.strictEqual(primed.byId.get(id).label, 'Retuned');

    await request(app).put(`/api/passive-nodes/${id}`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ label: 'Cache Buster', kind: 'notable', grants: [{ type: 'stat', stat: 'strength', value: 3 }] });

    const after = await loadTree(pool);
    assert.strictEqual(after.byId.get(id).label, 'Cache Buster');
    assert.deepStrictEqual(after.byId.get(id).grants, [{ type: 'stat', stat: 'strength', value: 3 }]);
  });

  await t.test('refuses an unknown kind, an unknown grant type and a bad stat name', async () => {
    const badKind = await request(app).put(`/api/passive-nodes/${id}`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ label: 'x', kind: 'legendary', grants: [] });
    assert.strictEqual(badKind.status, 400);
    assert.match(badKind.body.error, /kind/);

    const badGrant = await request(app).put(`/api/passive-nodes/${id}`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ label: 'x', kind: 'minor', grants: [{ type: 'wat', value: 1 }] });
    assert.strictEqual(badGrant.status, 400);
    assert.match(badGrant.body.error, /wat/);

    const badStat = await request(app).put(`/api/passive-nodes/${id}`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ label: 'x', kind: 'minor', grants: [{ type: 'stat', stat: 'strenght', value: 2 }] });
    assert.strictEqual(badStat.status, 400);
    assert.match(badStat.body.error, /stat/);
    assert.match(badStat.body.error, /strenght/);
  });

  await t.test('rejects every other way a grant can be silently inert', async () => {
    // One case per vocabulary axis, because a validator that only checks
    // `stat` is exactly as broken as one that checks nothing -- for the five
    // other grant types.
    const cases = [
      [{ type: 'resource', pool: 'health', value: 10 }, /resource pool/],
      [{ type: 'damage', element: 'holy', value: 10 }, /element/],
      [{ type: 'resist', element: 'psychic', value: 10 }, /element/],
      [{ type: 'status', status: 'poison', value: 10 }, /status/],
      [{ type: 'rule', rule: 'lifeCostMultiplyer', value: 0.5 }, /rule/],
      [{ type: 'stat', stat: 'strength', value: 'abc' }, /value/],
      [{ type: 'stat', stat: 'strength' }, /value/],
      [{ type: 'stat', stat: 'strength', value: null }, /value/],
      [{ type: 'stat', stat: 'strength', value: true }, /value/],
      [{ type: 'stat', value: 2 }, /stat/],
      ['not an object', /object/],
      [null, /object/],
    ];
    for (const [grant, re] of cases) {
      const res = await request(app).put(`/api/passive-nodes/${id}`)
        .set('Authorization', `Bearer ${admin}`)
        .send({ label: 'x', kind: 'minor', grants: [grant] });
      assert.strictEqual(res.status, 400, `expected 400 for ${JSON.stringify(grant)}`);
      assert.match(res.body.error, re, `wrong message for ${JSON.stringify(grant)}`);
    }

    // ...and none of the twelve wrote anything.
    const row = await pool.query('SELECT label FROM passive_nodes WHERE id = $1', [id]);
    assert.strictEqual(row.rows[0].label, 'Cache Buster');
  });

  await t.test('requires a label and an array of grants', async () => {
    for (const body of [
      { label: '   ', kind: 'minor', grants: [] },
      { label: 42, kind: 'minor', grants: [] },
      { kind: 'minor', grants: [] },
      { label: 'x', kind: 'minor', grants: { type: 'stat' } },
      { label: 'x', kind: 'minor' },
    ]) {
      const res = await request(app).put(`/api/passive-nodes/${id}`)
        .set('Authorization', `Bearer ${admin}`).send(body);
      assert.strictEqual(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    }
  });

  await t.test('accepts a numeric string and a negative value, storing them as numbers', async () => {
    const res = await request(app).put(`/api/passive-nodes/${id}`)
      .set('Authorization', `Bearer ${admin}`)
      .send({
        label: 'Coerced',
        kind: 'minor',
        grants: [{ type: 'resist', element: 'ice', value: '-15' }],
      });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.grants, [{ type: 'resist', element: 'ice', value: -15 }]);
    const row = await pool.query('SELECT grants FROM passive_nodes WHERE id = $1', [id]);
    assert.strictEqual(typeof row.rows[0].grants[0].value, 'number');
  });

  await t.test('stores only the fields the grant type uses', async () => {
    // A `stat` left over from the previous type on a `damage` grant validates,
    // stores and does nothing. Dropping it server-side means the frontend's
    // identical rule is a convenience, not the only guard.
    const res = await request(app).put(`/api/passive-nodes/${id}`)
      .set('Authorization', `Bearer ${admin}`)
      .send({
        label: 'Trimmed',
        kind: 'minor',
        grants: [{ type: 'damage', element: 'fire', stat: 'strength', junk: 1, value: 12 }],
      });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.grants, [{ type: 'damage', element: 'fire', value: 12 }]);
  });

  await t.test('refuses to turn an ordinary node into a start node', async () => {
    // kind='start' and a non-null start_class are the same fact (the DB CHECK),
    // so accepting this would either violate the constraint or hand a second
    // start node to a class.
    const res = await request(app).put(`/api/passive-nodes/${id}`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ label: 'x', kind: 'start', grants: [] });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /start/);
  });

  await t.test('refuses to edit an existing start node', async () => {
    // The other direction: a start node's grants are STRUCTURAL (SOMET-471 --
    // the seeder rewrites them on every reseed, forced or not), so an edit here
    // would be silently reverted the next time anyone ran seed-passive-tree.
    // Editing its kind would also break passive_nodes_start_class_check.
    const start = await pool.query("SELECT id, grants FROM passive_nodes WHERE key = 'start-strength'");
    const res = await request(app).put(`/api/passive-nodes/${start.rows[0].id}`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ label: 'Hijacked', kind: 'notable', grants: [] });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /start/);
    const after = await pool.query('SELECT label, kind, grants FROM passive_nodes WHERE id = $1',
      [start.rows[0].id]);
    assert.strictEqual(after.rows[0].kind, 'start');
    assert.notStrictEqual(after.rows[0].label, 'Hijacked');
    assert.deepStrictEqual(after.rows[0].grants, start.rows[0].grants);
  });

  await t.test('ignores structural fields even when they are sent', async () => {
    const before = await pool.query('SELECT x, y, sector, ring, key, start_class FROM passive_nodes WHERE id = $1', [id]);
    const res = await request(app).put(`/api/passive-nodes/${id}`)
      .set('Authorization', `Bearer ${admin}`)
      .send({
        label: 'Structure held', kind: 'minor', grants: [],
        x: 9999, y: 9999, sector: 'core', ring: 0, key: 'hijacked', start_class: 'Warrior', id: 1,
      });
    assert.strictEqual(res.status, 200);
    const after = await pool.query('SELECT x, y, sector, ring, key, start_class FROM passive_nodes WHERE id = $1', [id]);
    assert.deepStrictEqual(after.rows[0], before.rows[0]);
    assert.strictEqual(res.body.id, id);
  });

  await t.test('404s on a node that does not exist', async () => {
    const res = await request(app).put('/api/passive-nodes/99999999')
      .set('Authorization', `Bearer ${admin}`)
      .send({ label: 'x', kind: 'minor', grants: [] });
    assert.strictEqual(res.status, 404);
  });

  await t.test('400s rather than 500s on a non-numeric id', async () => {
    const res = await request(app).put('/api/passive-nodes/not-a-number')
      .set('Authorization', `Bearer ${admin}`)
      .send({ label: 'x', kind: 'minor', grants: [] });
    assert.strictEqual(res.status, 400);
  });

  await t.test('AC3: a reseed keeps an admin edit; --force overwrites it', async () => {
    // The end-to-end version of the seeder test in Task 1: the edit is made
    // through the ADMIN API, then the generator is re-run both ways. This is
    // the path an operator actually takes, and it is the one that would break
    // if the API ever wrote a column the seeder overwrites unconditionally.
    //
    // Locked, because passive_tree_seed_db.test.js runs seedPassiveTree(force)
    // in a parallel process against the same database; without the lock its
    // force-reseed can land between the PUT and the assertion below.
    await withAdvisoryLock(pool, PASSIVE_TREE_LOCK_KEY, async () => {
      const put = await request(app).put(`/api/passive-nodes/${id}`)
        .set('Authorization', `Bearer ${admin}`)
        .send({ label: 'Hand-tuned', kind: 'notable', grants: [{ type: 'stat', stat: 'strength', value: 7 }] });
      assert.strictEqual(put.status, 200);

      await seedPassiveTree(pool, { quiet: true });
      const kept = await pool.query('SELECT label, kind, grants FROM passive_nodes WHERE id = $1', [id]);
      assert.strictEqual(kept.rows[0].label, 'Hand-tuned');
      assert.strictEqual(kept.rows[0].kind, 'notable');
      assert.deepStrictEqual(kept.rows[0].grants, [{ type: 'stat', stat: 'strength', value: 7 }]);

      await seedPassiveTree(pool, { force: true, quiet: true });
      const forced = await pool.query('SELECT label, kind, grants FROM passive_nodes WHERE id = $1', [id]);
      // Hand-written literals read off the freshly seeded database, not
      // re-derived from generatePassiveTree -- deriving them from the same
      // generator the seeder runs would make this assertion true by
      // construction whatever --force did.
      assert.strictEqual(forced.rows[0].label, 'Sinew');
      assert.strictEqual(forced.rows[0].kind, 'minor');
      assert.deepStrictEqual(forced.rows[0].grants, [{ type: 'stat', stat: 'strength', value: 2 }]);
    }, { waitMs: PASSIVE_TREE_LOCK_WAIT_MS });
  });

  await t.test('AC4: editing an allocated node does not orphan character_passives', async () => {
    // A node someone has already spent a point on must survive both an admin
    // edit and the reseed that follows it, with the SAME id -- character_passives
    // references the id, so a delete-and-reinsert would either fail on the FK
    // or cascade the player's point away.
    const tag = `passadmin-${process.pid}-${Date.now()}`;
    const warrior = await pool.query("SELECT id FROM entity_types WHERE name = 'Warrior'");
    assert.strictEqual(warrior.rowCount, 1, 'the Warrior entity type must be seeded');
    const u = await pool.query(
      'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
      [tag, 'x', 'player'],
    );
    const c = await pool.query(
      'INSERT INTO characters (user_id, slot, name, entity_type_id) VALUES ($1, 1, $2, $3) RETURNING id',
      [u.rows[0].id, tag, warrior.rows[0].id],
    );
    t.after(async () => {
      await pool.query('DELETE FROM users WHERE id = $1', [u.rows[0].id]).catch(() => {});
    });
    await pool.query('INSERT INTO character_passives (character_id, node_id) VALUES ($1, $2)',
      [c.rows[0].id, id]);

    const res = await request(app).put(`/api/passive-nodes/${id}`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ label: 'Edited under a live allocation', kind: 'notable', grants: [] });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.id, id);   // the id never moves

    const stillAfterEdit = await pool.query(
      'SELECT node_id FROM character_passives WHERE character_id = $1', [c.rows[0].id]);
    assert.deepStrictEqual(stillAfterEdit.rows.map((r) => r.node_id), [id]);

    await withAdvisoryLock(pool, PASSIVE_TREE_LOCK_KEY, async () => {
      await seedPassiveTree(pool, { force: true, quiet: true });
    }, { waitMs: PASSIVE_TREE_LOCK_WAIT_MS });

    const still = await pool.query(
      'SELECT node_id FROM character_passives WHERE character_id = $1', [c.rows[0].id]);
    assert.deepStrictEqual(still.rows.map((r) => r.node_id), [id]);
    // And the node itself is still the same row, not a re-inserted twin.
    const same = await pool.query('SELECT id FROM passive_nodes WHERE key = $1', [TARGET_KEY]);
    assert.strictEqual(same.rows[0].id, id);
  });
});
