import { describe, it, expect } from 'vitest';
import { RenderSystem } from '../RenderSystem.js';
import { depthKey, worldToScreen } from '../../core/iso.js';

describe('RenderSystem.collectActors', () => {
  it('returns centre + depth for player, remotes, and creatures', () => {
    const player = { x: 0, y: 0, width: 64, height: 64 };
    const remotes = new Map([[7, { x: 100, y: 100, width: 64, height: 64 }]]);
    const creatures = [{ x: 200, y: 40, width: 32, height: 32 }];
    const actors = RenderSystem.collectActors(player, remotes, creatures);
    expect(actors).toContainEqual({ x: 32, y: 32, depth: depthKey(32, 32), sx: worldToScreen(32, 32).x, sy: worldToScreen(32, 32).y });       // player centre
    expect(actors).toContainEqual({ x: 132, y: 132, depth: depthKey(132, 132), sx: worldToScreen(132, 132).x, sy: worldToScreen(132, 132).y });   // remote
    expect(actors).toContainEqual({ x: 216, y: 56, depth: depthKey(216, 56), sx: worldToScreen(216, 56).x, sy: worldToScreen(216, 56).y });     // creature
  });
});
