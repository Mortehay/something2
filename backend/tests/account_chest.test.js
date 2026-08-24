const test = require('node:test');
const assert = require('node:assert');
const {
  fetchChest, depositItem, withdrawItem, CHEST_CAPACITY,
} = require('../src/services/accountChest.js');

// A SMALL IN-MEMORY POSTGRES, not a canned-response mock.
//
// This shape is deliberate. The thing under test here is almost entirely made
// of SQL predicates -- `AND character_id = $2` is the authorization check,
// `NOT EXISTS (...) ORDER BY slot LIMIT 1` is the capacity rule -- and a
// handler stub that returns a fixed `{ rowCount: 1 }` regardless of its params
// would pass every test below while the service shipped with no ownership
// check at all. So this fake EVALUATES the predicates against real rows and
// honors ROLLBACK by restoring a snapshot, which is what makes the
// "refused, and nothing moved" assertions mean anything.
//
// It also MODELS THE FOREIGN KEYS THAT DELETE THINGS (SOMET-498). `player_items
// .account_item_id` is ON DELETE CASCADE, so deleting an account_items row
// while an instance still names it destroys that instance -- which is the exact
// mistake withdrawItem's statement ordering exists to avoid. A fake that
// deleted the container without cascading would let that ordering be reversed
// with every test still green, so the cascade is implemented below and
// `withdrawing must not cascade the instance away` is what pins it.
//
// The round-trip behaviour this file exists to protect is asserted against a
// REAL database in account_chest_instance_db.test.js. This file covers the
// predicates and the orderings; that one covers rarity, item level and affixes.
function fakeDb(seed = {}) {
  const state = {
    playerItems: seed.playerItems ? seed.playerItems.map((r) => ({ ...r })) : [],
    accountItems: seed.accountItems ? seed.accountItems.map((r) => ({ ...r })) : [],
    equipment: seed.equipment ? seed.equipment.map((r) => ({ ...r })) : [],
    // { playerItemId, socketedIntoId } -- one row per stone instance, exactly
    // as stone_instances stores it.
    stones: seed.stones ? seed.stones.map((r) => ({ ...r })) : [],
    // { playerItemId, idx, affixTypeId, key, label, value, effect } -- one row
    // per player_item_affixes row, joined to its affix_types entry.
    affixes: seed.affixes ? seed.affixes.map((r) => ({ ...r })) : [],
  };
  let snapshot = null;
  let nextId = 1000;

  const snap = () => JSON.parse(JSON.stringify(state));
  const restore = (s) => {
    state.playerItems = s.playerItems;
    state.accountItems = s.accountItems;
    state.equipment = s.equipment;
    state.stones = s.stones;
    state.affixes = s.affixes;
  };

  // player_items.account_item_id ON DELETE CASCADE, and player_item_affixes
  // .player_item_id ON DELETE CASCADE behind it. Modelled, not assumed: this is
  // the destruction withdrawItem's ordering is written to avoid, so the fake
  // has to be able to perform it.
  const cascadeFromAccountItem = (accountItemId) => {
    const doomed = state.playerItems
      .filter((p) => p.accountItemId === accountItemId)
      .map((p) => p.id);
    state.playerItems = state.playerItems.filter((p) => !doomed.includes(p.id));
    state.affixes = state.affixes.filter((a) => !doomed.includes(a.playerItemId));
  };

  const query = async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s === 'BEGIN') { snapshot = snap(); return { rows: [], rowCount: 0 }; }
    if (s === 'COMMIT') { snapshot = null; return { rows: [], rowCount: 0 }; }
    if (s === 'ROLLBACK') {
      if (snapshot) restore(snapshot);
      snapshot = null;
      return { rows: [], rowCount: 0 };
    }

    // Ownership + lock. `character_id = $2` IS the authorization check.
    if (/^SELECT item_type_id, quantity, soulbound FROM player_items WHERE id = \$1 AND character_id = \$2 FOR UPDATE/.test(s)) {
      const [itemId, characterId] = params;
      const hit = state.playerItems.filter(
        (p) => p.id === itemId && p.characterId === characterId,
      );
      return {
        rows: hit.map((r) => ({
          item_type_id: r.itemTypeId, quantity: r.quantity ?? 1, soulbound: !!r.soulbound,
        })),
        rowCount: hit.length,
      };
    }

    // SOMET-498: UNSCOPED. One param, not two -- a fake that still accepted a
    // characterId here would make the widened guard untestable.
    if (/^SELECT 1 FROM player_equipment WHERE item_id = \$1$/.test(s)) {
      const [itemId] = params;
      const hit = state.equipment.filter((e) => e.itemId === itemId);
      return { rows: hit.map(() => ({ '?column?': 1 })), rowCount: hit.length };
    }

    // The item IS a stone.
    if (/^SELECT 1 FROM stone_instances WHERE player_item_id = \$1$/.test(s)) {
      const [itemId] = params;
      const hit = state.stones.filter((st) => st.playerItemId === itemId);
      return { rows: hit.map(() => ({})), rowCount: hit.length };
    }

    // The item HOSTS a stone.
    if (/^SELECT 1 FROM stone_instances WHERE socketed_into_id = \$1$/.test(s)) {
      const [itemId] = params;
      const hit = state.stones.filter((st) => st.socketedIntoId === itemId);
      return { rows: hit.map(() => ({})), rowCount: hit.length };
    }

    if (/INSERT INTO account_items/.test(s)) {
      const [userId, itemTypeId, quantity, soulbound, capacity] = params;
      const taken = new Set(
        state.accountItems.filter((a) => a.userId === userId).map((a) => a.slot),
      );
      let slot = null;
      for (let n = 1; n <= capacity; n += 1) {
        if (!taken.has(n)) { slot = n; break; }
      }
      if (slot === null) return { rows: [], rowCount: 0 };
      const row = {
        id: `a${nextId += 1}`, userId, slot, itemTypeId, quantity, soulbound: !!soulbound,
      };
      state.accountItems.push(row);
      return {
        rows: [{
          id: row.id,
          slot: row.slot,
          item_type_id: row.itemTypeId,
          quantity: row.quantity,
          soulbound: row.soulbound,
        }],
        rowCount: 1,
      };
    }

    // Deposit's handover: character -> chest, both holder columns in one
    // statement.
    if (/^UPDATE player_items SET character_id = NULL, account_item_id = \$2 WHERE id = \$1 AND character_id = \$3/.test(s)) {
      const [itemId, accountItemId, characterId] = params;
      const hit = state.playerItems.filter(
        (p) => p.id === itemId && p.characterId === characterId,
      );
      for (const r of hit) { r.characterId = null; r.accountItemId = accountItemId; }
      return { rows: [], rowCount: hit.length };
    }

    // Withdraw's ownership + lock on the CONTAINER.
    if (/^SELECT id FROM account_items WHERE id = \$1 AND user_id = \$2 FOR UPDATE/.test(s)) {
      const [accountItemId, userId] = params;
      const hit = state.accountItems.filter(
        (a) => a.id === accountItemId && a.userId === userId,
      );
      return { rows: hit.map((a) => ({ id: a.id })), rowCount: hit.length };
    }

    // Withdraw's detach: chest -> character.
    if (/^UPDATE player_items SET character_id = \$2, account_item_id = NULL WHERE account_item_id = \$1/.test(s)) {
      const [accountItemId, characterId] = params;
      const hit = state.playerItems.filter((p) => p.accountItemId === accountItemId);
      for (const r of hit) { r.characterId = characterId; r.accountItemId = null; }
      return {
        rows: hit.map((r) => ({
          id: r.id,
          item_type_id: r.itemTypeId,
          quantity: r.quantity ?? 1,
          rarity: r.rarity || 'white',
          item_level: r.itemLevel ?? 1,
          soulbound: !!r.soulbound,
        })),
        rowCount: hit.length,
      };
    }

    if (/FROM player_item_affixes pia JOIN affix_types at/.test(s)) {
      const [playerItemId] = params;
      const rows = state.affixes
        .filter((a) => a.playerItemId === playerItemId)
        .sort((a, b) => a.idx - b.idx)
        .map((a) => ({
          affix_type_id: a.affixTypeId, key: a.key, label: a.label, value: a.value, effect: a.effect,
        }));
      return { rows, rowCount: rows.length };
    }

    if (/^DELETE FROM account_items WHERE id = \$1 AND user_id = \$2$/.test(s)) {
      const [accountItemId, userId] = params;
      const idx = state.accountItems.findIndex(
        (a) => a.id === accountItemId && a.userId === userId,
      );
      if (idx === -1) return { rows: [], rowCount: 0 };
      state.accountItems.splice(idx, 1);
      cascadeFromAccountItem(accountItemId);
      return { rows: [], rowCount: 1 };
    }

    // SOMET-502: the listing joins to the instance each chest row is HOLDING,
    // so the fake models that join rather than merely tolerating it -- a fake
    // that returned the container columns alone would let the panel's grade
    // silently disappear while these tests stayed green.
    if (/FROM account_items ai[\s\S]*WHERE ai\.user_id = \$1/.test(s)) {
      const [userId] = params;
      const rows = state.accountItems
        .filter((a) => a.userId === userId)
        .sort((a, b) => a.slot - b.slot)
        .map((a) => {
          const held = state.playerItems.find((pi) => pi.accountItemId === a.id) || null;
          return {
            id: a.id,
            slot: a.slot,
            item_type_id: a.itemTypeId,
            quantity: a.quantity,
            soulbound: a.soulbound,
            // NULL instance_id is the legacy row the panel must leave alone.
            instance_id: held ? held.id : null,
            rarity: held ? (held.rarity || 'white') : null,
            item_level: held ? (held.itemLevel ?? 1) : null,
            affixes: held
              ? state.affixes
                .filter((x) => x.playerItemId === held.id)
                .sort((x, y) => x.idx - y.idx)
                .map((x) => ({
                  affixTypeId: x.affixTypeId, key: x.key, label: x.label, value: x.value, effect: x.effect,
                }))
              : null,
          };
        });
      return { rows, rowCount: rows.length };
    }

    throw new Error(`fakeDb: unhandled SQL: ${s}`);
  };

  return {
    state,
    query,
    connect: async () => ({ query, release: () => {} }),
  };
}

