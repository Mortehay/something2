const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sb = require('../src/authority/skillBalance.js');

const fresh = () => ({ maxHp: 100, hp: 100, mana: 100, stats: { rules: {} } });

test('a form survives a world change with its remaining time on the new clock', () => {
  const a = fresh();
  sb.castBuff(a, { id: 'dru_bear_form', nameEn: 'Bear Form' }, 1000);
  const carrier = new sb.BuffCarrier();
  assert.equal(carrier.stash('c1', a, 5000, 100000), 1);

  const b = fresh();
  const list = carrier.take('c1', 102000); // 2 s away
  const orig = a.buffs.get('dru_bear_form');
  assert.equal(sb.importBuffs(b, list, 50), 1);
  const nb = b.buffs.get('dru_bear_form');
  assert.ok(nb, 'form present');
  assert.equal(nb.expiresAt, 50 + (orig.expiresAt - 5000 - 2000));
  assert.equal(sb.activeForm(b), 'bear');
  assert.equal(carrier.size, 0, 'consumed');
});

test('a carried hpAdd form raises max hp again and removes cleanly', () => {
  const a = fresh();
  sb.castBuff(a, { id: 'dru_bear_form', nameEn: 'Bear Form' }, 0);
  const carrier = new sb.BuffCarrier();
  carrier.stash('c', a, 10, 0);
  const b = fresh();
  sb.importBuffs(b, carrier.take('c', 0), 0);
  assert.equal(b.maxHp, a.maxHp);
  sb.removeBuff(b, 'dru_bear_form');
  assert.equal(b.maxHp, 100);
});

test('expired, stealth, dead and other-character buffs are not carried', () => {
  const carrier = new sb.BuffCarrier();
  const a = fresh();
  sb.castBuff(a, { id: 'dru_hawk_form', nameEn: 'Hawk' }, 0);
  carrier.stash('c', a, 1, 0);
  assert.deepEqual(carrier.take('c', 10 * 60 * 60 * 1000), [], 'ran out while away');

  const dead = fresh();
  sb.castBuff(dead, { id: 'dru_hawk_form', nameEn: 'Hawk' }, 0);
  dead.hp = 0;
  assert.equal(carrier.stash('c', dead, 1, 0), 0);

  const s = fresh();
  s.buffs = new Map([['x', { id: 'x', durationMs: 5000, expiresAt: 5000, fx: { stealth: true } }]]);
  assert.equal(sb.exportBuffs(s, 0).length, 0);

  const o = fresh();
  sb.castBuff(o, { id: 'dru_wolf_form', nameEn: 'Wolf' }, 0);
  carrier.stash('c1', o, 1, 0);
  assert.deepEqual(carrier.take('c2', 0), []);
});

test('server wires stash on close and restore on join', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/authority/server.js'), 'utf8');
  assert.match(src, /carriedBuffs\.stash\(ws\.characterId[\s\S]{0,120}removePlayer\(ws\.userId\)/);
  assert.match(src, /importBuffs\([^\n]*carriedBuffs\.take\(ws\.characterId\)[\s\S]{0,200}applyBoon/);
});
