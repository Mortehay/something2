'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTunnelTracker } = require('./tunnelUsage');

const T0 = Date.parse('2026-11-05T10:00:00Z');
const off = { state: 'off', url: null, verified: false, ageSeconds: null };
const ng = (outBytes, requests) => ({ state: 'on', url: 'https://n.ngrok-free.dev', verified: true, ageSeconds: 5, counters: { outBytes, requests } });
const cf = (url, ageSeconds = 0, verified = true) => ({ state: 'on', url: verified ? url : null, verified, ageSeconds });
const status = (ngrok, cloudflare = off, online = true) => ({ online, tunnels: { ngrok, cloudflare } });

function rig(file = null) {
  let t = T0;
  const tracker = createTunnelTracker({ file, now: () => t });
  return { tracker, set: (v) => { t = v; }, advance: (ms) => { t += ms; } };
}

test('ngrok usage adds up deltas, and a new container counts from zero', () => {
  const { tracker } = rig();
  tracker.apply(status(ng(100_000_000, 100)));
  let u = tracker.apply(status(ng(250_000_000, 150))).tunnels.ngrok.usage;
  assert.equal(u.outBytes, 250_000_000);
  assert.equal(u.requests, 150);
  // Counters fell: a recreated container, so all it shows is new traffic.
  u = tracker.apply(status(ng(50_000_000, 10))).tunnels.ngrok.usage;
  assert.equal(u.outBytes, 300_000_000);
  assert.equal(u.requests, 160);
  assert.equal(u.outPercent, 30);
  assert.equal(u.requestPercent, 1);
});

test('stopping ngrok keeps the month, and the next container is not subtracted from the old one', () => {
  const { tracker } = rig();
  tracker.apply(status(ng(400_000_000, 10)));
  assert.equal(tracker.apply(status(off)).tunnels.ngrok.usage.outBytes, 400_000_000);
  const u = tracker.apply(status(ng(500_000_000, 20))).tunnels.ngrok.usage;
  assert.equal(u.outBytes, 900_000_000, 'a bigger counter on a new container is all new, not 100 MB');
  assert.equal(u.requests, 30);
});

test('a percentage never reads above 100', () => {
  const { tracker } = rig();
  const u = tracker.apply(status(ng(5_000_000_000, 90_000))).tunnels.ngrok.usage;
  assert.equal(u.outPercent, 100);
  assert.equal(u.requestPercent, 100);
});

test('the raw counters do not reach the tab', () => {
  const { tracker } = rig();
  assert.equal(tracker.apply(status(ng(1, 1))).tunnels.ngrok.counters, undefined);
});

test('a new calendar month restarts the estimate, and only ngrok itself clears the limit', () => {
  const { tracker, set } = rig();
  tracker.apply(status(ng(900_000_000, 100)));
  tracker.noteNgrokAnswer('ERR_NGROK_725');
  assert.equal(tracker.apply(status(ng(900_000_000, 100))).tunnels.ngrok.limitReached, true);
  set(Date.parse('2026-12-01T00:00:10Z'));
  const n = tracker.apply(status(ng(900_000_500, 101))).tunnels.ngrok;
  assert.equal(n.limitReached, true, "ngrok's cycle need not follow the calendar");
  assert.equal(n.usage.month, '2026-12');
  assert.equal(n.usage.outBytes, 500, 'only what moved since the last reading belongs to the new month');
  assert.equal(n.usage.requests, 1);
});

test('either ngrok limit code marks the limit, and a served request clears it', () => {
  for (const code of ['ERR_NGROK_725', 'ERR_NGROK_727']) {
    const { tracker } = rig();
    tracker.noteNgrokAnswer(code);
    assert.equal(tracker.apply(status(off)).tunnels.ngrok.limitReached, true, code);
    tracker.noteNgrokAnswer(null);
    assert.equal(tracker.apply(status(off)).tunnels.ngrok.limitReached, false, code);
  }
  const other = rig().tracker;
  other.noteNgrokAnswer('ERR_NGROK_8012');
  assert.equal(other.apply(status(off)).tunnels.ngrok.limitReached, false, 'an unrelated refusal is not the limit');
  other.noteNgrokAnswer('ERR_NGROK_725');
  other.noteNgrokAnswer('ERR_NGROK_334');
  assert.equal(other.apply(status(off)).tunnels.ngrok.limitReached, true, 'nor does it clear the limit');
});

test('a Cloudflare link that changed address is recorded with how long it lasted', () => {
  const { tracker, advance } = rig();
  tracker.apply(status(off, cf('https://a.trycloudflare.com', 3600)));
  advance(2 * 3600_000);
  tracker.apply(status(off, cf('https://a.trycloudflare.com', 3600 + 7200)));
  advance(60_000);
  const out = tracker.apply(status(off, cf('https://b.trycloudflare.com', 10))).tunnels.cloudflare;
  assert.deepEqual(out.pastLinkSeconds, [3 * 3600], 'an hour before the first reading plus two hours answered');
});

test('a healthy link stopped on purpose is not a lifetime; one already dead is', () => {
  const healthy = rig();
  healthy.tracker.apply(status(off, cf('https://a.trycloudflare.com', 100)));
  healthy.advance(60_000);
  assert.deepEqual(healthy.tracker.apply(status(off, off)).tunnels.cloudflare.pastLinkSeconds, []);

  const dead = rig();
  dead.tracker.apply(status(off, cf('https://a.trycloudflare.com', 100)));
  dead.advance(10 * 60_000);
  dead.tracker.apply(status(off, cf(null, 700, false)));
  assert.deepEqual(dead.tracker.apply(status(off, off)).tunnels.cloudflare.pastLinkSeconds, [100]);
});

test('an offline board closes nothing and forgets no counter', () => {
  const { tracker, advance } = rig();
  tracker.apply(status(ng(100, 1), cf('https://a.trycloudflare.com', 100)));
  advance(10 * 60_000);
  const offline = tracker.apply(status(off, off, false));
  assert.deepEqual(offline.tunnels.cloudflare.pastLinkSeconds, []);
  assert.equal(offline.tunnels.ngrok.usage.outBytes, 100, 'still shown while offline');
  assert.equal(tracker.apply(status(ng(150, 2), cf('https://a.trycloudflare.com', 800))).tunnels.ngrok.usage.outBytes, 150);
});

test('usage and links survive a helper restart', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tunnels-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'pi-tunnels.json');
  const a = rig(file);
  a.tracker.apply(status(ng(100, 5)));
  a.tracker.noteNgrokAnswer('ERR_NGROK_725');
  const b = rig(file);
  const n = b.tracker.apply(status(ng(160, 7))).tunnels.ngrok;
  assert.equal(n.usage.outBytes, 160, 'traffic while the helper was down is still counted');
  assert.equal(n.usage.requests, 7);
  assert.equal(n.limitReached, true);
  assert.equal((fs.statSync(file).mode & 0o777), 0o600);
});

test('an unreadable state file starts over rather than failing', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tunnels-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'pi-tunnels.json');
  fs.writeFileSync(file, '{not json');
  assert.equal(rig(file).tracker.apply(status(ng(5, 1))).tunnels.ngrok.usage.outBytes, 5);
});
