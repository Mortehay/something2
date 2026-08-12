// SOMET-155 (defect 1): the four legacy creatures (Wolf, Slime, Skeleton, Bat)
// must be paid the SAME gold as an identically-statted peer at the same rung.
//
// Gold scales by behaviour rung, not by hp. loot.js's spawnDrops uses the
// creature's own entity_types range whenever its max > 0 and only falls back to
// the rung otherwise, so a stale per-type range (derived from these creatures'
// pre-SOMET-250 hp) permanently outranks the rung and underpays them relative to
// the 288 P4 rows that carry no range of their own.
//
// This asserts the PAYOUT — the quantity spawnDrops actually inserts, rolled
// through the real loadCreatureTypes -> creatureGold/behaviorGold -> rollGold
// path — not the seed literals, and it compares each legacy creature against a
// real peer row from the generated P4 bestiary rather than against a constant
// copied out of the same seed file the code reads.
const test = require('node:test');
const assert = require('node:assert');
const { loadCreatureTypes } = require('../src/authority/creatures.js');
const { spawnDrops } = require('../src/authority/loot.js');
const { HOSTILE_CREATURES } = require('../seeds/data/entityTypes.js');
const { BESTIARY_P4_CREATURES } = require('../seeds/data/bestiaryP4.js');
const { CREATURE_BEHAVIORS } = require('../seeds/data/creatureBehaviors.js');

const LEGACY_NAMES = ['Wolf', 'Slime', 'Skeleton', 'Bat'];
// The peer: a generated P4 creature on the SAME rung with the SAME hp/defense,
// carrying no gold range of its own (the posture the legacy four should share).
const PEER_NAME = 'Beast Line';
const GOLD_TYPE_ID = 777;

const seedRow = (name) => HOSTILE_CREATURES.find((c) => c.name === name)
  || BESTIARY_P4_CREATURES.find((c) => c.name === name);

const rung = (name) => CREATURE_BEHAVIORS.find((b) => b.name === name);

// Shaped exactly like one row of loadCreatureTypes' own
// `entity_types e LEFT JOIN creature_behaviors b` SELECT, filled from the real
// seed rows: the creature's own gold_min/gold_max, and its rung's aliased
// behavior_gold_min/behavior_gold_max.
function loaderRowFor(seed, id) {
  const b = rung(seed.behavior_name);
  assert.ok(b, `seed row ${seed.name} names a rung that does not exist: ${seed.behavior_name}`);
  return {
    id,
    name: seed.name,
    color: seed.color,
    hp: seed.hp,
    defense: seed.defense,
    resistances: seed.resistances || {},
    faction: 'hostile',
    gold_min: seed.gold_min ?? 0,
    gold_max: seed.gold_max ?? 0,
    attack_element: 'physical',
    behavior_id: 9000 + id,
    behavior_name: b.name,
    aggro_radius: b.aggro_radius,
    leash_radius: b.leash_radius,
    chase_style: b.chase_style,
    preferred_range: b.preferred_range,
    move_speed_mult: b.move_speed_mult,
    damage_override: null,
    aura_radius: b.aura_radius ?? 0,
    aura_damage_mult: b.aura_damage_mult ?? 1,
    aura_defense_mult: b.aura_defense_mult ?? 1,
    aura_speed_mult: b.aura_speed_mult ?? 1,
    behavior_gold_min: b.gold_min ?? 0,
    behavior_gold_max: b.gold_max ?? 0,
    abilities: [],
  };
}

