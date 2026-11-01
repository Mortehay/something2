const test = require('node:test');
const assert = require('node:assert');
const ach = require('../src/services/achievements.js');

// A tiny in-memory stand-in for the three statements the service issues.
function fakeDb() {
  const counters = new Map();      // `${cid}|${key}` -> value
  const unlocked = new Map();      // `${cid}|${key}` -> Date
  const titles = new Map();        // cid -> active_title
  const questTitles = [];          // rows for the quest-title query
  return {
    counters, unlocked, titles, questTitles,
    async query(sql, params) {
      if (/INSERT INTO character_counters/.test(sql)) {
        const [cid, key, amt] = params;
        const k = `${cid}|${key}`;
        const prev = counters.get(k) || 0;
        const next = /GREATEST/.test(sql) ? Math.max(prev, amt) : prev + amt;
        counters.set(k, next);
        return { rows: [{ value: next }] };
      }
      if (/INSERT INTO character_achievements/.test(sql)) {
        const k = `${params[0]}|${params[1]}`;
        if (unlocked.has(k)) return { rows: [] };
        unlocked.set(k, new Date('2026-11-01T00:00:00Z'));
        return { rows: [{ achievement_key: params[1] }] };
      }
      if (/FROM character_counters/.test(sql)) {
        return { rows: [...counters.entries()].filter(([k]) => k.startsWith(`${params[0]}|`)).map(([k, v]) => ({ key: k.split('|')[1], value: v })) };
      }
      if (/FROM character_achievements/.test(sql)) {
        return { rows: [...unlocked.entries()].filter(([k]) => k.startsWith(`${params[0]}|`)).map(([k, d]) => ({ achievement_key: k.split('|')[1], unlocked_at: d })) };
      }
      if (/FROM character_quests/.test(sql)) return { rows: questTitles };
      if (/SELECT active_title FROM characters/.test(sql)) return { rows: [{ active_title: titles.get(params[0]) || null }] };
      if (/UPDATE characters SET active_title/.test(sql)) {
        titles.set(params[0], params.length > 1 ? params[1] : null);
        return { rows: [] };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
}

test('the catalog is well formed: unique keys, known categories and counters, positive targets', () => {
  assert.ok(ach.CATALOG.length >= 25);
  assert.strictEqual(new Set(ach.CATALOG.map((a) => a.key)).size, ach.CATALOG.length);
  for (const a of ach.CATALOG) {
    assert.ok(ach.CATEGORIES.includes(a.category), a.key);
    assert.ok(a.target > 0 && a.name && a.description && a.icon, a.key);
  }
  for (const c of ach.CATEGORIES) assert.ok(ach.CATALOG.some((a) => a.category === c), `${c} has entries`);
  const titles = ach.CATALOG.map((a) => a.title).filter(Boolean);
  assert.strictEqual(new Set(titles).size, titles.length, 'titles are unique');
  // Within one counter the targets climb, so a later milestone implies the earlier ones.
  for (const counter of ach.COUNTERS) {
    const t = ach.CATALOG.filter((a) => a.counter === counter).map((a) => a.target);
    assert.deepStrictEqual(t, [...t].sort((x, y) => x - y), counter);
  }
});

test('add counters accumulate, unlock once, and a flush reports only the new unlocks', async () => {
  const db = fakeDb();
  ach.bufferTrack(7, 'kills', 60);
  ach.bufferTrack(7, 'kills', 50);
  let res = await ach.flush(db);
  assert.strictEqual(db.counters.get('7|kills'), 110);
  assert.deepStrictEqual(res.map((r) => r.characterId), [7]);
  assert.deepStrictEqual(res[0].unlocked.map((u) => u.key).sort(), ['first_blood', 'slayer_100']);
  ach.bufferTrack(7, 'kills', 1);
  res = await ach.flush(db);
  assert.deepStrictEqual(res, [], 'nothing new');
  assert.strictEqual(ach.CATALOG.length > 0 && ach._bufferSize(), 0, 'buffer drained');
});

test('max counters keep the high-water mark and never go back', async () => {
  const db = fakeDb();
  ach.bufferTrack(8, 'level', 12, 'max');
  ach.bufferTrack(8, 'level', 9, 'max');
  let res = await ach.flush(db);
  assert.strictEqual(db.counters.get('8|level'), 12);
  assert.deepStrictEqual(res[0].unlocked.map((u) => u.key), ['level_10']);
  ach.bufferTrack(8, 'level', 5, 'max');
  await ach.flush(db);
  assert.strictEqual(db.counters.get('8|level'), 12);
});

test('unknown counters and junk amounts are ignored', async () => {
  const db = fakeDb();
  ach.bufferTrack(9, 'nonsense', 5);
  ach.bufferTrack(9, 'kills', 0);
  ach.bufferTrack(9, 'kills', -3);
  ach.bufferTrack(null, 'kills', 3);
  assert.deepStrictEqual(await ach.flush(db), []);
  assert.strictEqual(db.counters.size, 0);
});

test('a failed write is put back so nothing is lost', async () => {
  const db = fakeDb();
  const real = db.query.bind(db);
  let fail = true;
  db.query = async (sql, params) => { if (fail && /INSERT INTO character_counters/.test(sql)) { fail = false; throw new Error('boom'); } return real(sql, params); };
  ach.bufferTrack(10, 'chests', 3);
  const origErr = console.error; console.error = () => {};
  try { await ach.flush(db); } finally { console.error = origErr; }
  assert.strictEqual(ach._bufferSize(), 1, 'back in the buffer');
  await ach.flush(db);
  assert.strictEqual(db.counters.get('10|chests'), 3);
});

test('the journal reports progress capped at the target, and includes what is still buffered', async () => {
  const db = fakeDb();
  ach.bufferTrack(11, 'kills', 2000);
  await ach.flush(db);
  ach.bufferTrack(11, 'kills', 5);
  const j = await ach.getJournal(db, 11);
  const first = j.achievements.find((a) => a.key === 'first_blood');
  const big = j.achievements.find((a) => a.key === 'slayer_10000');
  assert.deepStrictEqual([first.unlocked, first.counter, first.target], [true, 1, 1]);
  assert.deepStrictEqual([big.unlocked, big.counter, big.target], [false, 2005, 10000]);
  assert.strictEqual(j.counters.kills, 2005);
  assert.ok(first.unlockedAt);
  await ach.flush(db);
});

test('titles come from achievements and quests; only an owned title can be worn', async () => {
  const db = fakeDb();
  ach.bufferTrack(12, 'kills', 1000);
  await ach.flush(db);
  db.questTitles.push({ title_reward: 'Core Seeker', quest_title: 'Whispers of the Shattered Core' });
  const j = await ach.getJournal(db, 12);
  assert.deepStrictEqual(j.titles.map((t) => [t.title, t.source]), [['the Slayer', 'achievement'], ['Core Seeker', 'quest']]);
  assert.strictEqual(j.activeTitle, null);

  assert.deepStrictEqual(await ach.setActiveTitle(db, 12, 'the Slayer'), { ok: true, activeTitle: 'the Slayer' });
  assert.strictEqual((await ach.getJournal(db, 12)).activeTitle, 'the Slayer');
  assert.deepStrictEqual(await ach.setActiveTitle(db, 12, 'Core Seeker'), { ok: true, activeTitle: 'Core Seeker' });
  const bad = await ach.setActiveTitle(db, 12, 'the Legend');
  assert.strictEqual(bad.ok, false);
  assert.strictEqual((await ach.getJournal(db, 12)).activeTitle, 'Core Seeker', 'unchanged by a refused title');
  assert.deepStrictEqual(await ach.setActiveTitle(db, 12, null), { ok: true, activeTitle: null });
});
