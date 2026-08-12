import { describe, it, expect } from 'vitest';
import { movementKeys, inputVector } from '../Player.js';

// SOMET-79: movement kept running while a modal panel was open. Clicks were
// already suppressed, so the player was typing into the inventory and walking
// underneath it -- and the same vector is sent to the authority, so the
// character really did move server-side, not just on the client.
describe('movementKeys gates movement on the open panels', () => {
  const held = { w: true, d: true };

  it('passes the real keys through when no panel is open', () => {
    expect(movementKeys({ keys: held })).toBe(held);
  });

  it('reports no movement while the inventory is open', () => {
    expect(inputVector(movementKeys({ keys: held, inventoryOpen: true }))).toEqual({ dx: 0, dy: 0 });
  });

  it('reports no movement while the shop is open', () => {
    // Not in the original report, which named only the inventory -- but the
    // shop is the same kind of centred modal reading the same key map, so
    // fixing one and not the other would leave the identical bug in place.
    expect(inputVector(movementKeys({ keys: held, shopOpen: true }))).toEqual({ dx: 0, dy: 0 });
  });

  it('returns an empty MAP, not a zeroed vector', () => {
    // Prediction (Player.update) and the authority send read the keys
    // separately. Zeroing one and not the other would desync the client from
    // the server -- a worse bug than the one being fixed -- so the gate has to
    // happen at the key map both of them consume.
    expect(movementKeys({ keys: held, inventoryOpen: true })).toEqual({});
  });

  it('survives a missing or empty state without throwing', () => {
    expect(movementKeys(null)).toEqual({});
    expect(movementKeys({})).toEqual({});
  });
});
