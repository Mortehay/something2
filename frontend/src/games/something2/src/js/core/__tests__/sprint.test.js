// Sprint on the client: the rule, the wire, the prediction replay -- and that the
// numbers are the SERVER's (a mismatch is a rubber-band).
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  SPRINT_MULT, SPRINT_DRAIN, SPRINT_START, SPRINT_UNLOCK, sprintWanted, drainStamina, speedWithSprint,
} from '../sprint.js';
import { reconcile } from '../../net/reconcile.js';
import { WorldAuthorityClient } from '../../net/WorldAuthorityClient.js';
import { Player } from '../../entities/Player.js';

const WORLD_JS = path.resolve(__dirname, '../../../../../../../../backend/src/authority/world.js');

describe('the client numbers are the server numbers', () => {
  it('SPRINT_* match backend world.js', () => {
    const src = fs.readFileSync(WORLD_JS, 'utf8');
    const num = (name) => Number(new RegExp(`const ${name} = ([0-9.]+);`).exec(src)[1]);
    expect(SPRINT_MULT).toBe(num('SPRINT_MULT'));
    expect(SPRINT_DRAIN).toBe(num('SPRINT_DRAIN'));
    expect(SPRINT_START).toBe(num('SPRINT_START'));
    expect(SPRINT_UNLOCK).toBe(num('SPRINT_UNLOCK'));
  });
});

const base = { shift: true, moving: true, stamina: 100 };

describe('sprintWanted', () => {
  it('needs Shift and movement', () => {
    expect(sprintWanted(base)).toBe(true);
    expect(sprintWanted({ ...base, shift: false })).toBe(false);
    expect(sprintWanted({ ...base, moving: false })).toBe(false);
  });
  it('starts at the start threshold, continues down to empty', () => {
    expect(sprintWanted({ ...base, stamina: SPRINT_START - 0.1 })).toBe(false);
    expect(sprintWanted({ ...base, stamina: SPRINT_START })).toBe(true);
    expect(sprintWanted({ ...base, stamina: 3, active: true })).toBe(true);
    expect(sprintWanted({ ...base, stamina: 0, active: true })).toBe(false);
  });
  it('after running dry it waits for the unlock threshold', () => {
    expect(sprintWanted({ ...base, stamina: SPRINT_UNLOCK - 1, locked: true })).toBe(false);
    expect(sprintWanted({ ...base, stamina: SPRINT_UNLOCK, locked: true })).toBe(true);
  });
  it('is off while rooted, channelling or stunned', () => {
    expect(sprintWanted({ ...base, speedMult: 0.001 })).toBe(false);
    expect(sprintWanted({ ...base, speedMult: 0.5 })).toBe(true); // a slow is not a root
    expect(sprintWanted({ ...base, channeling: true })).toBe(false);
    expect(sprintWanted({ ...base, stunned: true })).toBe(false);
  });
  it('treats an unknown stamina as none, not as full', () => {
    expect(sprintWanted({ ...base, stamina: undefined })).toBe(false);
    expect(sprintWanted({ ...base, stamina: NaN })).toBe(false);
  });
});

describe('cost and speed helpers', () => {
  it('drains per second and never below zero', () => {
    expect(drainStamina(100, 1)).toBe(100 - SPRINT_DRAIN);
    expect(drainStamina(2, 1)).toBe(0);
  });
  it('multiplies the speed only when sprinting', () => {
    expect(speedWithSprint(200, true)).toBe(200 * SPRINT_MULT);
    expect(speedWithSprint(200, false)).toBe(200);
    expect(speedWithSprint(200, undefined)).toBe(200);
  });
});

const open = { isWalkable: () => true, speedAt: () => 1 };
const dims = { width: 0, height: 0, speed: 100 };

