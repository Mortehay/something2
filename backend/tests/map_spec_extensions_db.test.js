// SOMET-641 (Plan 4a, Task 2). Three optional spec extensions that let every
// World Map Editor hand edit be expressed in a .map.json, and an applier that
// stops pruning links another spec declares:
//   - world `graph: [x, y]`   explicit map-graph position, wins over grid * 220
//   - link `kind: 'edge'`     a compass doorway with no grid-delta check
//   - link `to_name`          a target world by NAME, owned by another spec
//   - applyMapSpec keepSlots  '<world name>:<edge>' declared by other specs
//
// The DB tests apply small sx_mapext_* fixture specs, never the real ones, and
// always with moveEntry:false. They still hold the entry lock and the seed-sync
// lock (constraints.md), and delete only their own worlds (map_links,
// waypoints and world_creatures cascade from worlds).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { validateMapSpec } = require('../seeds/mapSpec.js');
const { applyMapSpec, GRID_SPACING } = require('../scripts/seed-map.js');
const { withEntryPreserved } = require('./helpers/entryWorld.js');
const { withSeedSyncLock } = require('./helpers/seedSyncTest.js');

const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

const P = 'sx_mapext_';

async function openPool() {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 2 });
  try { await pool.query('SELECT 1'); return pool; }
  catch (err) { await pool.end().catch(() => {}); return { unreachable: err.message }; }
}

async function cleanup(pool) {
  await pool.query("DELETE FROM worlds WHERE name LIKE 'sx\\_mapext\\_%'");
}

// Deep Forest is all-walkable terrain, so navigability never depends on a seed.
function world(key, grid, extra = {}) {
  return {
    key, name: `${P}${key}`, ...(grid ? { grid } : {}), seed: 4100 + key.charCodeAt(0),
    width: 64, height: 64, chunk_size: 64, biomes: ['Deep Forest'], biome_cell: 32,
    allowed_creature_types: [], ...extra,
  };
}
const ENTRY = { is_entry: true, entry_spawn: { x: 3200, y: 3200 } };

// Spec A: a -E-> b (grid), b -S-> c as an explicit edge (c is nowhere near b on
// the grid), and b dragged to a hand-placed graph position.
const specA = () => ({
  name: 'sx-mapext-a',
  worlds: [
    world('a', [2, 1], ENTRY),
    world('b', [3, 1], { graph: [1234.5, -77] }),
    world('c', [7, 7]),
  ],
  links: [
    { from: 'a', edge: 'E', to: 'b' },
    { kind: 'edge', from: 'b', edge: 'S', to: 'c' },
  ],
});

// Spec B: owns only d, and links it WEST into spec A's b by name (mirror
// b -E-> d), plus a portal from d into spec A's c by name.
const specB = (target = `${P}b`) => ({
  name: 'sx-mapext-b',
  worlds: [world('d', [9, 9], ENTRY)],
  links: [
    { from: 'd', edge: 'W', to_name: target },
    { kind: 'portal', from: 'd', from_x: 1050, from_y: 1050, to_name: `${P}c`, to_x: 1550, to_y: 1550 },
  ],
});