function lootPool(typeRows) {
  let n = 0;
  return {
    query: async (sql, params) => {
      if (/FROM entity_types e/i.test(sql)) return { rows: typeRows };
      if (/FROM creature_drops WHERE entity_type_id/i.test(sql)) return { rows: [] };
      if (/FROM behavior_drops WHERE behavior_id/i.test(sql)) return { rows: [] };
      if (/INSERT INTO world_items/i.test(sql)) {
        const [, itemTypeId, x, y, , quantity] = params;
        return { rows: [{ id: `zz-${++n}`, item_type_id: itemTypeId, x, y, expires_at: null, quantity }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

// Kills one creature and returns the gold quantity actually placed on the
// ground (0 when no coin pile was spawned at all).
async function goldPayout(entry, pool, name, rng) {
  const added = [];
  const e = { ...entry, world: { groundItems: { add: (rows) => added.push(...rows) } } };
  await spawnDrops(pool, e, { type: name, x: 0, y: 0 }, { rng });
  const piles = added.filter((r) => r.item_type_id === GOLD_TYPE_ID);
  assert.ok(piles.length <= 1, `${name} spawned ${piles.length} coin piles; exactly one (or none) is the contract`);
  return piles.length ? Number(piles[0].quantity) : 0;
}

test('the four legacy creatures pay their rung, matching an identically-statted P4 peer', async () => {
  const names = [...LEGACY_NAMES, PEER_NAME];
  const rows = names.map((n, i) => {
    const seed = seedRow(n);
    assert.ok(seed, `${n} is missing from the creature seed data`);
    return loaderRowFor(seed, 100 + i);
  });
  const pool = lootPool(rows);
  const {
    creatureTypeIds, creatureGold, behaviorGold, behaviorDrops,
  } = await loadCreatureTypes(pool);
  const entry = {
    worldId: 'w-test',
    goldItemTypeId: GOLD_TYPE_ID,
    creatureTypeIds,
    creatureGold,
    behaviorGold,
    behaviorDrops,
  };

  // Premise, asserted rather than assumed: the peer really is on the same rung
  // with the same stats, and that rung really does pay something. Without these
  // the equality below could pass vacuously (0 === 0) if the rung's own range
  // were ever zeroed.
  const peerSeed = seedRow(PEER_NAME);
  for (const n of LEGACY_NAMES) {
    const s = seedRow(n);
    assert.equal(s.behavior_name, peerSeed.behavior_name, `${n} is no longer on the peer's rung`);
    assert.equal(s.hp, peerSeed.hp, `${n} no longer shares the peer's hp`);
    assert.equal(s.defense, peerSeed.defense, `${n} no longer shares the peer's defense`);
  }

  const peerTop = await goldPayout(entry, pool, PEER_NAME, () => 0.999999);
  const peerBottom = await goldPayout(entry, pool, PEER_NAME, () => 0);
  assert.ok(peerTop > 0, 'the peer pays no gold at all — this rung has no range, so the comparison below proves nothing');

  for (const n of LEGACY_NAMES) {
    const top = await goldPayout(entry, pool, n, () => 0.999999);
    const bottom = await goldPayout(entry, pool, n, () => 0);
    assert.equal(top, peerTop,
      `${n}'s best roll is ${top} but its identically-statted peer ${PEER_NAME} rolls ${peerTop}: `
      + 'a stale per-type gold range is outranking the rung (loot.js spawnDrops prefers typeRange when its max > 0)');
    assert.equal(bottom, peerBottom, `${n}'s worst roll (${bottom}) differs from the peer's (${peerBottom})`);
    assert.ok(top > 0, `${n} pays no gold at all — zeroing its type range must make it INHERIT the rung, not lose gold`);
  }
});

// The other half of the fix: the seed rows themselves must carry no range of
// their own, or a FRESH database is reseeded straight back into the defect
// (scripts/seed-catalogs.js inserts entity_types with ON CONFLICT DO NOTHING,
// so the migration cannot help a database seeded from scratch afterwards).
test('the legacy seed rows carry no gold range of their own, so a fresh DB inherits the rung too', () => {
  for (const n of LEGACY_NAMES) {
    const s = seedRow(n);
    assert.equal(s.gold_max ?? 0, 0,
      `${n} still seeds gold_max=${s.gold_max}; spawnDrops prefers any type range with max > 0 over the rung`);
    assert.equal(s.gold_min ?? 0, 0, `${n} still seeds gold_min=${s.gold_min}`);
    assert.ok(rung(s.behavior_name) && (rung(s.behavior_name).gold_max ?? 0) > 0,
      `${n} has no rung range to inherit — zeroing it would remove its gold entirely`);
  }
});

// Live-database leg: proves the MIGRATION (1714440172000) actually landed, and
// that the live rows resolve to a paying rung. Read-only — no catalog row is
// written by this test.
const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
test('live entity_types rows for the legacy four are zeroed and resolve to a paying rung',
  { skip: !url ? 'no database URL — the LIVE gold rows are UNVERIFIED' : false }, async (t) => {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: url });
    try {
      const r = await pool.query(
        `SELECT e.name, e.gold_min, e.gold_max, b.name AS rung,
                b.gold_min AS rung_min, b.gold_max AS rung_max
           FROM entity_types e LEFT JOIN creature_behaviors b ON b.id = e.behavior_id
          WHERE e.name = ANY($1)`,
        [LEGACY_NAMES],
      );
      assert.equal(r.rowCount, LEGACY_NAMES.length, 'not every legacy creature exists in the live catalog');
      for (const row of r.rows) {
        assert.equal(Number(row.gold_max), 0,
          `${row.name} still carries gold_max=${row.gold_max} in the live catalog — the migration did not run`);
        assert.equal(Number(row.gold_min), 0, `${row.name} still carries gold_min=${row.gold_min}`);
        assert.ok(Number(row.rung_max) > 0,
          `${row.name}'s rung (${row.rung}) pays nothing, so zeroing its own range left it with no gold at all`);
      }
    } catch (err) {
      if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(String(err && err.message))) {
        t.skip(`NO DATABASE at ${url} — the LIVE gold rows are UNVERIFIED`);
        return;
      }
      throw err;
    } finally {
      await pool.end();
    }
  });
