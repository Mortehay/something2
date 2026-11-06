// SOMET-718. The Orange Pi admin tab (layout B): a status line, the actions on
// the left, charts on the right. BoardAdminView is presentational (SSR tests);
// the default export wires the hooks.
import { useState } from 'react';
import styled from 'styled-components';
import { Badge, Muted, Btn } from './seedUi.jsx';
import BoardChart from './BoardChart.jsx';
import BoardActions from './BoardActions.jsx';
import BoardInvites from './BoardInvites.jsx';
import ActionHistory, { Releases } from './BoardHistory.jsx';
import BoardLive from './BoardLive.jsx';
import AdminLoading from './AdminLoading.jsx';
import { useBoardInvites, useMakeInvites, useRevokeInvite } from './useBoardInvites.js';
import { useBoardStatus, useBoardMetrics, useBoardJob, useBoardPreview, useBoardAction, useClock, useBoardHistory, useBoardHistoryEntry, useBoardReleases, useBoardPlayers, useBoardBosses, useBoardSummon } from './useBoard.js';
import {
  RANGES, rangeMs, statusLine, shortVersion, latestValue, fmtBps, fmtPct, fmtMs, fmtGb, num,
  networkSeries, PING_SERIES, NOT_MOUNTED_TEXT, SERIES_COLORS, MID_ACTION_TEXT, PLAYER_SERIES, KILL_SERIES, fmtCount, fmtRate,
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

export function BoardAdminView({ status, samples, bucketMs = null, history, historySelected = null, historyEntry = null, historyError = null, onHistorySelect, releases, releasesError = null, invites = null, job, preview, range, now, pending = false, notice = null, staleSince = null, onAction, onRange, players, bosses, liveError = null, onSummon }) {
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
  const common = { samples: list, from, to, rangeLabel, bucketMs };
  return (
    <Page>
      <h2>Orange Pi</h2>
      <Bar role="status" aria-label="Board status">
        <b>{status.host || 'board'}</b>
        <Badge $tone={line.tone}>{line.text}</Badge>
        {shortVersion(status.version) && <span>Version <Code>{shortVersion(status.version)}</Code></span>}
        {status.commit && (status.online === false
          ? <span>last seen <Code>{status.commit}</Code></span>
          : <span>Running <Code>{status.commit}</Code></span>)}
      </Bar>
      {Number.isFinite(staleSince) && (
        <Bar role="alert">Could not refresh the status. Last checked {new Date(staleSince).toLocaleTimeString()}.</Bar>
      )}
      <Cols>
        <div>
          <BoardActions status={status} job={job} preview={preview} players={players} pending={pending} notice={notice} now={to} onAction={onAction} />
          {invites && <BoardInvites disabledReason={status.online === false ? 'The board is offline' : null} {...invites} />}
          <ActionHistory entries={history} selectedId={historySelected} entry={historyEntry} error={historyError} onSelect={onHistorySelect} />
          <Releases data={releases} error={releasesError} />
        </div>
        <div>
          <Ranges>
            <Muted>Range</Muted>
            {RANGES.map((r) => (
              <Btn key={r.id} $primary={r.id === range} aria-pressed={r.id === range} onClick={() => onRange(r.id)}>{r.label}</Btn>
            ))}
          </Ranges>
          <Grid>
            <BoardChart {...common} title="Players" series={PLAYER_SERIES} summary={summary(list, PLAYER_SERIES, fmtCount)} format={fmtCount} />
            <BoardChart {...common} title="Kills per min" series={KILL_SERIES} summary={summary(list, KILL_SERIES, fmtRate)} format={fmtRate} />
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
      <BoardLive players={players} bosses={bosses} error={liveError} status={status} job={job} pending={pending} onSummon={onSummon} />
    </Page>
  );
}

export default function BoardAdmin() {
  const status = useBoardStatus();
  const [range, setRange] = useState('1h');
  const metrics = useBoardMetrics(range);
  const job = useBoardJob();
  const { preview, load } = useBoardPreview();
  const act = useBoardAction();
  const now = useClock();
  const history = useBoardHistory();
  const [openId, setOpenId] = useState(null);
  const openEntry = useBoardHistoryEntry(openId);
  const releases = useBoardReleases();
  // Invite codes: read when the tab opens (once the board is known to be online), changed on demand.
  const online = (known) => Boolean(known) && known.available !== false && known.online !== false;
  const invitesQuery = useBoardInvites(online(status.data));
  const make = useMakeInvites();
  const revoke = useRevokeInvite();
  const players = useBoardPlayers();
  const bosses = useBoardBosses();
  const summon = useBoardSummon();

  const onAction = (kind) => {
    if (kind === 'seed-preview') { load(); return; }
    act.mutate(kind);
  };
  const known = status.data || (status.isError ? { available: false, reason: 'error', message: status.error.message } : undefined);
  // A failed poll keeps the last good data on screen; say how old it is.
  const staleSince = status.isError && status.data ? status.dataUpdatedAt : null;
  // midAction 503: the helper may have acted before it went away. Stays until the next action.
  const notice = (act.isError && act.error.midAction) || (summon.isError && summon.error.midAction) ? MID_ACTION_TEXT : null;
  return (
    <BoardAdminView status={known} samples={metrics.data?.samples || []} bucketMs={metrics.data?.bucketMs ?? null}
      history={history.data?.entries} historyError={history.isError ? history.error.message : null}
      historySelected={openId} historyEntry={openEntry.data ?? null} onHistorySelect={setOpenId}
      invites={{
        data: invitesQuery.data, loading: invitesQuery.isFetching, error: invitesQuery.isError ? invitesQuery.error.message : null,
        made: make.data ?? null, pending: make.isPending || revoke.isPending,
        onMake: (d) => make.mutate(d), onRevoke: (c) => { make.reset(); revoke.mutate(c); },
      }}
      releases={releases.data} releasesError={releases.isError ? releases.error.message : null} job={job.data ?? null}
      preview={preview} range={range} now={now || undefined} pending={act.isPending || summon.isPending} notice={notice}
      staleSince={staleSince} onAction={onAction} onRange={setRange}
      players={players.data} bosses={bosses.data} liveError={players.isError && !players.data ? players.error.message : (bosses.isError && !bosses.data ? bosses.error.message : null)}
      onSummon={(body) => summon.mutate(body)} />
  );
}
