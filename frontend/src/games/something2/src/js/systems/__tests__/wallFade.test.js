// SOMET-783. The wall reveal fade, restored after 73bb0769 replaced it with a
// constant alpha in an unrelated commit and nothing failed.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { wallAlpha, WALL_REVEAL_R, WALL_REVEAL_ALPHA } from '../wallRenderer.js';

const wall = { x: 1000, y: 1000, depth: 2000 };

describe('wallAlpha', () => {
  it('fades for an actor behind the wall and within the reveal radius', () => {
    expect(wallAlpha(wall, [{ x: 1000 + WALL_REVEAL_R - 10, y: 1000, depth: 1900 }])).toBe(WALL_REVEAL_ALPHA);
  });
  it('stays opaque for an actor in front, one too far away, or no actors', () => {
    expect(wallAlpha(wall, [{ x: 1010, y: 1000, depth: 2100 }])).toBe(1);
    expect(wallAlpha(wall, [{ x: 1000 + WALL_REVEAL_R + 10, y: 1000, depth: 1900 }])).toBe(1);
    expect(wallAlpha(wall, [])).toBe(1);
  });
  it('keeps the original tuning (150 px, alpha 0.3)', () => {
    expect(WALL_REVEAL_R).toBe(150);
    expect(WALL_REVEAL_ALPHA).toBe(0.3);
  });
});

describe('the draw loop uses it', () => {
  // Source gate: the fade was lost once by a one-line edit in the draw loop. A
  // full renderChunked harness is far heavier than this line is worth.
  const src = readFileSync(fileURLToPath(new URL('../RenderSystem.js', import.meta.url)), 'utf8');
  it('every wall is drawn with alpha from wallAlpha over the frame actors', () => {
    expect(src).toMatch(/drawWallDrawable\(this\.ctx, d, \{[^}]*alpha: wallAlpha\(d, actors\)/);
    expect(src).not.toMatch(/drawWallDrawable\(this\.ctx, d, \{ halfW, halfH, tileCache: this\._tileCache \}\)/);
  });
});
