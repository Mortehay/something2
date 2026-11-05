'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/authority/playerTrade');

function clock(start = 1000) {
  const c = { t: start, now: () => c.t };
  return c;
}
const A = { userId: 1, characterId: 11, name: 'Ann', worldId: 5 };
const B = { userId: 2, characterId: 22, name: 'Bob', worldId: 5 };

function open(c = clock()) {
  const r = T.createTradeRegistry({ now: c.now });
  assert.equal(r.invite(A, B).ok, true);
  const res = r.respond(2, true);
  assert.equal(res.ok, true);
  return { r, c, s: res.session };
}
function bothLocked() {
  const x = open();
  x.r.setItem(1, 'i1', true);
  assert.equal(x.r.lock(1).ok, true);
  assert.equal(x.r.lock(2).ok, true);
  return x;
}

test('exports constants', () => {
  assert.equal(T.INVITE_EXPIRY_MS, 30000);
  assert.equal(T.INVITE_THROTTLE_MS, 3000);
  assert.equal(T.CONFIRM_DELAY_MS, 1500);
  assert.equal(T.STASH_LIMIT, 16);
  assert.equal(T.TRADE_INVITE_RADIUS, 120);
  assert.equal(T.TRADE_BREAK_RADIUS, 240);
});

test('first OK locks and cannot be edited', () => {
  const { r } = open();
  r.setItem(1, 'i1', true);
  assert.equal(r.lock(1).ok, true);
  assert.equal(r.setItem(1, 'i2', true).ok, false);
  assert.equal(r.setGold(1, 5, 100).ok, false);
  const again = r.lock(1);
  assert.equal(again.ok, false);
  const s = r.sessionOf(1);
  assert.equal(s.a.locked, true);
  assert.equal(s.phase, 'open');
  assert.deepEqual(s.a.itemIds, ['i1']);
});

test('the unlocked partner can still edit after the first OK', () => {
  const { r } = open();
  r.lock(1);
  assert.equal(r.setItem(2, 'x', true).ok, true);
  assert.equal(r.setGold(2, 3, 10).ok, true);
});

test('there is no way to un-lock', () => {
  const { r } = open();
  assert.equal(r.unlock, undefined);
  assert.equal(Object.keys(r).some((k) => /unlock/i.test(k)), false);
  r.setItem(1, 'i', true);
  r.lock(1);
  const ab = r.abort(1);
  assert.equal(ab.ok, true);
  assert.equal(r.sessionOf(1), null);
  assert.equal(r.sessionOf(2), null);
});

test('confirm refused until both locked', () => {
  const { r, c } = open();
  r.setItem(1, 'i', true);
  r.lock(1);
  c.t += 5000;
  assert.equal(r.confirm(1).ok, false);
});

test('confirm refused for 1500 ms after both lock', () => {
  const { r, c } = bothLocked();
  c.t += 1499;
  assert.equal(r.confirm(1).ok, false);
  c.t += 1;
  assert.equal(r.confirm(1).ok, true);
});

test('settle is true once, only after both confirm', () => {
  const { r, c } = bothLocked();
  c.t += 1500;
  const a = r.confirm(1);
  assert.equal(a.ok, true);
  assert.equal(a.settle, false);
  const b = r.confirm(2);
  assert.equal(b.ok, true);
  assert.equal(b.settle, true);
  assert.equal(b.session.phase, 'settling');
  const rep = r.confirm(2);
  assert.equal(rep.ok, false);
  assert.notEqual(rep.settle, true);
  assert.equal(r.confirm(1).ok, false);
});

test('repeat confirm by the same side before the partner is refused', () => {
  const { r, c } = bothLocked();
  c.t += 1500;
  r.confirm(1);
  const again = r.confirm(1);
  assert.equal(again.ok, false);
  assert.notEqual(again.settle, true);
});

test('abort after own second OK is allowed, before the partner\'s', () => {
  const { r, c } = bothLocked();
  c.t += 1500;
  r.confirm(1);
  const ab = r.abort(1);
  assert.equal(ab.ok, true);
  assert.equal(ab.partnerUserId, 2);
  assert.equal(r.sessionOf(2), null);
});

test('abort is refused during settling', () => {
  const { r, c } = bothLocked();
  c.t += 1500;
  r.confirm(1);
  r.confirm(2);
  assert.equal(r.abort(1).ok, false);
  assert.equal(r.abort(2).ok, false);
  assert.notEqual(r.sessionOf(1), null);
});

test('finish removes a session', () => {
  const { r, s } = open();
  r.finish(s.id);
  assert.equal(r.sessionOf(1), null);
  assert.equal(r.isBusy(1), false);
  assert.equal(r.isBusy(2), false);
});

test('second lock with both stashes empty is refused nothing to trade', () => {
  const { r } = open();
  assert.equal(r.lock(1).ok, true);
  const second = r.lock(2);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'nothing to trade');
  assert.equal(r.sessionOf(2).phase, 'open');
  assert.equal(r.sessionOf(2).b.locked, false);
});

test('a one-sided gift completes', () => {
  const { r, c } = open();
  r.setGold(1, 10, 10);
  r.lock(1);
  assert.equal(r.lock(2).ok, true);
  c.t += 1500;
  r.confirm(1);
  assert.equal(r.confirm(2).settle, true);
});

