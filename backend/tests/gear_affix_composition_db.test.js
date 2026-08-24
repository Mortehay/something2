// backend/tests/gear_affix_composition_db.test.js
//
// SOMET-496 -- an equipped affix has to CHANGE THE GAME, not just the panel.
//
// This is the tenth feature in this project found live in the database,
// rendered in the UI and inert in play, each with a fully green suite. The
// affix half of SOMET-480 was rolled, persisted, hydrated, joined and drawn;
// composeProgression then handed composeStats `gear: []`, so `sources.*.gear`
// was structurally zero and derivePlayerStats -- which reads that same row --
// never saw it. A staff with `of Insight +6 INT` left max mana at 100 and the
// spell multiplier at x1.00.
//
// Three rules follow, and every test below obeys them:
//
//  1. NOTHING IS PROVEN BY READING `sources`. `sources` is exactly what looked
//     correct for the whole time the game ignored it. Every claim that a stat
//     is LIVE is made through a derived number -- maxMana, spellMult, maxHp --
//     produced by the REAL authority.
//
//  2. THE REAL EQUIP PATH. The `equip` websocket frame, into the real
//     messageHandlers, into world.setEquipment, against the real pool. Not
//     withGearAffixes in isolation: the pure overlay is covered in
//     gear_affix_overlay.test.js and has been correct-by-construction from the
//     first commit. What was broken was the wiring.
//
//  3. THE GATE STAYS GEAR-FREE. SOMET-478 refuses an item that would satisfy
//     its own requirement. The obvious fix for this ticket -- folding gear
//     into the row composeProgression returns -- would have reopened that hole,
//     because world.js#_requirementContext builds the gate's `base` out of
//     that row's six top-level keys. The last three tests are what makes the
//     difference between the two fixes observable.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const WebSocket = require('ws');

const { attachAuthority } = require('../src/authority/server.js');
const { World } = require('../src/authority/world.js');
const { loadItemTypes, loadInventory } = require('../src/authority/items.js');
const { loadProgression } = require('../src/services/progressionStore.js');
const { createCharacter } = require('../src/services/characters.js');

// createCharacter takes an entity_types id, not a class name.
async function warriorTypeId(pool) {
  const r = await pool.query("SELECT id FROM entity_types WHERE name = 'Warrior' AND is_playable = true");
  if (r.rows.length !== 1) throw new Error('the database needs a seeded playable Warrior');
  return r.rows[0].id;
}

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const SECRET = 'somet496-test-secret';
const TAG = `s496_${process.pid}_${Date.now().toString(36)}`;

function uniq(x) { return `${TAG}_${x}_${Math.random().toString(36).slice(2, 8)}`; }

// characters.name is capped at 32 characters, so a character name gets its own
// short unique form rather than the full TAG-prefixed one.
let nameSeq = 0;
function charName() { return `s496c${process.pid % 100000}x${(nameSeq += 1)}`; }

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

// The LIVE simulation's own pool for this player, off the next `state` frame.
// Stronger than the `stats` bundle riding the progression frame: this is the
// number world.js actually spends and regenerates. A fix that reached the wire
// but not applyDerivedStats would satisfy the frame and fail here.
async function liveMaxMana(ws, userId) {
  const st = await nextMsg(ws, 'state');
  const me = (st.players || []).find((p) => String(p.id) === String(userId));
  assert.ok(me, 'the joined player must appear in the state frame');
  return me.maxMana;
}

async function openPool() {
  if (!DB_URL) return null;
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 3000, max: 6 });
  try { await pool.query('SELECT 1'); } catch (err) {
    await pool.end().catch(() => {});
    // Loud, not silent. A skipped DB test is a test that verified nothing, and
    // this file is the one that proves the feature is not inert.
    throw new Error(`database unreachable, so nothing here was verified: ${err.message}`);
  }
  return pool;
}

// A catalog affix authored by this test, so the rolled value is EXACT rather
// than whatever the live catalog happens to hold. min_value === max_value, so
// even a roll through the real roller could only produce this number.
async function makeAffix(pool, key, effect, value) {
  const r = await pool.query(
    `INSERT INTO affix_types (key, label, kind, effect, min_value, max_value,
                              min_item_level, min_rarity, weight)
     VALUES ($1, $2, 'buff', $3::jsonb, $4, $4, 1, 'blue', 100) RETURNING id`,
    [key, `of ${key}`, JSON.stringify(effect), value],
  );
  return r.rows[0].id;
}

