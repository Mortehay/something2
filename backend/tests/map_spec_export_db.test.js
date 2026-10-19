// SOMET-641 (Plan 4a, Task 3). The DB -> spec writer: specFromDb turns the
// current database state of a map spec's worlds back into that spec, so a hand
// edit made in the World Map Editor can travel between PCs as a .map.json.
//
// Every edit below is made with the SQL (or service call) the admin route that
// makes it runs. Three of them have NO admin route -- a moved waypoint, a moved
// chest, and a moved village (the route can only delete + create, which is what
// this test does) -- so those use the plain UPDATE a hand edit would.
//
// The DB tests apply sx_w3_* fixture specs and sx_w3_-prefixed copies of the
// two shipped specs, always with moveEntry:false. They hold the entry lock and
// the seed-sync lock (constraints.md) and delete only their own worlds
// (map_links, waypoints, villages, world_chests and world_creatures cascade).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { validateMapSpec } = require('../seeds/mapSpec.js');
const { applyMapSpec } = require('../scripts/seed-map.js');
const { setLink, clearLink } = require('../src/services/mapLinks.js');
const { createVillage, rederiveVillageGuards } = require('../src/services/villages.js');
const { specFromDb, canonicalSpecJson, compassSlots } = require('../src/services/mapSpecExport.js');
const { withEntryPreserved } = require('./helpers/entryWorld.js');
const { withSeedSyncLock } = require('./helpers/seedSyncTest.js');

const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

const P = 'sx_w3_';
const SPEC_DIR = path.join(__dirname, '..', 'seeds', 'maps');
const SHIPPED = ['vale-region', 'p5-descent'];

async function openPool() {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 2 });
  try { await pool.query('SELECT 1'); return pool; }
  catch (err) { await pool.end().catch(() => {}); return { unreachable: err.message }; }
}

async function cleanup(pool) {
  await pool.query("DELETE FROM worlds WHERE name LIKE 'sx\\_w3\\_%'");
}

async function withDb(t, label, fn) {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} (${pool.unreachable}) — ${label} is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    await withSeedSyncLock(pool, () => withEntryPreserved(pool, async () => {
      await cleanup(pool);
      try { await fn(pool); } finally { await cleanup(pool); }
    }));
  } finally { await pool.end(); }
}

function readShipped(name) {
  return fs.readFileSync(path.join(SPEC_DIR, `${name}.map.json`), 'utf8');
}

// A copy of a shipped spec whose every globally unique name (world, waypoint)
// carries the prefix, so it can be applied beside the real one.
function prefixed(spec) {
  const s = structuredClone(spec);
  s.name = `${P}${spec.name}`;
  for (const w of s.worlds) {
    w.name = `${P}${w.name}`;
    for (const wp of w.waypoints ?? []) wp.name = `${P}${wp.name}`;
  }
  for (const l of s.links) {
    if (l.waypoint_name !== undefined) l.waypoint_name = `${P}${l.waypoint_name}`;
    if (l.to_name !== undefined) l.to_name = `${P}${l.to_name}`;
  }
  return s;
}

// World name -> spec name, for every world of every spec but `self`.
function othersOf(self, specs) {
  const m = new Map();
  for (const s of specs) if (s !== self) for (const w of s.worlds) m.set(w.name, s.name);
  return m;
}
function slotsOf(self, specs) {
  return specs.filter((s) => s !== self).flatMap(compassSlots);
}

// Deep Forest is all-walkable terrain, so navigability never depends on a seed.
function world(key, grid, seed, extra = {}) {
  return {
    key, name: `${P}${key}`, ...(grid ? { grid } : {}), seed,
    width: 64, height: 64, chunk_size: 64, biomes: ['Deep Forest'], biome_cell: 32,
    allowed_creature_types: [], ...extra,
  };
}

