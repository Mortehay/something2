// SOMET-486 -- what character select ADVERTISES is what a character GETS.
//
// This file exists because the defect it closes survived from SOMET-242 to
// SOMET-486 with a green suite the whole time. Two rules follow from that, and
// every test below obeys them:
//
//  1. READ BOTH SOURCES. The advertised number comes from
//     listPlayableClasses -- the exact function GET /api/characters/classes
//     serves -- and the played number comes from a player object the REAL
//     authority join handler put in a REAL world. A test that read only one
//     would have passed against the broken code for eleven months.
//
//  2. GO THROUGH THE JOIN PATH. Not derivePlayerStats in isolation. The
//     pure function has been correct-by-construction at every point in this
//     epic; what was wrong was the wiring, and two earlier slices in this
//     same epic shipped features that were completely inert because only the
//     pure function was tested.
//
// The authority is booted against the REAL pool, so ownedCharacter,
// joinPolicy, loadSpawn, loadInventory, grantStartingLoadout, loadProgression
// and addPlayer all run for real. The only stand-in is the JWT, which this
// file signs itself the way every other authority test does.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const WebSocket = require('ws');

const { attachAuthority } = require('../src/authority/server.js');
const { listPlayableClasses, createCharacter } = require('../src/services/characters.js');
const { derivePlayerStats } = require('../src/services/playerStats.js');
const { HP_BASE, MANA_BASE } = require('../src/services/progressionConstants.js');
const { entryWorldForJoin } = require('./helpers/entryWorld.js');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const SECRET = 'somet486-test-secret';

// SOMET-471 widened this file from three classes to six. The list is written
// out by hand rather than taken from listPlayableClasses, and the ORDER is
// load-bearing: userIds[i] is the account created for CLASSES[i], which is how
// the distinctness check below finds each class's joined player again.
//
// Ranger is absent because 471 demoted it. It is NOT replaced by Archer here
// in the sense of a rename -- Archer is a separate row, and the "Ranger is not
// advertised" assertion below is what stops a future rename passing quietly.
const CLASSES = ['Warrior', 'Mage', 'Monk', 'Cultist', 'Archer', 'Druid'];

// Unique per run so a re-run never collides with rows a previous run left
// behind, and so two branches sharing a database cannot fight over a name.
const TAG = `s486_${process.pid}_${Date.now().toString(36)}`;

function nextMsg(ws, type, ms = 15000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
    ws.on('message', function onMsg(data) {
      const m = JSON.parse(data);
      if (m.type === 'error') {
        clearTimeout(to); ws.off('message', onMsg); reject(new Error(`server error: ${m.message}`));
      } else if (!type || m.type === type) {
        clearTimeout(to); ws.off('message', onMsg); resolve(m);
      }
    });
  });
}

