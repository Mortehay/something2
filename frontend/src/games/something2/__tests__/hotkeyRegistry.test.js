import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// No two window keydown listeners may claim the same unmodified letter
// (SOMET-293 review, finding 1).
//
// WHY THIS TEST EXISTS. Slice F bound plain T to the waypoint travel popup in
// WaypointTravel.jsx while Game.js already bound plain T to the dev tile-texture
// toggle. Both are `window.addEventListener('keydown', ...)` with no state gate
// between them, so both fired: the panel opened AND the map went flat-coloured,
// with the explanatory toast hidden behind the panel's own backdrop. Every
// runtime test in this repo runs under vitest's node environment, so no test can
// mount both files and watch them collide -- and the two authors of a collision
// are by definition working in different files, so review is the only other
// place it could be caught. This reads the sources instead.
//
// WHY IT IS NOT A GREP FOR A TOKEN. A grep that looks for a string it can find
// in its own import line proves nothing; this project has shipped two of those
// this epic. This one PARSES: it discovers every file that registers a window
// keydown listener, extracts the letter each one claims and whether the claim is
// modified, and then asserts three things -- that every discovered file yielded
// at least one claim (so a file written in a shape the parser does not know
// fails loudly instead of counting as "claims nothing"), that the specific
// binding this finding moved is where it should be, and that no letter is
// claimed plain by two files.
//
// WHAT IT CANNOT DO. It sees the letter, not the runtime guards around it. Two
// handlers on the same letter that are genuinely exclusive (one only while a
// panel is open, say) would fail here and would have to be taught to the
// KNOWN_EXCLUSIVE list below with a reason -- deliberately, because that is a
// claim worth arguing for in review rather than assuming.

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../../..'); // frontend/src

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// The two shapes this codebase writes a hotkey in.
//
//   Game.js (one big handler, `const key = e.key.toLowerCase()` up top):
//       if (key === 'g' && ...)              -- plain
//       if (key === 'm' && e.shiftKey && ...) -- modified
//
//   The React panels (Minimap, WaypointTravel), each an early
//   return that rejects everything but its own unmodified letter:
//       if (e.key.toLowerCase() !== 'm' || e.shiftKey || ...) return;
//
// Escape and the arrow keys are out of scope on purpose: several panels listen
// for Escape in the CAPTURE phase and call stopImmediatePropagation precisely so
// that only the topmost one acts, which is a deliberate shared claim rather than
// a collision. Only single letters are registered here.
const MODIFIED = /\bkey === '([a-z])'\s*&&\s*e\.shiftKey/g;
const GAME_PLAIN = /\bkey === '([a-z])'(?!\s*&&\s*e\.shiftKey)/g;
const PANEL_PLAIN = /e\.key\.toLowerCase\(\)\s*!==\s*'([a-z])'\s*\|\|\s*e\.shiftKey/g;
// THE THIRD SHAPE (bfd67ab, SOMET-349). The panels moved to a layout-independent
// test -- `(e.key || '').toLowerCase() === 'm' || e.code === 'KeyM'` -- so a
// Cyrillic or AZERTY layout, where e.key is not the letter printed on the key,
// still opens the panel. PANEL_PLAIN stopped matching any of them, which is
// exactly the "no hotkey shape was recognised" failure this file promises to
// raise rather than pass quietly. Taught, not relaxed: the claim is still the
// letter, read here off e.code.
const PANEL_CODE = /e\.code === 'Key([A-Z])'/g;
// THE FOURTH SHAPE, same commit. Game.js folded its two reads into one helper,
// `const isKey = (target) => key === target || codeKey === target`, so its
// claims now read `isKey('g')` instead of `key === 'g'`. Without this the file
// with the MOST hotkeys in the codebase claimed none of them, and the
// collision check below was comparing the panels against an empty set.
const GAME_ISKEY_MODIFIED = /isKey\('([a-z])'\)\s*&&\s*e\.shiftKey/g;
const GAME_ISKEY_PLAIN = /isKey\('([a-z])'\)(?!\s*&&\s*e\.shiftKey)/g;

// Letters a second handler may legitimately claim, each with the reason it is
// exclusive of the first. Empty today; adding to it is a review decision.
const KNOWN_EXCLUSIVE = new Set();

