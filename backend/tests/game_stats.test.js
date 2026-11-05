// SOMET-720. The statistics' rules with no database: a fake pool records what would be written.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGameStats, BATCH_SIZE, RESUME_MS } = require('../src/authority/gameStats.js');

function rig({ fail = false } = {}) {
  let t = 1_000_000;
  const writes = [];
  const state = { fail };
  const pool = {
    query: async (sql, params) => {
      if (/INSERT INTO/.test(sql)) {
        if (state.fail) throw new Error('db went away');
        const [ids, mob, pvp, deaths, boss, play, sessions] = params;
        writes.push(ids.map((id, i) => ({
          id, mob: mob[i], pvp: pvp[i], deaths: deaths[i], boss: boss[i], play: play[i], sessions: sessions[i],
        })));
      }
      return { rows: state.rows || [] };
    },
  };
  const errors = [];
  const stats = createGameStats({ pool, now: () => t, log: { error: (m) => errors.push(m) } });
  return { stats, writes, errors, state, advance: (ms) => { t += ms; } };
}
const owner = () => ({});

test('a character who left is not written again', async () => {
  const r = rig();
  const ws = owner();
  r.stats.join(7, ws);
  r.advance(400); // under a second, the case that used to stay pending forever
  r.stats.leave(7, ws);
  assert.equal(await r.stats.flush(), true);
  assert.equal(r.writes.length, 1, 'the session itself is written once');
  assert.equal(r.writes[0][0].sessions, 1);
  assert.equal(r.stats.pendingCount(), 0);
  r.advance(1000);
  await r.stats.flush();
  r.advance(RESUME_MS + 1);
  await r.stats.flush();
  assert.equal(r.writes.length, 1, 'nothing more, so last_seen_at stays when they left');
  assert.equal(r.stats.pendingCount(), 0);
  assert.equal(r.stats.session(7), null, 'and the session is gone');
});

test('nothing to say writes nothing', async () => {
  const r = rig();
  await r.stats.flush();
  assert.equal(r.writes.length, 0);
});

test('a resumed join inside a second is not a row', async () => {
  const r = rig();
  const a = owner(); const b = owner();
  r.stats.join(7, a);
  await r.stats.flush();
  r.writes.length = 0;
  r.stats.leave(7, a);
  r.stats.join(7, b);
  await r.stats.flush();
  assert.equal(r.writes.length, 0);
  assert.equal(r.stats.pendingCount(), 0);
});

test('play time adds up across flushes: a part of a second is carried, not lost or repeated', async () => {
  const r = rig();
  const ws = owner();
  r.stats.join(7, ws);
  for (let i = 0; i < 4; i += 1) {
    r.advance(600);
    await r.stats.flush();
  }
  const total = r.writes.flat().reduce((n, w) => n + w.play, 0);
  assert.equal(total, 2, '2.4 s so far, written as 2 whole seconds');
  r.advance(600);
  await r.stats.flush();
  assert.equal(r.writes.flat().reduce((n, w) => n + w.play, 0), 3, '3.0 s');
  assert.equal(r.stats.session(7).online, true);
});

test('a kill counts for session, table and process total; a boss kill also as a boss', async () => {
  const r = rig();
  r.stats.join(7, owner());
  r.stats.recordKill(7);
  r.stats.recordKill(7, { boss: true });
  r.stats.recordKill(null); // no known killer
  const s = r.stats.session(7);
  assert.equal(s.mobKills, 2);
  assert.equal(s.bossKills, 1);
  assert.deepEqual(r.stats.totals(), { mobKills: 2, pvpKills: 0 });
  await r.stats.flush();
  assert.deepEqual(r.writes[0][0], { id: 7, mob: 2, pvp: 0, deaths: 0, boss: 1, play: 0, sessions: 1 });
});

test('kills write nothing until a flush, and one flush is one statement', async () => {
  const r = rig();
  r.stats.join(7, owner());
  for (let i = 0; i < 1000; i += 1) r.stats.recordKill(7);
  assert.equal(r.writes.length, 0);
  await r.stats.flush();
  assert.equal(r.writes.length, 1);
  assert.equal(r.writes[0][0].mob, 1000);
});

test('a big flush is batched', async () => {
  const r = rig();
  for (let id = 1; id <= BATCH_SIZE + 3; id += 1) r.stats.recordKill(id);
  await r.stats.flush();
  assert.deepEqual(r.writes.map((w) => w.length), [BATCH_SIZE, 3]);
});

