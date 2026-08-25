// SOMET-355. The specs were treated as the source of truth for map topology
// and were not one.
//
// Ten live `map_links` rows (five undirected edges) across the three authored
// maps had been drawn by hand through the admin map-link graph tab
// (PUT /api/worlds/:id/links) and were declared in no spec at all. A
// `make reseed-map` rebuilds from the specs, so it would have silently dropped
// every one of them -- and those five edges were the ONLY thing connecting
// hub-vale, spine-descent and loop-catacombs to each other. Measured before the
// fix: walkable reach from the entry world (Vale Crossing) was 20 worlds with
// them and 5 without, i.e. a re-seed would have turned 15 authored worlds into
// unreachable content. Nothing warned.
//
// Two things are pinned here, and they are different claims:
//   Leg 1 (offline) -- the SHIPPED spec's declared topology is by itself enough
//     to reach every world it declares. This is the regression that would have
//     shipped the 15 dead worlds; it needs no database.
//   Leg 2 (live DB) -- applyMapSpec actually CONVERGES the table onto the spec:
//     an undeclared doorway is removed and REPORTED, in both directions, and a
//     declared one survives. Without this the offline leg is a statement about
//     a JSON file and nothing more.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { applyMapSpec } = require('../scripts/seed-map.js');
const { setLink, pruneCompassLinks } = require('../src/services/mapLinks.js');
const { setEntryWorld } = require('../src/services/entryWorld.js');
const { withAdvisoryLock } = require('./helpers/advisoryLock.js');
const { ENTRY_LOCK_KEY, entryWorldForJoin } = require('./helpers/entryWorld.js');

const MAPS_DIR = path.join(__dirname, '..', 'seeds', 'maps');
const MIRROR = { N: 'S', S: 'N', E: 'W', W: 'E' };

const readSpec = (name) =>
  JSON.parse(fs.readFileSync(path.join(MAPS_DIR, `${name}.map.json`), 'utf8'));

// --- Leg 1: the declared topology stands on its own (offline) --------------

