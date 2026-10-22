// Frame grid for one GPU-box creature sheet: pick frames to redraw. Pure
// marking logic lives in frameRedraw.js; this only draws and wires it.
import { useState } from 'react';
import styled from 'styled-components';
import { Btn, Badge, Muted } from './seedUi.jsx';
import {
  DIRECTION_ORDER, WESTERN, DOUBLED, frameKey, isMarkable, toggleMark, markRow, contextFrames,
  rowSummary, redrawPayload, qualityByFrame, sheetSize,
} from './frameRedraw.js';
import { estimateLabel } from './spriteSelection.js';

const CHECKER = 'conic-gradient(#b8b8b8 25%, #e6e6e6 0 50%, #b8b8b8 0 75%, #e6e6e6 0) 0 0 / 16px 16px';
const Tabs = styled.div`display: flex; gap: 0.4rem; flex-wrap: wrap; align-items: center;`;
const Tab = styled(Btn)`${(p) => p.$active && 'border-color: var(--s2-accent); font-weight: 600;'}`;
const RowHead = styled.div`display: flex; gap: 0.6rem; align-items: center; font-size: 1.2rem; margin-top: 0.6rem;`;
const Strip = styled.div`display: flex; gap: 2px; flex-wrap: nowrap;`;
const Summary = styled.div`font-size: 1.1rem; color: ${(p) => (p.$warn ? 'var(--s2-warning)' : 'var(--s2-text-muted)')};`;
const Frame = styled.button`
  position: relative; padding: 0; background-color: transparent; image-rendering: pixelated; flex: none;
  background-repeat: no-repeat; cursor: pointer;
  outline: ${(p) => (p.$marked ? '3px solid var(--s2-danger)' : p.$context ? '2px dashed var(--s2-warning)' : '1px solid var(--s2-border)')};
  outline-offset: -1px; border: 0;
  &:disabled { cursor: not-allowed; opacity: 0.8; }
  &:focus-visible { box-shadow: 0 0 0 3px var(--s2-accent); }
`;
const Checker = styled.span`display: inline-block; background: ${CHECKER}; line-height: 0;`;
const Flag = styled.span`
  position: absolute; top: 2px; right: 2px; background: var(--s2-warning); color: #000;
  font-size: 1rem; line-height: 1; padding: 1px 4px; border-radius: 3px;
`;
const Prev = styled.span`
  display: inline-block; flex: none; image-rendering: pixelated; background-repeat: no-repeat; opacity: 0.85;
  outline: ${(p) => (p.$redrawn ? '3px solid var(--s2-accent)' : '1px solid var(--s2-border)')}; outline-offset: -1px;
`;
const Changed = styled.span`
  position: absolute; bottom: 2px; left: 2px; right: 2px; background: var(--s2-warning); color: #000;
  font-size: 1rem; line-height: 1.1; padding: 1px 3px; border-radius: 3px; text-align: center;
`;
const Cross = styled.span`
  position: absolute; top: 2px; left: 4px; color: var(--s2-danger); font-weight: 700; font-size: 1.6rem; line-height: 1;
`;
const Footer = styled.div`display: flex; gap: 1rem; align-items: center; margin-top: 0.8rem;`;

const flagTitle = (q) => {
  const parts = [`failed checks: ${(q.failed_checks || []).join(', ') || 'none listed'}`, `attempts: ${q.attempts ?? '?'}`];
  if (q.row_redrawn) parts.push('row redrawn');
  return parts.join(' · ');
};

function stepFocus(e) {
  const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
  if (!step) return;
  const sibs = [...e.currentTarget.parentElement.querySelectorAll('button:not(:disabled)')];
  const next = sibs[sibs.indexOf(e.currentTarget) + step];
  if (next) { e.preventDefault(); next.focus(); }
}

