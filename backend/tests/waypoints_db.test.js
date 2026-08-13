// The waypoint data model against the real database (SOMET-292).
//
// Three things live here, and only the middle one is ordinary:
//  1. the schema shape, because the delete rules and the composite primary key
//     ARE the design (see the migration's comments);
//  2. the service round trip -- the writer seed-map calls and the reader the
//     authority calls, exercised against each other;
//  3. THE LOAD-BEARING INVARIANT over the rows currently in this database: no
//     portal that a creature guards may be a waypoint. It passes trivially
//     today because nothing is flagged yet. That is the point -- it fails the
//     day someone flags one, which is the only day it matters.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const {
  fetchWaypoints, upsertWaypoint, activateWaypoint, listWaypointsForCharacter,
} = require('../src/services/waypoints');
const { recordVisit } = require('../src/services/visitedWorlds');
const { createCharacter, listPlayableClasses } = require('../src/services/characters');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

test('seed-map is the authoring writer for waypoints', () => {
  // A source-text guard, and the same trap visited_worlds_db.test.js guards
  // against: a table with a reader and no writer (or a writer and no reader) is
  // a feature that is green in every unit test and inert in the running game.
  // fetchWaypoints' reader side is proved behaviourally by
  // waypoint_activation_live.test.js, which drives the real authority; the
  // writer side has no runtime path to drive, so it is pinned here.
  const src = fs.readFileSync(path.join(__dirname, '../scripts/seed-map.js'), 'utf8');
  assert.match(src, /upsertWaypoint/,
    'seed-map.js must author waypoints through services/waypoints.js, or nothing ever writes one');
});