describe('reconcile replays each input at the speed it was sent with', () => {
  it('a sprinting input covers SPRINT_MULT x the distance of a walking one', () => {
    const walk = reconcile({ x: 0, y: 0 }, 0, [{ seq: 1, dx: 1, dy: 0, dt: 0.1 }], open, dims);
    const run = reconcile({ x: 0, y: 0 }, 0, [{ seq: 1, dx: 1, dy: 0, dt: 0.1, sprint: true }], open, dims);
    expect(run.x / walk.x).toBeCloseTo(SPRINT_MULT, 5);
  });
  it('mixed inputs: walk, then sprint, then the unsent tail at the right speed', () => {
    const buffer = [
      { seq: 1, dx: 1, dy: 0, dt: 0.1 },
      { seq: 2, dx: 1, dy: 0, dt: 0.1, sprint: true },
    ];
    const out = reconcile({ x: 0, y: 0 }, 0, buffer, open, dims, { dx: 1, dy: 0, dt: 0.1, sprint: true });
    const unit = walkUnit();
    expect(out.x).toBeCloseTo(unit * (1 + SPRINT_MULT + SPRINT_MULT), 4);
  });
  it('without a sprint flag nothing changes (old buffers and the walking path)', () => {
    const out = reconcile({ x: 10, y: 0 }, 1, [{ seq: 2, dx: 1, dy: 0, dt: 0.1 }], open, dims, { dx: 1, dy: 0, dt: 0.1 });
    expect(out.x).toBeCloseTo(10 + walkUnit() * 2, 4);
  });
});
function walkUnit() {
  return reconcile({ x: 0, y: 0 }, 0, [{ seq: 1, dx: 1, dy: 0, dt: 0.1 }], open, dims).x;
}

describe('the local player predicts the sprint', () => {
  it('moves SPRINT_MULT x as far with sprint=true', () => {
    const mk = () => { const p = new Player(); p.x = 0; p.y = 0; p.width = 0; p.height = 0; return p; };
    const a = mk(); const b = mk();
    a.update(0.1, { d: true }, open, false, false);
    b.update(0.1, { d: true }, open, false, true);
    expect(Math.abs(b.x - 0)).toBeGreaterThan(0);
    expect(Math.hypot(b.x, b.y) / Math.hypot(a.x, a.y)).toBeCloseTo(SPRINT_MULT, 4);
  });
});

class FakeWS {
  constructor() { this.sent = []; this.readyState = 1; FakeWS.last = this; this._l = {}; }
  addEventListener(t, cb) { this._l[t] = cb; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() {}
}
FakeWS.OPEN = 1;
beforeEach(() => { globalThis.WebSocket = FakeWS; });

describe('the input frame carries the sprint flag', () => {
  function client() {
    let t = 1000;
    const c = new WorldAuthorityClient({ url: 'ws://x', token: 't', now: () => t });
    c.connect('w1', 5);
    FakeWS.last._l.open();
    return { c, tick: (ms) => { t += ms; } };
  }
  it('sends sprint: true / false on the wire and in the replay record', () => {
    const { c, tick } = client();
    const walk = c.sendInput(1, 0, 0.05, false);
    tick(100);
    const run = c.sendInput(1, 0, 0.05, true); // a change of sprint flushes like a change of direction
    const frames = FakeWS.last.sent.filter((f) => f.type === 'input');
    expect(frames.every((f) => typeof f.sprint === 'boolean')).toBe(true);
    expect(walk.inputs[0].sprint).toBe(false);
    expect(run.inputs.some((i) => i.sprint === true)).toBe(true);
  });
  it('flushes time travelled at the old speed before switching speed', () => {
    const { c, tick } = client();
    c.sendInput(1, 0, 0.05, false);
    tick(10);
    c.sendInput(1, 0, 0.05, false);      // throttled: accumulates 0.05 s of WALKING
    tick(10);
    const r = c.sendInput(1, 0, 0.05, true); // switch: the walking time must go out as walking
    const sent = FakeWS.last.sent.filter((f) => f.type === 'input');
    const flush = sent.find((f) => f.sprint === false && f.dt > 0 && f.seq > 1);
    expect(flush).toBeTruthy();
    expect(r.inputs[r.inputs.length - 1].sprint).toBe(true);
  });
});
