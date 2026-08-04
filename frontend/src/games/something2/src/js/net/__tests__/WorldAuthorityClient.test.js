import { describe, it, expect, beforeEach } from 'vitest';
import { WorldAuthorityClient } from '../WorldAuthorityClient.js';

// Minimal fake WebSocket capturing sent frames.
class FakeWS {
  constructor(url) { this.url = url; this.sent = []; this.readyState = 1; FakeWS.last = this; this._l = {}; }
  addEventListener(t, cb) { this._l[t] = cb; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() {}
}
FakeWS.OPEN = 1;

beforeEach(() => { globalThis.WebSocket = FakeWS; FakeWS.last = null; });

function armClient(opts = {}) {
  const c = new WorldAuthorityClient({ url: 'ws://x/authority', token: 't', ...opts });
  c.connect('w1');
  FakeWS.last._l.open(); // marks connected, sends join
  return c;
}

describe('WorldAuthorityClient', () => {
  it('sends join on open', () => {
    const c = new WorldAuthorityClient({ url: 'ws://x/authority', token: 't' });
    c.connect('w1');
    FakeWS.last._l.open();
    expect(FakeWS.last.sent[0]).toEqual({ type: 'join', world_id: 'w1' });
  });

  it('throttles input to the interval and accumulates dt', () => {
    let clock = 1000;
    const c = new WorldAuthorityClient({ url: 'ws://x/authority', token: 't', inputIntervalMs: 50, now: () => clock });
    c.connect('w1');
    FakeWS.last._l.open();
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

  it('dispatches a joined message to onJoined', () => {
    const seen = [];
    armClient({ onJoined: (m) => seen.push(m) });
    FakeWS.last._l.message({ data: JSON.stringify({ type: 'joined', user_id: '1', spawn: { x: 5, y: 6 } }) });
    expect(seen).toHaveLength(1);
    expect(seen[0].user_id).toBe('1');
  });

  it('dispatches a creatures message to onCreatures', () => {
    const seen = [];
    armClient({ onCreatures: (m) => seen.push(m) });
    FakeWS.last._l.message({ data: JSON.stringify({ type: 'creatures', creatures: [{ id: 'a', x: 1, y: 2 }] }) });
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe('creatures');
  });

  it('ignores messages that arrive after disconnect (e.g. a self-kick during an intentional reconnect)', () => {
    const seen = [];
    const c = new WorldAuthorityClient({ url: 'ws://x/authority', token: 't', onKicked: (m) => seen.push(m) });
    c.connect('w1');
    FakeWS.last._l.open();
    const deadWs = FakeWS.last;

    // The doorway transition tears this socket down and opens a fresh one for
    // the destination world. The graceful close() is still in flight, so the
    // server's single-session guard can still deliver a late 'kicked' on this
    // dead socket — which must NOT flip the game into the kicked state.
    c.disconnect();
    deadWs._l.message({ data: JSON.stringify({ type: 'kicked', reason: 'signed_in_elsewhere' }) });

    expect(seen).toHaveLength(0);
  });

  it('sendAttack sends an aim vector', () => {
    const c = armClient();
    c.sendAttack(0.6, -0.8);
    const f = FakeWS.last.sent.find((m) => m.type === 'attack');
    expect(f).toEqual({ type: 'attack', ax: 0.6, ay: -0.8 });
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

  it('onState receives projectiles from a state frame', () => {
    const states = [];
    const c = new WorldAuthorityClient({ url: 'ws://x/authority', token: 't', onState: (m) => states.push(m) });
    c.connect('w1');
    FakeWS.last._l.open();
    FakeWS.last._l.message({ data: JSON.stringify({ type: 'state', players: [], projectiles: [{ id: '1', x: 1, y: 2, element: 'arcane' }] }) });
    expect(states[0].projectiles).toHaveLength(1);
  });

  // F3: onError must let callers tell a server-issued protocol rejection
  // (a `type:'error'` frame, e.g. an equip/drop refusal) apart from a raw
  // transport failure, so the UI can show the former without spamming the
  // player for the latter.
  it("a server 'error' frame is tagged as a rejection carrying the server's message", () => {
    const seen = [];
    armClient({ onError: (e) => seen.push(e) });
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
    armClient({ onKicked: (m) => seen.push(m) });
    FakeWS.last._l.message({ data: JSON.stringify({ type: 'kicked', reason: 'signed_in_elsewhere' }) });
    expect(seen).toHaveLength(1);
    expect(seen[0].reason).toBe('signed_in_elsewhere');
  });

  // Slice C (gold economy): the server credits the wallet out-of-band from the
  // inventory ('picked') — a ground gold pile is never an item — so onWallet
  // must fire on its own message type with the new balance.
  it('a wallet message invokes onWallet with the new balance', () => {
    const seen = [];
    armClient({ onWallet: (m) => seen.push(m) });
    FakeWS.last._l.message({ data: JSON.stringify({ type: 'wallet', gold: 42 }) });
    expect(seen).toHaveLength(1);
    expect(seen[0].gold).toBe(42);
  });

  // Slice D (merchant): interacting with a merchant returns its catalog +
  // buyback list on its own message type, distinct from wallet/picked.
  it('a shop message invokes onShop with the catalog and buyback', () => {
    const seen = [];
    armClient({ onShop: (m) => seen.push(m) });
    FakeWS.last._l.message({ data: JSON.stringify({ type: 'shop', villageId: 'v1', catalog: [{ id: 's1' }], buyback: [] }) });
    expect(seen).toHaveLength(1);
    expect(seen[0].villageId).toBe('v1');
    expect(seen[0].catalog).toHaveLength(1);
  });

  // SOMET-242 (Task 10): the authority pushes a 'progression' frame on kill
  // XP, level-up and death -- separate from the join payload's own
  // `progression` field, same split as gold (joined) vs wallet (onWallet).
  it('a progression message invokes onProgression, including a zero-XP no-op award', () => {
    const seen = [];
    armClient({ onProgression: (m) => seen.push(m) });
    const progression = { level: 2, experience: 130, stat_points: 3 };
    FakeWS.last._l.message({ data: JSON.stringify({ type: 'progression', progression, leveledUp: false, newLevel: 2, awarded: 0 }) });
    expect(seen).toHaveLength(1);
    expect(seen[0].progression).toEqual(progression);
    expect(seen[0].awarded).toBe(0);
  });
});