test('waypoint schema', { skip: !url ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());

  await t.test('character_waypoints is keyed on (character_id, waypoint_id)', async () => {
    // The PK is the idempotency guarantee for activation -- a surrogate id here
    // would let one character light one waypoint twice, and the tick loop
    // retries on every relog.
    const r = await pool.query(
      `SELECT a.attname
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'character_waypoints'::regclass AND i.indisprimary
        ORDER BY a.attname`);
    assert.deepEqual(r.rows.map((x) => x.attname), ['character_id', 'waypoint_id']);
  });

  await t.test('map_links.is_waypoint is a non-null boolean defaulting to false', async () => {
    const r = await pool.query(
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'map_links' AND column_name = 'is_waypoint'`);
    assert.equal(r.rows.length, 1, 'map_links.is_waypoint does not exist');
    assert.equal(r.rows[0].data_type, 'boolean');
    assert.equal(r.rows[0].is_nullable, 'NO');
    assert.match(r.rows[0].column_default, /false/);
  });

  await t.test('every existing map_links row defaults to not-a-waypoint', async () => {
    // The whole point of DEFAULT false: adding the column must not silently
    // promote seven guarded dungeon staircases into travel targets.
    const r = await pool.query(
      'SELECT count(*)::int AS n FROM map_links WHERE is_waypoint IS DISTINCT FROM false');
    assert.equal(r.rows[0].n, 0);
  });

  await t.test('deleting a waypoint\'s map link nulls the reference, keeping the waypoint', async () => {
    // ON DELETE SET NULL, not CASCADE -- CASCADE would take every character's
    // activation of the waypoint down with the relinked staircase. Same
    // reasoning blocks_portal_id was written under (1714440061000).
    const r = await pool.query(
      `SELECT c.confdeltype
         FROM pg_constraint c
        WHERE c.conrelid = 'waypoints'::regclass AND c.contype = 'f'
          AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute
                                 WHERE attrelid = 'waypoints'::regclass AND attname = 'map_link_id')]`);
    assert.equal(r.rows.length, 1, 'waypoints.map_link_id has no foreign key');
    assert.equal(r.rows[0].confdeltype, 'n', 'expected ON DELETE SET NULL');
  });

  await t.test('deleting a world removes its waypoints', async () => {
    const r = await pool.query(
      `SELECT c.confdeltype
         FROM pg_constraint c
        WHERE c.conrelid = 'waypoints'::regclass AND c.contype = 'f'
          AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute
                                 WHERE attrelid = 'waypoints'::regclass AND attname = 'world_id')]`);
    assert.equal(r.rows[0].confdeltype, 'c', 'expected ON DELETE CASCADE');
  });
});

test('waypoint services', { skip: !url ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());

  const classes = await listPlayableClasses(pool);
  const warrior = classes.find((c) => c.name === 'Warrior');

  // Fixture worlds and users are created and torn down BY NAME, unconditionally,
  // in a finally -- never by an id captured mid-test, which is lost the moment
  // an assertion throws before the capture.
  async function withFixture(tag, fn) {
    const worldA = `zzWpWorld${tag}A`;
    const worldB = `zzWpWorld${tag}B`;
    const username = `zzWpUser${tag}`;
    const cleanup = async () => {
      await pool.query('DELETE FROM worlds WHERE name = ANY($1)', [[worldA, worldB]]);
      await pool.query('DELETE FROM users WHERE username = $1', [username]);
    };
    await cleanup();   // a previous crashed run must not wedge this one
    try {
      const mk = async (name) => (await pool.query(
        `INSERT INTO worlds (name, seed, chunk_size, width, height)
         VALUES ($1, '1', 8, 40, 40) RETURNING id`, [name])).rows[0].id;
      const a = await mk(worldA);
      const b = await mk(worldB);
      await pool.query(
        "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player')", [username]);
      const userId = (await pool.query(
        'SELECT id FROM users WHERE username = $1', [username])).rows[0].id;
      const character = await createCharacter(pool, userId, `zzWpChar${tag}`, warrior.id);
      return await fn({ worldA: a, worldB: b, worldAName: worldA, worldBName: worldB, character });
    } finally {
      await cleanup();
    }
  }

  await t.test('upsertWaypoint writes what fetchWaypoints reads back', async () => {
    await withFixture('RT', async ({ worldA }) => {
      const client = await pool.connect();
      try {
        await upsertWaypoint(client, { worldId: worldA, x: 1250, y: 850, name: 'zzWpRT Well' });
      } finally { client.release(); }
      const got = await fetchWaypoints(pool, worldA);
      assert.equal(got.length, 1);
      assert.equal(got[0].name, 'zzWpRT Well');
      assert.equal(got[0].x, 1250);
      assert.equal(got[0].y, 850);
      assert.equal(got[0].mapLinkId, null);
      assert.equal(got[0].worldId, worldA);
    });
  });

  await t.test('re-authoring the same tile updates rather than duplicating', async () => {
    await withFixture('Idem', async ({ worldA }) => {
      const client = await pool.connect();
      try {
        // Same TILE (1250,850 and 1299,899 both floor to tile 8,12), a
        // different name: re-applying an edited spec must converge, and two
        // rows in one tile would leave one of them permanently unreachable
        // because the tick loop only ever finds one.
        await upsertWaypoint(client, { worldId: worldA, x: 1250, y: 850, name: 'zzWpIdem Old' });
        await upsertWaypoint(client, { worldId: worldA, x: 1299, y: 899, name: 'zzWpIdem New' });
      } finally { client.release(); }
      const got = await fetchWaypoints(pool, worldA);
      assert.equal(got.length, 1, 'two rows on one tile: one of them is unreachable');
      assert.equal(got[0].name, 'zzWpIdem New');
    });
  });

  await t.test('activation is idempotent and reports whether it was the first time', async () => {
    await withFixture('Act', async ({ worldA, character }) => {
      const client = await pool.connect();
      let id;
      try {
        ({ id } = await upsertWaypoint(client, { worldId: worldA, x: 250, y: 250, name: 'zzWpAct Stone' }));
      } finally { client.release(); }

      const first = await activateWaypoint(pool, character.id, id);
      assert.equal(first.firstTime, true);
      // Walking over it again is the normal case, not an error case: this runs
      // off the tick loop.
      const second = await activateWaypoint(pool, character.id, id);
      assert.equal(second.firstTime, false,
        'firstTime must track the database, not the caller\'s memory');
      const n = await pool.query(
        'SELECT count(*)::int AS n FROM character_waypoints WHERE waypoint_id = $1', [id]);
      assert.equal(n.rows[0].n, 1);
    });
  });

  await t.test('the list carries activated AND visited-but-unactivated waypoints', async () => {
    await withFixture('List', async ({ worldA, worldAName, character }) => {
      const client = await pool.connect();
      let lit; let dark;
      try {
        ({ id: lit } = await upsertWaypoint(client, { worldId: worldA, x: 250, y: 250, name: 'zzWpList Lit' }));
        ({ id: dark } = await upsertWaypoint(client, { worldId: worldA, x: 950, y: 950, name: 'zzWpList Dark' }));
      } finally { client.release(); }
      await recordVisit(pool, character.id, worldA);
      await activateWaypoint(pool, character.id, lit);

      const rows = await listWaypointsForCharacter(pool, character.id);
      const byId = new Map(rows.map((r) => [r.id, r]));
      // BOTH states in ONE call. Slice F draws them differently and cannot
      // build the popup at all if the unactivated half is missing.
      assert.ok(byId.has(lit) && byId.has(dark),
        'a visited world must contribute its unactivated waypoints too');
      assert.equal(byId.get(lit).activated, true);
      assert.ok(byId.get(lit).activatedAt instanceof Date);
      assert.equal(byId.get(dark).activated, false);
      assert.equal(byId.get(dark).activatedAt, null);
      assert.equal(byId.get(lit).worldName, worldAName, 'the popup groups by world name');
    });
  });

  await t.test('a waypoint in an unvisited world is withheld', async () => {
    await withFixture('Fog', async ({ worldA, worldB, character }) => {
      const client = await pool.connect();
      try {
        await upsertWaypoint(client, { worldId: worldA, x: 250, y: 250, name: 'zzWpFog Seen' });
        await upsertWaypoint(client, { worldId: worldB, x: 250, y: 250, name: 'zzWpFog Unseen' });
      } finally { client.release(); }
      await recordVisit(pool, character.id, worldA);

      const names = (await listWaypointsForCharacter(pool, character.id)).map((r) => r.name);
      assert.ok(names.includes('zzWpFog Seen'));
      assert.ok(!names.includes('zzWpFog Unseen'),
        'withholding must happen in the query -- a filter in the client still ships the name to the browser');
    });
  });

  await t.test('an activated waypoint survives losing its visit row', async () => {
    // Not hypothetical: SOMET-265 wiped visit rows, and joinPolicy still
    // carries the workaround. Standing on a waypoint is stronger evidence of
    // having been there than a bookkeeping row is.
    await withFixture('Lost', async ({ worldA, character }) => {
      const client = await pool.connect();
      let id;
      try {
        ({ id } = await upsertWaypoint(client, { worldId: worldA, x: 250, y: 250, name: 'zzWpLost Stone' }));
      } finally { client.release(); }
      await activateWaypoint(pool, character.id, id);   // no recordVisit at all
      const rows = await listWaypointsForCharacter(pool, character.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].activated, true);
    });
  });

  await t.test('deleting the character cascades its activations', async () => {
    let captured; let waypointId;
    await withFixture('Casc', async ({ worldA, character }) => {
      const client = await pool.connect();
      try {
        ({ id: waypointId } = await upsertWaypoint(
          client, { worldId: worldA, x: 250, y: 250, name: 'zzWpCasc Stone' }));
      } finally { client.release(); }
      captured = character.id;
      await activateWaypoint(pool, character.id, waypointId);
    });
    const r = await pool.query(
      'SELECT count(*)::int AS n FROM character_waypoints WHERE character_id = $1', [captured]);
    assert.equal(r.rows[0].n, 0);
  });
});

// ---------------------------------------------------------------------------
// The invariant the design calls load-bearing.
//
// A portal referenced by any creature's blocks_portal_id may never be a
// waypoint. If one is, the guarded dungeon entrance is bypassable on the second
// visit and the level-band gating joinPolicy was written to protect stops
// holding.
//
// Checked over the LIVE rows, by BOTH spellings (the map_links flag and a
// waypoints row pointing at the link), and on the MIRROR row as well:
// setPortalLink writes two rows per staircase and guards are inserted on the
// departure side only, so flagging the mirror would drop a traveller on the far
// side of the guard -- the same bypass, spelled backwards.
test('no guarded portal is a waypoint, in the live data',
  { skip: !url ? 'no database URL' : false }, async (t) => {
    const pool = new Pool({ connectionString: url });
    t.after(() => pool.end());

    // Every portal row that is guarded, plus the mirror of every guarded row.
    // The mirror is identified structurally (setPortalLink writes the mirror's
    // from_* as the forward row's to_*), not by an id we could have stored.
    const GUARDED_STAIRCASES = `
      WITH guarded AS (
        SELECT DISTINCT ml.*
          FROM map_links ml
          JOIN world_creatures wc ON wc.blocks_portal_id = ml.id
      ),
      staircase AS (
        SELECT id FROM guarded
        UNION
        SELECT m.id FROM map_links m JOIN guarded g
          ON m.edge = 'PORTAL' AND m.from_world_id = g.to_world_id
         AND m.from_x = g.to_x AND m.from_y = g.to_y
      )`;

    await t.test('no guarded portal link carries is_waypoint', async () => {
      const r = await pool.query(`${GUARDED_STAIRCASES}
        SELECT ml.id, ml.from_world_id, ml.from_x, ml.from_y
          FROM map_links ml JOIN staircase s ON s.id = ml.id
         WHERE ml.is_waypoint`);
      assert.deepEqual(r.rows, [],
        'a guarded staircase flagged as a waypoint is a guard the player never has to meet');
    });

    await t.test('no waypoint row points at a guarded portal link', async () => {
      const r = await pool.query(`${GUARDED_STAIRCASES}
        SELECT wp.id, wp.name FROM waypoints wp JOIN staircase s ON s.id = wp.map_link_id`);
      assert.deepEqual(r.rows, [],
        'the registry row is what the runtime reads -- flagged or not, this one bypasses a guard');
    });

    await t.test('no standalone waypoint sits on a guarded portal tile', async () => {
      // The same bypass with the link column left null: a waypoint dropped onto
      // the staircase's own tile is walked onto, lit, and travelled to.
      const r = await pool.query(`${GUARDED_STAIRCASES}
        SELECT wp.id, wp.name
          FROM waypoints wp
          JOIN map_links ml ON ml.id IN (SELECT id FROM staircase)
         WHERE wp.world_id = ml.from_world_id
           AND floor(wp.x / 100) = floor(ml.from_x / 100)
           AND floor(wp.y / 100) = floor(ml.from_y / 100)`);
      assert.deepEqual(r.rows, []);
    });

    await t.test('the guard scan sees the guarded portals this database actually has', async () => {
      // Without this, all three assertions above are vacuously true whenever the
      // guarded-staircase CTE returns nothing -- which is exactly what a typo in
      // the join would produce, silently. The design records seven creatures
      // carrying blocks_portal_id; assert only that the set is non-empty, since
      // the count is content that legitimately changes.
      const r = await pool.query(`${GUARDED_STAIRCASES} SELECT count(*)::int AS n FROM staircase`);
      assert.ok(r.rows[0].n > 0,
        'no guarded portal found at all -- the three assertions above are proving nothing');
    });
  });