test('class pools (SOMET-486, widened to six classes by SOMET-471)', { skip: !DB_URL ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 3000, max: 6 });
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    await pool.end().catch(() => {});
    // Loud, not silent: a skipped DB test is a test that verified nothing, and
    // this is the file that proves the advertisement is honest.
    throw new Error(`database unreachable, so nothing here was verified: ${err.message}`);
  }

  const server = http.createServer();
  const handle = attachAuthority(server, pool, { jwtSecret: SECRET, tickMs: 50 });
  await new Promise((r) => server.listen(0, r));
  const url = `ws://127.0.0.1:${server.address().port}/authority`;

  const sockets = [];
  const userIds = [];
  t.after(async () => {
    for (const ws of sockets) { try { ws.terminate(); } catch { /* already gone */ } }
    handle.close();
    if (server.listening) await new Promise((r) => server.close(r));
    // Scoped to the ids this file created, by primary key. Characters and
    // progression cascade off the user row.
    if (userIds.length) {
      await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [userIds]).catch(() => {});
    }
    await pool.end().catch(() => {});
  });

  // NOT `WHERE is_entry = true` (SOMET-505). That flag is globally exclusive
  // and peer test files borrow it onto throwaway worlds they then DELETE, so
  // the id it hands back can be a row that no longer exists by the time the
  // join frame below goes out -- measured, twice in four runs, as all seven
  // subtests here failing with `unknown world`. See tests/helpers/entryWorld.js.
  const { id: entryWorldId } = await entryWorldForJoin(pool);

  // ---- SOURCE 1: what character select advertises -------------------------
  const advertised = await listPlayableClasses(pool);
  const byName = new Map(advertised.map((c) => [c.name, c]));

  await t.test('character select advertises every class a real base pool', () => {
    for (const cls of advertised) {
      assert.ok(Number.isFinite(cls.hp) && cls.hp > 0, `${cls.name} advertises a real hp`);
      assert.ok(Number.isFinite(cls.mana) && cls.mana > 0, `${cls.name} advertises a real mana`);
    }
    // Literal, so a silent re-tune of the catalog is a failure here rather
    // than a test that quietly follows the data wherever it goes.
    assert.deepEqual(
      CLASSES.map((n) => [n, byName.get(n).hp, byName.get(n).mana]),
      [['Warrior', 100, 100], ['Mage', 75, 150], ['Monk', 90, 110],
        ['Cultist', 110, 90], ['Archer', 85, 115], ['Druid', 90, 135]]);
    // SOMET-471 demoted Ranger rather than renaming it into Archer. It must
    // NOT be offered -- and Archer must not be it wearing a new name, which is
    // what six_classes_db.test.js pins at the row level.
    assert.equal(byName.get('Ranger'), undefined,
      'Ranger is not playable any more and must not be advertised');
  });

  // ---- SOURCE 2: what a character actually gets, via the real join --------
  //
  // One account per class: the authority allows exactly one live session per
  // account ("newest join wins"), so three characters on one user would kick
  // each other out from under the assertions.
  async function joinAs(className) {
    const cls = byName.get(className);
    assert.ok(cls, `${className} must be a playable class`);

    const u = await pool.query(
      `INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`${TAG}_${className}`.toLowerCase()]);
    const userId = u.rows[0].id;
    userIds.push(userId);

    const character = await createCharacter(pool, userId, `${TAG}${className}`, cls.id);

    // `tv`, not `token_version`: the upgrade handler compares this claim
    // against users.token_version, which defaults to 1 for the row above.
    const token = jwt.sign({ user_id: userId, tv: 1 }, SECRET, { algorithm: 'HS256' });
    const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
    sockets.push(ws);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    ws.send(JSON.stringify({ type: 'join', character_id: character.id, world_id: entryWorldId }));
    await nextMsg(ws, 'joined');

    const world = handle.worlds.get(entryWorldId).world;
    const player = world.getPlayer(String(userId));
    assert.ok(player, `${className} must actually be in the world after joining`);
    return { cls, character, userId, player };
  }

  // AC2 + AC3, in one assertion each, comparing the two sources directly.
  // A fresh character is at BASE_STAT on every stat, so its pools are its
  // class's base pools with nothing added -- which is exactly what makes the
  // advertised number and the played number comparable at all.
  for (const className of CLASSES) {
    await t.test(`a ${className} joins with the pools character select advertised`, async () => {
      const { cls, player } = await joinAs(className);
      assert.equal(player.maxHp, cls.hp,
        `${className} is advertised at ${cls.hp} hp and must JOIN at ${cls.hp} hp`);
      assert.equal(player.maxMana, cls.mana,
        `${className} is advertised at ${cls.mana} mana and must JOIN at ${cls.mana} mana`);
      // Joining at full, not at some fraction: addPlayer sets current = max.
      assert.equal(player.hp, cls.hp);
      assert.equal(player.mana, cls.mana);
      // The class pools must ride the player, or every later re-derive
      // (level-up, chest, socket, respec) recomputes them class-blind.
      assert.deepEqual(player.classPools, { maxHp: cls.hp, maxMana: cls.mana },
        'the joined player must carry its class base pools for later re-derives');
    });
  }

  await t.test('the six classes really do differ once joined', async () => {
    // Guards against the whole file passing because every class happens to
    // advertise, and receive, the same number -- which is precisely the state
    // the game was in before 486 (100/100 for everyone). Six classes make that
    // easier to hit by accident, not harder.
    const world = handle.worlds.get(entryWorldId).world;
    const pools = CLASSES.map((n) => {
      const p = world.getPlayer(String(userIds[CLASSES.indexOf(n)]));
      return `${p.maxHp}/${p.maxMana}`;
    });
    assert.equal(new Set(pools).size, CLASSES.length,
      `all six classes joined with distinct pools, got ${pools.join(', ')}`);
  });

  // ---- AC1: no existing character's pools move ----------------------------
  //
  // The pool formula changed only in its BASE term, so "did anything move?"
  // reduces exactly to "does this character's class base differ from the
  // fallback the old code used?". Every character on this database is derived
  // both ways and the two are compared row by row; the characters this file
  // just created are excluded because they are, by definition, not existing
  // ones.
  await t.test('no pre-existing character\'s max HP or max mana moves', async () => {
    // SCOPED TO CHARACTERS THAT ACTUALLY PREDATE THE MIGRATION (SOMET-473).
    //
    // "Pre-existing" used to mean "every character not owned by this file's own
    // users", which silently included characters a CONCURRENTLY RUNNING peer
    // test had just created. Any peer that makes a non-Warrior -- and several
    // now do: life_cost_live_join_db makes a Cultist, charm_live_db makes a
    // Druid -- fails this assertion on a timing coincidence, because a
    // Cultist's pools are SUPPOSED to differ from the class-blind derive. That
    // is the guarantee working, reported as a violation of itself.
    //
    // The guarantee is about characters that existed BEFORE class base pools
    // shipped, so the population is defined by the migration's own run_on
    // rather than by "not mine". A peer's character, created after it, is out
    // of scope no matter when it happens to exist.
    const r = await pool.query(
      `SELECT c.id, c.name, e.name AS class_name, e.max_hp, e.max_mana,
              COALESCE(p.constitution, 5) AS constitution,
              COALESCE(p.intelligence, 5) AS intelligence
         FROM characters c
         JOIN entity_types e ON e.id = c.entity_type_id
         LEFT JOIN player_progression p ON p.character_id = c.id
        WHERE c.user_id <> ALL($1::int[])
          AND c.created_at < (SELECT run_on FROM pgmigrations
                               WHERE name = '1714440509000_class_base_pools')
        ORDER BY c.id`,
      [userIds]);

    if (!r.rows.length) {
      t.diagnostic('no pre-existing characters on this database; the no-move guarantee was not exercised here');
      return;
    }

    const moved = [];
    for (const row of r.rows) {
      const prog = {
        constitution: Number(row.constitution),
        intelligence: Number(row.intelligence),
      };
      const before = derivePlayerStats(prog); // the pre-486, class-blind derive
      const after = derivePlayerStats(prog, {
        maxHp: Number(row.max_hp), maxMana: Number(row.max_mana),
      });
      if (before.maxHp !== after.maxHp || before.maxMana !== after.maxMana) {
        moved.push(`${row.name} (${row.class_name}): ${before.maxHp}/${before.maxMana} -> ${after.maxHp}/${after.maxMana}`);
      }
    }
    assert.deepEqual(moved, [],
      'these characters\' pools moved -- SOMET-486 must be invisible to everyone who already exists');
  });

  await t.test('Warrior\'s base pools are exactly the fallback the old code used', async () => {
    // The mechanism behind the row-by-row check above: every character
    // predating 486 is a Warrior, and Warrior's base is pinned to the
    // constants the class-blind derive used. State it directly so a future
    // Warrior re-tune fails here, with a reason, rather than only showing up
    // as a mysterious diff in the loop above once a non-Warrior exists.
    const w = byName.get('Warrior');
    assert.deepEqual([w.hp, w.mana], [HP_BASE, MANA_BASE],
      'moving Warrior\'s base pools moves every character that predates SOMET-486');
  });
});
