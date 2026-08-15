// backend/tests/village_reposition_db.test.js
//
// SOMET-312 — a village whose box moves in the spec must MOVE in the database,
// and everything derived from that box must move with it.
//
// The defect this pins: scripts/seed-map.js skipped village creation for any
// world that already had one and warned only when the COUNT differed, so a
// moved village was 1 row against 1 declaration and drifted in total silence.
// SOMET-308 found the result in a browser -- the player spawned at a resized
// world's centre on open grass with the village 16 tiles away.
//
// FOUR things follow a village's box, and a fix that moves only the first is
// worse than the drift it replaces:
//
//   the villages row itself   min_row/min_col/width/height/gate_edge/spawn
//   the merchant post         merchant_x/merchant_y, derived by villageMerchantPost
//   the two gate guards       world_creatures rows with no village_id at all,
//                             so nothing moves them for us
//   every player's bind       player_binds IS a village spawn point
//                             (authority/server.js writes { x: v.spawnX, ... })
//
// And ONE thing must NOT move: the village's id, and with it the merchant_stock
// rows that cascade off it -- including items a PLAYER listed for sale.
//
// Everything here runs against a throwaway world (zzTestMoveVillage), created
// and deleted by this file, so it never reads another test's residue.

const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { applyMapSpec } = require('../scripts/seed-map.js');
const { withEntryPreserved } = require('./helpers/entryWorld.js');
const { villageGatePosts, villageMerchantPost } = require('../src/services/mapService.js');

const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

const WORLD = 'zzTestMoveVillage';

async function openPool() {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 2 });
  try { await pool.query('SELECT 1'); return pool; }
  catch (err) { await pool.end().catch(() => {}); return { unreachable: err.message }; }
}

const cleanup = async (pool) => {
  await pool.query('DELETE FROM worlds WHERE name = $1', [WORLD]).catch(() => {});
  await pool.query("DELETE FROM users WHERE username = 'zzMoveVillageUser'").catch(() => {});
};

// Box rows 10..13, cols 10..15; interior rows 11..12, cols 11..14; spawn tile
// (11,11) -> pixel centre (1150,1150), which is interior and is neither the
// merchant post nor either gate-guard post.
const HERE = {
  key: 'commons', min_row: 10, min_col: 10, width: 6, height: 4, gate_edge: 'S',
  spawn_x: 1150, spawn_y: 1150,
};
// The SAME village, elsewhere. Same key -- that is the whole point -- and a box
// that shares no tile with the old one, so "did it move?" cannot be answered
// half-right by an overlap.
const THERE = {
  key: 'commons', min_row: 40, min_col: 40, width: 6, height: 4, gate_edge: 'S',
  spawn_x: 4150, spawn_y: 4150,
};

const specWith = (village) => ({
  name: 'zz-test-move-village-fixture',
  topology: 'spine',
  worlds: [{
    key: 'a', name: WORLD, grid: [19, -3], seed: 977, width: 64, height: 64, chunk_size: 64,
    // Meadow's terrain tiles are all walkable, so the navigability check at the
    // end of applyMapSpec is deciding about the village and the doorways rather
    // than about a water blob this fixture never asked for.
    biomes: ['Meadow'], biome_cell: 32,
    allowed_creature_types: [], is_entry: true,
    // SOMET-335: an entry world's entry_spawn must BE the spawn of a village it
    // declares, so it moves with the village. That coupling is exactly what
    // SOMET-308 saw break, and keeping it here means a fix that moved the
    // village but not the spawn would fail validation rather than pass quietly.
    entry_spawn: { x: village.spawn_x, y: village.spawn_y },
    village,
  }],
  links: [],
});

const geometryOf = (v) => ({
  minRow: v.min_row, minCol: v.min_col, width: v.width, height: v.height, gateEdge: v.gate_edge,
});
const postKey = (p) => `${Number(p.x)},${Number(p.y)}`;

const captureSeedWarnings = async (fn) => {
  const lines = [];
  const real = console.warn;
  console.warn = (...args) => { lines.push(args.join(' ')); };
  try { await fn(); } finally { console.warn = real; }
  return lines.filter((l) => l.startsWith('seed-map:'));
};