function claimsIn(source) {
  const plain = new Set();
  const modified = new Set();
  for (const m of source.matchAll(MODIFIED)) modified.add(m[1]);
  for (const m of source.matchAll(GAME_ISKEY_MODIFIED)) modified.add(m[1]);
  for (const m of source.matchAll(GAME_PLAIN)) plain.add(m[1]);
  for (const m of source.matchAll(GAME_ISKEY_PLAIN)) plain.add(m[1]);
  for (const m of source.matchAll(PANEL_PLAIN)) plain.add(m[1]);
  for (const m of source.matchAll(PANEL_CODE)) plain.add(m[1].toLowerCase());
  // A letter matched by both regexes is modified-only: GAME_PLAIN's lookahead
  // handles `&& e.shiftKey` written immediately after, but not a longer form.
  for (const k of modified) plain.delete(k);
  return { plain, modified };
}

describe('window keydown hotkeys', () => {
  const listeners = walk(SRC)
    .filter((f) => /addEventListener\(\s*['"]keydown['"]/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => ({ file: path.relative(SRC, f), ...claimsIn(fs.readFileSync(f, 'utf8')) }));

  it('finds the files that bind keys at all', () => {
    // If the discovery walk breaks -- a moved directory, a renamed extension --
    // every assertion below passes over an empty list. This is the fixed point
    // that makes the rest mean something.
    //
    // The bound was 4 until SOMET-483 deleted CharacterSheet.jsx, the standalone
    // level popup, and moved its C binding into Game.js's own handler. LOWERED,
    // not deleted -- and the three surviving claimants are named below, so a
    // discovery walk that silently found only one of them fails here rather
    // than passing a weakened count.
    expect(listeners.length).toBeGreaterThanOrEqual(3);
    const files = listeners.map((l) => l.file);
    expect(files).toContain('games/something2/Minimap.jsx');
    expect(files).toContain('games/something2/WaypointTravel.jsx');
    expect(files).toContain('games/something2/src/js/core/Game.js');
    expect(files).not.toContain('games/something2/CharacterSheet.jsx');
  });

  it('gives C to exactly one handler -- Game.js, which opens the Character tab', () => {
    // The deleted popup owned C. Reusing it rather than retiring it keeps the
    // player's muscle memory, and this pins that the reuse did not create a
    // second claimant.
    const byFile = Object.fromEntries(listeners.map((l) => [l.file, l]));
    expect([...byFile['games/something2/src/js/core/Game.js'].plain]).toContain('c');
    expect(listeners.filter((l) => l.plain.has('c'))).toHaveLength(1);
  });

  it('parses a claim out of every file that registers one', () => {
    // A file the parser does not understand yields no claims and would sail
    // through the collision check below. Fail on it here instead, so the next
    // hotkey written in a new shape teaches this test rather than escaping it.
    const silent = listeners
      .filter((l) => l.plain.size === 0 && l.modified.size === 0)
      .map((l) => l.file);
    expect(silent, 'these files bind keydown but no hotkey shape was recognised '
      + '-- teach the regexes above, do not delete this assertion').toEqual([]);
  });

  it('leaves plain T to the travel popup and the dev texture toggle on Shift+T', () => {
    const byFile = Object.fromEntries(listeners.map((l) => [l.file, l]));
    const game = byFile['games/something2/src/js/core/Game.js'];
    const travel = byFile['games/something2/WaypointTravel.jsx'];
    expect([...travel.plain]).toContain('t');
    expect([...game.modified]).toContain('t');
    expect([...game.plain]).not.toContain('t');
  });

  it('gives no unmodified letter to two handlers', () => {
    const owners = new Map();
    const collisions = [];
    for (const l of listeners) {
      for (const k of l.plain) {
        if (KNOWN_EXCLUSIVE.has(k)) continue;
        if (owners.has(k)) collisions.push(`'${k}': ${owners.get(k)} and ${l.file}`);
        else owners.set(k, l.file);
      }
    }
    expect(collisions, 'two window keydown listeners fire on the same key; both '
      + 'will run (see this file\'s header for what that looked like last time)').toEqual([]);
  });
});
