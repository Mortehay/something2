// SOMET-642. The git strip of the Seed / Export tab: branch, ahead/behind,
// seed changes, and Pull / Commit seeds / Push, each behind a confirm dialog.
// Presentational GitStripView (testable); the default export wires the hooks.
import { useState } from 'react';
import styled from 'styled-components';
import { useGitStatus, useGitAction } from './useSeedExport.js';
import { gitStripText, gitActionStates, pluralize, GIT_UNAVAILABLE_TEXT } from './seedExportModel.js';
import { Btn, Badge, Muted, Modal, fmtTime } from './seedUi.jsx';

const Strip = styled.div`
  display: flex; align-items: center; gap: 0.8rem; flex-wrap: wrap; margin: 0.8rem 0;
  padding: 0.5rem 0.9rem; border-radius: 8px; border: 1px solid var(--s2-border);
  background: var(--s2-surface-raised); color: var(--s2-text); font-size: 1.4rem;
`;
const Files = styled.ul`font-size: 1.2rem; max-height: 160px; overflow-y: auto; margin: 0.4rem 0; padding-left: 1.4rem;`;
const Msg = styled.textarea`
  width: 100%; min-height: 60px; box-sizing: border-box; background: var(--s2-surface-raised);
  color: var(--s2-text); border: 1px solid var(--s2-border-strong); border-radius: 6px; padding: 6px; font: inherit;
`;

// What each confirm dialog says it will do.
export function gitConfirmText(op, s) {
  if (op === 'pull') return `Fast-forward ${pluralize(s.behind, 'commit')} from ${s.upstream || `origin/${s.branch}`}.`;
  if (op === 'push') return `Push ${pluralize(s.ahead, 'commit')} to origin/${s.branch}.`;
  return `Commit ${pluralize((s.seedsDirty || []).length, 'file')} under backend/seeds/ on ${s.branch}. Nothing else is staged.`;
}

const TITLES = { pull: 'Pull', commit: 'Commit seeds', push: 'Push' };

export function GitStripView({ status, busy, pending, onRun }) {
  const [dialog, setDialog] = useState(null);
  const [message, setMessage] = useState('');
  if (!status) return null;
  if (status.available === false) {
    return <Strip role="status"><Muted>{GIT_UNAVAILABLE_TEXT}</Muted></Strip>;
  }
  const acts = gitActionStates(status, busy);
  const other = (status.otherDirty || []).length;
  const open = (op) => { if (op === 'commit') setMessage(status.suggestedMessage || ''); setDialog(op); };
  const run = () => { onRun(dialog, message); setDialog(null); };
  const btn = (op) => (
    <Btn key={op} disabled={Boolean(acts[op].reason) || pending} title={acts[op].reason || undefined}
      onClick={() => open(op)}>{op === 'commit' ? 'Commit seeds…' : `${TITLES[op]}…`}</Btn>
  );
  return (
    <Strip role="status" aria-label="Git status">
      <b>{gitStripText(status)}</b>
      {other > 0 && <Badge $tone="warn">{`${pluralize(other, 'change')} outside seeds/ — won't be committed`}</Badge>}
      <Muted>{status.lastFetchAt ? `fetched ${fmtTime(status.lastFetchAt)}` : 'never fetched'}</Muted>
      <Btn disabled={busy || pending} title={busy ? acts.pull.reason : undefined} onClick={() => onRun('fetch')}>Fetch</Btn>
      {btn('pull')}{btn('commit')}{btn('push')}
      {dialog && (
        <Modal $w="480px" onClose={() => setDialog(null)} label={TITLES[dialog]}>
          <>
            <h3 style={{ marginTop: 0 }}>{TITLES[dialog]}</h3>
            <p>{gitConfirmText(dialog, status)}</p>
            {dialog === 'commit' && (<>
              <Files>{(status.seedsDirty || []).map((f) => <li key={f}>{f}</li>)}</Files>
              <Msg aria-label="Commit message" value={message} onChange={(e) => setMessage(e.target.value)} />
            </>)}
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 8 }}>
              <Btn onClick={() => setDialog(null)}>Cancel</Btn>
              <Btn $primary disabled={dialog === 'commit' && !message.trim()} onClick={run}>{TITLES[dialog]}</Btn>
            </div>
          </>
        </Modal>
      )}
    </Strip>
  );
}

export default function SeedGitStrip({ busy }) {
  const status = useGitStatus();
  const action = useGitAction();
  return (
    <GitStripView status={status.data} busy={busy} pending={action.isPending}
      onRun={(op, message) => action.mutate({ op, message })} />
  );
}