test('a village whose spec box moves is repositioned, with everything derived from it', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} (${pool.unreachable}) — village repositioning is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  const villageRow = async () => (await pool.query(
    `SELECT v.* FROM villages v JOIN worlds w ON w.id = v.world_id WHERE w.name = $1`,
    [WORLD])).rows[0];
  const guardPosts = async () => (await pool.query(
    `SELECT wc.home_x, wc.home_y FROM world_creatures wc JOIN worlds w ON w.id = wc.world_id
      WHERE w.name = $1 AND wc.type = 'Village Guard' ORDER BY wc.home_x, wc.home_y`,
    [WORLD])).rows.map((r) => postKey({ x: r.home_x, y: r.home_y }));

  try {
    await cleanup(pool);
    await withEntryPreserved(pool, async () => {
      // --- seed it where the spec first says ------------------------------
      const first = await applyMapSpec(pool, specWith(HERE));
      assert.equal(first.villages, 1, 'the first seed must create the village');
      assert.equal(first.villagesMoved, 0, 'a creation is not a move');

      const before = await villageRow();
      assert.ok(before, 'the fixture village must exist, or every assertion below is vacuous');
      assert.equal(before.spec_key, 'commons');
      assert.equal(Number(before.min_row), HERE.min_row);

      // A merchant with stock, and one row of it listed by a PLAYER. This is
      // the thing a delete-then-recreate would destroy (merchant_stock.village_id
      // is ON DELETE CASCADE), so it is asserted before AND after the move.
      const stockBefore = (await pool.query(
        'SELECT count(*)::int AS n FROM merchant_stock WHERE village_id = $1', [before.id])).rows[0].n;
      assert.ok(stockBefore > 0,
        'createVillage must have seeded a base catalog, or the stock-survival check below proves nothing');
      const item = (await pool.query('SELECT id FROM item_types LIMIT 1')).rows[0];
      assert.ok(item, 'this database has no item types, so no player listing can be planted');
      const user = (await pool.query(
        `INSERT INTO users (username, password_hash) VALUES ('zzMoveVillageUser', 'x') RETURNING id`)).rows[0];
      await pool.query(
        `INSERT INTO merchant_stock (world_id, village_id, item_type_id, price, seller_user_id, quantity)
         VALUES ($1, $2, $3, 99, $4, 1)`,
        [before.world_id, before.id, item.id, user.id]);

      // A player bound to this village, exactly as the authority writes it:
      // the bind IS the village spawn point.
      const et = (await pool.query('SELECT id FROM entity_types LIMIT 1')).rows[0];
      const ch = (await pool.query(
        `INSERT INTO characters (user_id, slot, name, entity_type_id)
         VALUES ($1, 1, 'zzMoveVillageChar', $2) RETURNING id`, [user.id, et.id])).rows[0];
      await pool.query('INSERT INTO player_binds (character_id, world_id, x, y) VALUES ($1,$2,$3,$4)',
        [ch.id, before.world_id, HERE.spawn_x, HERE.spawn_y]);

      const postsBefore = await guardPosts();
      assert.deepEqual(postsBefore, villageGatePosts(geometryOf(HERE)).map(postKey).sort(),
        'the guards must start on the OLD box\'s posts, or "they moved" means nothing');

      // --- move it --------------------------------------------------------
      const warnings = await captureSeedWarnings(async () => {
        const second = await applyMapSpec(pool, specWith(THERE));
        assert.equal(second.villagesMoved, 1, 'the applier must report the move');
        assert.equal(second.villages, 0, 'a move is not a creation');
      });

      // Loud: the count mismatch already warned, and a moved box is the case
      // that used to be silent. Asserted on content, not just on length.
      assert.equal(warnings.length, 1, `expected exactly one warning, got ${JSON.stringify(warnings)}`);
      assert.match(warnings[0], /MOVED/);
      assert.match(warnings[0], new RegExp(`rows ${HERE.min_row}\\.\\.`), 'the warning must name where it was');
      assert.match(warnings[0], new RegExp(`rows ${THERE.min_row}\\.\\.`), 'the warning must name where it went');

      // --- the row itself ---------------------------------------------------
      const after = await villageRow();
      assert.equal(after.id, before.id,
        'the village must keep its id — a delete-then-recreate would cascade its merchant stock away');
      assert.deepEqual(
        { min_row: after.min_row, min_col: after.min_col, width: after.width,
          height: after.height, gate_edge: after.gate_edge.trim(),
          spawn_x: Number(after.spawn_x), spawn_y: Number(after.spawn_y) },
        { min_row: THERE.min_row, min_col: THERE.min_col, width: THERE.width,
          height: THERE.height, gate_edge: THERE.gate_edge,
          spawn_x: THERE.spawn_x, spawn_y: THERE.spawn_y },
        'the live village box must be what the spec now declares');

      // --- the merchant post ------------------------------------------------
      // Compared against villageMerchantPost applied to the NEW box, which is
      // the same function createVillage uses -- so a moved village and a freshly
      // created one put their merchant in the same place. Also compared against
      // the OLD stored value, because "derived correctly" and "actually changed"
      // are two different claims and only the second one catches a missing write.
      const mpost = villageMerchantPost(geometryOf(THERE));
      assert.equal(postKey({ x: after.merchant_x, y: after.merchant_y }), postKey(mpost),
        'the merchant post must be re-derived from the new box');
      assert.notEqual(postKey({ x: after.merchant_x, y: after.merchant_y }),
        postKey({ x: before.merchant_x, y: before.merchant_y }),
        'the merchant post did not change at all — the fixture cannot prove anything');

      // --- the guards -------------------------------------------------------
      const postsAfter = await guardPosts();
      assert.deepEqual(postsAfter, villageGatePosts(geometryOf(THERE)).map(postKey).sort(),
        'both gate guards must stand on the NEW box\'s posts');
      assert.equal(postsAfter.filter((p) => postsBefore.includes(p)).length, 0,
        'no guard may be left standing at the old gate');
      assert.equal(postsAfter.length, 2,
        'exactly two guards — a re-derive that appended instead of replacing would leave four');

      // --- the merchant stock ------------------------------------------------
      const stockAfter = (await pool.query(
        'SELECT count(*)::int AS n FROM merchant_stock WHERE village_id = $1', [after.id])).rows[0].n;
      assert.equal(stockAfter, stockBefore + 1, 'the merchant stock must survive the move intact');
      const listing = await pool.query(
        'SELECT count(*)::int AS n FROM merchant_stock WHERE village_id = $1 AND seller_user_id = $2',
        [after.id, user.id]);
      assert.equal(listing.rows[0].n, 1, 'the player\'s own listing must survive the move');

      // --- the player bind ----------------------------------------------------
      const bind = (await pool.query(
        'SELECT x, y FROM player_binds WHERE character_id = $1', [ch.id])).rows[0];
      assert.deepEqual({ x: Number(bind.x), y: Number(bind.y) },
        { x: THERE.spawn_x, y: THERE.spawn_y },
        'a bind IS a village spawn point — left behind, it respawns the player on open ground '
        + 'where the village used to be');

      // --- and it settles ------------------------------------------------------
      const settleWarnings = await captureSeedWarnings(async () => {
        const third = await applyMapSpec(pool, specWith(THERE));
        assert.equal(third.villagesMoved, 0,
          're-applying the moved spec must report no further move — otherwise the applier is '
          + 'comparing against something other than what it wrote');
      });
      assert.deepEqual(settleWarnings, [], 'a settled spec must be quiet');
    });
  } finally {
    await cleanup(pool);
    await pool.end().catch(() => {});
  }
});