async function compassLinks(pool) {
  return (await pool.query(
    `SELECT wf.name AS from_name, ml.edge, wt.name AS to_name FROM map_links ml
       JOIN worlds wf ON wf.id = ml.from_world_id JOIN worlds wt ON wt.id = ml.to_world_id
      WHERE ml.edge <> 'PORTAL' AND (wf.name LIKE 'sx\\_mapext\\_%' OR wt.name LIKE 'sx\\_mapext\\_%')
      ORDER BY 1, 2`)).rows.map((r) => `${r.from_name}:${r.edge}->${r.to_name}`);
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

// ---------------------------------------------------------------------------

test('graph overrides grid position', async (t) => {
  // Validator: finite numbers, exactly two of them.
  assert.deepEqual(validateMapSpec(specA()), []);
  for (const bad of [[1], [1, 2, 3], ['1', 2], [NaN, 0], [Infinity, 0], { x: 1, y: 2 }, null]) {
    const s = specA();
    s.worlds[1].graph = bad;
    const errs = validateMapSpec(s);
    assert.ok(errs.some((e) => /world "b" graph/.test(e)),
      `graph ${JSON.stringify(bad)} must be refused, got ${JSON.stringify(errs)}`);
  }
  // A portal-only world may carry graph without grid.
  const portalOnly = specA();
  portalOnly.worlds.push(world('p', null, { graph: [10, 20] }));
  portalOnly.links.push({ kind: 'portal', from: 'a', from_x: 1050, from_y: 1050, to: 'p', to_x: 1550, to_y: 1550 });
  assert.deepEqual(validateMapSpec(portalOnly), []);

  await withDb(t, 'graph override', async (pool) => {
    await applyMapSpec(pool, portalOnly, { moveEntry: false });
    const rows = (await pool.query(
      "SELECT name, graph_x, graph_y FROM worlds WHERE name LIKE 'sx\\_mapext\\_%' ORDER BY name")).rows;
    const pos = Object.fromEntries(rows.map((r) => [r.name, [r.graph_x, r.graph_y]]));
    assert.deepEqual(pos[`${P}a`], [2 * GRID_SPACING, 1 * GRID_SPACING], 'no graph key: grid-derived as before');
    assert.deepEqual(pos[`${P}b`], [1234.5, -77], 'graph wins over grid');
    assert.deepEqual(pos[`${P}c`], [7 * GRID_SPACING, 7 * GRID_SPACING]);
    assert.deepEqual(pos[`${P}p`], [10, 20], 'graph on a grid-less portal-only world');
  });
});

test('edge link applies without a grid check and survives re-seed', async (t) => {
  // The same link without kind:'edge' is a grid contradiction.
  const plain = specA();
  delete plain.links[1].kind;
  assert.ok(validateMapSpec(plain).some((e) => /b->c declares edge S/.test(e)));

  const badEdge = specA();
  badEdge.links[1].edge = 'PORTAL';
  assert.ok(validateMapSpec(badEdge).some((e) => /invalid edge "PORTAL"/.test(e)));

  // (from, edge) uniqueness spans plain and edge links.
  const dupSlot = specA();
  dupSlot.links.push({ kind: 'edge', from: 'a', edge: 'E', to: 'c' });
  assert.ok(validateMapSpec(dupSlot).some((e) => /"a" already has a link on edge E/.test(e)));

  // Two links whose MIRRORS land on one slot: c:N would hold both b and a, and
  // setLink's ON CONFLICT would silently keep only the second.
  const mirrorClash = specA();
  mirrorClash.links.push({ kind: 'edge', from: 'a', edge: 'S', to: 'c' });
  assert.ok(validateMapSpec(mirrorClash).some((e) => /mirror/.test(e) && /"c"/.test(e)),
    JSON.stringify(validateMapSpec(mirrorClash)));

  // Both directions declared explicitly is consistent, not a clash.
  const both = specA();
  both.links.push({ kind: 'edge', from: 'c', edge: 'N', to: 'b' });
  assert.deepEqual(validateMapSpec(both), []);

  // An edge link still needs a bounded target world.
  const unbounded = specA();
  delete unbounded.worlds[2].width;
  assert.ok(validateMapSpec(unbounded).some((e) => /"c" width/.test(e)));

  await withDb(t, 'edge link', async (pool) => {
    const first = await applyMapSpec(pool, specA(), { moveEntry: false });
    const want = [`${P}a:E->${P}b`, `${P}b:S->${P}c`, `${P}b:W->${P}a`, `${P}c:N->${P}b`];
    assert.deepEqual(await compassLinks(pool), want);
    assert.equal(first.links, 2);
    const second = await applyMapSpec(pool, specA(), { moveEntry: false });
    assert.deepEqual(second.linksRemoved, [], 're-seed must not prune the edge link or its mirror');
    assert.deepEqual(await compassLinks(pool), want);
  });
});

test('to_name link resolves across specs; missing target refused before writes', async (t) => {
  assert.deepEqual(validateMapSpec(specB()), [], 'to_name to a world outside the spec validates');

  const both = specB();
  both.links[0].to = 'd';
  assert.ok(validateMapSpec(both).some((e) => /both "to" and "to_name"/.test(e)));

  const local = specB(`${P}d`);
  assert.ok(validateMapSpec(local).some((e) => /use "to"/.test(e)), JSON.stringify(validateMapSpec(local)));

  for (const bad of ['', 7, null]) {
    const s = specB();
    s.links[0].to_name = bad;
    assert.ok(validateMapSpec(s).some((e) => /to_name/.test(e)), `to_name ${JSON.stringify(bad)}`);
  }

  // Two cross-spec links whose mirrors land on the same foreign slot.
  const clash = specB();
  clash.worlds.push(world('e', [9, 8]));
  clash.links.push({ from: 'd', edge: 'N', to: 'e' });
  clash.links.push({ kind: 'edge', from: 'e', edge: 'W', to_name: `${P}b` });
  assert.ok(validateMapSpec(clash).some((e) => /mirror/.test(e)), JSON.stringify(validateMapSpec(clash)));

  await withDb(t, 'to_name', async (pool) => {
    await applyMapSpec(pool, specA(), { moveEntry: false });

    const missing = specB(`${P}nope`);
    missing.links[1].to_name = `${P}nope2`;
    await assert.rejects(applyMapSpec(pool, missing, { moveEntry: false }),
      (err) => err.message.includes(`${P}nope`) && err.message.includes(`${P}nope2`));
    const d = await pool.query(`SELECT 1 FROM worlds WHERE name = '${P}d'`);
    assert.equal(d.rowCount, 0, 'a missing to_name target must refuse BEFORE any write');

    await applyMapSpec(pool, specB(), { moveEntry: false });
    const links = await compassLinks(pool);
    assert.ok(links.includes(`${P}d:W->${P}b`), JSON.stringify(links));
    assert.ok(links.includes(`${P}b:E->${P}d`), 'mirror of a cross-spec compass link');
    const portals = (await pool.query(
      `SELECT wf.name AS f, wt.name AS t, ml.from_x, ml.from_y FROM map_links ml
         JOIN worlds wf ON wf.id = ml.from_world_id JOIN worlds wt ON wt.id = ml.to_world_id
        WHERE ml.edge = 'PORTAL' AND wf.name LIKE 'sx\\_mapext\\_%' ORDER BY 1`)).rows;
    assert.deepEqual(portals.map((r) => `${r.f}@${r.from_x},${r.from_y}->${r.t}`),
      [`${P}c@1550,1550->${P}d`, `${P}d@1050,1050->${P}c`]);
  });
});

test("cross-spec link is kept by both specs' prune", async (t) => {
  await withDb(t, 'cross-spec prune', async (pool) => {
    await applyMapSpec(pool, specA(), { moveEntry: false });
    await applyMapSpec(pool, specB(), { moveEntry: false });
    const all = await compassLinks(pool);
    assert.ok(all.includes(`${P}d:W->${P}b`) && all.includes(`${P}b:E->${P}d`));

    // B re-applied alone: the mirror b:E->d is inbound from a world B does not
    // own, but it is the mirror of B's own declared link -- B's keep set.
    const b2 = await applyMapSpec(pool, specB(), { moveEntry: false });
    assert.deepEqual(b2.linksRemoved, []);

    // A re-applied WITH B's declared slots: neither half is pruned.
    const a2 = await applyMapSpec(pool, specA(), { moveEntry: false, keepSlots: [`${P}d:W`] });
    assert.deepEqual(a2.linksRemoved, []);
    assert.deepEqual(await compassLinks(pool), all);

    // B re-applied with A's slots too (what Task 4 passes): still nothing.
    const b3 = await applyMapSpec(pool, specB(), { moveEntry: false, keepSlots: [`${P}a:E`, `${P}b:S`] });
    assert.deepEqual(b3.linksRemoved, []);
    assert.deepEqual(await compassLinks(pool), all);

    // Without keepSlots, A still converges as before: both halves of B's link go.
    const a3 = await applyMapSpec(pool, specA(), { moveEntry: false });
    assert.deepEqual(a3.linksRemoved.map((r) => `${r.from_name}:${r.edge}->${r.to_name}`).sort(),
      [`${P}b:E->${P}d`, `${P}d:W->${P}b`]);
  });
});

test('existing specs validate and apply unchanged', async (t) => {
  // The checked-in specs use none of the new fields, so every new code path is
  // unreachable from them; seed_map_db.test.js "every shipped spec applies
  // cleanly" pins that they apply idempotently with linksRemoved [].
  const dir = path.join(__dirname, '..', 'seeds', 'maps');
  for (const f of ['vale-region.map.json', 'p5-descent.map.json']) {
    const spec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.deepEqual(validateMapSpec(spec), [], `${f} must still validate`);
    assert.ok(spec.worlds.every((w) => !('graph' in w)), `${f} declares graph`);
    assert.ok(spec.links.every((l) => l.kind !== 'edge' && !('to_name' in l)), `${f} uses edge/to_name`);
  }

  // A plain spec (grid compass + portal, no new keys) lands exactly the rows
  // and positions derived independently from its grid.
  const plain = {
    name: 'sx-mapext-plain',
    worlds: [world('a', [2, 1], ENTRY), world('b', [3, 1]), world('q', null)],
    links: [
      { from: 'a', edge: 'E', to: 'b' },
      { kind: 'portal', from: 'b', from_x: 1050, from_y: 1050, to: 'q', to_x: 1550, to_y: 1550 },
    ],
  };
  assert.deepEqual(validateMapSpec(plain), []);
  await withDb(t, 'plain spec', async (pool) => {
    const r = await applyMapSpec(pool, plain, { moveEntry: false });
    assert.equal(r.links, 2);
    assert.deepEqual(await compassLinks(pool), [`${P}a:E->${P}b`, `${P}b:W->${P}a`]);
    const rows = (await pool.query(
      "SELECT name, graph_x, graph_y FROM worlds WHERE name LIKE 'sx\\_mapext\\_%' ORDER BY name")).rows;
    assert.deepEqual(rows.map((x) => [x.name, x.graph_x, x.graph_y]), [
      [`${P}a`, 440, 220], [`${P}b`, 660, 220], [`${P}q`, null, null]]);
    const again = await applyMapSpec(pool, plain, { moveEntry: false });
    assert.deepEqual(again.linksRemoved, []);
  });
});