test('stash limit 16; duplicate add no-op; removing absent refused', () => {
  const { r } = open();
  for (let i = 0; i < 16; i++) assert.equal(r.setItem(1, `i${i}`, true).ok, true);
  assert.equal(r.setItem(1, 'extra', true).ok, false);
  assert.equal(r.setItem(1, 'i0', true).ok, true);
  assert.equal(r.sessionOf(1).a.itemIds.length, 16);
  assert.equal(r.setItem(1, 'nope', false).ok, false);
  assert.equal(r.setItem(1, 'i0', false).ok, true);
  assert.equal(r.sessionOf(1).a.itemIds.length, 15);
});

test('gold validation', () => {
  const { r } = open();
  for (const bad of [1.5, -1, NaN, '5', Infinity, 2 ** 53, 101, null, undefined]) {
    assert.equal(r.setGold(1, bad, 100).ok, false, String(bad));
  }
  assert.equal(r.setGold(1, 0, 100).ok, true);
  assert.equal(r.setGold(1, 100, 100).ok, true);
  assert.equal(r.sessionOf(1).a.gold, 100);
  assert.equal(r.setGold(1, 5, NaN).ok, false);
});

test('invite refusals', () => {
  const c = clock();
  const r = T.createTradeRegistry({ now: c.now });
  assert.equal(r.invite(A, A).ok, false);
  assert.equal(r.invite(A, B).ok, true);
  assert.equal(r.invite(A, { userId: 3, characterId: 33, name: 'C' }).ok, false); // live invite
  assert.equal(r.isBusy(1), true);
  assert.equal(r.isBusy(2), true);
  // target busy for others
  assert.equal(r.invite({ userId: 3, characterId: 33, name: 'C', worldId: 5 }, B).ok, false);
  assert.equal(r.respond(3, true).ok, false); // only the target can respond
  assert.equal(r.respond(1, true).ok, false);
  const d = r.respond(2, false);
  assert.equal(d.ok, true);
  assert.equal(d.accepted, false);
  assert.equal(d.inviterUserId, 1);
  assert.equal(r.isBusy(1), false);
  assert.equal(r.isBusy(2), false);
  // throttle
  c.t += 2999;
  assert.equal(r.invite(A, B).ok, false);
  c.t += 1;
  const ok = r.invite(A, B);
  assert.equal(ok.ok, true);
  assert.equal(ok.expiresInMs, 30000);
});

test('invite expires after 30000 ms', () => {
  const c = clock();
  const r = T.createTradeRegistry({ now: c.now });
  r.invite(A, B);
  c.t += 29999;
  assert.deepEqual(r.expireInvites(), []);
  c.t += 1;
  assert.deepEqual(r.expireInvites(), [{ inviterUserId: 1, targetUserId: 2 }]);
  assert.equal(r.respond(2, true).ok, false);
  assert.equal(r.isBusy(1), false);
});

test('respond after expiry without sweep is refused', () => {
  const c = clock();
  const r = T.createTradeRegistry({ now: c.now });
  r.invite(A, B);
  c.t += 30000;
  assert.equal(r.respond(2, true).ok, false);
  assert.equal(r.isBusy(2), false);
});

test('accept creates session with shape, helpers and sessions()', () => {
  const { r, s } = open();
  assert.equal(s.phase, 'open');
  assert.equal(s.worldId, 5);
  assert.equal(s.a.userId, 1);
  assert.equal(s.b.name, 'Bob');
  assert.deepEqual(s.a, { userId: 1, characterId: 11, name: 'Ann', itemIds: [], gold: 0, locked: false, confirmed: false });
  assert.equal(r.sideOf(s, 2), s.b);
  assert.equal(r.partnerOf(s, 2), s.a);
  assert.equal(r.sideOf(s, 9), null);
  assert.deepEqual([...r.sessions()], [s]);
  assert.equal(r.invite(A, B).ok, false);
});

test('bad input never throws', () => {
  const r = T.createTradeRegistry();
  assert.equal(r.invite(null, null).ok, false);
  assert.equal(r.respond(9, true).ok, false);
  assert.equal(r.setItem(9, 'x', true).ok, false);
  assert.equal(r.setGold(9, 1, 1).ok, false);
  assert.equal(r.lock(9).ok, false);
  assert.equal(r.confirm(9).ok, false);
  assert.equal(r.abort(9).ok, false);
  r.finish('nope');
});

test('an item id must be a non-empty string', () => {
  const { r, s } = open();
  for (const bad of [5, NaN, Infinity, '', null, undefined, {}]) {
    assert.equal(r.setItem(1, bad, true).ok, false, String(bad));
  }
  assert.deepEqual(r.sideOf(s, 1).itemIds, []);
});

test('dropInvitesOf frees both players of an invite, from either end', () => {
  for (const leaver of [1, 2]) {
    const r = T.createTradeRegistry({ now: clock().now });
    assert.equal(r.invite(A, B).ok, true);
    assert.deepEqual(r.dropInvitesOf(leaver), [{ inviterUserId: 1, targetUserId: 2 }]);
    assert.equal(r.isBusy(1), false);
    assert.equal(r.isBusy(2), false);
    assert.equal(r.respond(2, true).ok, false);
  }
});
