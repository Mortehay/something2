// The HUD stack on the right sits on the paired inventory's X at large canvas
// sizes, so it stands aside while a chest or merchant window is open. The real
// GameView, rendered in vitest's node environment: the first render reads the
// signal directly. The 100 ms poll that follows it needs a browser.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const outlet = vi.hoisted(() => ({ value: null }));
vi.mock('react-router-dom', async (original) => ({ ...(await original()), useOutletContext: () => outlet.value }));
vi.mock('../../../context/AuthContext', () => ({ useAuth: () => ({ isAdmin: false }) }));
vi.mock('../useMaps.js', () => ({ useMapTiles: () => ({ mapTiles: {} }) }));
vi.mock('../useWorlds', () => ({
  useWorlds: () => ({ worlds: [], isLoadingWorlds: false }),
  useCreateWorld: () => ({ mutate() {} }),
  useDeleteWorld: () => ({ mutate() {} }),
}));
// Its own first render is always empty: the count arrives with its first poll.
vi.mock('../PassivePointsNudge.jsx', () => ({ default: () => createElement('button', null, 'NUDGE') }));
vi.mock('../WaypointTravel.jsx', () => ({ default: () => null }));
vi.mock('../WorldBossHud.jsx', () => ({ default: () => null }));

import GameView from '../GameView.jsx';
import { t } from '../src/js/i18n/i18n.js';

const render = (paired) => {
  outlet.value = {
    gameRef: { current: { isPairedWindowOpen: () => paired } },
    isPlaying: true, isFullscreen: false, toggleFullscreen() {}, openHelp() {}, changeCharacter() {},
    activeCharacter: { id: 1 }, setSelectedWorldId() {},
  };
  return renderToStaticMarkup(createElement(GameView));
};

// The markup of the div carrying the attribute, opening tag included.
function hiddenRegion(html) {
  const start = html.indexOf('<div data-hud-stack');
  expect(start).toBeGreaterThanOrEqual(0);
  const tags = /<(\/?)div\b[^>]*>/g;
  tags.lastIndex = start;
  let depth = 0;
  for (let m = tags.exec(html); m; m = tags.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index);
  }
  throw new Error('unbalanced markup');
}

describe('the HUD stack beside a paired window', () => {
  beforeEach(() => { globalThis.localStorage = { getItem: () => null, setItem() {} }; });
  afterEach(() => { delete globalThis.localStorage; });

  const BUTTONS = ['How to play', 'Settings', 'NUDGE', 'Change Character'];

  it('all four sit in one region that is display:none while a window is paired', () => {
    const region = hiddenRegion(render(true));
    expect(region.slice(0, region.indexOf('>'))).toContain('display:none');
    for (const label of BUTTONS) expect(region).toContain(t(label));
  });

  it('come back when the window closes', () => {
    const region = hiddenRegion(render(false));
    expect(region).not.toContain('display:none');
    for (const label of BUTTONS) expect(region).toContain(t(label));
  });

  it('the fullscreen toggle is not part of it', () => {
    const html = render(true);
    expect(hiddenRegion(html)).not.toContain(t('Enter fullscreen'));
    expect(html).toContain(t('Enter fullscreen'));
  });
});