// entry.world.getPlayer(userId) -> the in-memory player whose `inv.items`
// mirror both movers keep in step with the DB.
function fakeEntry(userId, items = []) {
  const player = { inv: { items: items.map((i) => ({ ...i })) } };
  return { entry: { world: { getPlayer: (u) => (u === userId ? player : null) } }, player };
}

const USER = 1;
const OTHER_USER = 2;
const CHAR_A = 10;
const CHAR_B = 11;

// A stored item, in the shape the chest ACTUALLY holds one after SOMET-498:
// a container row plus the instance it holds, with the container's three
// columns mirroring the instance's.
function stored(id, { userId = USER, slot = 1, itemTypeId = 7, quantity = 1, soulbound = false } = {}) {
  return {
    accountItem: {
      id, userId, slot, itemTypeId, quantity, soulbound,
    },
    playerItem: {
      id: `held-${id}`, characterId: null, accountItemId: id, itemTypeId, quantity, soulbound,
    },
  };
}

// The holder of each instance, as a set of {id, holder} pairs. Asserting on
// this rather than on `playerItems.length` is what SOMET-498 forced: a
// deposited instance is no longer deleted, so a length check would pass for
// both "moved into the chest" and "left on the character".
function holders(db) {
  return db.state.playerItems.map((p) => ({
    id: p.id,
    // eslint-disable-next-line no-nested-ternary
    holder: p.characterId != null ? `char:${p.characterId}`
      : (p.accountItemId != null ? `chest:${p.accountItemId}` : 'NOBODY'),
  }));
}

