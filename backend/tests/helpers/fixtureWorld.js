// Create a throwaway world, hand its id to fn, and remove it AFTERWARDS NO
// MATTER WHAT.
//
// The bug this exists to make unrepresentable (SOMET-341): the natural way to
// write one of these tests puts the cleanup at the end of the `try`, where the
// `finally` only closes the pool --
//
//     try {
//       const worldId = await makeWorld(pool);
//       assert.equal(...);                                   // <-- throws here
//       await pool.query('DELETE FROM worlds WHERE id = $1', [worldId]);
//     } finally { await pool.end(); }
//
// -- so the first failing assertion leaks its world into the SHARED dev
// database permanently. Nine `respawn-test-*` worlds accumulated that way
// before this helper existed, and because each carried a random name, no later
// run could ever recognise or reclaim them.
//
// Two deliberate choices:
//
//   * Cleanup deletes BY NAME, not by a captured id, and the name is computed
//     BEFORE the insert. An id only exists once the INSERT has returned, so an
//     id-based cleanup cannot cover a failure during creation; a name-based one
//     covers it and is a harmless no-op when no row was written. This mirrors
//     the pattern world_population_db / safe_region_population_db / waypoints_db
//     already use and document.
//   * The name is unique per process AND per call. `node --test` runs files in
//     parallel, and more than one session may run this suite against the shared
//     dev database at the same time, so a fixed fixture name would have two
//     owners and the faster one would delete the slower one's world mid-test.
//
// Deleting the world row is enough on its own: world_creatures,
// creature_respawns and the rest are FK-cascaded from worlds.
let seq = 0;

// `seed` is NOT NULL with no default and MUST be supplied -- terrain is a
// function of (seed, size), so a world with no seed is not merely untidy, it
// cannot generate. `name` is likewise NOT NULL.
const DEFAULTS = {
  seed: 4242, width: 96, height: 96, density: 'normal', chunkSize: 32,
};

async function withFixtureWorld(pool, fn, { prefix = 'zzFixture', ...overrides } = {}) {
  const cols = { ...DEFAULTS, ...overrides };
  seq += 1;
  const name = `${prefix}-${process.pid}-${Date.now()}-${seq}`;
  try {
    const r = await pool.query(
      `INSERT INTO worlds (name, seed, width, height, density, chunk_size)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [name, cols.seed, cols.width, cols.height, cols.density, cols.chunkSize],
    );
    return await fn(r.rows[0].id, name);
  } finally {
    await pool.query('DELETE FROM worlds WHERE name = $1', [name]); // FKs cascade
  }
}

module.exports = { withFixtureWorld };