test('every world in vale-region is reachable from the entry over DECLARED links alone', () => {
  const spec = readSpec('vale-region');
  const entry = spec.worlds.find((w) => w.is_entry);
  assert.ok(entry, 'vale-region must declare an entry world');

  // Undirected: setLink writes the mirror row, so a declared link is walkable
  // both ways whether or not the spec restates it.
  //
  // PORTALS COUNT (SOMET-446). This walk excluded `kind: 'portal'` when it was
  // written, which was a no-op then -- vale-region declared no portals, so
  // "compass links" and "declared links" were the same set. They are not any
  // more: 21 of this spec's worlds now sit behind guarded portals. Excluding
  // them would fail this test for content that is perfectly well declared,
  // which is the opposite of what it is for. A portal is spec-declared and
  // applyMapSpec applies it (scripts/seed-map.js's setPortalLink pass, plus a
  // guard pass), so a portal-reached world is NOT stranded by a re-seed --
  // which is the actual claim being made here.
  const adjacency = new Map(spec.worlds.map((w) => [w.key, []]));
  for (const l of spec.links) {
    adjacency.get(l.from).push(l.to);
    adjacency.get(l.to).push(l.from);
  }
  const seen = new Set([entry.key]);
  const queue = [entry.key];
  while (queue.length) {
    for (const next of adjacency.get(queue.pop())) {
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }

  const unreachable = spec.worlds.filter((w) => !seen.has(w.key)).map((w) => w.name);
  assert.deepEqual(unreachable, [],
    'these worlds are only reachable through links no spec declares -- a re-seed would strand them');
  // Non-vacuity: an empty or single-world spec would satisfy the check above
  // while proving nothing. 34 = the 20 merged-region worlds plus SOMET-446's
  // three dungeons (7 catacombs, 8 Sunscar Hollows, 6 Rimevault).
  assert.equal(seen.size, 34, 'expected the merged region to be 34 worlds');
});

// The three regions were merged precisely so their connections could be
// declared. If a later edit pulls them back onto overlapping grid cells, the
// connectors stop being expressible and the hand-drawn drift comes straight
// back -- so the cross-region edges are pinned by name, not just by count.
test('the three regions are actually connected to each other by declared links', () => {
  const spec = readSpec('vale-region');
  const regionOf = (key) => key.split('_')[0];
  const cross = spec.links
    .filter((l) => regionOf(l.from) !== regionOf(l.to))
    .map((l) => (l.kind === 'portal'
      ? `${l.from} --PORTAL--> ${l.to}`
      : `${l.from} --${l.edge}--> ${l.to}`))
    .sort();
  // SOMET-446 changed the KIND of two of these, not their existence. The two
  // doorways into the catacombs became one guarded portal, because a dungeon
  // you can stroll into through a compass edge is not gated by anything:
  //   cata_farhall --N--> spine_elite  (deleted; a level 4-6 spine world
  //     opened straight into a level 7-12 dungeon room)
  //   vale_mire --S--> cata_crypt      (became vale_mire --PORTAL--> cata_entry)
  // Portals are listed here alongside doorways because the claim this test
  // makes is about DECLARED connections, not about doorways specifically.
  assert.deepEqual(cross, [
    'vale_dunes --PORTAL--> hollow_entry',
    'vale_forest --E--> spine_entry',
    'vale_frozen --PORTAL--> rime_hub',
    'vale_mire --PORTAL--> cata_entry',
  ]);
});

// --- Leg 2: the applier converges the live table (needs a database) --------

const url = process.env.TEST_DATABASE_URL;
const skip = !url
  ? 'no TEST_DATABASE_URL -- refusing to mutate a real database (this test writes and deletes map_links)'
  : false;

test('applyMapSpec converges live doorways onto the spec', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());

  // A throwaway two-world spec, zz-prefixed like the rest of this suite's
  // fixtures so it cannot collide with authored content.
  const spec = {
    name: 'zzLinkAuthority',
    topology: 'spine',
    worlds: [
      {
        key: 'a', name: 'zzLinkA', grid: [0, 0], seed: 7101,
        width: 64, height: 64, chunk_size: 32, biomes: ['Meadow'],
        allowed_creature_types: [], is_entry: true, entry_spawn: { x: 3200, y: 3200 },
      },
      {
        key: 'b', name: 'zzLinkB', grid: [1, 0], seed: 7102,
        width: 64, height: 64, chunk_size: 32, biomes: ['Meadow'],
        allowed_creature_types: [], is_entry: false,
      },
    ],
    links: [{ from: 'a', edge: 'E', to: 'b' }],
  };
  const cleanup = async () => {
    await pool.query(`DELETE FROM worlds WHERE name LIKE 'zzLink%'`); // map_links cascade
  };

  const idOf = async (name) =>
    (await pool.query('SELECT id FROM worlds WHERE name = $1', [name])).rows[0].id;
  const edgesOf = async (name) => (await pool.query(
    `SELECT ml.edge FROM map_links ml JOIN worlds w ON w.id = ml.from_world_id
      WHERE w.name = $1 AND ml.edge <> 'PORTAL' ORDER BY ml.edge`, [name])).rows.map((r) => r.edge);

  // is_entry is GLOBAL -- setting one world's flag clears every other -- and
  // validateMapSpec requires every spec to declare exactly one entry world
  // (seeds/mapSpec.js), so this two-world fixture cannot avoid borrowing it:
  // applyMapSpec's setEntryWorld moves the flag onto zzLinkA and COMMITS.
  //
  // SOMET-508 -- WHY THIS IS NOT THE TRANSACTION FIX ITS SIBLING GOT.
  //
  // starting_loadout_worn_by_every_class_db.test.js closes the same class of
  // defect -- destructive global setup with no transaction -- by doing the
  // setup on one pooled client inside a transaction that is always ROLLBACKed,
  // so no peer process can ever observe it and no throw can strand it. That
  // shape is unavailable here. applyMapSpec opens its OWN transaction on its
  // own pooled client and COMMITs it (scripts/seed-map.js), so there is no
  // outer transaction for this file to roll back: the borrow is committed by
  // the code under test, and removing it is not an option either, because a
  // spec with no entry world does not validate. So this half needs the other
  // remedy -- mutual exclusion plus a restore that is guaranteed AND correct.
  //
  // What was actually wrong here was the RESTORE, twice over. It used to be:
  //
  //     const priorEntry = (await pool.query(
  //       'SELECT name FROM worlds WHERE is_entry')).rows[0]?.name;
  //     await pool.query('UPDATE worlds SET is_entry = (name = $1)', [priorEntry]);
  //
  //   1. IT SNAPSHOTTED THE LIVE FLAG. That query does not name a world, it
  //      names whoever holds the flag at that instant. seed_map_db.test.js
  //      applies every shipped spec in readdir order, so p5-descent lands
  //      before vale-region and `The Catacombs: Entry` holds the flag for a
  //      measured 46-47 SECONDS of a full run (helpers/entryWorld.js). Snapshot
  //      inside that window and the line above MOVES THE GAME'S ENTRY WORLD
  //      PERMANENTLY. SOMET-505 made every READER immune to a borrowed flag, so
  //      this stopped breaking joins -- but the writer could still relocate the
  //      entry world for good, silently, and nothing would notice.
  //
  //   2. `SET is_entry = (name = $1)` MATCHES NOTHING WHEN $1 IS GONE, and
  //      still clears every current entry row: zero entry worlds, which is the
  //      SOMET-265 loss. A snapshot taken while a PEER's throwaway fixture held
  //      the flag names a world that peer then deletes in its own cleanup.
  //
  // Both go away by not snapshotting at all. Which world should hold is_entry
  // is not a runtime fact to be observed, it is DECLARED in the checked-in
  // specs: entryWorldForJoin() resolves the single shipped world declaring both
  // is_entry and allows_fast_travel -- the property SOMET-505 picked precisely
  // because no test borrows it. That answer is correct whatever any peer is
  // doing at the time, and its target cannot vanish mid-run. The write goes
  // through services/entryWorld.js, one statement, EXISTS-guarded, so it can
  // never clear the flag without setting it.
  //
  // ENTRY_LOCK_KEY is now held across the whole borrow, which the old code
  // claimed to do and did not. It is the key every other is_entry writer takes
  // (seed_map_db.test.js, seed_map_vault_chests_db.test.js and
  // chests_integration_db.test.js, all via withEntryPreserved), and holding it
  // is what stops one of THEM snapshotting zzLinkA while we hold the flag and
  // then "restoring" onto a throwaway this file is about to delete -- zero
  // entry worlds, from two helpers both behaving as written. The lock is a
  // courtesy to peers; the correctness of OUR restore does not depend on it,
  // which matters because withAdvisoryLock degrades to unguarded after 6s and
  // is therefore never a substitute for a guaranteed restore.
  const shippedEntry = await entryWorldForJoin(pool);
  const restoreEntry = async () => { await setEntryWorld(pool, shippedEntry.id); };

  await withAdvisoryLock(pool, ENTRY_LOCK_KEY, async () => {
    // Two nested finallys, not one with two statements in it. The flag comes
    // home BEFORE the world holding it is deleted, so there is never an instant
    // with zero entry worlds -- and a failure in either step cannot skip the
    // other, which the old single `finally { cleanup(); restoreEntry(); }`
    // could not promise in either direction.
    try {
      try {
        await cleanup();
        await applyMapSpec(pool, spec);

        await t.test('a hand-drawn doorway the spec does not declare is removed AND reported', async () => {
          // Exactly what the admin graph tab does: setLink, which writes the
          // mirror row too. 'N' is free on both worlds, so this is a second,
          // undeclared connection rather than a rewrite of the declared 'E' one.
          await setLink(pool, await idOf('zzLinkA'), 'N', await idOf('zzLinkB'));
          assert.deepEqual(await edgesOf('zzLinkA'), ['E', 'N'], 'precondition: the hand-drawn link exists');

          const result = await applyMapSpec(pool, spec);

          assert.deepEqual(await edgesOf('zzLinkA'), ['E'], 'the undeclared doorway must be gone');
          // The MIRROR too. A prune that only removed the forward row would leave
          // a one-way doorway -- a player walks through and cannot walk back,
          // which is the exact shape of the two half-links found live.
          assert.deepEqual(await edgesOf('zzLinkB'), ['W'], "the undeclared doorway's mirror must be gone too");

          const reported = result.linksRemoved.map((l) => `${l.from_name} --${l.edge}--> ${l.to_name}`).sort();
          assert.deepEqual(reported, ['zzLinkA --N--> zzLinkB', 'zzLinkB --S--> zzLinkA'],
            'removals must be reported BY NAME -- a silent prune is the defect this exists to prevent');
        });

        await t.test('the declared doorway survives, so this is convergence and not a purge', async () => {
          // The failure mode on the other side: a prune that deleted everything
          // would satisfy every assertion above and leave the map with no
          // doorways at all.
          assert.deepEqual(await edgesOf('zzLinkA'), ['E']);
          assert.deepEqual(await edgesOf('zzLinkB'), ['W']);
          const again = await applyMapSpec(pool, spec);
          assert.deepEqual(again.linksRemoved, [],
            're-applying an already-converged spec must report nothing removed');
          assert.deepEqual(await edgesOf('zzLinkA'), ['E']);
        });

        await t.test('a one-way link IN from a world this spec does not own is removed', async () => {
          // The inbound-orphan case, and the reason pruneCompassLinks runs two
          // DELETEs. A foreign world pointing at ours cannot be repaired by
          // pruning our own outbound rows: its row's from_world_id is not in this
          // spec at all.
          const foreign = await pool.query(
            `INSERT INTO worlds (name, width, height, chunk_size, seed, biomes)
             VALUES ('zzLinkForeign', 64, 64, 32, 7103, '["Meadow"]'::jsonb) RETURNING id`);
          await pool.query(
            `INSERT INTO map_links (from_world_id, edge, to_world_id) VALUES ($1, 'S', $2)`,
            [foreign.rows[0].id, await idOf('zzLinkA')]);

          const result = await applyMapSpec(pool, spec);

          assert.deepEqual(await edgesOf('zzLinkForeign'), [],
            'a doorway INTO this spec that the spec does not declare must be removed');
          assert.ok(
            result.linksRemoved.some((l) => l.from_name === 'zzLinkForeign' && l.to_name === 'zzLinkA'),
            'the inbound orphan must be reported too');
        });
      } finally {
        await restoreEntry();
      }
    } finally {
      await cleanup();
    }

    // The flag is home: not merely "somewhere", but on the world the shipped
    // specs declare, with zzLinkA already deleted. Read STILL INSIDE the lock,
    // because reading `worlds WHERE is_entry` anywhere else is the very habit
    // SOMET-505 removed -- outside the guarded section a peer mid-borrow would
    // make this assertion flap.
    const entryNow = await pool.query('SELECT name FROM worlds WHERE is_entry = true');
    assert.deepStrictEqual(entryNow.rows.map((r) => r.name), [shippedEntry.name],
      'this file must hand the entry world back exactly as the shipped specs declare it');
  });
});