// SOMET-502. The chest LISTING must describe the instance it is holding, not
// just the container's three columns -- renderBank had no grade to read and drew
// a stored foxy sword exactly like a white one. Both directions are pinned here:
// a held row is hydrated, and a row holding nothing keeps its exact pre-502
// five-key shape so a legacy row still renders as it always did.
test('SOMET-502: fetchChest lists the held instance\'s rarity, level and affix VALUES, and leaves an instance-less row alone', async () => {
  const EFFECT = { type: 'stat', stat: 'strength' };
  const db = fakeDb({
    accountItems: [
      { id: 'a1', userId: USER, slot: 1, itemTypeId: 7, quantity: 1, soulbound: false },
      { id: 'a2', userId: USER, slot: 2, itemTypeId: 8, quantity: 3, soulbound: true },
    ],
    playerItems: [
      { id: 'held-a1', characterId: null, accountItemId: 'a1', itemTypeId: 7, quantity: 1, rarity: 'foxy', itemLevel: 88 },
    ],
    affixes: [
      { playerItemId: 'held-a1', idx: 0, affixTypeId: 3, key: 'of_might', label: 'of Might', value: 3.13, effect: EFFECT },
    ],
  });

  const chest = await fetchChest(db, USER);
  assert.deepStrictEqual(chest.items[0], {
    id: 'a1', slot: 1, typeId: 7, quantity: 1, soulbound: false,
    rarity: 'foxy', itemLevel: 88,
    affixes: [{ affixTypeId: 3, key: 'of_might', label: 'of Might', value: 3.13, effect: EFFECT }],
  }, 'a held instance reaches the panel with its grade, its level and its rolled VALUES');
  assert.deepStrictEqual(chest.items[1], {
    id: 'a2', slot: 2, typeId: 8, quantity: 3, soulbound: true,
  }, 'a row holding nothing gains no keys at all -- the panel falls back to its own neutral');
});

