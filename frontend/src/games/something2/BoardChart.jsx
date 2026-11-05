// SOMET-718. One small time-series chart of the Orange Pi tab: inline SVG
// lines in series tokens, a legend naming each series, the latest value in the
// header, and a hover read-out. Values are only ever numbers drawn as
// coordinates or text children; nothing is interpolated as HTML.
import { useState } from 'react';
import styled from 'styled-components';
import { chartPoints, num, toMs, autoMax } from './boardModel.js';

const W = 300;
const H = 60;

const Card = styled.div`
  border: 1px solid var(--s2-border); border-radius: 8px; padding: 0.6rem 0.9rem;
  background: var(--s2-surface-raised); min-width: 0; position: relative;
`;
const Head = styled.div`display: flex; justify-content: space-between; gap: 0.8rem; align-items: baseline;`;
const Title = styled.span`font-size: 1.2rem; color: var(--s2-text-muted); font-weight: 600;`;
const Value = styled.b`font-size: 1.4rem; color: var(--s2-text-strong); font-variant-numeric: tabular-nums; text-align: right;`;
const Legend = styled.div`display: flex; gap: 1rem; flex-wrap: wrap; font-size: 1.1rem; color: var(--s2-text-secondary); margin-top: 0.2rem;`;
const Plot = styled.svg`width: 100%; height: 6rem; display: block; margin-top: 0.3rem; overflow: visible;`;
const Axis = styled.div`display: flex; justify-content: space-between; font-size: 1rem; color: var(--s2-text-dim);`;
const Tip = styled.div`
  position: absolute; right: 0.6rem; top: 2.8rem; z-index: 2; pointer-events: none; font-size: 1.1rem;
  background: var(--s2-surface); color: var(--s2-text); border: 1px solid var(--s2-border-strong);
  border-radius: 6px; padding: 0.3rem 0.6rem; font-variant-numeric: tabular-nums;
`;

const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// series: [{ key, label, color, dash?, read }]; max: number, or null for auto.
export default function BoardChart({ title, summary, series, samples, from, to, max = null, format, rangeLabel = '', bucketMs = null }) {
  const [hover, setHover] = useState(null);
  const list = Array.isArray(samples) ? samples : [];
  const top = autoMax(list, series.map((d) => d.read), max);
  const geo = { width: W, height: H, max: top, from, to };
  const span = to - from || 1;
  const near = hover === null ? null : nearest(list, from + hover * span, bucketMs);
  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width > 0) setHover(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
  };
  return (
    <Card aria-label={`${title} chart`}>
      <Head><Title>{title}</Title><Value>{summary}</Value></Head>
      {series.length > 1 && (
        <Legend>
          {series.map((d) => (
            <span key={d.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <svg width="16" height="6" aria-hidden="true">
                <line x1="0" y1="3" x2="16" y2="3" stroke={d.color} strokeWidth="2" strokeDasharray={d.dash ? '4 2' : undefined} />
              </svg>
              <span>{d.label}</span>
            </span>
          ))}
        </Legend>
      )}
      <Plot viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${title} over the last ${rangeLabel}`}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <line x1="0" y1={H} x2={W} y2={H} stroke="var(--s2-border)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <line x1="0" y1={H / 2} x2={W} y2={H / 2} stroke="var(--s2-border)" strokeWidth="1" strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
        {series.map((d) => chartPoints(list, d.read, { ...geo, carryMs: d.carryMs, bucketMs }).map((pts, i) => (
          <polyline key={`${d.key}-${i}`} points={pts} fill="none" stroke={d.color} strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" strokeDasharray={d.dash ? '5 3' : undefined} vectorEffect="non-scaling-stroke" />
        )))}
        {hover !== null && (
          <line x1={hover * W} y1="0" x2={hover * W} y2={H} stroke="var(--s2-text-dim)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        )}
      </Plot>
      <Axis><span>{rangeLabel ? `-${rangeLabel}` : ''}</span><span>now</span></Axis>
      {near && (
        <Tip role="tooltip">
          <div>{clock(near.t)}{near.online === false ? ' · offline' : ''}</div>
          {near.online !== false && series.map((d) => (
            <div key={d.key}>{series.length > 1 ? `${d.label}: ` : ''}{num(d.read(near)) === null ? 'No data' : format(d.read(near))}</div>
          ))}
        </Tip>
      )}
    </Card>
  );
}

// The sample closest in time, but only if it is within one interval of the cursor.
function nearest(list, t, bucketMs) {
  const reach = Math.max(20000, num(bucketMs) > 0 ? bucketMs : 0);
  let best = null;
  let bestD = Infinity;
  for (const s of list) {
    const st = toMs(s?.t);
    if (st === null) continue;
    const d = Math.abs(st - t);
    if (d < bestD) { best = s; bestD = d; }
  }
  return bestD <= reach ? best : null;
}
