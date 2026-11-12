// Tunnels admin tab (dev PC only): two independent cards (Cloudflare, ngrok) plus a History sub-tab.
// Every value from the backend is rendered as a text child, never markup.
import { useEffect, useState } from 'react';
import styled from 'styled-components';
import toast from 'react-hot-toast';
import { Badge, Muted, Btn, fmtTime } from './seedUi.jsx';
import AdminLoading from './AdminLoading.jsx';
import { useTunnels, useTunnelHistory, useTunnelToggle } from './useTunnels.js';
import { PROVIDERS, formatUptime, statusLabel, endReasonLabel, canToggle, durationText, cardAction, canEditMode, modeSuffix, NOT_DEV_TEXT } from './tunnelsModel.js';

const Page = styled.div`
  padding: 2rem; color: var(--s2-text); max-width: 1200px; margin: 0 auto;
  height: 100%; overflow-y: auto; background-color: var(--s2-surface);
`;
const Tabs = styled.div`display: flex; gap: 0.4rem; margin: 0.8rem 0;`;
const Cards = styled.div`
  display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; align-items: start;
  @media (max-width: 800px) { grid-template-columns: 1fr; }
`;
const Card = styled.section`
  border: 1px solid var(--s2-border); border-radius: 8px; padding: 0.8rem 1rem;
  background: var(--s2-surface-raised); display: flex; flex-direction: column; gap: 0.5rem; font-size: 1.4rem;
  h3 { margin: 0; font-size: 1.6rem; color: var(--s2-text-strong); }
`;
const Row = styled.div`display: flex; gap: 0.6rem; flex-wrap: wrap; align-items: center;`;
const Addr = styled.code`background: var(--s2-bg-sunken); padding: 1px 6px; border-radius: 4px; word-break: break-all;`;
const Warn = styled.p`margin: 0; padding: 0.4rem 0.6rem; border: 1px solid var(--s2-warning); color: var(--s2-warning); border-radius: 6px; font-size: 1.3rem;`;
const Err = styled.p`margin: 0; color: var(--s2-danger); font-size: 1.3rem;`;
const Bar = styled.div`
  padding: 0.6rem 0.9rem; margin: 0.8rem 0; border: 1px solid var(--s2-border); border-radius: 8px;
  background: var(--s2-surface-raised); font-size: 1.4rem;
`;
const Table = styled.table`
  width: 100%; border-collapse: collapse; font-size: 1.3rem;
  th, td { text-align: left; vertical-align: top; padding: 0.4rem 0.5rem; border-top: 1px solid var(--s2-border); }
  th { color: var(--s2-text-muted); font-weight: 600; }
  ul { margin: 0.2rem 0 0; padding-left: 1.2rem; }
`;

const TONE = { on: 'ok', starting: 'info', failed: 'bad', busy: 'warn', off: undefined };

async function copyLink(url) {
  try {
    await navigator.clipboard.writeText(url);
    toast.success('Link copied');
  } catch {
    toast.error(`Could not copy. Copy the address by hand: ${url}`, { duration: 15000 });
  }
}

export function TunnelCard({ name, card, registrationMode, pending, now, onStart, onStop }) {
  const [live, setLive] = useState(false);
  const state = card?.state || 'off';
  const isOn = state === 'on';
  // ngrok runs one version at a time: the choice is editable only while off. When on, show what runs.
  const liveShown = isOn ? card?.mode === 'live' : live;
  const action = cardAction(state);
  const toggleOk = canToggle(card || { state: 'off' }, pending);
  const players = Number.isFinite(card?.players) ? card.players : 0;
  return (
    <Card aria-label={name}>
      <Row><h3>{name}</h3><Badge $tone={TONE[state]}>{statusLabel(state)}</Badge></Row>
      {isOn && (
        <Row>
          {card.url ? <><Addr>{card.url}</Addr><Btn onClick={() => copyLink(card.url)}>Copy link</Btn></> : <Muted>Address unknown</Muted>}
        </Row>
      )}
      {isOn && card.startedAt && <span>{formatUptime(card.startedAt, now)}</span>}
      {isOn && <span>Players right now: {players}</span>}
      {state === 'failed' && card?.error && <Err role="alert">{String(card.error)}</Err>}
      <label>
        <input type="checkbox" checked={liveShown} disabled={!canEditMode(state, pending)}
          onChange={(e) => setLive(e.target.checked)} /> Live version
      </label>
      {isOn && registrationMode === 'open' && (
        <Warn role="alert">Registration is open: anyone with this link can create an account.</Warn>
      )}
      <Row>
        <Btn $primary={action === 'start'} disabled={!toggleOk}
          onClick={() => (action === 'stop' ? onStop() : onStart(live ? 'live' : 'built'))}>
          {{ stop: 'Turn off', wait: 'Starting…', start: 'Turn on' }[action]}
        </Btn>
      </Row>
    </Card>
  );
}