// Spec A: a -E-> b -E-> c on the grid, a portal (a waypoint, with art) from a
// into the grid-less p, and a village, a waypoint and a vault chest in b.
const fixtureA = () => ({
  name: 'sx-w3-a',
  worlds: [
    world('a', [0, 0], 731001, { is_entry: true, entry_spawn: { x: 3200, y: 3200 } }),
    world('b', [1, 0], 731002, {
      village: {
        key: 'bv', min_row: 20, min_col: 20, width: 6, height: 4,
        gate_edge: 'S', spawn_x: 2150, spawn_y: 2150,
      },
      chest: { x: 4550, y: 4550, guard_creature_type: 'Slime', level: 2 },
      waypoints: [{ x: 4050, y: 4050, name: `${P}b stone` }],
    }),
    world('c', [2, 0], 731003),
    world('p', null, 731004),
  ],
  links: [
    { from: 'a', edge: 'E', to: 'b' },
    { from: 'b', edge: 'E', to: 'c' },
    {
      kind: 'portal', from: 'a', from_x: 1050, from_y: 1050, to: 'p', to_x: 1550, to_y: 1550,
      art: 'portal', is_waypoint: true, waypoint_name: `${P}a stair`,
    },
  ],
});
// Spec B: one world, d. Its name sorts after A's, which decides which spec a
// hand-drawn link between them is written into.
const fixtureB = () => ({
  name: 'sx-w3-b',
  worlds: [world('d', [0, 0], 731005, { is_entry: true, entry_spawn: { x: 3200, y: 3200 } })],
  links: [],
});

async function worldId(pool, name) {
  const r = await pool.query('SELECT id FROM worlds WHERE name = $1', [name]);
  assert.equal(r.rowCount, 1, `world ${name}`);
  return r.rows[0].id;
}

// PUT /api/worlds/:id (src/index.js): the admin form sends every field back,
// so the route's UPDATE is called with the current values plus the edit.
async function putWorld(pool, name, patch) {
  const cur = (await pool.query('SELECT * FROM worlds WHERE name = $1', [name])).rows[0];
  const b = { ...cur, ...patch };
  await pool.query(
    `UPDATE worlds SET name = $1, width = $2, height = $3, creature_count = $4,
       allowed_creature_types = $5::jsonb, is_entry = $6, entry_spawn = $7::jsonb,
       biomes = $8::jsonb, biome_cell = $9,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $10 RETURNING *`,
    [b.name, b.width, b.height, b.creature_count, JSON.stringify(b.allowed_creature_types),
      b.is_entry, b.entry_spawn ? JSON.stringify(b.entry_spawn) : null,
      JSON.stringify(b.biomes), b.biome_cell, cur.id],
  );
}

// Everything a spec authors, as the database holds it. Village spec_key is
// left out on purpose: a re-seed adopts an admin-created (unkeyed) village by
// its exact box and stamps the key, which is identity bookkeeping, not state.
async function snapshot(pool) {
  const q = async (sql) => (await pool.query(sql)).rows;
  return {
    worlds: await q(`SELECT name, seed, chunk_size, width, height, allowed_creature_types, entry_spawn,
        biomes, biome_cell, graph_x, graph_y, level_min, level_max, density, allows_fast_travel,
        safe_road_radius, safe_rects, authored_roads, pens, dungeon_boss
        FROM worlds WHERE name LIKE 'sx\\_w3\\_%' ORDER BY name`),
    links: await q(`SELECT wf.name AS f, ml.edge, wt.name AS t, ml.from_x, ml.from_y, ml.to_x, ml.to_y,
        ml.is_waypoint, ml.entity_type_id FROM map_links ml
        JOIN worlds wf ON wf.id = ml.from_world_id JOIN worlds wt ON wt.id = ml.to_world_id
        WHERE wf.name LIKE 'sx\\_w3\\_%' ORDER BY 1, 2, 4, 5`),
    waypoints: await q(`SELECT w.name AS world, wp.name, wp.x, wp.y, wp.entity_type_id, wp.map_link_id IS NOT NULL AS portal
        FROM waypoints wp JOIN worlds w ON w.id = wp.world_id WHERE w.name LIKE 'sx\\_w3\\_%' ORDER BY 2`),
    villages: await q(`SELECT w.name AS world, v.min_row, v.min_col, v.width, v.height, v.gate_edge, v.spawn_x,
        v.spawn_y, v.merchant_x, v.merchant_y, v.merchant_entity_type_id, v.bank_entity_type_id
        FROM villages v JOIN worlds w ON w.id = v.world_id WHERE w.name LIKE 'sx\\_w3\\_%' ORDER BY 1, 2, 3`),
    chests: await q(`SELECT w.name AS world, c.x, c.y, c.kind, c.guard_level, c.guard_entity_type_id, c.entity_type_id
        FROM world_chests c JOIN worlds w ON w.id = c.world_id WHERE w.name LIKE 'sx\\_w3\\_%' ORDER BY 1`),
  };
}

