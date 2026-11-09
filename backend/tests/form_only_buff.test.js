const test = require('node:test');
const assert = require('node:assert/strict');
const { formGate } = require('../src/authority/skillSynergy.js');

const primal = { id: 'dru_primal_metamorphosis', class: 'Druid', type: 'buff' };

test('Primal Metamorphosis is refused outside a form, before anything is spent', () => {
  const r = formGate(primal, null);
  assert.equal(r.reason, 'form');
});

test('Primal Metamorphosis is allowed in any form', () => {
  for (const f of ['bear', 'hawk', 'wolf']) assert.equal(formGate(primal, f), null);
});

test('other Druid buffs are not affected', () => {
  assert.equal(formGate({ id: 'dru_thorns_aura', class: 'Druid', type: 'buff' }, null), null);
});
