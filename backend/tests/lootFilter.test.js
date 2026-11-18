'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const lf = require('../src/authority/lootFilter.js');

const TYPES = new Map([
  [1, { id: 1, category: 'weapon' }],
  [2, { id: 2, category: 'armor' }],
  [3, { id: 3, category: 'currency' }],
]);
const typeOf = (id) => TYPES.get(id) || null;

function rule(extra = {}) {
  return lf.sanitizeConfig({
    presets: [{ id: 'p', name: 'p', rules: [{ id: 'r', action: 'hide', ...extra }] }],
  }).presets[0].rules[0];
}

test('the top matching rule wins; rules below it are not consulted', () => {
  const rules = lf.sanitizeConfig({ presets: [{ id: 'p', rules: [
    { id: 'a', action: 'emphasize', conditions: { affixIds: [7] } },
    { id: 'b', action: 'hide', conditions: { rarities: ['white'] } },
  ] }] }).presets[0].rules;
  const white = { typeId: 1, rarity: 'white', itemLevel: 5, affixIds: [] };
  const whiteWithAffix = { ...white, affixIds: [7] };
  assert.equal(lf.evaluate(rules, white, typeOf).action, 'hide');
  assert.equal(lf.evaluate(rules, whiteWithAffix, typeOf).action, 'emphasize');
});

test('no matching rule gives null, so the item is drawn as before', () => {
  const rules = [rule({ conditions: { rarities: ['foxy'] } })];
  assert.equal(lf.evaluate(rules, { typeId: 1, rarity: 'white' }, typeOf), null);
  assert.equal(lf.evaluate([], { typeId: 1, rarity: 'white' }, typeOf), null);
});

test('a disabled rule is skipped', () => {
  const rules = [rule({ enabled: false, conditions: { rarities: ['white'] } })];
  assert.equal(lf.evaluate(rules, { typeId: 1, rarity: 'white' }, typeOf), null);
});

test('a rule with no conditions matches everything', () => {
  assert.equal(lf.isHidden([rule()], { typeId: 2, rarity: 'blue', itemLevel: 80 }, typeOf), true);
});

test('rarity, category and base type conditions', () => {
  const byRarity = rule({ conditions: { rarities: ['blue', 'yellow'] } });
  assert.equal(lf.ruleMatches(byRarity, { typeId: 1, rarity: 'yellow' }, typeOf), true);
  assert.equal(lf.ruleMatches(byRarity, { typeId: 1, rarity: 'foxy' }, typeOf), false);
  const byCategory = rule({ conditions: { categories: ['weapon'] } });
  assert.equal(lf.ruleMatches(byCategory, { typeId: 1, rarity: 'white' }, typeOf), true);
  assert.equal(lf.ruleMatches(byCategory, { typeId: 2, rarity: 'white' }, typeOf), false);
  assert.equal(lf.ruleMatches(byCategory, { typeId: 99, rarity: 'white' }, typeOf), false, 'unknown type cannot be proven');
  const byType = rule({ conditions: { typeIds: [2] } });
  assert.equal(lf.ruleMatches(byType, { typeId: 2, rarity: 'white' }, typeOf), true);
  assert.equal(lf.ruleMatches(byType, { typeId: 1, rarity: 'white' }, typeOf), false);
});

test('item level bounds are inclusive', () => {
  const r = rule({ conditions: { minLevel: 10, maxLevel: 20 } });
  const at = (itemLevel) => lf.ruleMatches(r, { typeId: 1, rarity: 'white', itemLevel }, typeOf);
  assert.equal(at(9), false);
  assert.equal(at(10), true);
  assert.equal(at(20), true);
  assert.equal(at(21), false);
});

test('affix conditions: any vs all', () => {
  const any = rule({ conditions: { affixIds: [1, 2], affixMode: 'any' } });
  const all = rule({ conditions: { affixIds: [1, 2], affixMode: 'all' } });
  const one = { typeId: 1, rarity: 'blue', affixIds: [2] };
  const both = { typeId: 1, rarity: 'blue', affixIds: [1, 2, 3] };
  assert.equal(lf.ruleMatches(any, one, typeOf), true);
  assert.equal(lf.ruleMatches(all, one, typeOf), false);
  assert.equal(lf.ruleMatches(all, both, typeOf), true);
  assert.equal(lf.ruleMatches(any, { typeId: 1, rarity: 'white' }, typeOf), false, 'no affixes never matches an affix rule');
});

test('sanitizeConfig rejects bad input with a readable message', () => {
  assert.throws(() => lf.sanitizeConfig(null), lf.FilterError);
  assert.throws(() => lf.sanitizeConfig({ presets: [] }), /at least one preset/);
  const one = (r) => ({ presets: [{ id: 'p', rules: [r] }] });
  assert.throws(() => lf.sanitizeConfig(one({ action: 'nuke' })), /action must be/);
  assert.throws(() => lf.sanitizeConfig(one({ action: 'show', conditions: { rarities: ['purple'] } })), /rarities/);
  assert.throws(() => lf.sanitizeConfig(one({ action: 'show', conditions: { minLevel: 50, maxLevel: 10 } })), /above maxLevel/);
  assert.throws(() => lf.sanitizeConfig(one({ action: 'show', conditions: { minLevel: 0 } })), /level must be/);
  assert.throws(() => lf.sanitizeConfig(one({ action: 'show', style: { fontSize: 99 } })), /fontSize/);
  assert.throws(() => lf.sanitizeConfig(one({ action: 'show', conditions: { affixIds: ['x'] } })), /affixIds/);
  const many = { presets: [{ id: 'p', rules: Array.from({ length: lf.MAX_RULES + 1 }, () => ({ action: 'hide' })) }] };
  assert.throws(() => lf.sanitizeConfig(many), /at most/);
});

test('sanitizeConfig normalises: bad colours dropped, ids made unique, names trimmed, active falls back', () => {
  const cfg = lf.sanitizeConfig({
    activeId: 'missing',
    presets: [
      { id: 'a', name: '  Mine  ', rules: [
        { id: 'x', action: 'emphasize', style: { textColor: '#FFAA00', bgColor: 'red', beam: true, beamColor: '#abc' } },
        { id: 'x', action: 'hide' },
      ] },
      { id: 'a', name: '' },
    ],
  });
  assert.equal(cfg.activeId, 'a');
  assert.deepEqual(cfg.presets.map((p) => p.id), ['a', 'a-2']);
  assert.equal(cfg.presets[0].name, 'Mine');
  assert.equal(cfg.presets[1].name, 'Preset 2');
  const [r1, r2] = cfg.presets[0].rules;
  assert.deepEqual([r1.id, r2.id], ['x', 'x-2']);
  assert.equal(r1.style.textColor, '#ffaa00');
  assert.equal(r1.style.bgColor, null, 'a named colour is not accepted');
  assert.equal(r1.style.beam, true);
  assert.equal(cfg.presets[0].autolootSkipHidden, true, 'defaults on');
});

test('the default config is valid and hides nothing', () => {
  const cfg = lf.sanitizeConfig(lf.defaultConfig());
  assert.equal(lf.activePreset(cfg).rules.length, 0);
  assert.equal(lf.isHidden(lf.activePreset(cfg).rules, { typeId: 1, rarity: 'white' }, typeOf), false);
});
