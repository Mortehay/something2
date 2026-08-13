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
function fakeDb(seed = {}) {
  const state = {
    playerItems: seed.playerItems ? seed.playerItems.map((r) => ({ ...r })) : [],
    accountItems: seed.accountItems ? seed.accountItems.map((r) => ({ ...r })) : [],
    equipment: seed.equipment ? seed.equipment.map((r) => ({ ...r })) : [],
    // { playerItemId, socketedIntoId } -- one row per stone instance, exactly
    // as stone_instances stores it.
    stones: seed.stones ? seed.stones.map((r) => ({ ...r })) : [],
  };
  let snapshot = null;
  let nextId = 1000;

  const snap = () => JSON.parse(JSON.stringify(state));
  const restore = (s) => {
    state.playerItems = s.playerItems;
    state.accountItems = s.accountItems;
    state.equipment = s.equipment;
    state.stones = s.stones;
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

    if (/SELECT 1 FROM player_equipment/.test(s)) {
      const [itemId, characterId] = params;
      const hit = state.equipment.filter(
        (e) => e.itemId === itemId && e.characterId === characterId,
      );
      return { rows: hit.map(() => ({ '?column?': 1 })), rowCount: hit.length };
    }

    // The item IS a stone: joined through player_items on character_id, so an
    // id the caller does not own must not match even if it is a real stone.
    if (/FROM stone_instances si JOIN player_items pi/.test(s)) {
      const [itemId, characterId] = params;
      const hit = state.stones.filter((st) => st.playerItemId === itemId
        && state.playerItems.some((p) => p.id === itemId && p.characterId === characterId));
      return { rows: hit.map(() => ({})), rowCount: hit.length };
    }

    // The item HOSTS a stone.
    if (/FROM stone_instances si JOIN player_items host/.test(s)) {
      const [itemId, characterId] = params;
      const hit = state.stones.filter((st) => st.socketedIntoId === itemId
        && state.playerItems.some((p) => p.id === itemId && p.characterId === characterId));
      return { rows: hit.map(() => ({})), rowCount: hit.length };
    }

    if (/DELETE FROM player_items WHERE id = \$1 AND character_id = \$2/.test(s)) {
      const [itemId, characterId] = params;
      const idx = state.playerItems.findIndex(
        (p) => p.id === itemId && p.characterId === characterId,
      );
      if (idx === -1) return { rows: [], rowCount: 0 };
      const [row] = state.playerItems.splice(idx, 1);
      return {
        rows: [{
          item_type_id: row.itemTypeId, quantity: row.quantity ?? 1, soulbound: !!row.soulbound,
        }],
        rowCount: 1,
      };
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

    if (/DELETE FROM account_items WHERE id = \$1 AND user_id = \$2/.test(s)) {
      const [accountItemId, userId] = params;
      const idx = state.accountItems.findIndex(
        (a) => a.id === accountItemId && a.userId === userId,
      );
      if (idx === -1) return { rows: [], rowCount: 0 };
      const [row] = state.accountItems.splice(idx, 1);
      return {
        rows: [{
          item_type_id: row.itemTypeId, quantity: row.quantity ?? 1, soulbound: !!row.soulbound,
        }],
        rowCount: 1,
      };
    }

    if (/INSERT INTO player_items/.test(s)) {
      const [characterId, itemTypeId, quantity, soulbound] = params;
      const row = {
        id: `p${nextId += 1}`, characterId, itemTypeId, quantity, soulbound: !!soulbound,
      };
      state.playerItems.push(row);
      return {
        rows: [{ id: row.id, item_type_id: row.itemTypeId, quantity: row.quantity }],
        rowCount: 1,
      };
    }

    if (/FROM account_items WHERE user_id = \$1/.test(s)) {
      const [userId] = params;
      const rows = state.accountItems
        .filter((a) => a.userId === userId)
        .sort((a, b) => a.slot - b.slot)
        .map((a) => ({
          id: a.id,
          slot: a.slot,
          item_type_id: a.itemTypeId,
          quantity: a.quantity,
          soulbound: a.soulbound,
        }));
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

test('an item deposited by one character is in the chest for another on the same account', async () => {
  const db = fakeDb({
    playerItems: [{ id: 'p1', characterId: CHAR_A, itemTypeId: 7, quantity: 1 }],
  });
  const { entry, player } = fakeEntry(USER, [{ id: 'p1', typeId: 7, quantity: 1 }]);

  const dep = await depositItem(db, entry, USER, CHAR_A, 'p1');
  assert.equal(dep.ok, true);
  // The depositing character no longer holds it, in the DB and in the mirror.
  assert.equal(db.state.playerItems.length, 0);
  assert.deepEqual(player.inv.items, []);

  // The OTHER character on the same account sees it: the chest is read by
  // user_id, and CHAR_B never touched it.
  const chest = await fetchChest(db, USER);
  assert.equal(chest.items.length, 1);
  assert.equal(chest.items[0].typeId, 7);
  assert.equal(chest.capacity, CHEST_CAPACITY);

  const { entry: entryB, player: playerB } = fakeEntry(USER, []);
  const wd = await withdrawItem(db, entryB, USER, CHAR_B, chest.items[0].id);
  assert.equal(wd.ok, true);
  assert.equal(wd.item.typeId, 7);
  // It landed on CHAR_B, not back on CHAR_A.
  assert.equal(db.state.playerItems.length, 1);
  assert.equal(db.state.playerItems[0].characterId, CHAR_B);
  assert.equal(playerB.inv.items.length, 1);
  assert.equal((await fetchChest(db, USER)).items.length, 0);
});

test('another account cannot see or withdraw a stored item', async () => {
  const db = fakeDb({
    accountItems: [{ id: 'a1', userId: USER, slot: 1, itemTypeId: 7, quantity: 1 }],
  });

  // The bank post is public; the chest is not. A second account reads its own.
  assert.deepEqual((await fetchChest(db, OTHER_USER)).items, []);

  // ...and naming the row id directly changes nothing: the user_id predicate
  // is the authorization, not the listing.
  const { entry } = fakeEntry(OTHER_USER, []);
  const wd = await withdrawItem(db, entry, OTHER_USER, 99, 'a1');
  assert.equal(wd.ok, false);
  assert.match(wd.reason, /not in your chest/);
  assert.equal(db.state.accountItems.length, 1);
  assert.equal(db.state.playerItems.length, 0);
});

test('a character cannot deposit another character\'s item', async () => {
  const db = fakeDb({
    playerItems: [{ id: 'p1', characterId: CHAR_B, itemTypeId: 7, quantity: 1 }],
  });
  const { entry } = fakeEntry(USER, []);

  const r = await depositItem(db, entry, USER, CHAR_A, 'p1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /do not own/);
  // Still CHAR_B's, and nothing was stored.
  assert.equal(db.state.playerItems.length, 1);
  assert.equal(db.state.playerItems[0].characterId, CHAR_B);
  assert.equal(db.state.accountItems.length, 0);
});

test('an equipped item is refused and stays equipped', async () => {
  const db = fakeDb({
    playerItems: [{ id: 'p1', characterId: CHAR_A, itemTypeId: 7, quantity: 1 }],
    equipment: [{ itemId: 'p1', characterId: CHAR_A, slot: 'main_hand' }],
  });
  const { entry, player } = fakeEntry(USER, [{ id: 'p1', typeId: 7, quantity: 1 }]);

  const r = await depositItem(db, entry, USER, CHAR_A, 'p1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /unequip/);
  // player_equipment.item_id CASCADEs on a player_items delete, so the real
  // failure this guards is a silent unequip: assert the row survived.
  assert.equal(db.state.equipment.length, 1);
  assert.equal(db.state.playerItems.length, 1);
  assert.deepEqual(player.inv.items.map((i) => i.id), ['p1']);
});

test('a stone is refused, so its instance row (and its XP) is never cascaded away', async () => {
  const db = fakeDb({
    playerItems: [{ id: 'p1', characterId: CHAR_A, itemTypeId: 30, quantity: 1 }],
    stones: [{ playerItemId: 'p1', socketedIntoId: null }],
  });
  const { entry } = fakeEntry(USER, [{ id: 'p1', typeId: 30, quantity: 1 }]);

  const r = await depositItem(db, entry, USER, CHAR_A, 'p1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /stones cannot be stored/);
  assert.equal(db.state.stones.length, 1);
  assert.equal(db.state.playerItems.length, 1);
});

test('a weapon with a stone socketed into it is refused', async () => {
  const db = fakeDb({
    playerItems: [
      { id: 'w1', characterId: CHAR_A, itemTypeId: 4, quantity: 1 },
      { id: 's1', characterId: CHAR_A, itemTypeId: 30, quantity: 1 },
    ],
    stones: [{ playerItemId: 's1', socketedIntoId: 'w1' }],
  });
  const { entry } = fakeEntry(USER, []);

  const r = await depositItem(db, entry, USER, CHAR_A, 'w1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /unsocket/);
  assert.equal(db.state.playerItems.length, 2);
  assert.equal(db.state.accountItems.length, 0);
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
    assert.equal(r.ok, true, `deposit ${i} should succeed`);
  }
  assert.equal(db.state.accountItems.length, CHEST_CAPACITY);

  const overflow = await depositItem(db, entry, USER, CHAR_A, `p${CHEST_CAPACITY}`);
  assert.equal(overflow.ok, false);
  assert.match(overflow.reason, /full/);
  // THE POINT OF THIS TEST: the refusal happens AFTER the DELETE, so without
  // the ROLLBACK the item would be gone from the character and absent from the
  // chest -- destroyed by a capacity check. It must still be carried.
  assert.equal(db.state.playerItems.length, 1);
  assert.equal(db.state.playerItems[0].id, `p${CHEST_CAPACITY}`);
  assert.equal(db.state.accountItems.length, CHEST_CAPACITY);
  assert.deepEqual(player.inv.items.map((i) => i.id), [`p${CHEST_CAPACITY}`]);

  // Slots are 1..CHEST_CAPACITY with no duplicates and no gaps.
  const slots = db.state.accountItems.map((a) => a.slot).sort((a, b) => a - b);
  assert.deepEqual(slots, Array.from({ length: CHEST_CAPACITY }, (_, i) => i + 1));
});

test('a withdrawal frees its slot and the next deposit reuses the lowest free one', async () => {
  const db = fakeDb({
    playerItems: [{ id: 'p1', characterId: CHAR_A, itemTypeId: 7, quantity: 1 }],
    accountItems: [
      { id: 'a1', userId: USER, slot: 1, itemTypeId: 5, quantity: 1 },
      { id: 'a2', userId: USER, slot: 2, itemTypeId: 6, quantity: 1 },
      { id: 'a3', userId: USER, slot: 3, itemTypeId: 8, quantity: 1 },
    ],
  });
  const { entry } = fakeEntry(USER, [{ id: 'p1', typeId: 7, quantity: 1 }]);

  const wd = await withdrawItem(db, entry, USER, CHAR_A, 'a2');
  assert.equal(wd.ok, true);

  const dep = await depositItem(db, entry, USER, CHAR_A, 'p1');
  assert.equal(dep.ok, true);
  assert.equal(dep.stored.slot, 2, 'the freed slot is the lowest free one');

  // fetchChest orders by slot, so the panel's rows stay put across the move
  // rather than reshuffling around the hole.
  const chest = await fetchChest(db, USER);
  assert.deepEqual(chest.items.map((i) => i.slot), [1, 2, 3]);
});

test('soulbound survives the round trip, so a bound item cannot be laundered into a sellable one', async () => {
  const db = fakeDb({
    playerItems: [{ id: 'p1', characterId: CHAR_A, itemTypeId: 7, quantity: 1, soulbound: true }],
  });
  const { entry } = fakeEntry(USER, [{ id: 'p1', typeId: 7, quantity: 1 }]);

  const dep = await depositItem(db, entry, USER, CHAR_A, 'p1');
  assert.equal(dep.ok, true);
  assert.equal(dep.stored.soulbound, true);
  assert.equal((await fetchChest(db, USER)).items[0].soulbound, true);

  const { entry: entryB } = fakeEntry(USER, []);
  const wd = await withdrawItem(db, entryB, USER, CHAR_B, dep.stored.id);
  assert.equal(wd.ok, true);
  // The flag is what trade.js's sellItem reads to refuse the sale. If the
  // round trip cleared it, SOMET-277's gold faucet would reopen through the
  // chest: deposit the starter kit, withdraw it, sell it, delete the
  // character, repeat.
  assert.equal(db.state.playerItems[0].soulbound, true);
});

test('a stacked row keeps its quantity across the round trip', async () => {
  const db = fakeDb({
    playerItems: [{ id: 'p1', characterId: CHAR_A, itemTypeId: 62, quantity: 24 }],
  });
  const { entry } = fakeEntry(USER, [{ id: 'p1', typeId: 62, quantity: 24 }]);

  const dep = await depositItem(db, entry, USER, CHAR_A, 'p1');
  assert.equal(dep.ok, true);
  assert.equal(dep.stored.quantity, 24);

  const wd = await withdrawItem(db, entry, USER, CHAR_A, dep.stored.id);
  assert.equal(wd.ok, true);
  // trade.js refuses to SELL a stack because it would pay for one unit and
  // delete the row; a transfer moves the row whole, so there is nothing to
  // refuse and nothing to lose.
  assert.equal(wd.item.quantity, 24);
});