test('an item deposited by one character is in the chest for another on the same account', async () => {
  const db = fakeDb({
    playerItems: [{ id: 'p1', characterId: CHAR_A, itemTypeId: 7, quantity: 1 }],
  });
  const { entry, player } = fakeEntry(USER, [{ id: 'p1', typeId: 7, quantity: 1 }]);

  const dep = await depositItem(db, entry, USER, CHAR_A, 'p1');
  assert.strictEqual(dep.ok, true, dep.reason);
  // SOMET-498: the instance is MOVED, not destroyed. The depositing character
  // no longer holds it -- but it still exists, held by the chest row, which is
  // the whole fix.
  assert.deepStrictEqual(holders(db), [{ id: 'p1', holder: `chest:${dep.stored.id}` }]);
  assert.deepStrictEqual(player.inv.items, []);

  // The OTHER character on the same account sees it: the chest is read by
  // user_id, and CHAR_B never touched it.
  const chest = await fetchChest(db, USER);
  assert.strictEqual(chest.items.length, 1);
  assert.strictEqual(chest.items[0].typeId, 7);
  assert.strictEqual(chest.capacity, CHEST_CAPACITY);

  const { entry: entryB, player: playerB } = fakeEntry(USER, []);
  const wd = await withdrawItem(db, entryB, USER, CHAR_B, chest.items[0].id);
  assert.strictEqual(wd.ok, true, wd.reason);
  assert.strictEqual(wd.item.typeId, 7);
  // It landed on CHAR_B, not back on CHAR_A -- and it is the SAME instance id
  // that went in, never a rebuilt copy.
  assert.strictEqual(wd.item.id, 'p1', 'the withdrawn item must be the very instance deposited');
  assert.deepStrictEqual(holders(db), [{ id: 'p1', holder: `char:${CHAR_B}` }]);
  assert.strictEqual(playerB.inv.items.length, 1);
  assert.deepStrictEqual((await fetchChest(db, USER)).items, []);
});

