// SOMET-718. The Orange Pi admin tab (layout B): a status line, the actions on
// the left, charts on the right. BoardAdminView is presentational (SSR tests);
// the default export wires the hooks.
import { useState } from 'react';
import styled from 'styled-components';
import { Badge, Muted, Btn } from './seedUi.jsx';
import BoardChart from './BoardChart.jsx';
import BoardActions from './BoardActions.jsx';
import AdminLoading from './AdminLoading.jsx';
import { useBoardStatus, useBoardMetrics, useBoardJob, useBoardPreview, useBoardAction } from './useBoard.js';
import {
  RANGES, rangeMs, statusLine, latestValue, fmtBps, fmtPct, fmtMs, fmtGb, num,
  networkSeries, PING_SERIES, NOT_MOUNTED_TEXT, SERIES_COLORS,
} from './boardModel.js';

const Page = styled.div`
  padding: 2rem; color: var(--s2-text); max-width: 1200px; margin: 0 auto;
  height: 100%; overflow-y: auto; background-color: var(--s2-surface);
`;
const Bar = styled.div`
  display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; padding: 0.6rem 0.9rem; margin: 0.8rem 0;
  border: 1px solid var(--s2-border); border-radius: 8px; background: var(--s2-surface-raised); font-size: 1.4rem;
`;
const Cols = styled.div`
  display: grid; grid-template-columns: minmax(26rem, 34%) 1fr; gap: 1rem; align-items: start;
  @media (max-width: 800px) { grid-template-columns: 1fr; }
`;
const Grid = styled.div`display: grid; grid-template-columns: repeat(auto-fit, minmax(26rem, 1fr)); gap: 0.8rem;`;
const Ranges = styled.div`display: flex; gap: 0.4rem; align-items: center; margin-bottom: 0.8rem;`;
const Code = styled.code`background: var(--s2-bg-sunken); padding: 1px 6px; border-radius: 4px;`;

const cpu = (s) => s.cpuPct;
const mem = (s) => s.memUsedMb;
const disk = (s) => s.diskPct;

const only = (k, label, color, read) => [{ key: k, label, color, read }];

// "No data" when a series has nothing, else the latest reading of each.
function summary(samples, series, fmt) {
  const parts = series.map((d) => {
    const v = latestValue(samples, d.read);
    return v === null ? null : (series.length > 1 ? `${d.label} ${fmt(v)}` : fmt(v));
  }).filter(Boolean);
  return parts.length ? parts.join(' · ') : 'No data';
}

const latestT = (samples) => (Array.isArray(samples) && samples.length ? samples[samples.length - 1].t ?? null : null);

function Unavailable({ status }) {
  if (status.reason === 'not_mounted') return <Bar role="status">{NOT_MOUNTED_TEXT}</Bar>;
  if (status.reason === 'error') return <Bar role="status">{status.message || 'The board status could not be read.'}</Bar>;
  return (
    <Bar role="status" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
      <b>The board helper is not running.</b>
      <span>Start it on this PC with <Code>{status.hint || 'make pi-helper'}</Code></span>
    </Bar>
  );
}

export function BoardAdminView({ status, samples, job, preview, range, now, onAction, onRange }) {
  if (!status) return <Page><h2>Orange Pi</h2><AdminLoading /></Page>;
  if (status.available === false) return <Page><h2>Orange Pi</h2><Unavailable status={status} /></Page>;
  const line = statusLine(status);
  // The right edge of the time axis: the caller's clock (the last fetch), else the
  // newest sample. Never Date.now() here, so a render is a pure function of props.
  const newest = latestT(samples);
  const to = Number.isFinite(now) ? now : (newest ?? 0);
  const from = to - rangeMs(range);
  const rangeLabel = (RANGES.find((r) => r.id === range) || RANGES[1]).label;
  const list = Array.isArray(samples) ? samples : [];
  const total = latestValue(list, (s) => s.memTotalMb);
  const used = latestValue(list, mem);
  const net = networkSeries(list);
  const common = { samples: list, from, to, rangeLabel };
  return (
    <Page>
      <h2>Orange Pi</h2>
      <Bar role="status" aria-label="Board status">
        <b>{status.host || 'board'}</b>
        <Badge $tone={line.tone}>{line.text}</Badge>
        {status.commit && <span>Running <Code>{status.commit}</Code></span>}
      </Bar>
      <Cols>
        <BoardActions status={status} job={job} preview={preview} onAction={onAction} />
        <div>
          <Ranges>
            <Muted>Range</Muted>
            {RANGES.map((r) => (
              <Btn key={r.id} $primary={r.id === range} aria-pressed={r.id === range} onClick={() => onRange(r.id)}>{r.label}</Btn>
            ))}
          </Ranges>
          <Grid>
            <BoardChart {...common} title="CPU" max={100} series={only('cpu', 'CPU', SERIES_COLORS[0], cpu)}
              summary={summary(list, only('cpu', 'CPU', '', cpu), fmtPct)} format={fmtPct} />
            <BoardChart {...common} title="Memory" max={num(total)} series={only('mem', 'Used', SERIES_COLORS[0], mem)}
              summary={used === null ? 'No data' : `${fmtGb(used)}${total === null ? '' : ` / ${fmtGb(total)}`} GB`}
              format={(v) => `${fmtGb(v)} GB`} />
            <BoardChart {...common} title="Disk" max={100} series={only('disk', 'Disk', SERIES_COLORS[0], disk)}
              summary={summary(list, only('disk', 'Disk', '', disk), fmtPct)} format={fmtPct} />
            <BoardChart {...common} title="Ping" series={PING_SERIES} summary={summary(list, PING_SERIES, fmtMs)} format={fmtMs} />
            <BoardChart {...common} title="Network" series={net} summary={summary(list, net, fmtBps)} format={fmtBps} />
          </Grid>
        </div>
      </Cols>
    </Page>
  );
}

export default function BoardAdmin() {
  const status = useBoardStatus();
  const [range, setRange] = useState('1h');
  const metrics = useBoardMetrics(range);
  const job = useBoardJob();
  const previewM = useBoardPreview();
  const act = useBoardAction();

  let preview = null;
  if (previewM.isPending) preview = { state: 'loading' };
  else if (previewM.isError) preview = { state: 'error', message: previewM.error.message };
  else if (previewM.data) preview = { state: 'ready', data: previewM.data };

  const onAction = (kind) => {
    if (kind === 'seed-preview') { previewM.reset(); previewM.mutate(); return; }
    act.mutate(kind);
  };
  const known = status.data || (status.isError ? { available: false, reason: 'error', message: status.error.message } : undefined);
  return (
    <BoardAdminView status={known} samples={metrics.data?.samples || []} job={job.data ?? null}
      preview={preview} range={range} now={metrics.dataUpdatedAt || undefined} onAction={onAction} onRange={setRange} />
  );
}
