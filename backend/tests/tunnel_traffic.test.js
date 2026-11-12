const test = require('node:test');
const assert = require('node:assert');
const { createTunnelTraffic } = require('../src/services/tunnelTraffic.js');

const CF = 'quiet-fox-1.trycloudflare.com';
const NG = 'my-game.ngrok.app';

test('counts only matching hosts', () => {
  const t = createTunnelTraffic();
  t.noteConnection({ host: `${CF}:443`, userId: 1 });
  t.noteConnection({ host: CF.toUpperCase(), userId: 2 });
  t.noteConnection({ host: 'localhost:15173', userId: 3 });
  t.noteConnection({ host: NG, userId: 4 });
  t.noteConnection({ host: undefined, userId: 5 });
  assert.strictEqual(t.countFor(CF), 2);
  assert.strictEqual(t.countFor(`${CF}:8443`), 2, 'the port is ignored on the lookup side too');
  assert.strictEqual(t.countFor(NG), 1);
  assert.deepStrictEqual(t.usersFor(CF).sort(), [1, 2]);
  assert.strictEqual(t.countFor('other.trycloudflare.com'), 0);
});

test('release decrements once; usersFor is distinct ids', () => {
  const t = createTunnelTraffic();
  const a = t.noteConnection({ host: CF, userId: '7' });
  const b = t.noteConnection({ host: CF, userId: 7 });
  t.noteConnection({ host: CF, userId: 8 });
  assert.strictEqual(t.countFor(CF), 3);
  assert.deepStrictEqual(t.usersFor(CF).sort(), [7, 8]);
  a();
  a(); // a second release is a no-op
  assert.strictEqual(t.countFor(CF), 2);
  assert.deepStrictEqual(t.usersFor(CF).sort(), [7, 8], 'user 7 still has a socket');
  b();
  assert.strictEqual(t.countFor(CF), 1);
  assert.deepStrictEqual(t.usersFor(CF), [8]);
});

test('errors are drained once, with the host normalised and a time', () => {
  const t = createTunnelTraffic({ now: () => 1000 });
  t.noteError({ host: `${NG}:443`, kind: 'http_5xx', detail: 'GET /api/x 502' });
  t.noteError({ host: CF, kind: 'ws_refused', detail: 'bad token' });
  const got = t.takeErrors();
  assert.deepStrictEqual(got, [
    { host: NG, kind: 'http_5xx', detail: 'GET /api/x 502', at: new Date(1000).toISOString() },
    { host: CF, kind: 'ws_refused', detail: 'bad token', at: new Date(1000).toISOString() },
  ]);
  assert.deepStrictEqual(t.takeErrors(), []);
});

test('the error buffer is bounded and bad input never throws', () => {
  const t = createTunnelTraffic();
  for (let i = 0; i < 5000; i += 1) t.noteError({ host: CF, kind: 'http_5xx', detail: String(i) });
  const got = t.takeErrors();
  assert.ok(got.length <= 500);
  assert.strictEqual(got[got.length - 1].detail, '4999', 'the newest are kept');
  assert.doesNotThrow(() => t.noteError(null));
  assert.doesNotThrow(() => t.noteConnection(null)());
});

test('module default instance has the brief interface', () => {
  const m = require('../src/services/tunnelTraffic.js');
  for (const f of ['noteConnection', 'countFor', 'usersFor', 'noteError', 'takeErrors']) assert.strictEqual(typeof m[f], 'function', f);
});

test('index.js notes a 5xx with its Host and path (no query) and leaves the response alone', async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(48);
  const request = require('supertest');
  const { app } = require('../src/index.js');
  const shared = require('../src/services/tunnelTraffic.js');
  app.get('/__tunnel_traffic_probe/:code', (req, res) => res.status(Number(req.params.code)).json({ ok: false }));
  shared.takeErrors();
  const r = await request(app).get('/__tunnel_traffic_probe/502?token=secret').set('Host', `${CF}:443`);
  assert.strictEqual(r.status, 502);
  assert.deepStrictEqual(r.body, { ok: false });
  await request(app).get('/__tunnel_traffic_probe/404').set('Host', CF);
  const errs = shared.takeErrors();
  assert.deepStrictEqual(errs.map((e) => [e.host, e.kind, e.detail]), [[CF, 'http_5xx', 'GET /__tunnel_traffic_probe/502 502']]);
});

test('takeSeen: short visits between takes are kept, with the most at once; drained to what is live', () => {
  const t = createTunnelTraffic();
  const a = t.noteConnection({ host: CF, userId: 1 });
  const b = t.noteConnection({ host: CF, userId: 2 });
  t.noteConnection({ host: CF, userId: 2 }); // a second tab is the same account
  a(); b();
  t.noteConnection({ host: 'localhost', userId: 9 });
  const seen = t.takeSeen();
  assert.deepStrictEqual(seen[CF].users.sort(), [1, 2]);
  assert.strictEqual(seen[CF].peak, 2);
  const again = t.takeSeen();
  assert.deepStrictEqual(again[CF].users, [2], 'after a take only who is still connected');
  assert.strictEqual(again[CF].peak, 1);
});

test('restore puts taken errors and seen accounts back (a failed write loses nothing)', () => {
  const t = createTunnelTraffic({ now: () => 5 });
  t.noteError({ host: CF, kind: 'http_5xx', detail: 'a' });
  const r = t.noteConnection({ host: CF, userId: 3 });
  r();
  const errors = t.takeErrors();
  const seen = t.takeSeen();
  t.noteError({ host: CF, kind: 'http_5xx', detail: 'b' });
  t.restore({ errors, seen });
  assert.deepStrictEqual(t.takeErrors().map((e) => e.detail), ['a', 'b']);
  const s = t.takeSeen();
  assert.deepStrictEqual(s[CF].users, [3]);
  assert.strictEqual(s[CF].peak, 1);
});