test('another account cannot see or withdraw a stored item', async () => {
  const s = stored('a1');
  const db = fakeDb({ accountItems: [s.accountItem], playerItems: [s.playerItem] });

  // The bank post is public; the chest is not. A second account reads its own.
  assert.deepStrictEqual((await fetchChest(db, OTHER_USER)).items, []);

  // ...and naming the row id directly changes nothing: the user_id predicate
  // is the authorization, not the listing.
  const { entry } = fakeEntry(OTHER_USER, []);
  const wd = await withdrawItem(db, entry, OTHER_USER, 99, 'a1');
  assert.strictEqual(wd.ok, false);
  assert.match(wd.reason, /not in your chest/);
  assert.strictEqual(db.state.accountItems.length, 1);
  // The refusal must not have cascaded the held instance away either.
  assert.deepStrictEqual(holders(db), [{ id: 'held-a1', holder: 'chest:a1' }]);
});

test('a character cannot deposit another character\'s item', async () => {
  const db = fakeDb({
    playerItems: [{ id: 'p1', characterId: CHAR_B, itemTypeId: 7, quantity: 1 }],
  });
  const { entry } = fakeEntry(USER, []);

  const r = await depositItem(db, entry, USER, CHAR_A, 'p1');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /do not own/);
  // Still CHAR_B's, and nothing was stored.
  assert.deepStrictEqual(holders(db), [{ id: 'p1', holder: `char:${CHAR_B}` }]);
  assert.strictEqual(db.state.accountItems.length, 0);
});

test('an equipped item is refused and stays equipped', async () => {
  const db = fakeDb({
    playerItems: [{ id: 'p1', characterId: CHAR_A, itemTypeId: 7, quantity: 1 }],
    equipment: [{ itemId: 'p1', characterId: CHAR_A, slot: 'main_hand' }],
  });
  const { entry, player } = fakeEntry(USER, [{ id: 'p1', typeId: 7, quantity: 1 }]);

  const r = await depositItem(db, entry, USER, CHAR_A, 'p1');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /unequip/);
  // SOMET-498 made this guard the ONLY thing holding the line. Pre-498 the
  // DELETE cascaded player_equipment away, so a missed case merely unequipped
  // the character silently; an UPDATE cascades nothing, so a missed case now
  // leaves a paper-doll row pointing at an item sitting in the chest. Assert
  // BOTH halves: the equipment row survived AND the item never moved.
  assert.strictEqual(db.state.equipment.length, 1);
  assert.deepStrictEqual(holders(db), [{ id: 'p1', holder: `char:${CHAR_A}` }]);
  assert.strictEqual(db.state.accountItems.length, 0);
  assert.deepStrictEqual(player.inv.items.map((i) => i.id), ['p1']);
});

// The equipment row is UNIQUE(item_id) and is not scoped to the depositing
// character in the guard any more (SOMET-498). A row naming this instance from
// anywhere must block: with the CASCADE gone there is nothing else to clean it
// up.
test('an item equipped under a different character id is still refused', async () => {
  const db = fakeDb({
    playerItems: [{ id: 'p1', characterId: CHAR_A, itemTypeId: 7, quantity: 1 }],
    equipment: [{ itemId: 'p1', characterId: CHAR_B, slot: 'main_hand' }],
  });
  const { entry } = fakeEntry(USER, [{ id: 'p1', typeId: 7, quantity: 1 }]);

  const r = await depositItem(db, entry, USER, CHAR_A, 'p1');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /unequip/);
  assert.deepStrictEqual(holders(db), [{ id: 'p1', holder: `char:${CHAR_A}` }]);
});

test('a stone is refused, so its instance row (and its XP) is never cascaded away', async () => {
  const db = fakeDb({
    playerItems: [{ id: 'p1', characterId: CHAR_A, itemTypeId: 30, quantity: 1 }],
    stones: [{ playerItemId: 'p1', socketedIntoId: null }],
  });
  const { entry } = fakeEntry(USER, [{ id: 'p1', typeId: 30, quantity: 1 }]);

  const r = await depositItem(db, entry, USER, CHAR_A, 'p1');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /stones cannot be stored/);
  assert.strictEqual(db.state.stones.length, 1);
  assert.deepStrictEqual(holders(db), [{ id: 'p1', holder: `char:${CHAR_A}` }]);
});

