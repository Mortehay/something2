import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { remainingHoldMs, bootLoadingVisible, recoveryPanelVisible, sceneUrl, LOADING_SCENES, MIN_SCREEN_MS } from '../loadingScreen.js';

const ready = { isGameRoute: true, isPlaying: false, joinPhase: null, hasCharacter: true, isAdmin: false, joinAttempted: false, expired: false };

describe('remainingHoldMs', () => {
  it('holds a quick entry up to the minimum and never goes negative', () => {
    expect(remainingHoldMs(1000, 1100)).toBe(MIN_SCREEN_MS - 100);
    expect(remainingHoldMs(1000, 1000 + MIN_SCREEN_MS + 5000)).toBe(0);
  });
});

describe('bootLoadingVisible', () => {
  it('covers the wait between page start and the first join', () => {
    expect(bootLoadingVisible(ready)).toBe(true);
  });
  it.each([
    ['another route', { isGameRoute: false }],
    ['already playing', { isPlaying: true }],
    ['the join overlay is up', { joinPhase: 'Entering…' }],
    ['the character picker is showing', { hasCharacter: false }],
    ['an admin, who picks a world by hand', { isAdmin: true }],
    ['a join already ran, so a failure reaches its recovery panel', { joinAttempted: true }],
    ['the limit passed, so a failed catalogue load cannot trap the page', { expired: true }],
  ])('stays down for %s', (_name, change) => {
    expect(bootLoadingVisible({ ...ready, ...change })).toBe(false);
  });
});

describe('recoveryPanelVisible', () => {
  const failed = { isPlaying: false, isAdmin: false, hasCharacter: true, isEntering: false };
  it('shows once a join has failed', () => expect(recoveryPanelVisible(failed)).toBe(true));
  it('does not claim failure while an entry is running', () => {
    expect(recoveryPanelVisible({ ...failed, isEntering: true })).toBe(false);
  });
  it('stays for neither a player in a world, an admin, nor no character', () => {
    expect(recoveryPanelVisible({ ...failed, isPlaying: true })).toBe(false);
    expect(recoveryPanelVisible({ ...failed, isAdmin: true })).toBe(false);
    expect(recoveryPanelVisible({ ...failed, hasCharacter: false })).toBe(false);
  });
});

describe('the scene files', () => {
  const dir = path.resolve(__dirname, '../../../../public/loading-scenes');
  it('are exactly the scenes the code can ask for', () => {
    expect(fs.readdirSync(dir).map((f) => f.replace('.svg', '')).sort()).toEqual([...LOADING_SCENES].sort());
  });
  it.each(LOADING_SCENES)('%s is self-contained, scrolls, and stops for reduced motion', (name) => {
    const svg = fs.readFileSync(path.join(dir, `${name}.svg`), 'utf8');
    expect(svg).not.toMatch(/\b(href|src)=["'](?!#)/);
    expect(svg).not.toMatch(/url\((?!#)/);
    expect(svg).not.toMatch(/<(image|text|script)\b/);
    expect(svg).toMatch(/@keyframes/);
    expect(svg).toMatch(/prefers-reduced-motion:\s*reduce/);
  });
});

describe('sceneUrl', () => {
  it('serves a known scene', () => expect(sceneUrl('snow')).toBe('/loading-scenes/snow.svg'));
  it.each([[null], [undefined], ['../../etc/passwd'], ['nope']])('falls back to the default for %s', (s) => {
    expect(sceneUrl(s)).toBe('/loading-scenes/forest.svg');
  });
});