// ---------------------------------------------------------------------------

test('canonicalSpecJson is identity on the checked-in specs', () => {
  for (const name of SHIPPED) {
    const text = readShipped(name);
    assert.equal(canonicalSpecJson(JSON.parse(text)), text, `${name} must round-trip byte for byte`);
  }
  // Authored key order wins over any fixed list.
  assert.equal(canonicalSpecJson({ worlds: [], name: 'z' }), '{\n  "worlds": [],\n  "name": "z"\n}\n');
});

test('validateMapSpec externallyReachable counts a world reached from another spec', () => {
  const spec = {
    name: 'sx-w3-island',
    worlds: [world('a', [0, 0], 1, { is_entry: true }), world('b', [5, 5], 2), world('c', [6, 5], 3)],
    links: [{ from: 'b', edge: 'E', to: 'c' }],
  };
  const errs = validateMapSpec(spec);
  assert.ok(errs.some((e) => /"b" is unreachable/.test(e)) && errs.some((e) => /"c" is unreachable/.test(e)),
    'default behaviour is unchanged');
  assert.deepEqual(validateMapSpec(spec, { externallyReachable: new Set(['b']) }), [],
    'b is reached from another spec, and c through b');
  assert.ok(validateMapSpec(spec, { externallyReachable: new Set(['nope']) })
    .some((e) => /"b" is unreachable/.test(e)));
});

test('writer is identity on an unedited seed', async (t) => {
  const specs = SHIPPED.map((n) => prefixed(JSON.parse(readShipped(n))));
  await withDb(t, 'shipped identity', async (pool) => {
    for (const s of specs) await applyMapSpec(pool, s, { moveEntry: false });
    for (const s of specs) {
      const { spec, notes } = await specFromDb(pool, s, {
        otherSpecWorlds: othersOf(s, specs), keepSlots: slotsOf(s, specs),
      });
      assert.deepEqual(notes, [], `${s.name}: an unedited seed has nothing to report`);
      assert.equal(canonicalSpecJson(spec), canonicalSpecJson(s), `${s.name} must be written back unchanged`);
    }
  });
});

