const test = require('node:test');
const assert = require('node:assert');
const g = require('../src/services/bossGate.js');

const spireBoss = { name: 'Spire of Trials: Floor 5', dungeon_boss: { entity: 'Ossuary Warden' } };

test('only a Spire floor that carries a boss is gated', () => {
  assert.ok(g.isGatedWorld(spireBoss));
  assert.ok(!g.isGatedWorld({ name: 'Spire of Trials: Floor 6', dungeon_boss: null }));
  assert.ok(!g.isGatedWorld({ name: 'The Catacombs: End', dungeon_boss: { entity: 'x' } }));
  assert.ok(!g.isGatedWorld(null));
});

test('the east door of a boss floor is shut until the boss is cleared', () => {
  const base = { gated: true, worldId: 'w5', toWorldId: 'w6', forwardTo: 'w6' };
  assert.strictEqual(g.mayPass({ ...base, cleared: new Set() }), false);
  assert.strictEqual(g.mayPass({ ...base, cleared: undefined }), false, 'fails closed before the set loads');
  assert.strictEqual(g.mayPass({ ...base, cleared: new Set(['w4']) }), false, 'another floor does not count');
  assert.strictEqual(g.mayPass({ ...base, cleared: new Set(['w5']) }), true);
});

test('the way back and non-gated floors are never blocked; admins pass', () => {
  assert.strictEqual(g.mayPass({ gated: true, worldId: 'w5', toWorldId: 'w4', forwardTo: 'w6', cleared: new Set() }), true);
  assert.strictEqual(g.mayPass({ gated: false, worldId: 'w4', toWorldId: 'w5', forwardTo: 'w5', cleared: new Set() }), true);
  assert.strictEqual(g.mayPass({ gated: true, worldId: 'w5', toWorldId: 'w6', forwardTo: 'w6', cleared: new Set(), isAdmin: true }), true);
});

test('credit goes to the killer and to players close to the boss, not to far-away ones', () => {
  const mk = (userId, x, y) => ({ userId, characterId: userId * 10, x, y, width: 0, height: 0 });
  const players = [mk(1, 0, 0), mk(2, 500, 0), mk(3, 9000, 0)];
  const got = g.clearBeneficiaries(players, 1, 100, 0).map((p) => p.userId);
  assert.deepStrictEqual(got, [1, 2]);
  assert.deepStrictEqual(g.clearBeneficiaries(players, 3, 100, 0).map((p) => p.userId), [1, 2, 3], 'the killer is always credited');
});

test('recording is idempotent and loading returns the world ids', async () => {
  const rows = new Map();
  const pool = {
    query: async (sql, params) => {
      if (/INSERT INTO character_boss_clears/.test(sql)) { rows.set(`${params[0]}:${params[1]}`, params[1]); return { rowCount: 1 }; }
      if (/SELECT world_id FROM character_boss_clears/.test(sql)) {
        return { rows: [...rows.entries()].filter(([k]) => k.startsWith(`${params[0]}:`)).map(([, w]) => ({ world_id: w })) };
      }
      throw new Error(sql);
    },
  };
  await g.recordBossClear(pool, 7, 'w5');
  await g.recordBossClear(pool, 7, 'w5');
  assert.deepStrictEqual([...await g.loadClearedBosses(pool, 7)], ['w5']);
  assert.strictEqual((await g.loadClearedBosses(pool, 8)).size, 0);
});