// THE GUARD SOMET-498 MADE LOAD-BEARING. Pre-498 the DELETE fired
// stone_instances.socketed_into_id's ON DELETE SET NULL and the stone simply
// popped out into the inventory -- untidy, not damage. An UPDATE fires no such
// thing, so without this refusal the stone stays socketed into a weapon in the
// chest while its own row still belongs to the character: loadInventory's
// socket join (which requires host_pi.character_id) stops seeing the socket, so
// the stone reads as loose while being unsocketable into anything else.
test('a weapon with a stone socketed into it is refused, and the socket is untouched', async () => {
  const db = fakeDb({
    playerItems: [
      { id: 'w1', characterId: CHAR_A, itemTypeId: 4, quantity: 1 },
      { id: 's1', characterId: CHAR_A, itemTypeId: 30, quantity: 1 },
    ],
    stones: [{ playerItemId: 's1', socketedIntoId: 'w1' }],
  });
  const { entry } = fakeEntry(USER, []);

  const r = await depositItem(db, entry, USER, CHAR_A, 'w1');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /unsocket/);
  assert.deepStrictEqual(holders(db), [
    { id: 'w1', holder: `char:${CHAR_A}` },
    { id: 's1', holder: `char:${CHAR_A}` },
  ]);
  assert.strictEqual(db.state.accountItems.length, 0);
  // The socket itself must still be intact: this refusal exists precisely
  // because nothing else would part them any more.
  assert.deepStrictEqual(db.state.stones, [{ playerItemId: 's1', socketedIntoId: 'w1' }]);
});

test('the chest fills to exactly CHEST_CAPACITY and the next deposit is refused intact', async () => {
  // One more item than the chest can hold.
  const playerItems = Array.from({ length: CHEST_CAPACITY + 1 }, (_, i) => ({
    id: `p${i}`, characterId: CHAR_A, itemTypeId: 7, quantity: 1,
  }));
  const db = fakeDb({ playerItems });
  const { entry, player } = fakeEntry(
    USER, playerItems.map((p) => ({ id: p.id, typeId: 7, quantity: 1 })),
  );

  for (let i = 0; i < CHEST_CAPACITY; i += 1) {
    const r = await depositItem(db, entry, USER, CHAR_A, `p${i}`);
    assert.strictEqual(r.ok, true, `deposit ${i} should succeed`);
  }
  assert.strictEqual(db.state.accountItems.length, CHEST_CAPACITY);

  const overflow = await depositItem(db, entry, USER, CHAR_A, `p${CHEST_CAPACITY}`);
  assert.strictEqual(overflow.ok, false);
  assert.match(overflow.reason, /full/);
  // THE POINT OF THIS TEST: the refusal happens after the container INSERT has
  // been attempted and inside an open transaction holding the instance's FOR
  // UPDATE lock, so it must ROLLBACK rather than return. The item must still be
  // carried by the character -- not held by a chest row, and not ownerless.
  const still = holders(db).filter((h) => h.holder === `char:${CHAR_A}`);
  assert.deepStrictEqual(still, [{ id: `p${CHEST_CAPACITY}`, holder: `char:${CHAR_A}` }]);
  assert.strictEqual(holders(db).filter((h) => h.holder === 'NOBODY').length, 0,
    'no instance may be left without a holder');
  assert.strictEqual(db.state.accountItems.length, CHEST_CAPACITY);
  assert.deepStrictEqual(player.inv.items.map((i) => i.id), [`p${CHEST_CAPACITY}`]);

  // Slots are 1..CHEST_CAPACITY with no duplicates and no gaps.
  const slots = db.state.accountItems.map((a) => a.slot).sort((a, b) => a - b);
  assert.deepStrictEqual(slots, Array.from({ length: CHEST_CAPACITY }, (_, i) => i + 1));
});

