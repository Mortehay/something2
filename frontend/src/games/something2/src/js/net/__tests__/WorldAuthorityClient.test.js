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

it('sendEquip sends the weaponId', () => {
  const c = armClient();
  c.sendEquip(3);
  const f = FakeWS.last.sent.find((m) => m.type === 'equip');
  expect(f).toEqual({ type: 'equip', weaponId: 3 });
});

it('onState receives projectiles from a state frame', () => {
  const states = [];
  const c = new WorldAuthorityClient({ url: 'ws://x/authority', token: 't', onState: (m) => states.push(m) });
  c.connect('w1');
  FakeWS.last._l.open();
  FakeWS.last._l.message({ data: JSON.stringify({ type: 'state', players: [], projectiles: [{ id: '1', x: 1, y: 2, element: 'arcane' }] }) });
  expect(states[0].projectiles).toHaveLength(1);
});