// Every item_types row this file creates, so cleanup deletes exactly those
// rather than everything matching a name pattern -- the two top-level tests
// share a TAG and would otherwise race each other's fixtures.
const createdItemTypes = [];

async function makeItemType(pool, name, extra = {}) {
  const c = {
    category: 'armor', slot: 'chest', kind: null, damage: 0, cooldown: 0, defense: 1,
    reach: null, arc_width: null,
    req_level: 1, req_strength: 0, item_level: 1, tier: 1, ...extra,
  };
  const r = await pool.query(
    `INSERT INTO item_types (name, category, slot, kind, damage, cooldown, defense,
                             reach, arc_width,
                             req_level, req_strength, item_level, tier)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [name, c.category, c.slot, c.kind, c.damage, c.cooldown, c.defense,
      c.reach, c.arc_width,
      c.req_level, c.req_strength, c.item_level, c.tier],
  );
  createdItemTypes.push(r.rows[0].id);
  return r.rows[0].id;
}

// One affixed instance, written the way the roller writes one: the instance
// row carries the rarity and item level, the affix rows carry the value.
async function makeAffixedItem(pool, characterId, typeId, affixTypeId, value) {
  const r = await pool.query(
    `INSERT INTO player_items (character_id, item_type_id, quantity, rarity, item_level)
     VALUES ($1,$2,1,'blue',1) RETURNING id`,
    [characterId, typeId],
  );
  const itemId = r.rows[0].id;
  await pool.query(
    'INSERT INTO player_item_affixes (player_item_id, idx, affix_type_id, value) VALUES ($1,0,$2,$3)',
    [itemId, affixTypeId, value],
  );
  return itemId;
}

async function makeUser(pool) {
  const u = await pool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1,'x','player') RETURNING id",
    [uniq('user')],
  );
  return u.rows[0].id;
}

// ===========================================================================
// PART 1 -- through the REAL authority: join, equip, unequip.
//
// EVERY SESSION HERE JOINS ONCE AND IS NEVER RECONNECTED, and each scenario
// gets its own account. That is deliberate: server.js's `ws.on('close')`
// identity-checks the outgoing socket at the TOP and then AWAITS persist() and
// flushBind() before it runs removePlayer / sockets.delete / the empty-world
// eviction, so a new session for the same account registering inside that
// await window is torn down by the stale close and receives no further
// `state` frame. An earlier revision of this file reconnected the same
// character and failed roughly one run in three because of it. That is a
// pre-existing session-lifecycle defect, reported separately; a
// deliberately-flaky fixture is not a way to describe it.
// ===========================================================================

test('an equipped affix is live in play (SOMET-496)', { skip: !DB_URL ? 'no database URL' : false }, async (t) => {
  const pool = await openPool();
  const server = http.createServer();
  const handle = attachAuthority(server, pool, { jwtSecret: SECRET, tickMs: 50 });
  await new Promise((r) => server.listen(0, r));
  const url = `ws://127.0.0.1:${server.address().port}/authority`;

  const userIds = [];
  const affixIds = [];
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) { try { ws.terminate(); } catch { /* already gone */ } }
    handle.close();
    if (server.listening) await new Promise((r) => server.close(r));
    if (userIds.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [userIds]).catch(() => {});
    // affix_types is ON DELETE RESTRICT from player_item_affixes, so the user
    // cascade above has to land first.
    if (affixIds.length) await pool.query('DELETE FROM affix_types WHERE id = ANY($1::int[])', [affixIds]).catch(() => {});
    await pool.query('DELETE FROM item_types WHERE id = ANY($1::int[])', [createdItemTypes]).catch(() => {});
    await pool.end().catch(() => {});
  });

  const entry = await pool.query('SELECT id FROM worlds WHERE is_entry = true LIMIT 1');
  assert.strictEqual(entry.rows.length, 1, 'the database needs a seeded entry world');
  const worldId = entry.rows[0].id;
  const warrior = await warriorTypeId(pool);

  // ONE affix catalog row, shared by every character below: `of Insight`,
  // +6 INT, min_value === max_value so the number is exact.
  const insight = await makeAffix(pool, uniq('insight'), { type: 'stat', stat: 'intelligence' }, 6);
  affixIds.push(insight);
  const staffType = await makeItemType(pool, uniq('staff'), {
    category: 'weapon', slot: 'main_hand', kind: 'melee', damage: 5, cooldown: 500, defense: 0,
    reach: 40, arc_width: 1.2,
  });
  const stoneType = (await pool.query(
    `INSERT INTO item_types (name, category, slot, kind, damage, cooldown,
                             stat_bonus_stat, stat_bonus_amount)
     VALUES ($1,'stone',NULL,NULL,0,0,'intelligence',3) RETURNING id`,
    [uniq('stone')],
  )).rows[0].id;
  createdItemTypes.push(stoneType);

  // A seeded tree node worth exactly +4 INT, allocated straight into
  // character_passives so the fixture does not depend on which nodes the
  // seeded tree happens to make reachable.
  const node = await pool.query(
    `SELECT id FROM passive_nodes
      WHERE grants @> '[{"type":"stat","stat":"intelligence","value":4}]'::jsonb
      LIMIT 1`,
  );
  assert.strictEqual(node.rows.length, 1,
    'no seeded passive node grants exactly +4 intelligence; pick another value');
  const intNode = node.rows[0].id;

  // A whole character: an account, a Warrior (base pools 100/100, so every
  // figure below is hand-computable from progressionConstants), the affixed
  // staff, and whatever else the scenario asked for -- all in the database
  // BEFORE anyone joins.
  async function scenario({ equipStaff = false, tree = false, stone = false } = {}) {
    const userId = await makeUser(pool);
    userIds.push(userId);
    const character = await createCharacter(pool, userId, charName(), warrior);
    const staffId = await makeAffixedItem(pool, character.id, staffType, insight, 6);
    if (equipStaff) {
      await pool.query(
        `INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1,'main_hand',$2)
         ON CONFLICT (character_id, slot) DO UPDATE SET item_id = EXCLUDED.item_id`,
        [character.id, staffId],
      );
    }
    if (tree) {
      await pool.query(
        'INSERT INTO character_passives (character_id, node_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [character.id, intNode],
      );
    }
    if (stone) {
      const stoneId = (await pool.query(
        'INSERT INTO player_items (character_id, item_type_id, quantity) VALUES ($1,$2,1) RETURNING id',
        [character.id, stoneType],
      )).rows[0].id;
      await pool.query(
        'INSERT INTO stone_instances (player_item_id, socketed_into_id) VALUES ($1,$2)', [stoneId, staffId],
      );
    }
    const ws = new WebSocket(`${url}?token=${encodeURIComponent(jwt.sign({ user_id: userId, tv: 1 }, SECRET, { algorithm: 'HS256' }))}`);
    sockets.push(ws);
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
    ws.send(JSON.stringify({ type: 'join', world_id: worldId, character_id: character.id }));
    const joined = await nextMsg(ws, 'joined');
    return { userId, character, staffId, ws, joined };
  }

  // -------------------------------------------------------------------------
  // AC1 / AC2 -- the real equip frame, the real derive, on a live session.
  // -------------------------------------------------------------------------
  const a = await scenario();

  // BASELINE. A Warrior at base INT 5: MANA_BASE 100, spellMult 1 + 0.05 * 0.
  await t.test('baseline: the staff is carried, not worn', async () => {
    assert.ok(a.joined.items.some((i) => i.id === a.staffId), 'the affixed staff must be in the pack');
    assert.notStrictEqual(a.joined.equipment.main_hand, a.staffId);
    assert.strictEqual(a.joined.progression.intelligence, 5);
    assert.strictEqual(await liveMaxMana(a.ws, a.userId), 100);
  });

  // INT 5 + 6 = 11.
  //   maxMana   = MANA_BASE 100 + MANA_PER_INT 10 * (11 - 5) = 160
  //   spellMult = 1 + SPELL_PER_INT 0.05 * (11 - 5)          = 1.30
  a.ws.send(JSON.stringify({ type: 'equip', itemId: a.staffId, slot: 'main_hand' }));
  const equipped = await nextMsg(a.ws, 'progression');

  await t.test('equipping a +6 INT affix raises INT, max mana and the spell multiplier', async () => {
    assert.strictEqual(equipped.progression.intelligence, 11);
    assert.strictEqual(equipped.stats.maxMana, 160,
      'the affix must reach derivePlayerStats, not just the breakdown');
    assert.strictEqual(equipped.stats.spellMult, 1.3);
    // ...and the LIVE world agrees. The wire bundle alone would be another
    // number nobody plays with.
    assert.strictEqual(await liveMaxMana(a.ws, a.userId), 160);
  });

  // AC5. The Character tab's `gear` column. Asserted last and never alone: on
  // its own this is precisely the assertion that stayed green for the whole
  // life of the defect.
  await t.test('the Character tab gear column is non-zero for an affixed character', () => {
    assert.deepStrictEqual(equipped.progression.sources.intelligence, { base: 5, tree: 0, gear: 6 });
    const gearMods = equipped.progression.modifiers.filter((m) => m.source === 'gear');
    assert.strictEqual(gearMods.length, 1);
    assert.strictEqual(gearMods[0].detail, 'intelligence');
    assert.strictEqual(gearMods[0].value, 6);
    assert.ok(gearMods[0].label && gearMods[0].label.length > 0,
      'a gear modifier with a blank label renders as an unexplained number');
  });

  a.ws.send(JSON.stringify({ type: 'unequip', slot: 'main_hand' }));
  const removed = await nextMsg(a.ws, 'progression');

  await t.test('unequipping puts INT, max mana and the spell multiplier back', async () => {
    assert.strictEqual(removed.progression.intelligence, 5);
    assert.strictEqual(removed.stats.maxMana, 100);
    assert.strictEqual(removed.stats.spellMult, 1);
    assert.strictEqual(await liveMaxMana(a.ws, a.userId), 100);
    assert.deepStrictEqual(removed.progression.sources.intelligence, { base: 5, tree: 0, gear: 0 });
  });

  // -------------------------------------------------------------------------
  // AC4 -- NO DOUBLE COUNTING, and the JOIN path rather than the equip one.
  //
  // The join derives BEFORE addPlayer (its own `over` branch), so it is a
  // second, separate wiring of the same fold and the one place a fix can land
  // on the equip handler and miss the front door.
  //
  // INT = 5 base + 4 tree + 6 gear = 15, ONCE.
  //   maxMana   = 100 + 10 * (15 - 5) = 200
  //   spellMult = 1 + 0.05 * (15 - 5) = 1.50
  // A row that folded gear in twice would read INT 21 / 260 mana / x1.80.
  // -------------------------------------------------------------------------
  const b = await scenario({ equipStaff: true, tree: true });

  await t.test('joining with the staff already worn counts base, tree and gear once each', async () => {
    assert.strictEqual(b.joined.equipment.main_hand, b.staffId, 'the staff must be worn at join');
    assert.strictEqual(b.joined.progression.intelligence, 15);
    assert.deepStrictEqual(b.joined.progression.sources.intelligence, { base: 5, tree: 4, gear: 6 });
    assert.strictEqual(await liveMaxMana(b.ws, b.userId), 200);
  });

  // -------------------------------------------------------------------------
  // THE FOLD ORDER, in numbers rather than in a source regex.
  //
  // withGearAffixes rebuilds the six top-level stat keys, so it destroys
  // whatever an earlier overlay wrote onto them. Gear folds in first and the
  // buff stones on top; reversed, every stone silently stops counting for an
  // affixed character -- and nothing about the number would look wrong.
  //
  // INT = 5 base + 4 tree + 6 affix + 3 stone = 18 -> maxMana 100 + 10*13 = 230.
  // Reversed, the stone is discarded and this reads 200 -- exactly the number
  // the previous scenario asserts WITHOUT a stone.
  // -------------------------------------------------------------------------
  const c = await scenario({ equipStaff: true, tree: true, stone: true });

  await t.test('a buff stone and an affix on the same stat BOTH count', async () => {
    assert.strictEqual(await liveMaxMana(c.ws, c.userId), 230);
    // The stone is a TOP-LEVEL overlay and has never appeared in `sources`;
    // that is pre-existing (SOMET-245) and is not what this ticket changed.
    assert.deepStrictEqual(c.joined.progression.sources.intelligence, { base: 5, tree: 4, gear: 6 });
  });
});