test('each admin edit appears in the written spec', async (t) => {
  const A = fixtureA();
  const B = fixtureB();
  assert.deepEqual(validateMapSpec(A), []);
  assert.deepEqual(validateMapSpec(B), []);
  await withDb(t, 'admin edits', async (pool) => {
    await applyMapSpec(pool, A, { moveEntry: false });
    await applyMapSpec(pool, B, { moveEntry: false });
    const write = (s, specs) => specFromDb(pool, s, {
      otherSpecWorlds: othersOf(s, specs), keepSlots: slotsOf(s, specs),
    });

    // Unedited fixtures (portal art, a portal waypoint, a grid-less world).
    for (const s of [A, B]) {
      const { spec, notes } = await write(s, [A, B]);
      assert.deepEqual(notes, []);
      assert.equal(canonicalSpecJson(spec), canonicalSpecJson(s), `${s.name} unedited`);
    }

    const ids = {};
    for (const k of ['a', 'b', 'c', 'd']) ids[k] = await worldId(pool, `${P}${k}`);

    // 1. World fields, PUT /api/worlds/:id: rename, resize, biome cell.
    await putWorld(pool, `${P}c`, { name: `${P}c renamed`, width: 72, height: 72, biome_cell: 16 });
    //    POST /api/worlds/:id/regenerate: a new seed.
    await pool.query('UPDATE worlds SET seed = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
      [731099, ids.b]);
    // 2. PUT /api/worlds/:id/graph-position.
    await pool.query(`UPDATE worlds SET graph_x = $1, graph_y = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 RETURNING id, graph_x, graph_y`, [333.5, -12, ids.a]);
    // 3. POST /api/worlds/:id/links: a doorway the grid cannot express (a is
    //    at [0,0], c at [2,0]); DELETE /api/worlds/:id/links/:edge: b-E->c.
    await setLink(pool, ids.a, 'S', ids.c);
    await clearLink(pool, ids.b, 'E');
    // 4. POST /api/worlds/:id/links into the OTHER spec's world.
    await setLink(pool, ids.b, 'N', ids.d);
    // 5. A moved village: DELETE /api/worlds/:id/villages/:villageId, then
    //    POST /api/worlds/:id/villages (which stores no spec key).
    const village = (await pool.query('SELECT id FROM villages WHERE world_id = $1', [ids.b])).rows[0];
    let client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM villages WHERE id = $1 AND world_id = $2', [village.id, ids.b]);
      await rederiveVillageGuards(client, ids.b);
      await client.query('COMMIT');
      await client.query('BEGIN');
      await createVillage(client, ids.b, {
        min_row: 30, min_col: 30, width: 6, height: 4, gate_edge: 'S', spawn_x: 3150, spawn_y: 3150,
      });
      await client.query('COMMIT');
    } finally { client.release(); }
    //    PUT /api/villages/:id/art (merchant slot).
    const newVillage = (await pool.query('SELECT id FROM villages WHERE world_id = $1', [ids.b])).rows[0];
    await pool.query('UPDATE villages SET merchant_entity_type_id = $2 WHERE id = $1',
      [newVillage.id, (await pool.query("SELECT id FROM entity_types WHERE name = 'merchant_post'")).rows[0].id]);
    // 6. A moved waypoint (no route moves one), and PUT /api/waypoints/:id/art.
    const wp = (await pool.query('SELECT id FROM waypoints WHERE name = $1', [`${P}b stone`])).rows[0];
    await pool.query('UPDATE waypoints SET x = $2, y = $3 WHERE id = $1', [wp.id, 4150, 4250]);
    await pool.query('UPDATE waypoints SET entity_type_id = $2 WHERE id = $1',
      [wp.id, (await pool.query("SELECT id FROM entity_types WHERE name = 'waypoint_stone'")).rows[0].id]);
    // 7. A moved vault chest (no route moves one).
    await pool.query("UPDATE world_chests SET x = $2, y = $3 WHERE world_id = $1 AND kind = 'vault'",
      [ids.b, 4750, 4850]);

    const outA = await write(A, [A, B]);
    const outB = await write(B, [A, B]);
    const a = outA.spec;
    const byKey = Object.fromEntries(a.worlds.map((w) => [w.key, w]));

    assert.equal(byKey.c.name, `${P}c renamed`, 'rename followed (matched by seed)');
    assert.deepEqual([byKey.c.width, byKey.c.height, byKey.c.biome_cell], [72, 72, 16]);
    assert.deepEqual(byKey.c.grid, [2, 0], 'grid is never moved');
    assert.equal(byKey.b.seed, 731099);
    assert.deepEqual(byKey.a.graph, [333.5, -12]);
    assert.deepEqual(Object.keys(byKey.a).slice(0, 5), ['key', 'name', 'grid', 'graph', 'seed'],
      'an added key lands right after grid');
    assert.ok(!('graph' in byKey.b), 'an undragged world gets no graph key');
    assert.deepEqual(byKey.b.village, {
      key: 'bv', min_row: 30, min_col: 30, width: 6, height: 4, gate_edge: 'S',
      spawn_x: 3150, spawn_y: 3150, art: { merchant: 'merchant_post' },
    }, 'the one deleted village and the one created village are the same village');
    assert.deepEqual(byKey.b.waypoints, [{ x: 4150, y: 4250, name: `${P}b stone`, art: 'waypoint_stone' }]);
    assert.deepEqual(byKey.b.chest, { x: 4750, y: 4850, guard_creature_type: 'Slime', level: 2 });

    assert.deepEqual(a.links, [
      { from: 'a', edge: 'E', to: 'b' },
      A.links[2],
      { kind: 'edge', from: 'a', edge: 'S', to: 'c' },
      { from: 'b', edge: 'N', to_name: `${P}d` },
    ], 'b-E->c removed, the hand-drawn links added, the cross-spec one in the spec that sorts first');
    assert.equal(canonicalSpecJson(outB.spec), canonicalSpecJson(B), 'B does not also claim the cross-spec link');

    // Every written spec validates, and re-applies to the same DB state.
    assert.deepEqual(validateMapSpec(a, { externallyReachable: outA.externallyReachable }), []);
    assert.deepEqual(validateMapSpec(outB.spec, { externallyReachable: outB.externallyReachable }), []);
    const before = await snapshot(pool);
    const written = [a, outB.spec];
    for (const s of written) {
      const r = await applyMapSpec(pool, s, { moveEntry: false, keepSlots: slotsOf(s, written) });
      assert.deepEqual(r.linksRemoved, [], `${s.name} re-apply removed links`);
    }
    assert.deepEqual(await snapshot(pool), before, 're-applying the written specs changes nothing');
    for (const s of written) {
      const again = await write(s, written);
      assert.equal(canonicalSpecJson(again.spec), canonicalSpecJson(s), `${s.name} is a fixed point`);
    }
  });
});

