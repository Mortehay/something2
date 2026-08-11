import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// F-046/SOMET-226: the Worlds picker's delete-world trash icon and the
// world-creation form were rendered unconditionally, so a non-admin player
// saw a destructive-looking, admin-only control that the backend correctly
// rejects with 403 -- a UI gating bug, not a security hole, but a real UX
// defect (a control that looks available and then silently fails).
//
// Something2.jsx has since been split; the Worlds picker now lives in
// GameView.jsx. The guarded JSX moved verbatim, so both assertions still apply.
//
// GameView.jsx isn't rendered in tests (vitest here runs in a plain node
// environment, no jsdom/RTL), so this is a source-structure regression test:
// it asserts the destructive controls are lexically wrapped in the same
// `isAdmin &&` guard already used for the admin-only nav entries, rather than a
// rendered-DOM assertion.
const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '../GameView.jsx'), 'utf8');

// SOMET-262 widened this file, and the reason is worth stating: the two
// assertions below pinned exactly the two controls SOMET-226 had fixed --
// the trash icon and the create form -- and said NOTHING about the world list
// or the Enter World button they sit inside. Both stayed ungated, so a
// player-role account carried all 86 world names, seeds and chunk sizes in its
// DOM, and this file was green the entire time.
//
// A guard that pins only what was already fixed is not a guard; it is a record
// of a past fix. The assertion added here is about the CONTAINER, so a future
// change that gates the pieces individually and forgets the panel cannot pass.

describe('Worlds picker admin gating', () => {
  it('gates the delete-world trash icon behind isAdmin', () => {
    expect(source).toMatch(/\{isAdmin\s*&&\s*\(\s*<HiOutlineTrash/);
  });

  it('gates the world-creation form behind isAdmin', () => {
    expect(source).toMatch(/\{isAdmin\s*&&\s*\(\s*<div style=\{\{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '15px' \}\}>/);
  });

  it('gates the ENTIRE picker overlay behind isAdmin, not just the controls inside it', () => {
    // The world list and the Enter World button have no guard of their own --
    // they are gated by this one wrapper. Asserting the wrapper is what makes
    // the whole panel covered rather than three separately-forgettable pieces.
    expect(source).toMatch(/\{!isPlaying\s*&&\s*isAdmin\s*&&\s*\(\s*<UIOverlay>/);
  });

  it('renders the world list and Enter World button ONLY inside that overlay', () => {
    // Belt and braces against the gate being satisfied by a second, ungated
    // copy of the picker elsewhere in the file: there must be exactly one
    // UIOverlay and one Enter World button, so the wrapper above governs them.
    expect(source.match(/<UIOverlay>/g) || []).toHaveLength(1);
    expect(source.match(/Enter World \(chunked\)/g) || []).toHaveLength(1);
    expect(source.match(/worlds\?\.map\(/g) || []).toHaveLength(1);
  });

  it('leaves a player a way out when a join fails', () => {
    // Removing the picker removed the escape hatch enterWorld's own comment
    // called "a safe fallback": the auto-join effect sets autoJoinedRef BEFORE
    // awaiting enterWorld, so a failed join never retries, and a player was
    // left with an active character, isPlaying false, and no control at all.
    // Reproduced live via "kicked: signed in elsewhere".
    expect(source).toMatch(/\{!isPlaying\s*&&\s*!isAdmin\s*&&\s*activeCharacter\s*&&\s*\(/);
    // Both routes out, not one: retry the same world, or go back to the picker.
    expect(source).toMatch(/<RecoveryPanel/);
    expect(source).toMatch(/onClick=\{changeCharacter\}/);
  });

  it('refuses to offer Enter World without an active character', () => {
    // GameShell's enterWorld opens `if (!activeCharacter) return false;` -- a
    // SILENT refusal. The picker appears in exactly that state, so without
    // this the button is dead and indistinguishable from one that worked.
    expect(source).toMatch(/disabled=\{!selectedWorldId \|\| !activeCharacter\}/);
    expect(source).toMatch(/Choose a character first/);
  });
});