// ===========================================================================
// PART 2 -- the circularity guard, which the obvious fix would have broken.
// ===========================================================================

function armWorld(itemTypes) {
  const map = { chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] };
  return new World(map, itemTypes, null, 8);
}

test('gear is excluded from the equip gate base (SOMET-478 under SOMET-496)', { skip: !DB_URL ? 'no database URL' : false }, async (t) => {
  const pool = await openPool();
  const userIds = [];
  const affixIds = [];
  t.after(async () => {
    if (userIds.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [userIds]).catch(() => {});
    if (affixIds.length) await pool.query('DELETE FROM affix_types WHERE id = ANY($1::int[])', [affixIds]).catch(() => {});
    await pool.query('DELETE FROM item_types WHERE id = ANY($1::int[])', [createdItemTypes]).catch(() => {});
    await pool.end().catch(() => {});
  });

  const userId = await makeUser(pool);
  userIds.push(userId);
  const character = await createCharacter(pool, userId, charName(), await warriorTypeId(pool));
  await pool.query('UPDATE player_progression SET level = 60 WHERE character_id = $1', [character.id]);

  const might = await makeAffix(pool, uniq('might'), { type: 'stat', stat: 'strength' }, 20);
  affixIds.push(might);
  const plateType = await makeItemType(pool, uniq('plate'), { slot: 'chest', req_strength: 20 });
  const helmType = await makeItemType(pool, uniq('helm'), { slot: 'head' });

  const plate = await makeAffixedItem(pool, character.id, plateType, might, 20);
  const helm = (await pool.query(
    "INSERT INTO player_items (character_id, item_type_id, quantity, rarity, item_level) VALUES ($1,$2,1,'white',1) RETURNING id",
    [character.id, helmType],
  )).rows[0].id;

  const itemTypes = await loadItemTypes(pool);

  await t.test('a plate carrying its own +20 STR AFFIX cannot satisfy its own 20-STR gate', async () => {
    const inv = await loadInventory(pool, character.id);
    const world = armWorld(itemTypes);
    world.addPlayer('u-circ-affix', { x: 0, y: 0 }, inv, { x: 0, y: 0 }, 0, undefined, character.id);

    const r = await world.setEquipment(pool, 'u-circ-affix', plate, 'chest');
    assert.strictEqual(r.ok, false, 'the plate must not bootstrap itself past its own gate');
    assert.match(r.reason, /20 strength/);
    const eq = await pool.query('SELECT count(*)::int AS n FROM player_equipment WHERE character_id = $1', [character.id]);
    assert.strictEqual(eq.rows[0].n, 0, 'a refused equip must write nothing');
  });

  // The positive half, so the refusal above cannot be "affixes never count".
  // The SAME affix, moved onto a helm that is actually worn, qualifies the
  // plate -- 5 base + 20 from a DIFFERENT equipped item = 25 >= 20.
  await t.test('the same affix worn on a DIFFERENT item does qualify the plate', async () => {
    await pool.query('DELETE FROM player_item_affixes WHERE player_item_id = $1', [plate]);
    await pool.query(
      'INSERT INTO player_item_affixes (player_item_id, idx, affix_type_id, value) VALUES ($1,0,$2,20)',
      [helm, might],
    );
    const inv = await loadInventory(pool, character.id);
    const world = armWorld(itemTypes);
    world.addPlayer('u-qual', { x: 0, y: 0 }, inv, { x: 0, y: 0 }, 0, undefined, character.id);

    assert.deepStrictEqual(await world.setEquipment(pool, 'u-qual', helm, 'head'), { ok: true });
    assert.deepStrictEqual(await world.setEquipment(pool, 'u-qual', plate, 'chest'), { ok: true });

    // ...and taking the helm off is refused BY NAME, because the plate would
    // become illegal. THIS is the assertion that dies if gear is ever folded
    // into the row _requirementContext reads: the plate's qualifying 20 STR
    // would already be inside `base`, removing the helm would change nothing,
    // and the orphan check would go quietly inert.
    const blocked = await world.clearEquipment(pool, 'u-qual', 'head');
    assert.strictEqual(blocked.ok, false);
    assert.match(blocked.reason, /would no longer meet its requirements/);
  });

  // The most direct statement of the rule this ticket had to preserve. The
  // PERSISTED, GATING row is gear-free; the RUNTIME row is not. Both are read
  // here, in one test, so a fix that collapses them into one is a failure
  // rather than a silently widened gate.
  await t.test('the gating row stays gear-free while the runtime row carries the gear', async () => {
    const { equippedAffixGrants, withGearAffixes } = require('../src/services/gearAffixes.js');
    const inv = await loadInventory(pool, character.id);
    assert.strictEqual(inv.equipment.head, helm, 'the +20 STR helm must be worn for this to mean anything');

    const gating = await loadProgression(pool, character.id);
    assert.strictEqual(gating.strength, 5,
      'loadProgression feeds world.js#_requirementContext; gear must never reach it');
    assert.deepStrictEqual(gating.sources.strength, { base: 5, tree: 0, gear: 0 });

    const runtime = withGearAffixes(gating, equippedAffixGrants(inv));
    assert.strictEqual(runtime.strength, 25, 'the runtime row is where the gear lands');
    // meleeMult = 1 + MELEE_PER_STR 0.05 * (25 - 5) = 2.00
    const { derivePlayerStats } = require('../src/services/playerStats.js');
    assert.strictEqual(derivePlayerStats(runtime, { maxHp: 100, maxMana: 100 }).meleeMult, 2);
  });
});