test('a PvP death: the killer a pvp kill, the victim a death; a creature or self only a death', async () => {
  const r = rig();
  r.stats.join(1, owner());
  r.stats.join(2, owner());
  r.stats.recordDeath(2, 1);
  assert.equal(r.stats.session(1).pvpKills, 1);
  assert.equal(r.stats.session(1).deaths, 0);
  assert.equal(r.stats.session(2).deaths, 1);
  r.stats.recordDeath(2, null);
  r.stats.recordDeath(2, 2);
  assert.equal(r.stats.session(2).deaths, 3);
  assert.equal(r.stats.session(2).pvpKills, 0);
  assert.deepEqual(r.stats.totals(), { mobKills: 0, pvpKills: 1 });
});

test('a stale close cannot end the session a newer socket holds', () => {
  const r = rig();
  const old = owner(); const fresh = owner();
  const s = r.stats.join(7, old);
  assert.equal(r.stats.join(7, fresh), s, 'the same session');
  assert.equal(r.stats.leave(7, old), false);
  assert.equal(s.online, true);
  assert.equal(r.stats.leave(7, fresh), true);
  assert.equal(s.online, false);
});

test('a session resumes inside the window and is new after it', () => {
  const r = rig();
  const a = owner();
  const s = r.stats.join(7, a);
  r.stats.leave(7, a);
  r.advance(RESUME_MS);
  const b = owner();
  assert.equal(r.stats.join(7, b), s);
  r.stats.leave(7, b);
  r.advance(RESUME_MS + 1);
  assert.notEqual(r.stats.join(7, owner()), s);
});

test('a failed flush logs, resolves false and keeps everything for the next', async () => {
  const r = rig({ fail: true });
  r.stats.join(7, owner());
  r.stats.recordKill(7);
  r.advance(2000);
  assert.equal(await r.stats.flush(), false);
  assert.ok(r.errors.some((e) => /flush failed/.test(e)));
  assert.equal(r.stats.pendingCount(), 1);
  r.stats.recordKill(7);
  r.state.fail = false;
  assert.equal(await r.stats.flush(), true);
  assert.deepEqual(r.writes[0][0], { id: 7, mob: 2, pvp: 0, deaths: 0, boss: 0, play: 2, sessions: 1 });
  assert.equal(r.stats.pendingCount(), 0);
});

test('flushes never overlap: one asked during a write runs once after it', async () => {
  const release = [];
  let concurrent = 0; let peak = 0; let count = 0;
  const pool = { query: () => { count += 1; concurrent += 1; peak = Math.max(peak, concurrent); return new Promise((res) => { release.push(() => { concurrent -= 1; res({ rows: [] }); }); }); } };
  const stats = createGameStats({ pool, now: () => 5 });
  stats.recordKill(1);
  const first = stats.flush();
  stats.recordKill(2);
  const second = stats.flush();
  await new Promise((r) => { setImmediate(r); });
  release.shift()();
  await new Promise((r) => { setImmediate(r); });
  release.shift()();
  await Promise.all([first, second]);
  assert.equal(peak, 1);
  assert.equal(count, 2);
});

test('after stop a disconnect no longer touches the pool', async () => {
  const r = rig();
  r.stats.recordKill(1);
  r.stats.stop();
  assert.equal(await r.stats.flushOnDisconnect(), false);
  assert.equal(r.writes.length, 0);
  assert.equal(await r.stats.flush(), true, 'an explicit last flush still works');
  assert.equal(r.writes.length, 1);
});

test('lifetime is the table plus what is not written yet', async () => {
  const r = rig();
  r.state.rows = [{ character_id: 7, mob_kills: '10', pvp_kills: '1', deaths: '2', boss_kills: '3', play_seconds: '100', sessions: 4 }];
  r.stats.join(7, owner());
  r.stats.recordKill(7);
  r.advance(5000);
  const l = (await r.stats.lifetime([7, 8]));
  assert.deepEqual(l.get(7), { mobKills: 11, pvpKills: 1, deaths: 2, bossKills: 3, playSeconds: 105, sessions: 5 });
  assert.deepEqual(l.get(8), { mobKills: 0, pvpKills: 0, deaths: 0, bossKills: 0, playSeconds: 0, sessions: 0 });
});
