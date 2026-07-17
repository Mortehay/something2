import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorldAuthorityClient } from './WorldAuthorityClient.js';

// Minimal fake WebSocket capturing sent frames.
class FakeWS {
  constructor(url) { this.url = url; this.readyState = 1; this.sent = []; FakeWS.last = this; this.listeners = {}; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; }
  emit(t, ev) { (this.listeners[t] || []).forEach((fn) => fn(ev)); }
}

beforeEach(() => { globalThis.WebSocket = FakeWS; FakeWS.OPEN = 1; });

describe('WorldAuthorityClient', () => {
  it('sends join on open', () => {
    const c = new WorldAuthorityClient({ url: 'ws://x/authority', token: 't' });
    c.connect('w1');
    FakeWS.last.emit('open');
    expect(FakeWS.last.sent[0]).toEqual({ type: 'join', world_id: 'w1' });
  });

  it('throttles input to the interval and accumulates dt', () => {
    let clock = 1000;
    const c = new WorldAuthorityClient({ url: 'ws://x/authority', token: 't', inputIntervalMs: 50, now: () => clock });
    c.connect('w1');
    FakeWS.last.emit('open');
    FakeWS.last.sent.length = 0; // drop the join frame

    const r1 = c.sendInput(1, 0, 0.016); // t=1000, first send allowed
    expect(r1.sent).toBe(true);
    expect(r1.seq).toBe(1);

    clock = 1020;
    const r2 = c.sendInput(1, 0, 0.016); // only 20ms later → throttled
    expect(r2.sent).toBe(false);

    clock = 1060;
    const r3 = c.sendInput(0, 1, 0.016); // 60ms since last send → send
    expect(r3.sent).toBe(true);
    expect(r3.seq).toBe(2);
    // dt accumulated since the previous actual send (r1 already reported/reset its
    // own dt): the throttled r2 frame (0.016) + the current r3 frame (0.016) = 0.032.
    expect(r3.dt).toBeCloseTo(0.032, 5);
    // most-recent input vector wins
    const last = FakeWS.last.sent[FakeWS.last.sent.length - 1];
    expect(last).toMatchObject({ type: 'input', seq: 2, dx: 0, dy: 1 });
  });

  it('dispatches joined/state to callbacks', () => {
    const onJoined = vi.fn();
    const onState = vi.fn();
    const c = new WorldAuthorityClient({ url: 'ws://x/authority', token: 't', onJoined, onState });
    c.connect('w1');
    FakeWS.last.emit('message', { data: JSON.stringify({ type: 'joined', user_id: '1', spawn: { x: 5, y: 6 } }) });
    FakeWS.last.emit('message', { data: JSON.stringify({ type: 'state', tick: 1, ackSeq: 0, players: [] }) });
    expect(onJoined).toHaveBeenCalledWith(expect.objectContaining({ user_id: '1' }));
    expect(onState).toHaveBeenCalledWith(expect.objectContaining({ tick: 1 }));
  });

  it('dispatches a creatures message to onCreatures', () => {
    const onCreatures = vi.fn();
    const c = new WorldAuthorityClient({ url: 'ws://x/authority', token: 't', onCreatures });
    c.connect('w1');
    FakeWS.last.emit('message', { data: JSON.stringify({ type: 'creatures', creatures: [{ id: 'a', x: 1, y: 2 }] }) });
    expect(onCreatures).toHaveBeenCalledWith(expect.objectContaining({ type: 'creatures' }));
  });

  it('sendAttack sends an attack message', () => {
    const c = new WorldAuthorityClient({ url: 'ws://x/authority', token: 't' });
    c.connect('w1');
    FakeWS.last.emit('open');
    FakeWS.last.sent.length = 0;
    c.sendAttack();
    expect(FakeWS.last.sent).toContainEqual({ type: 'attack' });
  });
});