// The adoption path, which is what makes every ALREADY-SEEDED database converge
// without a migration touching villages (SOMET-335: a migration that repairs
// seeded content is undone by the next re-seed).
//
// Two rungs, and this asserts both, because only the second one closes the
// defect on a live database:
//
//   unchanged box  -> matched by its box and stamped with the key. Quiet-ish;
//                     it is bookkeeping, not a move.
//   moved box      -> matches nothing by box, so it is adopted as the one
//                     candidate left and THEN moved, in a single run.
test('an unkeyed village seeded before SOMET-312 is adopted, then moves', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} (${pool.unreachable}) — village adoption is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  const row = async () => (await pool.query(
    `SELECT v.id, v.spec_key, v.min_row, v.spawn_x FROM villages v
       JOIN worlds w ON w.id = v.world_id WHERE w.name = $1`, [WORLD])).rows[0];
  const unkey = () => pool.query(
    `UPDATE villages SET spec_key = NULL
      WHERE world_id = (SELECT id FROM worlds WHERE name = $1)`, [WORLD]);

  try {
    await cleanup(pool);
    await withEntryPreserved(pool, async () => {
      await applyMapSpec(pool, specWith(HERE));
      const seeded = await row();
      assert.ok(seeded, 'the fixture village must exist');

      // --- rung 1: same box, no key -> adopted in place ---------------------
      await unkey();
      assert.equal((await row()).spec_key, null,
        'the fixture must actually be unkeyed, or the adoption below is not being exercised');
      const n1 = await applyMapSpec(pool, specWith(HERE));
      assert.equal(n1.villages, 0, 'an adopted village must not be re-created alongside itself');
      assert.equal(n1.villagesMoved, 0, 'stamping a key on an unchanged box is not a move');
      const adopted = await row();
      assert.equal(adopted.id, seeded.id, 'adoption must claim the EXISTING row, not a new one');
      assert.equal(adopted.spec_key, 'commons', 'the row must now carry the spec key');
      assert.equal(Number(adopted.min_row), HERE.min_row, 'adoption must not move anything');

      // --- rung 2: no key AND a moved box -> adopted and moved in one run ---
      // This is the live-database case the whole ticket turns on: nothing in
      // the row matches the spec any more, so only "one declaration, one row,
      // nothing to choose between them" can pair them up.
      await unkey();
      const n2 = await applyMapSpec(pool, specWith(THERE));
      assert.equal(n2.villagesMoved, 1,
        'an unkeyed row facing a moved box is the SOMET-308 case — it must be adopted and moved');
      assert.equal(n2.villages, 0, 'and never created alongside the row it should have adopted');
      const moved = await row();
      assert.equal(moved.id, seeded.id, 'still the same row — its merchant stock must not be at risk');
      assert.equal(moved.spec_key, 'commons');
      assert.equal(Number(moved.min_row), THERE.min_row);
      assert.equal(Number(moved.spawn_x), THERE.spawn_x);
    });
  } finally {
    await cleanup(pool);
    await pool.end().catch(() => {});
  }
});
