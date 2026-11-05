// frontend/src/games/something2/AssetPreload.jsx
// First-entry preload screen: how many textures are still coming and roughly how
// long that will take. A view over ImageManager.stats() -- it owns no loading, and
// the game is already running underneath (the renderer draws colour fallbacks
// until each image lands), so "Play now" is always available.
//
// Shown once per page load. If everything is already cached it never appears:
// nothing is drawn until the load has outlasted FLASH_GUARD_MS.
import { useEffect, useState } from 'react';
import styled from 'styled-components';
import { t } from './src/js/i18n/i18n.js';
import { useLang } from './src/js/i18n/useLang.js';
import { createEtaTracker, formatEta, percent } from './src/js/net/assetProgress.js';

const POLL_MS = 250;
const FLASH_GUARD_MS = 400;
// Pending must stay at zero this long before we call it finished: chunks and
// creatures request their art in bursts right after the join.
const QUIET_POLLS = 4;

let preloadFinished = false; // module-level: once per page load, across remounts

const Overlay = styled.div`
  position: absolute;
  inset: 0;
  z-index: 25;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: var(--s2-bg);
  color: var(--s2-text-secondary);
  text-align: center;
  padding: 0 16px;
  .title { color: var(--s2-text-strong); font-size: 1.1rem; }
  .meta { color: var(--s2-text-dim); font-size: 0.9rem; font-variant-numeric: tabular-nums; }
  .bar {
    width: min(360px, 80vw);
    height: 10px;
    border-radius: 5px;
    background: rgba(255, 255, 255, 0.1);
    overflow: hidden;
  }
  .bar > i {
    display: block;
    height: 100%;
    background: var(--s2-accent);
    transition: width 0.25s linear;
  }
  button {
    margin-top: 6px;
    background: transparent;
    color: var(--s2-text-secondary);
    border: 1px solid currentColor;
    border-radius: 6px;
    padding: 4px 12px;
    cursor: pointer;
  }
`;

export default function AssetPreload({ gameRef }) {
  useLang();
  const [view, setView] = useState(null);

  useEffect(() => {
    if (preloadFinished) return undefined;
    const tracker = createEtaTracker();
    const start = Date.now();
    let quiet = 0;
    const id = setInterval(() => {
      const im = gameRef.current && gameRef.current.imageManager;
      if (!im || !im.stats) return;
      const s = im.stats();
      const now = Date.now();
      tracker.sample(now, s.settled);
      quiet = s.pending === 0 ? quiet + 1 : 0;
      if (quiet >= QUIET_POLLS) {
        preloadFinished = true;
        clearInterval(id);
        setView(null);
        return;
      }
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
  return (
    <Overlay role="status" aria-live="polite">
      <div className="title">{t('Loading textures…')}</div>
      <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={view.pct}>
        <i style={{ width: `${view.pct}%` }} />
      </div>
      <div className="meta">
        {view.pct}% · {t('{done} of {total}', { done: view.done, total: view.total })}
      </div>
      <div className="meta">
        {eta
          ? (eta.m > 0
            ? t('About {m} min {s} s left', { m: eta.m, s: eta.s })
            : t('About {s} s left', { s: eta.s }))
          : t('Estimating time left…')}
      </div>
      <button type="button" onClick={() => { preloadFinished = true; setView(null); }}>
        {t('Play now')}
      </button>
    </Overlay>
  );
}
