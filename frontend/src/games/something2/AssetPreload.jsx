// frontend/src/games/something2/AssetPreload.jsx
// First-entry preload indicator: how many textures are still coming and roughly
// how long that will take. A view over ImageManager.stats() -- it owns no loading,
// and the game is already running (the renderer draws colour fallbacks until each
// image lands). It is a corner chip, NOT a blocking page: the character is in the
// world and can be attacked, so the player must always see it (SOMET-759).
//
// Shown once per page load. If everything is already cached it never appears:
// nothing is drawn until the load has outlasted FLASH_GUARD_MS.
import { useEffect, useState } from 'react';
import styled from 'styled-components';
import { t } from './src/js/i18n/i18n.js';
import { useLang } from './src/js/i18n/useLang.js';
import { createEtaTracker, formatEta, percent } from './src/js/net/assetProgress.js';
import { TEXTURES_QUIET_MS } from './src/js/managers/ImageManager.js';

const POLL_MS = 250;
const FLASH_GUARD_MS = 400;
// "Finished" is ImageManager.isQuiet: pending has stayed at zero for
// TEXTURES_QUIET_MS (chunks and creatures request their art in bursts right
// after the join). The Amber Stance ready signal uses the same rule, so the
// seal's countdown never starts while this chip is still up.

let preloadFinished = false; // module-level: once per page load, across remounts

// A small corner chip, never a page: the world stays visible and the player can
// react while creatures can already hit them (SOMET-759). pointer-events: none so
// it can never swallow a click meant for the canvas. Top-centre is clear of every
// HUD element (orbs, XP bar and hotbar at the bottom, minimap and menu at the
// top-right, invite button at the left); light text on a dark box stays legible
// over any terrain, which --s2-text-secondary (a light-theme token) did not.
const Chip = styled.div`
  position: absolute;
  left: 50%;
  top: 12px;
  transform: translateX(-50%);
  z-index: 25;
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: min(220px, 60vw);
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.78);
  color: #f2f2f2;
  font-size: 0.75rem;
  pointer-events: none;
  .meta { font-variant-numeric: tabular-nums; }
  .bar {
    height: 4px;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.15);
    overflow: hidden;
  }
  .bar > i {
    display: block;
    height: 100%;
    background: var(--s2-accent);
    transition: width 0.25s linear;
  }
`;

export default function AssetPreload({ gameRef }) {
  useLang();
  const [view, setView] = useState(null);

  useEffect(() => {
    if (preloadFinished) return undefined;
    const tracker = createEtaTracker();
    const start = Date.now();
    const id = setInterval(() => {
      const im = gameRef.current && gameRef.current.imageManager;
      if (!im || !im.stats || !im.isQuiet) return;
      if (im.isQuiet(performance.now(), TEXTURES_QUIET_MS)) {
        preloadFinished = true;
        clearInterval(id);
        setView(null);
        return;
      }
      const s = im.stats();
      const now = Date.now();
      tracker.sample(now, s.settled);
      if (now - start < FLASH_GUARD_MS) return;
      setView({
        done: s.settled, total: s.total, failed: s.failed,
        pct: percent(s.settled, s.total),
        eta: formatEta(tracker.eta(now, s.pending)),
      });
    }, POLL_MS);
    return () => clearInterval(id);
  }, [gameRef]);

  if (!view || preloadFinished) return null;
  const { eta } = view;
  const etaText = eta
    ? (eta.m > 0
      ? t('About {m} min {s} s left', { m: eta.m, s: eta.s })
      : t('About {s} s left', { s: eta.s }))
    : t('Estimating time left…');
  return (
    <Chip role="status" aria-live="polite">
      <div className="meta">
        {t('Loading textures…')} {view.pct}% · {etaText}
      </div>
      <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={view.pct}>
        <i style={{ width: `${view.pct}%` }} />
      </div>
    </Chip>
  );
}