test('a withdrawal frees its slot and the next deposit reuses the lowest free one', async () => {
  const s1 = stored('a1', { slot: 1, itemTypeId: 5 });
  const s2 = stored('a2', { slot: 2, itemTypeId: 6 });
  const s3 = stored('a3', { slot: 3, itemTypeId: 8 });
  const db = fakeDb({
    playerItems: [
      { id: 'p1', characterId: CHAR_A, itemTypeId: 7, quantity: 1 },
      s1.playerItem, s2.playerItem, s3.playerItem,
    ],
    accountItems: [s1.accountItem, s2.accountItem, s3.accountItem],
  });
  const { entry } = fakeEntry(USER, [{ id: 'p1', typeId: 7, quantity: 1 }]);

  const wd = await withdrawItem(db, entry, USER, CHAR_A, 'a2');
  assert.strictEqual(wd.ok, true, wd.reason);

  const dep = await depositItem(db, entry, USER, CHAR_A, 'p1');
  assert.strictEqual(dep.ok, true, dep.reason);
  assert.strictEqual(dep.stored.slot, 2, 'the freed slot is the lowest free one');

  // fetchChest orders by slot, so the panel's rows stay put across the move
  // rather than reshuffling around the hole.
  const chest = await fetchChest(db, USER);
  assert.deepStrictEqual(chest.items.map((i) => i.slot), [1, 2, 3]);
});

// THE ORDERING TEST. `player_items.account_item_id` is ON DELETE CASCADE, so a
// withdrawItem that deleted the container before detaching the instance would
// destroy the item it was handing over -- inside a transaction that then
// COMMITs, with the player watching an empty hand. Reversing those two
// statements in the service turns this test red and nothing else does.
test('withdrawing must not cascade the instance away', async () => {
  const s = stored('a1', { itemTypeId: 42 });
  const db = fakeDb({ accountItems: [s.accountItem], playerItems: [s.playerItem] });
  const { entry, player } = fakeEntry(USER, []);

  const wd = await withdrawItem(db, entry, USER, CHAR_A, 'a1');
  assert.strictEqual(wd.ok, true, wd.reason);
  assert.strictEqual(wd.item.id, 'held-a1', 'the same instance must come back');
  assert.deepStrictEqual(holders(db), [{ id: 'held-a1', holder: `char:${CHAR_A}` }]);
  assert.deepStrictEqual(db.state.accountItems, []);
  assert.deepStrictEqual(player.inv.items.map((i) => i.id), ['held-a1']);
});

// A container row that holds no instance is unreachable after the
// 1714440513000 backfill, and withdrawItem REFUSES it rather than minting a
// fresh white item from item_type_id -- which is exactly the pre-498 bug. The
// container must survive the refusal so nothing is lost.
test('a chest row holding no instance is refused, not rebuilt from the type', async () => {
  const db = fakeDb({
    accountItems: [{
      id: 'a1', userId: USER, slot: 1, itemTypeId: 7, quantity: 1, soulbound: false,
    }],
  });
  const { entry, player } = fakeEntry(USER, []);

  const wd = await withdrawItem(db, entry, USER, CHAR_A, 'a1');
  assert.strictEqual(wd.ok, false, 'an instance-less chest row must not mint a replacement');
  assert.match(wd.reason, /cannot be withdrawn/);
  assert.strictEqual(db.state.accountItems.length, 1, 'and the container must survive the refusal');
  assert.deepStrictEqual(holders(db), []);
  assert.deepStrictEqual(player.inv.items, []);
});

test('soulbound survives the round trip, so a bound item cannot be laundered into a sellable one', async () => {
  const db = fakeDb({
    playerItems: [{ id: 'p1', characterId: CHAR_A, itemTypeId: 7, quantity: 1, soulbound: true }],
  });
  const { entry } = fakeEntry(USER, [{ id: 'p1', typeId: 7, quantity: 1 }]);

  const dep = await depositItem(db, entry, USER, CHAR_A, 'p1');
  assert.strictEqual(dep.ok, true, dep.reason);
  assert.strictEqual(dep.stored.soulbound, true);
  assert.strictEqual((await fetchChest(db, USER)).items[0].soulbound, true);

  const { entry: entryB } = fakeEntry(USER, []);
  const wd = await withdrawItem(db, entryB, USER, CHAR_B, dep.stored.id);
  assert.strictEqual(wd.ok, true, wd.reason);
  // SOMET-316: the flag must survive on the WIRE too, not only in the row.
  // Without this the withdrawn item loses its `bound` marker the instant it
  // lands back in the panel it was just taken from.
  assert.strictEqual(wd.item.soulbound, true);
  // The flag is what trade.js's sellItem reads to refuse the sale. If the
  // round trip cleared it, SOMET-277's gold faucet would reopen through the
  // chest: deposit the starter kit, withdraw it, sell it, delete the
  // character, repeat.
  assert.strictEqual(db.state.playerItems[0].soulbound, true);
});

