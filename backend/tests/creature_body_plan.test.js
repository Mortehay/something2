'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, parseAnswer, actionsForBody } = require('../src/services/creatureBodyPlan.js');

const WOLF = { id: 1, name: 'Grey Wolf', prompt: 'a wolf' };
const ORC = { id: 2, name: 'Orc', prompt: 'an orc' };

test('parseAnswer reads one id=shape per line and ignores chatter', () => {
  const got = parseAnswer('Sure!\n1=quadruped\n 2: Humanoid \nnothing here', [WOLF, ORC]);
  assert.deepEqual([...got], [[1, 'quadruped'], [2, 'humanoid']]);
});

test('an unknown shape, an unasked id or a missing line stays undecided', () => {
  assert.deepEqual([...parseAnswer('1=hexapod\n99=humanoid', [WOLF, ORC])], []);
});

test('classify sends every creature and surfaces a busy provider', async () => {
  let sent;
  const got = await classify({}, [WOLF, ORC], {
    complete: async (_db, req) => { sent = req; return { ok: true, text: '1=quadruped\n2=humanoid' }; },
  });
  assert.equal(got.get(1), 'quadruped');
  assert.match(sent.prompt, /1: Grey Wolf - a wolf/);
  assert.match(sent.prompt, /2: Orc - an orc/);
  await assert.rejects(
    classify({}, [WOLF], { complete: async () => ({ ok: false, busy: true, error: 'held' }) }),
    (err) => err.busy === true && /held/.test(err.message),
  );
});

test('a four-legged body drops the actions that need hands', () => {
  assert.deepEqual(actionsForBody(['idle', 'cast', 'walk', 'use'], 'quadruped'), ['idle', 'walk']);
  assert.deepEqual(actionsForBody(['cast'], 'quadruped'), ['idle']);
  assert.deepEqual(actionsForBody(['cast'], 'humanoid'), ['cast']);
  assert.deepEqual(actionsForBody(['cast'], null), ['cast']);
});