test('a re-pointed doorway replaces the declared link; its stale mirror is reported', async (t) => {
  // POST /api/worlds/:id/links onto an occupied slot: setLink upserts a:E->c
  // and c:W->a, and leaves b:W->a behind pointing at a door that now leads to c.
  const C = {
    name: 'sx-w3-c',
    worlds: [
      world('a', [0, 0], 731011, { is_entry: true, entry_spawn: { x: 3200, y: 3200 } }),
      world('b', [1, 0], 731012),
      world('c', [1, 1], 731013),
    ],
    links: [{ from: 'a', edge: 'E', to: 'b' }, { from: 'b', edge: 'S', to: 'c' }],
  };
  assert.deepEqual(validateMapSpec(C), []);
  await withDb(t, 're-pointed doorway', async (pool) => {
    await applyMapSpec(pool, C, { moveEntry: false });
    await setLink(pool, await worldId(pool, `${P}a`), 'E', await worldId(pool, `${P}c`));
    const { spec, notes, externallyReachable } = await specFromDb(pool, C);
    assert.deepEqual(spec.links, [
      { from: 'b', edge: 'S', to: 'c' },
      { kind: 'edge', from: 'a', edge: 'E', to: 'c' },
    ]);
    assert.equal(notes.length, 1, JSON.stringify(notes));
    assert.match(notes[0], /one-way doorway sx_w3_b -W-> sx_w3_a \(its mirror slot leads to sx_w3_c\)/);
    assert.deepEqual(validateMapSpec(spec, { externallyReachable }), []);
    const r = await applyMapSpec(pool, spec, { moveEntry: false });
    assert.deepEqual(r.linksRemoved.map((l) => `${l.from_name}:${l.edge}->${l.to_name}`), [`${P}b:W->${P}a`],
      're-applying the written spec removes exactly the stale one-way row');
    const again = await specFromDb(pool, spec);
    assert.deepEqual(again.notes, []);
    assert.equal(canonicalSpecJson(again.spec), canonicalSpecJson(spec));
  });
});
