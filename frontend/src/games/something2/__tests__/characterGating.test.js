import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-text regression tests, matching ui/__tests__/authGating.test.js.
// vitest runs in a plain node environment in this project, so none of these
// modules can be rendered or socket-tested here. Each assertion below
// corresponds to a specific way the wiring can go INERT while every other test
// still passes -- which is the failure mode this epic invites, since a join
// refused for a missing character never sends 'joined' and the client simply
// sits there.
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, rel), 'utf8');

describe('the join frame carries a character id', () => {
  it('WorldAuthorityClient sends character_id, not just world_id', () => {
    const source = read('../src/js/net/WorldAuthorityClient.js');
    expect(source).toMatch(/type:\s*['"]join['"][\s\S]{0,120}character_id/);
  });

  it('connect refuses to open a socket without one', () => {
    // Opening anyway produces a server-side refusal the player sees as an
    // unactionable toast; failing here is louder and closer to the cause.
    const source = read('../src/js/net/WorldAuthorityClient.js');
    expect(source).toMatch(/connect\(worldId, characterId\)/);
    expect(source).toMatch(/requires a character id/);
  });

  it('Game.initChunked accepts and forwards a characterId', () => {
    const source = read('../src/js/core/Game.js');
    expect(source).toMatch(/initChunked\(\{[^}]*characterId/);
    expect(source).toMatch(/connect\(worldId, characterId\)/);
  });
});

// Read once at module scope: two separate describes assert against GameShell,
// and a copy scoped inside one of them is not visible to the other.
const gameShellSource = read('../GameShell.jsx');

describe('GameShell gates the canvas behind a character', () => {
  const source = gameShellSource;

  it('actually RENDERS CharacterSelect, not merely imports it', () => {
    // This assertion used to be `toMatch(/CharacterSelect/)`, which the import
    // line satisfied on its own. GameShell imported the component and never
    // rendered it: the whole character gate was inert, the suite was green, and
    // a player logging in landed on the raw world list. Caught in the browser,
    // which is the only place this component executes at all.
    expect(source).toMatch(/<CharacterSelect\b/);
  });

  it('gates the picker on the RESOLVED character, not the stored id', () => {
    // `!activeCharacterId` would send a player whose character was deleted on
    // another device straight into a join the server refuses -- and a refused
    // join never sends `joined`, so the client just sits there.
    expect(source).toMatch(/!isPlaying && !activeCharacter\b(?!Id)/);
  });

  it('passes the picker the props it needs to honour the cap', () => {
    expect(source).toMatch(/<CharacterSelect[\s\S]{0,240}maxCharacters=\{maxCharacters\}/);
    expect(source).toMatch(/<CharacterSelect[\s\S]{0,240}onPlay=\{playCharacter\}/);
  });

  it('passes the active character into initChunked', () => {
    expect(source).toMatch(/characterId:/);
  });

  it('still uses an END match on /game', () => {
    // Pinned by ui/__tests__/authGating.test.js too; repeated here because this
    // task edits the same component and the two files are read independently.
    expect(source).toMatch(/useMatch\('\/game'\)/);
    expect(source).not.toMatch(/useMatch\('\/game\/\*'\)/);
  });

  it('keeps the canvas mounted rather than unmounting it behind the picker', () => {
    // The canvas element must stay rendered unconditionally with a display
    // toggle. Replacing it with `{active && <canvas/>}` would recreate the
    // element RenderSystem captured, and the running loop would draw into a
    // detached node -- the exact bug the comment above that canvas describes.
    expect(source).toMatch(/display:\s*isGameRoute && isPlaying \? 'block' : 'none'/);
  });
});

describe('auto-join waits for a character', () => {
  it('GameShell actually SUPPLIES hasCharacter to autoJoinTarget', () => {
    // The guard below lived in autoJoinTarget while this call site never passed
    // the flag, so it arrived `undefined` and auto-join returned null for
    // EVERY player. The pure-function test passed the flag explicitly and was
    // green the whole time -- a guard is only real if its input is wired.
    expect(gameShellSource).toMatch(/autoJoinTarget\(\{[\s\S]{0,600}hasCharacter:/);
  });

  it('re-runs the auto-join effect when the character changes', () => {
    // Choosing a character is the LAST input to become ready. Without it in
    // the dependency array the effect never fires again after the picker
    // closes, and the player is stranded on the world list.
    expect(gameShellSource).toMatch(/isAdmin, isPlaying, isGameRoute, activeCharacter\]/);
  });

  it('autoJoinTarget refuses without one', async () => {
    const { autoJoinTarget } = await import('../autoJoin.js');
    const ready = {
      isAdmin: false, isPlaying: false, alreadyJoined: false, hasGame: true,
      worlds: [{ id: 'w1', is_entry: true }], mapTiles: {}, mapConfig: {},
    };
    expect(autoJoinTarget({ ...ready, hasCharacter: true })).toBe('w1');
    expect(autoJoinTarget({ ...ready, hasCharacter: false })).toBe(null);
  });
});

describe('signing out clears the active character', () => {
  it('AuthContext.signOut calls clearActiveCharacterId', () => {
    // Without this, the next account to sign in on this browser inherits a
    // stale id and is bounced by the server's ownership check -- which looks
    // like a broken app, not a stale session.
    const source = read('../../../context/AuthContext.jsx');
    expect(source).toMatch(/clearActiveCharacterId/);
    expect(source).toMatch(/signOut[\s\S]{0,500}clearActiveCharacterId\(\)/);
  });
});
