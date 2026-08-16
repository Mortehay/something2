import { describe, it, expect, afterEach } from 'vitest';
import {
  elementColor, elementTint, configureElements, resetElements, DEFAULT_ELEMENT_COLOR,
} from '../elements.js';

afterEach(() => resetElements());

describe('the built-in palette', () => {
  it('is exactly what was on screen before the catalog existed', () => {
    // These are the values the two retired literals held. If a refactor
    // changes them, every projectile, ring and burn tint in the game changes
    // colour for anyone whose server has not sent a catalog.
    expect(elementColor('arcane')).toBe('#9b5de5');
    expect(elementColor('fire')).toBe('#f4763b');
    expect(elementColor('ice')).toBe('#5bc0f8');
    expect(elementColor('lightning')).toBe('#f4d35e');
    expect(elementTint('fire')).toBe('#ff9a4d');
    expect(elementTint('arcane')).toBe('#c08cff');
  });

  it('gives an unknown element the default colour and no tint', () => {
    expect(elementColor('void')).toBe(DEFAULT_ELEMENT_COLOR);
    expect(elementColor(null)).toBe(DEFAULT_ELEMENT_COLOR);
    expect(elementTint('void')).toBeNull();
  });

  it('leaves physical untinted so an effect keeps its own colour', () => {
    expect(elementTint('physical')).toBeNull();
  });
});

describe('configureElements', () => {
  it('applies a served catalog', () => {
    configureElements([
      { name: 'fire', color: '#ff0000', tint: '#ff8888' },
      { name: 'void', color: '#101010', tint: null },
    ]);
    expect(elementColor('fire')).toBe('#ff0000');
    expect(elementTint('fire')).toBe('#ff8888');
  });

  it('lets the server add an element the client has never heard of', () => {
    // AC 3: adding an element must need no frontend change.
    expect(elementColor('void')).toBe(DEFAULT_ELEMENT_COLOR);
    configureElements([{ name: 'void', color: '#101010', tint: '#404040' }]);
    expect(elementColor('void')).toBe('#101010');
    expect(elementTint('void')).toBe('#404040');
  });

  it('honours a catalog that says an element has NO tint', () => {
    // The subtle one: skipping null tints instead of storing them would let
    // the built-in table show through and tint an element the catalog says
    // must not be tinted.
    configureElements([{ name: 'fire', color: '#ff0000', tint: null }]);
    expect(elementTint('fire')).toBeNull();
  });

  it('ignores a missing, empty or unusable catalog rather than blanking the palette', () => {
    // Applying an empty list would leave every element resolving to the same
    // fallback yellow -- which reads as a rendering bug, not a missing table.
    for (const junk of [undefined, null, [], 'nope', {}, [{}], [{ name: '' }], [{ name: 'fire' }]]) {
      configureElements(junk);
      expect(elementColor('fire')).toBe('#f4763b');
      expect(elementColor('ice')).toBe('#5bc0f8');
    }
  });

  it('does not let one catalog leak into the next after a reset', () => {
    configureElements([{ name: 'fire', color: '#ff0000', tint: null }]);
    expect(elementColor('fire')).toBe('#ff0000');
    resetElements();
    expect(elementColor('fire')).toBe('#f4763b');
  });
});