export default function SpriteFrameGrid({
  sheetUrl, sheetPx, manifest, initialMarks, initialAction, compare, onSend, onMarksChange, secondsPerCell, sending,
}) {
  const [marks, setMarksState] = useState(() => new Set(initialMarks || []));
  const rows = manifest?.rows || [];
  const actions = [...new Set(rows.map((r) => r.action))];
  const firstMarked = actions.find((a) => [...marks].some((k) => k.startsWith(`${a}/`)));
  const [action, setAction] = useState(firstMarked || initialAction || actions[0]);
  // The loaded image's real size wins; the rect bounding box is only a fallback until it loads.
  const size = sheetPx?.w ? sheetPx : sheetSize(manifest);
  const quality = qualityByFrame(manifest);
  const setMarks = (next) => { setMarksState(next); if (onMarksChange) onMarksChange(next); };
  const countIn = (a, set) => [...set].filter((k) => k.startsWith(`${a}/`)).length;
  const flaggedKeys = (a) => [...quality.keys()].filter((k) => (a ? k.startsWith(`${a}/`) : true) && isMarkable(k.split('/')[1]));
  const markFlagged = (a) => setMarks(new Set([...marks, ...flaggedKeys(a)]));
  const payload = redrawPayload(marks, manifest);
  const redrawnKeys = new Set((compare?.redrawFrames || []).map((f) => frameKey(f.action, f.direction, f.frame)));
  const changedKeys = new Set(compare?.changedUnmarked || []);
  const cropStyle = (url, [x, y, w, h]) => ({
    width: w * 2, height: h * 2,
    backgroundImage: `url(${JSON.stringify(url)})`,
    backgroundSize: `${size.w * 2}px ${size.h * 2}px`,
    backgroundPosition: `${-x * 2}px ${-y * 2}px`,
  });

  const renderRow = (row) => {
    const { direction } = row;
    const markable = isMarkable(direction);
    const markedIdx = [];
    for (let i = 0; i < row.frames; i += 1) if (marks.has(frameKey(action, direction, i))) markedIdx.push(i);
    const ctx = new Set(contextFrames(row.frames, markedIdx));
    const summary = rowSummary(row.frames, markedIdx);
    const rowRedrawn = compare && Array.from({ length: row.frames }, (_, i) => i)
      .some((i) => redrawnKeys.has(frameKey(action, direction, i)));
    const cells = Array.from({ length: row.frames }, (_, i) => i)
      .filter((i) => manifest.frames?.[frameKey(action, direction, i)]);
    return (
      <div key={`${action}/${direction}`}>
        <RowHead>
          <strong>{`${action} · ${direction}`}</strong>
          {DOUBLED.includes(direction) && <Muted>×2 in game</Muted>}
          {markable && (
            <>
              <Btn type="button" onClick={() => setMarks(markRow(marks, action, direction, row.frames, true))}>Mark row</Btn>
              <Btn type="button" onClick={() => setMarks(markRow(marks, action, direction, row.frames, false))}>Clear row</Btn>
            </>
          )}
        </RowHead>
        {rowRedrawn && (
          <>
            <Muted>previous</Muted>
            <Strip data-strip="previous">
              {cells.map((i) => {
                const key = frameKey(action, direction, i);
                return (
                  <Checker key={key}>
                    <Prev $redrawn={redrawnKeys.has(key)} style={cropStyle(compare.previousUrl, manifest.frames[key])} />
                  </Checker>
                );
              })}
            </Strip>
            <Muted>new</Muted>
          </>
        )}
        <Strip data-strip="new">
          {Array.from({ length: row.frames }, (_, i) => {
            const key = frameKey(action, direction, i);
            const rect = manifest.frames?.[key];
            if (!rect) return null;
            const q = quality.get(key);
            const on = marks.has(key);
            return (
              <Checker key={key}>
                <Frame type="button" aria-pressed={on} disabled={!markable}
                  aria-label={`${action} ${direction} frame ${i}`}
                  $marked={on} $context={ctx.has(i)} onKeyDown={stepFocus}
                  onClick={() => setMarks(toggleMark(marks, key))}
                  style={{
                    ...cropStyle(sheetUrl, rect),
                    ...(redrawnKeys.has(key) && !on ? { outline: '3px solid var(--s2-accent)' } : {}),
                  }}>
                  {on && <Cross aria-hidden="true">✕</Cross>}
                  {changedKeys.has(key) && <Changed>changed, not marked</Changed>}
                  {q && <Flag title={flagTitle(q)}>!</Flag>}
                </Frame>
              </Checker>
            );
          })}
        </Strip>
        {summary && <Summary $warn={summary.tone === 'warning'}>{summary.text}</Summary>}
      </div>
    );
  };

  const rowsOf = (dirs) => dirs.map((d) => rows.find((r) => r.action === action && r.direction === d)).filter(Boolean);
  const flaggedAll = flaggedKeys(null).length;
  const flaggedTab = flaggedKeys(action).length;
  return (
    <div>
      <Tabs>
        {actions.map((a) => (
          <Tab key={a} type="button" $active={a === action} onClick={() => setAction(a)}>
            {a}
            {countIn(a, marks) > 0 && <Badge $tone="bad">{`${countIn(a, marks)}`}</Badge>}
            {[...changedKeys].filter((k) => k.startsWith(`${a}/`)).length > 0 && (
              <Badge $tone="warn">{`${[...changedKeys].filter((k) => k.startsWith(`${a}/`)).length} changed, not marked`}</Badge>
            )}
            {flaggedKeys(a).length > 0 && <Badge $tone="warn">{`${flaggedKeys(a).length} flagged`}</Badge>}
          </Tab>
        ))}
        {flaggedAll > 0 && <Btn type="button" onClick={() => markFlagged(null)}>{`Mark flagged (${flaggedAll}) in sheet`}</Btn>}
      </Tabs>
      {flaggedTab > 0 && (
        <RowHead><Btn type="button" onClick={() => markFlagged(action)}>{`Mark flagged (${flaggedTab})`}</Btn></RowHead>
      )}
      {rowsOf(DIRECTION_ORDER).map(renderRow)}
      <details style={{ marginTop: '0.8rem' }}>
        <summary>Not drawn in game (mirrored from e / ne / se)</summary>
        {rowsOf(WESTERN).map(renderRow)}
      </details>
      <Footer>
        <Muted>{`${payload.length} frame${payload.length === 1 ? '' : 's'} marked · ${estimateLabel(payload.length, secondsPerCell || 57)}`}</Muted>
        <Btn type="button" $primary disabled={!payload.length || sending} onClick={() => onSend(payload)}>
          {`Redraw ${payload.length} frame${payload.length === 1 ? '' : 's'}`}
        </Btn>
      </Footer>
    </div>
  );
}
