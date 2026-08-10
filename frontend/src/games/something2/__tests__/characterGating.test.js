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

describe('GameShell gates the canvas behind a character', () => {
  const source = read('../GameShell.jsx');

  it('renders CharacterSelect', () => {
    expect(source).toMatch(/CharacterSelect/);
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
