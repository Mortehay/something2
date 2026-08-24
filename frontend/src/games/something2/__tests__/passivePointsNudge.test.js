// The unspent-passive-points nudge.
//
// Asserts the label, not the render: vitest runs node-env here and this HUD
// component cannot be mounted without the provider stack (the same reason
// characterSession.js and classIdentity.js exist as plain modules). The string
// IS the feature -- a player who never opens the help learns about the tree
// from this text or not at all -- so the string is what is pinned.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nudgeLabel } from '../passivePointsLabel.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEW = path.resolve(HERE, '../GameView.jsx');

describe('nudgeLabel', () => {
  it('names the key, so the nudge teaches the binding rather than just nagging', () => {
    // "press P" is the load-bearing half. A label reading "2 passive points"
    // alone would restate what the character sheet already says and still leave
    // the player without a way in -- which was the original complaint.
    expect(nudgeLabel(2)).toBe('2 passive points — press P');
  });

  it('says "point", singular, for exactly one', () => {
    expect(nudgeLabel(1)).toBe('1 passive point — press P');
  });

  it('shows nothing at zero, so a player who has spent them is not nagged', () => {
    expect(nudgeLabel(0)).toBeNull();
  });

  it('shows nothing for an unknown count rather than flashing on every join', () => {
    // `passivePoints` is absent until the first progression frame lands. If a
    // missing value read as "some", the nudge would appear for a moment on
    // every single join, including for characters with nothing to spend.
    expect(nudgeLabel(undefined)).toBeNull();
    expect(nudgeLabel(null)).toBeNull();
    expect(nudgeLabel(NaN)).toBeNull();
    expect(nudgeLabel('')).toBeNull();
  });

  it('shows nothing for a negative count', () => {
    expect(nudgeLabel(-3)).toBeNull();
  });
});

describe('the nudge is actually mounted', () => {
  // Without this, the component could be perfect and never rendered -- the
  // single most common defect in this epic (ten features live in the database,
  // rendered in the UI, and unreachable in play). An import alone is not
  // enough: it must appear in the JSX, gated on isPlaying like its neighbours.
  const view = fs.readFileSync(VIEW, 'utf8');

  it('is imported and rendered in the in-game HUD stack', () => {
    expect(view).toMatch(/import PassivePointsNudge from/);
    expect(view).toMatch(/\{isPlaying && <PassivePointsNudge gameRef=\{gameRef\} \/>\}/);
  });
});
