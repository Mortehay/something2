import { describe, it, expect } from 'vitest';
import PlayerWorldMap from '../PlayerWorldMap.jsx';

// playerWorldMap.test.js reads this file as SOURCE TEXT, which never executes
// its imports -- a bad import path or a syntax error there would pass every
// assertion in that file and only surface in the browser. This actually
// evaluates the module.
describe('PlayerWorldMap', () => {
  it('is a component export', () => {
    expect(typeof PlayerWorldMap).toBe('function');
  });
});
