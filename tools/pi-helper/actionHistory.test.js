'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createActionHistory, MAX_ENTRIES } = require('./actionHistory');
const { createJobs, LOG_CAP } = require('./jobs');
const { createServer, historyRoutes } = require('./server');

const tmp = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-actions-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const until = async (fn) => { for (let i = 0; i < 400 && !fn(); i += 1) await new Promise((r) => setTimeout(r, 5)); };
const job = (n, over = {}) => ({
  id: `id${n}`, kind: 'update', state: 'ok', startedAt: `2026-11-0${(n % 9) + 1}T10:00:00.000Z`, finishedAt: `2026-11-0${(n % 9) + 1}T10:05:00.000Z`,
  steps: [{ name: 'backup', state: 'ok', detail: 'backup finished' }], log: `log of ${n}\n`, error: null, targetSha: 'b'.repeat(40), ciUrl: 'https://github.com/o/r/actions/runs/1', ...over,
});

test('a finished job is written to the history with no tab open', async (t) => {
  const file = path.join(tmp(t), 'pi-actions.jsonl');
  const history = createActionHistory({ file });
  const jobs = createJobs({ onDone: (j) => history.add(j) });
  jobs.start('restart', [{ name: 'restart', run: async ({ log }) => { log('restarting'); } }]);
  await until(() => !jobs.isRunning());
  await until(() => fs.existsSync(file));
  const [line] = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(line.kind, 'restart');
  assert.equal(line.state, 'ok');
  assert.equal(line.log, 'restarting\n');
  assert.deepEqual(Object.keys(line).sort(), ['ciUrl', 'error', 'finishedAt', 'id', 'kind', 'log', 'startedAt', 'state', 'steps', 'targetSha']);
});

test('a failed job is recorded with its error', () => {
  const history = createActionHistory({ file: null });
  history.add(job(1, { state: 'failed', error: 'The deploy failed' }));
  assert.equal(history.list()[0].state, 'failed');
  assert.equal(history.list()[0].error, 'The deploy failed');
});

test('only the last 50 are kept, newest first, and they survive a restart', (t) => {
  const file = path.join(tmp(t), 'pi-actions.jsonl');
  const a = createActionHistory({ file });
  for (let i = 0; i < 60; i += 1) a.add(job(i));
  assert.equal(MAX_ENTRIES, 50);
  const b = createActionHistory({ file });
  const ids = b.list().map((e) => e.id);
  assert.equal(ids.length, 50);
  assert.equal(ids[0], 'id59');
  assert.equal(ids[49], 'id10');
});

test('the list has no logs and the entry has the log, capped to 16 KB', () => {
  const history = createActionHistory({ file: null });
  history.add(job(1, { log: 'x'.repeat(LOG_CAP * 3) }));
  assert.ok(!('log' in history.list()[0]));
  const e = history.get('id1');
  assert.equal(e.log.length, LOG_CAP);
  assert.equal(e.steps[0].detail, 'backup finished');
});

test('a corrupt line is skipped on load', (t) => {
  const file = path.join(tmp(t), 'pi-actions.jsonl');
  fs.writeFileSync(file, `${JSON.stringify(job(1))}\nnope\n{"id":5}\n${JSON.stringify(job(2))}\n{"id":"id3","kind":"upd`);
  const h = createActionHistory({ file });
  assert.deepEqual(h.list().map((e) => e.id), ['id2', 'id1']);
});

test('the id is only compared, never used as a path', (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'secret'), 'top secret');
  const h = createActionHistory({ file: path.join(dir, 'pi-actions.jsonl') });
  h.add(job(1));
  for (const bad of ['../secret', '..%2Fsecret', '/etc/passwd', 'id1/../id1', '', 'a'.repeat(200), null, undefined, { id: 'id1' }]) assert.equal(h.get(bad), null, String(bad));
  assert.equal(h.get('id1').id, 'id1');
});

test('a write error is logged once and does not throw', (t) => {
  const dir = tmp(t);
  const logs = [];
  const h = createActionHistory({ file: path.join(dir, 'missing', 'deeper', 'x', '\0bad'), log: (m) => logs.push(m) });
  h.add(job(1)); h.add(job(2));
  assert.equal(logs.length, 1);
  assert.equal(h.list().length, 2);
});

test('GET /history and GET /history/:id through the helper server', async (t) => {
  const dir = tmp(t);
  const history = createActionHistory({ file: path.join(dir, 'pi-actions.jsonl') });
  history.add(job(1)); history.add(job(2, { state: 'failed', error: 'boom' }));
  const live = await createServer({ root: dir, runDir: dir, routes: historyRoutes(history) }).start();
  t.after(() => live.close());
  const token = fs.readFileSync(path.join(dir, 'pi-helper.token'), 'utf8').trim();
  const get = (p) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: path.join(dir, 'pi-helper.sock'), path: p, headers: { 'X-Pi-Helper-Token': token } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
    });
    req.on('error', reject); req.end();
  });
  const list = await get('/history');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.entries.map((e) => e.id), ['id2', 'id1']);
  assert.ok(list.body.entries.every((e) => !('log' in e)));
  const one = await get('/history/id1');
  assert.equal(one.body.log, 'log of 1\n');
  assert.equal((await get('/history/nope')).status, 404);
  assert.equal((await get('/history/..%2Fsecret')).status, 400);
  assert.equal((await get('/history/a%20b')).status, 400);
});
