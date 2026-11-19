'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classify, parseAnswer, actionsForBody, BODY_PLANS, NON_HUMANOID, catalogActionsForBody, sameBody,
} = require('../src/services/creatureBodyPlan.js');

const WOLF = { id: 1, name: 'Grey Wolf', prompt: 'a wolf' };
const ORC = { id: 2, name: 'Orc', prompt: 'an orc' };

test('parseAnswer reads one id=shape per line and ignores chatter', () => {
  const got = parseAnswer('Sure!\n1=quadruped\n 2: Humanoid \nnothing here', [WOLF, ORC]);
  assert.deepEqual([...got], [[1, 'quadruped'], [2, 'humanoid']]);
});

test('an unknown shape, an unasked id, a missing line or "undecided" stays unset', () => {
  assert.deepEqual([...parseAnswer('1=hexapod\n99=humanoid', [WOLF, ORC])], []);
  assert.deepEqual([...parseAnswer('1=undecided\n2=undecided', [WOLF, ORC])], []);
});

test('the prompt lets the model decline when the text names no body', async () => {
  let sent;
  await classify({}, [WOLF], { complete: async (_db, req) => { sent = req; return { ok: true, text: '' }; } });
  assert.match(sent.system, /undecided/);
  assert.match(sent.system, /Size words/);
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

test('blob and multileg are body values beside the old ones', () => {
  assert.deepEqual(BODY_PLANS, ['humanoid', 'quadruped', 'other', 'blob', 'multileg']);
  assert.deepEqual(NON_HUMANOID, ['quadruped', 'blob', 'multileg']);
});

test('catalogActionsForBody keeps actions whose catalog lists the body', () => {
  const cat = [{ id: 'idle', body_plans: ['humanoid', 'quadruped', 'blob'] }, { id: 'walk', body_plans: ['humanoid', 'quadruped'] }, { id: 'use' }];
  assert.deepEqual(catalogActionsForBody(['idle', 'walk', 'use'], 'blob', cat), ['idle']);
  assert.deepEqual(catalogActionsForBody(['idle', 'walk', 'use'], null, cat), ['idle', 'walk', 'use']);
  assert.deepEqual(catalogActionsForBody(['use'], 'quadruped', cat), []);
  assert.deepEqual(catalogActionsForBody(['idle'], 'multileg', cat), []);
  assert.deepEqual(catalogActionsForBody(['walk', 'idle'], 'humanoid', cat), ['walk', 'idle']);
});

test('sameBody treats no echo, null and humanoid as one body', () => {
  assert.equal(sameBody(undefined, 'humanoid'), true);
  assert.equal(sameBody(null, undefined), true);
  assert.equal(sameBody('quadruped', 'humanoid'), false);
  assert.equal(sameBody('quadruped', undefined), false);
  assert.equal(sameBody('blob', 'blob'), true);
});

test('parseAnswer reads blob and multileg', () => {
  const out = parseAnswer('1=blob\n2=multileg', [WOLF, ORC]);
  assert.equal(out.get(1), 'blob');
  assert.equal(out.get(2), 'multileg');
});

test('the prompt names blob and multileg bodies, and other no longer claims slimes or spiders', async () => {
  let sent;
  await classify({}, [WOLF], { complete: async (_db, req) => { sent = req; return { ok: true, text: '' }; } });
  assert.match(sent.system, /^blob:.*slime/im);
  assert.match(sent.system, /^multileg:.*spider.*crab/im);
  const otherLine = sent.system.split('\n').find((l) => l.startsWith('other:'));
  assert.ok(otherLine);
  assert.doesNotMatch(otherLine, /slime|spider|insect/i);
});