function History() {
  const { data, isLoading, error } = useTunnelHistory();
  if (isLoading) return <AdminLoading />;
  if (error) return <Err role="alert">{error.message}</Err>;
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  if (sessions.length === 0) return <Muted>No tunnel sessions in the last 30 days</Muted>;
  return (
    <Table>
      <thead><tr><th>Service and address</th><th>Started / stopped</th><th>How it ended</th><th>Players</th><th>Problems</th></tr></thead>
      <tbody>
        {sessions.map((s) => (
          <tr key={s.id}>
            <td><b>{s.provider}</b>{modeSuffix(s.mode)}<br />{s.url ? <Addr>{s.url}</Addr> : <Muted>Address unknown</Muted>}</td>
            <td>{fmtTime(s.startedAt)}<br />{s.endedAt ? fmtTime(s.endedAt) : 'Still running'}<br /><Muted>{durationText(s.durationSec)}</Muted></td>
            <td>{endReasonLabel(s.endedAt ? s.endReason : null)}{s.error && <Err>{String(s.error)}</Err>}</td>
            <td>Peak {s.peakPlayers ?? 0}{Array.isArray(s.players) && s.players.length > 0 && <><br /><Muted>{s.players.join(', ')}</Muted></>}</td>
            <td>{Array.isArray(s.events) && s.events.length > 0
              ? <ul>{s.events.map((e, i) => <li key={i}><Muted>{fmtTime(e.at)}</Muted> {e.kind}{e.detail ? `: ${e.detail}` : ''}</li>)}</ul>
              : <Muted>None</Muted>}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export default function TunnelsAdmin() {
  const [tab, setTab] = useState('tunnels');
  const [now, setNow] = useState(() => Date.now());
  const { data, isLoading, error } = useTunnels();
  const { start, stop } = useTunnelToggle();
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const pendingFor = (id) => (start.isPending && start.variables?.provider === id) || (stop.isPending && stop.variables?.provider === id);
  return (
    <Page>
      <h2>Tunnels</h2>
      <Tabs role="tablist">
        {[['tunnels', 'Tunnels'], ['history', 'History']].map(([id, label]) => (
          <Btn key={id} role="tab" aria-selected={tab === id} $primary={tab === id} onClick={() => setTab(id)}>{label}</Btn>
        ))}
      </Tabs>
      {tab === 'history' ? <History /> : (
        <>
          {isLoading && <AdminLoading />}
          {error?.status === 404 && <Bar role="status">{NOT_DEV_TEXT}</Bar>}
          {error && error.status !== 404 && <Bar role="alert">{error.message}</Bar>}
          {data?.available === false && <Bar role="status">{data.hint || 'Run make tunnel-helper on this PC'}</Bar>}
          {data?.available && (
            <Cards>
              {PROVIDERS.map((p) => (
                <TunnelCard key={p.id} name={p.name} card={data.tunnels?.[p.id]} registrationMode={data.registrationMode}
                  pending={pendingFor(p.id)} now={now}
                  onStart={(mode) => start.mutate({ provider: p.id, mode })}
                  onStop={() => stop.mutate({ provider: p.id })} />
              ))}
            </Cards>
          )}
        </>
      )}
    </Page>
  );
}