test('a stacked row keeps its quantity across the round trip', async () => {
  const db = fakeDb({
    playerItems: [{ id: 'p1', characterId: CHAR_A, itemTypeId: 62, quantity: 24 }],
  });
  const { entry } = fakeEntry(USER, [{ id: 'p1', typeId: 62, quantity: 24 }]);

  const dep = await depositItem(db, entry, USER, CHAR_A, 'p1');
  assert.strictEqual(dep.ok, true, dep.reason);
  assert.strictEqual(dep.stored.quantity, 24);
  // An unbound item must come back unbound: the round trip preserves the flag,
  // it does not invent one.
  assert.strictEqual(dep.stored.soulbound, false);

  const wd = await withdrawItem(db, entry, USER, CHAR_A, dep.stored.id);
  assert.strictEqual(wd.ok, true, wd.reason);
  // SOMET-498: instance-held chest rows are NOT forced to quantity 1. The
  // chest holds the instance and the stack's quantity is a column ON that
  // instance, so a whole-row move preserves it by construction -- there is no
  // per-unit accounting to get wrong, which is why trade.js has to refuse a
  // stacked SALE and this does not.
  assert.strictEqual(wd.item.quantity, 24);
  assert.strictEqual(wd.item.id, 'p1', 'and it is the same stack row, not a rebuilt one');
});

// The live in-memory mirror is what equipRequirements#gearStatGrants reads on
// the equip path -- NOT the database. An item that is correct in Postgres and
// affix-less in p.inv.items is the "live in the schema, inert in play" shape
// this epic keeps shipping, so the mirror is asserted here as well as against a
// real database in account_chest_instance_db.test.js.
test('the withdrawn item carries its rolled identity into the LIVE inventory', async () => {
  const s = stored('a1', { itemTypeId: 7 });
  s.playerItem.rarity = 'foxy';
  s.playerItem.itemLevel = 88;
  const db = fakeDb({
    accountItems: [s.accountItem],
    playerItems: [s.playerItem],
    affixes: [
      {
        playerItemId: 'held-a1', idx: 0, affixTypeId: 3, key: 'might', label: 'Might', value: 3.13, effect: { str: 3.13 },
      },
      {
        playerItemId: 'held-a1', idx: 1, affixTypeId: 5, key: 'vigor', label: 'Vigor', value: 11.5, effect: { hp: 11.5 },
      },
    ],
  });
  const { entry, player } = fakeEntry(USER, []);

  const wd = await withdrawItem(db, entry, USER, CHAR_A, 'a1');
  assert.strictEqual(wd.ok, true, wd.reason);

  const live = player.inv.items.find((i) => i.id === 'held-a1');
  assert.ok(live, 'the withdrawn item must be pushed into the live inventory');
  assert.strictEqual(live.rarity, 'foxy');
  assert.strictEqual(live.itemLevel, 88);
  // BY VALUE, in order, with `effect` -- an id-only or zeroed list grants
  // nothing on the equip path while looking perfectly healthy in a count check.
  assert.deepStrictEqual(live.affixes, [
    {
      affixTypeId: 3, key: 'might', label: 'Might', value: 3.13, effect: { str: 3.13 },
    },
    {
      affixTypeId: 5, key: 'vigor', label: 'Vigor', value: 11.5, effect: { hp: 11.5 },
    },
  ]);
  // And the same object went out on the wire.
  assert.deepStrictEqual(wd.item, live);
});
