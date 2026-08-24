// Every key the game claims must appear in the "How to play" panel.
//
// WHY THIS EXISTS. HELP_SECTIONS carries the comment "One place to describe the
// controls, so the panel can't drift from reality" -- and it drifted anyway.
// SOMET-476 bound `p` to the passive tree and SOMET-483 bound `c` to the
// character sheet, and neither added a help row. `b` (bank) and `f` (chest)
// had been undocumented for longer. The result was a player holding unspent
// passive points with no way in the game to discover the tree existed.
//
// A comment is not a guard. This is the guard.
//
// It parses the SAME claim patterns hotkeyRegistry.test.js does, so the two
// cannot disagree about what "claimed" means, and it reads HELP_SECTIONS out of
// the component source rather than importing GameShell -- importing it drags in
// the whole provider stack, and this assertion is about text, not rendering.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOMETHING2 = path.resolve(HERE, '..');
const GAME_JS = path.join(SOMETHING2, 'src/js/core/Game.js');
const SHELL_JSX = path.join(SOMETHING2, 'GameShell.jsx');

// WASD are movement and are documented as a single row ("Move (arrow keys also
// work)"), not as four separate letters. Excluding them here is the one
// deliberate exemption; anything else claimed must be named in the panel.
const MOVEMENT = new Set(['w', 'a', 's', 'd']);

// The same two shapes hotkeyRegistry.test.js matches. Kept in sync deliberately:
// if Game.js adopts a third idiom, BOTH files must learn it, and this one going
// quiet is exactly the failure it exists to prevent -- hence the floor below.
function claimedKeys(source) {
  const keys = new Set();
  for (const m of source.matchAll(/isKey\('([a-z])'\)/g)) keys.add(m[1]);
  for (const m of source.matchAll(/\bkey === '([a-z])'/g)) keys.add(m[1]);
  return keys;
}

// Everything between `const HELP_SECTIONS = [` and its closing `];`.
function helpSource(shell) {
  const start = shell.indexOf('const HELP_SECTIONS = [');
  expect(start, 'HELP_SECTIONS not found in GameShell.jsx').toBeGreaterThan(-1);
  const end = shell.indexOf('\n];', start);
  expect(end, 'HELP_SECTIONS has no closing bracket').toBeGreaterThan(start);
  return shell.slice(start, end);
}

describe('the How to play panel covers every claimed hotkey', () => {
  const game = fs.readFileSync(GAME_JS, 'utf8');
  const shell = fs.readFileSync(SHELL_JSX, 'utf8');
  const claimed = claimedKeys(game);
  const help = helpSource(shell);

  it('finds a plausible number of claims, so a broken regex fails loudly', () => {
    // Without this, a change to Game.js's idiom would make `claimed` empty and
    // every assertion below would pass vacuously -- the exact shape of bug this
    // whole file is about.
    expect(claimed.size).toBeGreaterThanOrEqual(6);
    expect(claimed.has('i')).toBe(true); // inventory: a claim that has always existed
  });

  it('names every claimed key, so a new binding cannot ship undiscoverable', () => {
    const documented = new Set();
    for (const m of help.matchAll(/\[\['([A-Za-z])'\]\]/g)) documented.add(m[1].toLowerCase());

    const missing = [...claimed]
      .filter((k) => !MOVEMENT.has(k) && !documented.has(k))
      .sort();

    expect(missing, `claimed but absent from How to play: ${missing.join(', ')}`).toEqual([]);
  });

  it('documents the passive tree and the character sheet by name', () => {
    // Named explicitly rather than left to the letter check: these two are the
    // reason the file exists, and a row reading only "P" would satisfy the
    // check above while telling a player nothing.
    expect(help).toMatch(/[Pp]assive skill tree/);
    expect(help).toMatch(/passive points/i);
    expect(help).toMatch(/Character sheet/);
  });
});
