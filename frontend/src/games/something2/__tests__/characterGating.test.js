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

  it('exposes changeCharacter to the HUD, and the HUD calls it', () => {
    // Same inertness shape as CharacterSelect above: `changeCharacter` was
    // defined in GameShell and referenced NOWHERE else -- not in the Outlet
    // context, not by any control -- so a player could not switch characters
    // without hand-clearing localStorage. SOMET-262 lists "Change character
    // disconnects cleanly" as an acceptance criterion, and it was unreachable.
    expect(source).toMatch(/changeCharacter,/);
    const gameView = read('../GameView.jsx');
    expect(gameView).toMatch(/changeCharacter/);
    expect(gameView).toMatch(/onClick=\{changeCharacter\}/);
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

  it('rebuilds the Game instance after changeCharacter throws it away', () => {
    // changeCharacter destroys the Game and nulls gameRef. The effect that
    // builds one is keyed on [isGameRoute], and switching characters never
    // leaves /game -- so nothing rebuilt it, and gameRef stayed null for the
    // rest of the session. Everything downstream then refused SILENTLY:
    // autoJoinTarget returns null on `hasGame: false`, and enterWorld opens
    // with `if (!worldId || !gameRef.current) return false`, so even the
    // recovery panel's "Try again" did nothing. Reported from the game as
    // "selected another character then i stuck at map page".
    //
    // A ref cannot be an effect dependency, so the rebuild has to be driven by
    // state. Both halves are pinned: the bump and the dependency.
    expect(source).toMatch(/setGameEpoch\(\(n\) => n \+ 1\)/);
    expect(source).toMatch(/\}, \[isGameRoute, gameEpoch\]\)/);
    // ...and the bump must live in changeCharacter, not just exist somewhere.
    const changeCharacterBody = source.slice(
      source.indexOf('const changeCharacter'),
      source.indexOf('const exitToMenu'),
    );
    expect(changeCharacterBody).toMatch(/setGameEpoch/);
  });
});

describe('auto-join waits for a character', () => {
  it('GameShell actually SUPPLIES hasCharacter to autoJoinTarget', () => {
    // The guard below lived in autoJoinTarget while this call site never passed
    // the flag, so it arrived `undefined` and auto-join returned null for
    // EVERY player. The pure-function test passed the flag explicitly and was
    // green the whole time -- a guard is only real if its input is wired.
    // Window widened alongside the lastWorldId guard below: the call site keeps
    // growing rationale comments between the opening brace and this argument,
    // and a window tight enough to feel "precise" just fails on prose.
    //
    // SOMET-262: the arguments moved into a `joinTargetArgs()` builder, because
    // a SECOND caller appeared (the player's manual retry) and two hand-written
    // argument lists is exactly how this field got dropped the first time. The
    // guard follows the arguments -- it is not relaxed. Both assertions still
    // hold: the field must be supplied, and every autoJoinTarget call must go
    // through the builder rather than assembling its own list.
    expect(gameShellSource).toMatch(/joinTargetArgs\s*=\s*\(\)\s*=>\s*\(\{[\s\S]{0,1500}hasCharacter:/);
    // EVERY call must go through the builder -- including the retry, which
    // spreads it to override two flags. A call that assembled its own literal
    // would be free to omit a field again, which is the whole failure this
    // guard exists for.
    const calls = gameShellSource.match(/autoJoinTarget\([^)]*/g) || [];
    expect(calls.length).toBeGreaterThan(0);
    // `joinTargetArgs\(` without the closing paren on purpose: the slice above
    // stops at the FIRST ')', which is the builder's own.
    for (const call of calls) expect(call).toMatch(/joinTargetArgs\(/);
  });

  it('GameShell SUPPLIES lastWorldId to autoJoinTarget', () => {
    // The same failure mode as hasCharacter below: the pure function can prefer
    // the last world all it likes, but if the call site never passes it the
    // argument is undefined and every player silently resumes into the entry
    // world -- with autoJoin.test.js green throughout, because it passes the
    // value explicitly. The guard has to be on the CALL SITE.
    // Generous window: the call site carries long rationale comments between
    // the opening brace and this argument, and a window tight enough to be
    // "precise" just fails on prose.
    // SOMET-262 moved the arguments into `joinTargetArgs()` -- see the note on
    // the hasCharacter guard above. Same assertion, following the arguments.
    expect(gameShellSource).toMatch(/joinTargetArgs\s*=\s*\(\)\s*=>\s*\(\{[\s\S]{0,1500}lastWorldId:/);
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
      // isGameRoute as of SOMET-271 -- see autoJoin.test.js's own describe.
      isGameRoute: true,
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
