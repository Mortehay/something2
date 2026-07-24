import { describe, it, expect } from 'vitest';
import { worldTileToView } from '../minimapRenderer.js';

describe('worldTileToView', () => {
  const view = { centerCol: 100, centerRow: 100, step: 4, cellW: 12, boxW: 180, boxH: 180 };

  it('places the center tile at the box center', () => {
    expect(worldTileToView(100, 100, view)).toEqual({ x: 90, y: 90 });
  });

  it('moves +step tiles east/south by one diamond (screen down)', () => {
    // +step cols and +step rows => dc=1, dr=1 => x offset 0, y offset cellH
    const p = worldTileToView(104, 104, view);
    expect(p.x).toBeCloseTo(90);
    expect(p.y).toBeCloseTo(90 + 12 / 2); // cellH = cellW/2 = 6
  });

  it('projects +step col alone to the lower-right in iso', () => {
    const p = worldTileToView(104, 100, view); // dc=1, dr=0
    expect(p.x).toBeCloseTo(90 + 12 / 2); // +hw
    expect(p.y).toBeCloseTo(90 + 6 / 2);  // +hh
  });
});
