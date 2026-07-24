const test = require('node:test');
const assert = require('node:assert');
const { runGeneration } = require('../scripts/lib/spriteRunner.js');
const { fingerprint, resolveEntity } = require('../scripts/lib/spriteManifest.js');

const DEFAULTS = { backend: 'sd-turbo', size: [128, 160], seed: 0 };
const WOLF = { name: 'Wolf', kind: 'creature', prompt: 'a wolf', seed: 101 };
const TREE = { name: 'Tree', kind: 'object', prompt: 'a tree', seed: 301 };

function fakeClient(script) {
  return {
    calls: [],
    async startJob(token, spec) {
      this.calls.push(spec.name);
      const s = script[spec.name];
      if (s.startThrows) throw new Error('start failed');
      return { jobId: `${spec.name}-job`, route: spec.kind === 'creature' ? 'sprite-jobs' : 'entity-jobs' };
    },
    async pollJob(token, route, jobId) {
      return script[jobId.replace('-job', '')].poll;
    },
  };
}

test('generates a fresh entity and records it in the lock + report', async () => {
  const client = fakeClient({ Wolf: { poll: { status: 'done', result: { atlas_key: 'sprites/Wolf/atlas.png', manifest_key: 'sprites/Wolf/atlas.json' } } } });
  const { report, lock } = await runGeneration({
    entities: [WOLF], defaults: DEFAULTS, lock: {}, client, token: 'T',
    nameToId: { Wolf: 7 }, force: false, dryRun: false,
  });
  assert.equal(report[0].status, 'generated');
  assert.equal(report[0].atlasKey, 'sprites/Wolf/atlas.png');
  assert.equal(report[0].entityTypeId, 7);
  assert.equal(lock.Wolf.fingerprint, fingerprint(resolveEntity(DEFAULTS, WOLF)));
  assert.equal(lock.Wolf.atlas_key, 'sprites/Wolf/atlas.png');
});

test('skips an entity whose fingerprint is unchanged', async () => {
  const preLock = { Wolf: { fingerprint: fingerprint(resolveEntity(DEFAULTS, WOLF)) } };
  const client = fakeClient({});
  const { report } = await runGeneration({
    entities: [WOLF], defaults: DEFAULTS, lock: preLock, client, token: 'T',
    nameToId: {}, force: false, dryRun: false,
  });
  assert.equal(report[0].status, 'skipped');
  assert.deepEqual(client.calls, []);
});

test('--force regenerates even when unchanged', async () => {
  const preLock = { Wolf: { fingerprint: fingerprint(resolveEntity(DEFAULTS, WOLF)) } };
  const preLockWolfOriginal = JSON.parse(JSON.stringify(preLock.Wolf));
  const client = fakeClient({ Wolf: { poll: { status: 'done', result: { atlas_key: 'k', manifest_key: 'm' } } } });
  const { report, lock } = await runGeneration({
    entities: [WOLF], defaults: DEFAULTS, lock: preLock, client, token: 'T',
    nameToId: { Wolf: 7 }, force: true, dryRun: false,
  });
  assert.equal(report[0].status, 'generated');
  assert.deepEqual(client.calls, ['Wolf']);
  // Verify input lock is not mutated
  assert.deepEqual(preLock.Wolf, preLockWolfOriginal);
  // Verify returned lock is a different object
  assert.notEqual(lock, preLock);
  // Verify returned lock has the new data
  assert.equal(lock.Wolf.atlas_key, 'k');
});

test('--dry-run plans without calling the client', async () => {
  const client = fakeClient({});
  const { report, lock } = await runGeneration({
    entities: [WOLF, TREE], defaults: DEFAULTS, lock: {}, client, token: 'T',
    nameToId: { Wolf: 7 }, force: false, dryRun: true,
  });
  assert.deepEqual(report.map((r) => r.status), ['planned', 'planned']);
  assert.deepEqual(client.calls, []);
  assert.deepEqual(lock, {});
});

test('a job error is reported and does not update the lock', async () => {
  const client = fakeClient({ Wolf: { poll: { status: 'error', error: 'boom' } } });
  const { report, lock } = await runGeneration({
    entities: [WOLF], defaults: DEFAULTS, lock: {}, client, token: 'T',
    nameToId: { Wolf: 7 }, force: false, dryRun: false,
  });
  assert.equal(report[0].status, 'failed');
  assert.equal(report[0].error, 'boom');
  assert.deepEqual(lock, {});
});

test('entityTypeId is null for names with no matching row (heroes)', async () => {
  const hero = { name: 'hero_knight', kind: 'creature', prompt: 'a knight', seed: 201 };
  const client = fakeClient({ hero_knight: { poll: { status: 'done', result: { atlas_key: 'k', manifest_key: 'm' } } } });
  const { report } = await runGeneration({
    entities: [hero], defaults: DEFAULTS, lock: {}, client, token: 'T',
    nameToId: {}, force: false, dryRun: false,
  });
  assert.equal(report[0].entityTypeId, null);
});

test('startJob exception is caught, reported as failed, and does not update the lock', async () => {
  const client = fakeClient({ Wolf: { startThrows: true } });
  const { report, lock } = await runGeneration({
    entities: [WOLF], defaults: DEFAULTS, lock: {}, client, token: 'T',
    nameToId: { Wolf: 7 }, force: false, dryRun: false,
  });
  assert.equal(report[0].status, 'failed');
  assert.equal(report[0].error, 'start failed');
  assert.deepEqual(lock, {});
});
