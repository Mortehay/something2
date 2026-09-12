const test = require('node:test');
const assert = require('node:assert');
const { fetchVillages } = require('../src/services/villages');

test('fetchVillages maps snake_case columns to camelCase', async () => {
  const pool = {
    query: async (sql, params) => {
      // SOMET-582 added the four *_art joins; the query is now
      // "FROM villages v ... WHERE v.world_id = $1".
      assert.match(sql, /FROM villages v[\s\S]*WHERE v\.world_id = \$1/i);
      assert.deepEqual(params, ['w1']);
      return { rows: [{
        id: 'v1', min_row: 5, min_col: 6, width: 8, height: 6,
        gate_edge: 'S', spawn_x: 650, spawn_y: 550,
        merchant_x: 950, merchant_y: 850,
      }] };
    },
  };
  const out = await fetchVillages(pool, 'w1');
  // SOMET-310 added bankX/bankY. They are DERIVED here rather than selected,
  // so they belong in this exhaustive comparison: an accidental extra field on
  // the join payload should fail this test, which is the reason it deepEquals
  // the whole object instead of picking keys.
  //
  // Gate S offsets the bank one column off the merchant: merchant (950,850) is
  // tile (row 8, col 9), so the bank takes col 10 -> x 1050, same row.
  assert.deepEqual(out, [{
    id: 'v1', minRow: 5, minCol: 6, width: 8, height: 6,
    gateEdge: 'S', spawnX: 650, spawnY: 550,
    merchantX: 950, merchantY: 850,
    bankX: 1050, bankY: 850,
    gemMerchantX: 850, gemMerchantY: 850,
    skillMerchantX: 1750, skillMerchantY: 650,
    // SOMET-582: no *_art column in this fixture's row, so all four default
    // to null -- this exhaustive comparison is exactly where a silently
    // added/dropped join column would be caught.
    merchantArt: null, bankArt: null, gemMerchantArt: null, skillMerchantArt: null,
  }]);
});

test('fetchVillages maps null merchant columns to null', async () => {
  const pool = {
    query: async () => ({ rows: [{
      id: 'v2', min_row: 1, min_col: 1, width: 3, height: 3,
      gate_edge: 'N', spawn_x: 150, spawn_y: 150,
      merchant_x: null, merchant_y: null,
    }] }),
  };
  const out = await fetchVillages(pool, 'w1');
  assert.equal(out[0].merchantX, null);
  assert.equal(out[0].merchantY, null);
  // A village with no stored merchant still gets a bank: the post falls back to
  // the derived merchant position rather than going null, so the chest is never
  // missing just because the merchant column was never written.
  //
  // This is also the documented 3x3 degenerate case -- the interior is the
  // single tile (row 2, col 2), so the offset clamps back onto it and the bank
  // shares the merchant's tile instead of landing on the impassable wall ring.
  assert.equal(out[0].bankX, 250);
  assert.equal(out[0].bankY, 250);
  assert.equal(out[0].skillMerchantX, 750);
  assert.equal(out[0].skillMerchantY, 250);
});

// The bank must sit inside the walkable interior of EVERY legal village, on
// every gate edge. The wall ring is impassable, so a post on it is a chest no
// player can ever reach -- the same class of bug SOMET-153 filed for village
// spawns landing inside walls.
test('the bank post lands on an interior tile for every legal village shape', () => {
  const { VILLAGE_LIMITS } = require('../src/services/villages');
  const { villageBankPost, villageMerchantPost } = require('../src/services/mapService');

  for (let width = VILLAGE_LIMITS.minW; width <= VILLAGE_LIMITS.maxW; width += 1) {
    for (let height = VILLAGE_LIMITS.minH; height <= VILLAGE_LIMITS.maxH; height += 1) {
      if (width + height > VILLAGE_LIMITS.maxSum) continue;
      for (const gateEdge of ['N', 'S', 'E', 'W']) {
        const v = { minRow: 4, minCol: 7, width, height, gateEdge };
        const bank = villageBankPost(v, villageMerchantPost(v));
        const row = Math.floor(bank.y / 100);
        const col = Math.floor(bank.x / 100);
        const label = `${width}x${height} gate ${gateEdge}`;
        assert.ok(row >= v.minRow + 1 && row <= v.minRow + height - 2,
          `${label}: bank row ${row} is outside the interior`);
        assert.ok(col >= v.minCol + 1 && col <= v.minCol + width - 2,
          `${label}: bank col ${col} is outside the interior`);
      }
    }
  }
});

// A village big enough to have room for both must not stack them: two markers
// on one tile is legible only in the 1x1-interior case the header calls out.
test('the bank does not share the merchant tile when the interior has room', () => {
  const { villageBankPost, villageMerchantPost } = require('../src/services/mapService');

  for (const gateEdge of ['N', 'S', 'E', 'W']) {
    const v = { minRow: 0, minCol: 0, width: 5, height: 5, gateEdge };
    const merchant = villageMerchantPost(v);
    const bank = villageBankPost(v, merchant);
    assert.notDeepEqual(bank, merchant, `gate ${gateEdge}: bank stacked on the merchant`);
  }
});

test('the skill merchant sits inside the skill house and never stacks on bank or merchant', () => {
  const { villageBankPost, villageMerchantPost, villageSkillMerchantPost, villageSkillHouse } = require('../src/services/mapService');

  for (const gateEdge of ['N', 'S', 'E', 'W']) {
    const v = { minRow: 10, minCol: 10, width: 6, height: 4, gateEdge };
    const merchant = villageMerchantPost(v);
    const bank = villageBankPost(v, merchant);
    const skill = villageSkillMerchantPost(v);
    const house = villageSkillHouse(v);

    assert.notDeepEqual(skill, merchant, `gate ${gateEdge}: skill stacked on merchant`);
    assert.notDeepEqual(skill, bank, `gate ${gateEdge}: skill stacked on bank`);

    const sRow = Math.floor(skill.y / 100);
    const sCol = Math.floor(skill.x / 100);
    assert.ok(sRow >= house.minRow + 1 && sRow <= house.minRow + house.height - 2, 'skill inside house row');
    assert.ok(sCol >= house.minCol + 1 && sCol <= house.minCol + house.width - 2, 'skill inside house col');
  }
});
