import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorldAuthorityClient } from '../WorldAuthorityClient.js';

// Minimal fake WebSocket capturing sent frames.
class FakeWS {
  constructor() { this.sent = []; this.readyState = 1; FakeWS.last = this; this._l = {}; }
  addEventListener(t, cb) { this._l[t] = cb; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() {}
}
FakeWS.OPEN = 1;

beforeEach(() => { global.WebSocket = FakeWS; FakeWS.last = null; });

function armClient() {
  const c = new WorldAuthorityClient({ url: 'ws://x/authority', token: 't' });
  c.connect('w1');
  FakeWS.last._l.open();     // marks connected, sends join
  return c;
}

it('sendAttack sends an aim vector', () => {
  const c = armClient();
  c.sendAttack(0.6, -0.8);
  const f = FakeWS.last.sent.find((m) => m.type === 'attack');
  expect(f).toEqual({ type: 'attack', ax: 0.6, ay: -0.8 });
});

it('sendEquip sends itemId + slot', () => {
  const c = armClient();
  c.sendEquip('w3', 'hand');
  const f = FakeWS.last.sent.find((m) => m.type === 'equip');
  expect(f).toEqual({ type: 'equip', itemId: 'w3', slot: 'hand' });
});

it('onState receives projectiles from a state frame', () => {
  const states = [];
  const c = new WorldAuthorityClient({ url: 'ws://x/authority', token: 't', onState: (m) => states.push(m) });
  c.connect('w1');
  FakeWS.last._l.open();
  FakeWS.last._l.message({ data: JSON.stringify({ type: 'state', players: [], projectiles: [{ id: '1', x: 1, y: 2, element: 'arcane' }] }) });
  expect(states[0].projectiles).toHaveLength(1);
});

it('sendEquip sends itemId + slot', () => {
  const c = armClient();
  c.sendEquip('i5', 'chest');
  expect(FakeWS.last.sent.find((m) => m.type === 'equip')).toEqual({ type: 'equip', itemId: 'i5', slot: 'chest' });
});

it('sendUnequip sends the slot', () => {
  const c = armClient();
  c.sendUnequip('chest');
  expect(FakeWS.last.sent.find((m) => m.type === 'unequip')).toEqual({ type: 'unequip', slot: 'chest' });
});

// F3: onError must let callers tell a server-issued protocol rejection
// (a `type:'error'` frame, e.g. an equip/drop refusal) apart from a raw
// transport failure, so the UI can show the former without spamming the
// player for the latter.
it("a server 'error' frame is tagged as a rejection carrying the server's message", () => {
  const seen = [];
  const c = new WorldAuthorityClient({ url: 'ws://x/authority', token: 't', onError: (e) => seen.push(e) });
  c.connect('w1');
  FakeWS.last._l.open();
  FakeWS.last._l.message({ data: JSON.stringify({ type: 'error', message: 'unequip it first' }) });
  expect(seen).toHaveLength(1);
  expect(seen[0].isServerRejection).toBe(true);
  expect(seen[0].serverMessage).toBe('unequip it first');
});

it('a raw websocket error is NOT tagged as a server rejection', () => {
  const seen = [];
  const c = new WorldAuthorityClient({ url: 'ws://x/authority', token: 't', onError: (e) => seen.push(e) });
  c.connect('w1');
  FakeWS.last._l.error();
  expect(seen).toHaveLength(1);
  expect(seen[0].isServerRejection).toBeUndefined();
});

it('a kicked message invokes onKicked', () => {
  const seen = [];
  const c = new WorldAuthorityClient({ url: 'ws://x/authority', token: 't', onKicked: (m) => seen.push(m) });
  c.connect('w1');
  FakeWS.last._l.open();
  FakeWS.last._l.message({ data: JSON.stringify({ type: 'kicked', reason: 'signed_in_elsewhere' }) });
  expect(seen).toHaveLength(1);
  expect(seen[0].reason).toBe('signed_in_elsewhere');
});

// Slice C (gold economy): the server credits the wallet out-of-band from the
// inventory ('picked') — a ground gold pile is never an item — so onWallet
// must fire on its own message type with the new balance.
it('a wallet message invokes onWallet with the new balance', () => {
  const seen = [];
  const c = new WorldAuthorityClient({ url: 'ws://x/authority', token: 't', onWallet: (m) => seen.push(m) });
  c.connect('w1');
  FakeWS.last._l.open();
  FakeWS.last._l.message({ data: JSON.stringify({ type: 'wallet', gold: 42 }) });
  expect(seen).toHaveLength(1);
  expect(seen[0].gold).toBe(42);
});

// Slice D (merchant): interacting with a merchant returns its catalog +
// buyback list on its own message type, distinct from wallet/picked.
it('a shop message invokes onShop with the catalog and buyback', () => {
  const seen = [];
  const c = new WorldAuthorityClient({ url: 'ws://x/authority', token: 't', onShop: (m) => seen.push(m) });
  c.connect('w1');
  FakeWS.last._l.open();
  FakeWS.last._l.message({ data: JSON.stringify({ type: 'shop', villageId: 'v1', catalog: [{ id: 's1' }], buyback: [] }) });
  expect(seen).toHaveLength(1);
  expect(seen[0].villageId).toBe('v1');
  expect(seen[0].catalog).toHaveLength(1);
});
