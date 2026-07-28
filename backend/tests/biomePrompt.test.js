const test = require('node:test');
const assert = require('node:assert');
const { composeBiomePrompt } = require('../src/services/biomePrompt');

const DUNES = {
  name: 'Arid Dunes',
  palette: ['ochre', 'gold', 'burnt sienna'],
  art_style: 'sun-bleached hand-drawn fantasy, harsh light',
  exclusions: 'no grass, no snow',
};

test('no biome leaves the base prompt untouched', () => {
  assert.equal(composeBiomePrompt('a mossy boulder', null), 'a mossy boulder');
  assert.equal(composeBiomePrompt('a mossy boulder', undefined), 'a mossy boulder');
});

test('a full biome appends palette, style and exclusions', () => {
  assert.equal(
    composeBiomePrompt('a mossy boulder', DUNES),
    'a mossy boulder, ochre, gold, burnt sienna palette, sun-bleached hand-drawn fantasy, harsh light. Avoid: no grass, no snow',
  );
});

test('an empty palette produces no dangling comma', () => {
  assert.equal(
    composeBiomePrompt('a boulder', { ...DUNES, palette: [] }),
    'a boulder, sun-bleached hand-drawn fantasy, harsh light. Avoid: no grass, no snow',
  );
});

test('an empty art_style produces no dangling comma', () => {
  assert.equal(
    composeBiomePrompt('a boulder', { ...DUNES, art_style: '   ' }),
    'a boulder, ochre, gold, burnt sienna palette. Avoid: no grass, no snow',
  );
});

test('empty exclusions produce no trailing "Avoid:"', () => {
  assert.equal(
    composeBiomePrompt('a boulder', { ...DUNES, exclusions: '' }),
    'a boulder, ochre, gold, burnt sienna palette, sun-bleached hand-drawn fantasy, harsh light',
  );
});

test('a fully empty biome is a no-op', () => {
  assert.equal(
    composeBiomePrompt('a boulder', { name: 'Blank', palette: [], art_style: '', exclusions: '' }),
    'a boulder',
  );
});

test('an empty base prompt still yields a usable string', () => {
  assert.equal(
    composeBiomePrompt('', DUNES),
    'ochre, gold, burnt sienna palette, sun-bleached hand-drawn fantasy, harsh light. Avoid: no grass, no snow',
  );
  assert.equal(composeBiomePrompt(undefined, null), '');
});

test('falsy palette entries are dropped', () => {
  assert.equal(
    composeBiomePrompt('a boulder', { palette: ['ochre', '', null, 'gold'], art_style: '', exclusions: '' }),
    'a boulder, ochre, gold palette',
  );
});
