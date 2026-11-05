// SOMET-720. Under the Orange Pi tab's grid, full width: who is online and every boss, as the board's
// game server sees them. Presentational; the parent passes the data and onSummon. Names come from the
// game's database and players: they are only ever React text children.
import { useState } from 'react';
import styled from 'styled-components';
import { Btn, Muted, Modal } from './seedUi.jsx';
import {
  actionReason, bossKey, bossPlayersThere, bossStatus, bossTypeLabel, fmtDuration, fmtPing, fmtRate, num, summonBlock, summonBody, summonConfirm, summonLabel, summonTarget,
} from './boardModel.js';

const Box = styled.section`
  border: 1px solid var(--s2-border); border-radius: 8px; padding: 0.8rem 1rem; margin-top: 0.8rem;
  background: var(--s2-surface-raised); overflow-x: auto;
  h4 { margin: 0 0 0.5rem; font-size: 1.3rem; color: var(--s2-text-strong); }
`;
const Table = styled.table`
  width: 100%; border-collapse: collapse; font-size: 1.3rem;
  th { text-align: left; font-weight: 600; color: var(--s2-text-muted); border-bottom: 1px solid var(--s2-border-strong); padding: 0.3rem 0.8rem 0.3rem 0; white-space: nowrap; }
  td { border-bottom: 1px solid var(--s2-border); padding: 0.4rem 0.8rem 0.4rem 0; color: var(--s2-text); }
  th.n, td.n { text-align: right; font-variant-numeric: tabular-nums; }
  tr:last-child td { border-bottom: 0; }
`;
const STATE_COLOR = { ok: 'var(--s2-success)', bad: 'var(--s2-danger)', muted: 'var(--s2-text-muted)' };
const State = styled.b`color: ${(p) => STATE_COLOR[p.$tone] || 'var(--s2-text)'};`;
const Err = styled.p`color: var(--s2-danger); margin: 0.4rem 0; font-size: 1.3rem;`;
const Lines = styled.ul`list-style: none; padding: 0; margin: 0.4rem 0; font-size: 1.4rem; li { margin: 0.3rem 0; }`;

// One of the two tables' empty and unavailable states: { message } while the data is not there.
function emptyReason(data, error, loadingText) {
  if (error) return error;
  if (!data) return loadingText;
  if (data.available === false) return data.message || 'No live data right now.';
  return null;
}

export function PlayersTable({ data, error = null }) {
  const reason = emptyReason(data, error, 'Reading the board…');
  const list = !reason && Array.isArray(data.players) ? data.players : [];
  return (
    <Box aria-label="Players online">
      <h4>Players online{reason ? '' : ` (${list.length})`}</h4>
      {reason && <Muted role="status">{reason}</Muted>}
      {!reason && list.length === 0 && <Muted>Nobody is playing right now.</Muted>}
      {list.length > 0 && (
        <Table>
          <thead>
            <tr>
              <th>Player</th><th className="n">Level</th><th>World</th><th className="n">Playing for</th>
              <th className="n">Mob kills / min</th><th className="n">PvP kills / min</th><th className="n">Deaths this session</th>
              <th className="n">Lifetime kills</th><th className="n">Ping</th>
            </tr>
          </thead>
          <tbody>
            {list.map((p, i) => (
              <tr key={`${p.name}-${i}`}>
                <td>{p.name ?? '–'}</td>
                <td className="n">{p.level ?? '–'}</td>
                <td>{p.world ?? '–'}</td>
                <td className="n">{fmtDuration(p.sessionSeconds)}</td>
                <td className="n">{fmtRate(p.mobKillsPerMin)}</td>
                <td className="n">{fmtRate(p.pvpKillsPerMin)}</td>
                <td className="n">{num(p.deaths) ?? '–'}</td>
                <td className="n">{p.lifetime ? (num(p.lifetime.mobKills) ?? 0) + (num(p.lifetime.pvpKills) ?? 0) : '–'}</td>
                <td className="n">{fmtPing(p.pingMs)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Box>
  );
}

export function SummonDialog({ boss, status, job, pending, onConfirm, onClose }) {
  const block = actionReason(status, job, pending) || summonBlock(boss);
  if (!boss) {
    return (
      <Modal $w="520px" onClose={onClose} label="Summon">
        <p>This boss is no longer on the list.</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}><Btn onClick={onClose}>Close</Btn></div>
      </Modal>
    );
  }
  const text = summonConfirm(boss);
  return (
    <Modal $w="520px" onClose={onClose} label={text.title}>
      <h3 style={{ marginTop: 0 }}>{text.title}</h3>
      <Lines>{text.lines.map((l) => <li key={l}>{l}</li>)}</Lines>
      {block && <Err>{block}</Err>}
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 8 }}>
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn $primary disabled={Boolean(block)} title={block || undefined} onClick={onConfirm}>{text.confirm}</Btn>
      </div>
    </Modal>
  );
}

export function BossesTable({ data, error = null, status, job, pending = false, onSummon, initialDialog = null }) {
  // The key, not the row: the row behind an open dialog keeps moving with each poll.
  const [dialog, setDialog] = useState(initialDialog);
  const reason = emptyReason(data, error, 'Reading the board…');
  const list = !reason && Array.isArray(data.bosses) ? data.bosses : [];
  const busy = actionReason(status, job, pending);
  const open = dialog ? list.find((b) => bossKey(b) === dialog) || null : null;
  const confirm = () => { const b = open; setDialog(null); if (b) onSummon(summonBody(b)); };
  return (
    <Box aria-label="Bosses">
      <h4>Bosses</h4>
      {reason && <Muted role="status">{reason}</Muted>}
      {!reason && list.length === 0 && <Muted>No bosses in the catalog or on any map.</Muted>}
      {list.length > 0 && (
        <Table>
          <thead><tr><th>Boss</th><th>Type</th><th>Where</th><th>Status</th><th className="n">Players there</th><th aria-label="Action" /></tr></thead>
          <tbody>
            {list.map((b) => {
              const st = bossStatus(b);
              const blocked = busy || summonBlock(b);
              const target = summonTarget(b);
              return (
                <tr key={bossKey(b)}>
                  <td>{b.name}</td>
                  <td>{bossTypeLabel(b)}</td>
                  <td>{b.world ?? <Muted>{target.world ? `would land in ${target.world}` : 'no world loaded'}</Muted>}</td>
                  <td><State $tone={st.tone}>{st.word}</State>{st.detail ? <Muted>, {st.detail}</Muted> : null}</td>
                  <td className="n">{bossPlayersThere(b) ?? '–'}</td>
                  <td className="n">
                    <Btn disabled={Boolean(blocked)} title={blocked || undefined} onClick={() => setDialog(bossKey(b))}>{summonLabel(b)}</Btn>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {dialog && (
        <SummonDialog boss={open} status={status} job={job} pending={pending} onConfirm={confirm} onClose={() => setDialog(null)} />
      )}
    </Box>
  );
}

export default function BoardLive({ players, bosses, error = null, status, job, pending = false, onSummon }) {
  return (
    <>
      <PlayersTable data={players} error={error} />
      <BossesTable data={bosses} error={error} status={status} job={job} pending={pending} onSummon={onSummon} />
    </>
  );
}
