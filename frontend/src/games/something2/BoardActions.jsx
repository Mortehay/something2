// SOMET-718. The left column of the Orange Pi tab: game version, the two
// tunnel links, the last action, and the confirm dialogs. Presentational; the
// parent passes onAction(kind) and everything the boxes need to decide.
import { useState } from 'react';
import styled from 'styled-components';
import toast from 'react-hot-toast';
import { Btn, Muted, Modal } from './seedUi.jsx';
import {
  confirmText, seedBlockers, safeUrl, tunnelLink, actionReason, jobRunning, jobTitle, logTail,
  SEED_NOTE, RESTART_NOTE_TEXT,
} from './boardModel.js';

const Box = styled.section`
  border: 1px solid var(--s2-border); border-radius: 8px; padding: 0.8rem 1rem; margin-bottom: 0.8rem;
  background: var(--s2-surface-raised);
  h4 { margin: 0 0 0.5rem; font-size: 1.3rem; color: var(--s2-text-strong); }
`;
const Row = styled.div`display: flex; gap: 0.6rem; flex-wrap: wrap; align-items: center; margin-top: 0.4rem;`;
const Link = styled.a`font-family: monospace; font-size: 1.2rem; word-break: break-all; color: var(--s2-accent);`;
const Pre = styled.pre`
  font-size: 1.1rem; background: var(--s2-bg-sunken); color: var(--s2-text-secondary); padding: 0.5rem 0.7rem;
  border-radius: 6px; max-height: 18rem; overflow: auto; white-space: pre-wrap; word-break: break-word; margin: 0.4rem 0 0;
`;
const Steps = styled.ul`list-style: none; padding: 0; margin: 0.3rem 0; font-size: 1.2rem;`;
const Err = styled.p`color: var(--s2-danger); margin: 0.4rem 0; font-size: 1.3rem;`;
const Note = styled.p`margin: 0.5rem 0 0; font-size: 1.2rem; color: var(--s2-text-muted);`;

const STEP_MARK = { ok: '✓', failed: '✗', running: '…' };
const STEP_TONE = { ok: 'var(--s2-success)', failed: 'var(--s2-danger)' };

async function copyLink(url) {
  try {
    await navigator.clipboard.writeText(url);
    toast.success('Link copied');
  } catch {
    // No clipboard (plain http, denied permission): hand the link over as text.
    toast.error(`Could not copy. Copy the link by hand: ${url}`, { duration: 15000 });
  }
}

function ExternalLink({ href, children }) {
  const url = safeUrl(href);
  if (!url) return null;
  return <Link href={url} target="_blank" rel="noopener noreferrer">{children || url}</Link>;
}

function TunnelBox({ name, label, tunnel, reason, open }) {
  const link = tunnelLink(tunnel);
  const on = tunnel?.state === 'on';
  return (
    <Box aria-label={`${label} link`}>
      <h4>{label} link</h4>
      {link && <div><ExternalLink href={link} /></div>}
      {on && !link && <Muted>Started, waiting for the link to answer</Muted>}
      {!on && <Muted>Stopped</Muted>}
      <Row>
        {link && <Btn onClick={() => copyLink(link)}>Copy</Btn>}
        {on
          ? <Btn disabled={Boolean(reason)} title={reason || undefined} onClick={() => open(`${name}-stop`)}>Stop</Btn>
          : <Btn disabled={Boolean(reason)} title={reason || undefined} onClick={() => open(`${name}-start`)}>Start</Btn>}
      </Row>
    </Box>
  );
}

function LastAction({ job, reason, open }) {
  if (!job) return <Box aria-label="Last action"><h4>Last action</h4><Muted>Nothing has run yet</Muted></Box>;
  const ci = safeUrl(job.ciUrl);
  const log = logTail(job.log);
  return (
    <Box aria-label="Last action">
      <h4>{jobTitle(job)}</h4>
      {Array.isArray(job.steps) && job.steps.length > 0 && (
        <Steps>
          {job.steps.map((s, i) => (
            <li key={`${s.name}-${i}`} style={{ color: STEP_TONE[s.state] || 'var(--s2-text-muted)' }}>
              {STEP_MARK[s.state] || '·'} {s.name}{s.detail ? <Muted> · {s.detail}</Muted> : null}
            </li>
          ))}
        </Steps>
      )}
      {job.state === 'failed' && <Err>{job.error || 'The action failed'}</Err>}
      {ci && <div><ExternalLink href={ci}>CI run</ExternalLink></div>}
      {job.kind === 'seed' && job.state === 'ok' && (
        <>
          <Note>{RESTART_NOTE_TEXT}</Note>
          <Row><Btn disabled={Boolean(reason)} title={reason || undefined} onClick={() => open('restart')}>Restart</Btn></Row>
        </>
      )}
      {log && <Pre>{log}</Pre>}
    </Box>
  );
}

const TITLES = {
  update: 'Update to latest main', seed: 'Seed from git', restart: 'Restart the game',
  'cloudflare-stop': 'Stop the Cloudflare link', 'cloudflare-start': 'Start the Cloudflare link',
  'ngrok-stop': 'Stop the ngrok link', 'ngrok-start': 'Start the ngrok link',
};

function SeedBody({ preview }) {
  if (!preview || preview.state === 'loading') return <p>Checking what would change…</p>;
  if (preview.state === 'error') return <Err>{preview.message}</Err>;
  const data = preview.data;
  if (data?.needsUpdate) return <p>The board must be updated first, then seeded.</p>;
  const blocked = seedBlockers(data);
  return (
    <>
      <p>{confirmText('seed', data)}</p>
      {blocked && <Err>{blocked}</Err>}
    </>
  );
}

// null when the dialog may be confirmed, else why not.
function seedApplyBlock(preview) {
  if (!preview || preview.state !== 'ready') return 'Waiting for the preview';
  if (preview.data?.needsUpdate) return 'The board must be updated first';
  return seedBlockers(preview.data);
}

function Dialog({ kind, status, preview, onConfirm, onClose }) {
  const isSeed = kind === 'seed';
  const text = kind === 'update' ? confirmText('update', status) : confirmText(kind, preview?.data);
  const block = isSeed ? seedApplyBlock(preview) : null;
  return (
    <Modal $w="520px" onClose={onClose} label={TITLES[kind]}>
      <h3 style={{ marginTop: 0 }}>{TITLES[kind]}</h3>
      {isSeed ? <SeedBody preview={preview} /> : <p>{text}</p>}
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 8 }}>
        <Btn onClick={onClose}>Cancel</Btn>
        {!(isSeed && preview?.data?.needsUpdate) && (
          <Btn $primary disabled={Boolean(block)} title={block || undefined} onClick={onConfirm}>
            {isSeed ? 'Apply' : (TITLES[kind].startsWith('Update') ? 'Update' : TITLES[kind].split(' ')[0])}
          </Btn>
        )}
      </div>
    </Modal>
  );
}

export default function BoardActions({ status, job, preview, onAction }) {
  const [dialog, setDialog] = useState(null);
  const reason = actionReason(status, job);
  const open = (kind) => {
    if (kind === 'seed') onAction('seed-preview');
    setDialog(kind);
  };
  const confirm = () => { const k = dialog; setDialog(null); onAction(k); };
  const t = status.tunnels || {};
  return (
    <div>
      <Box aria-label="Game version">
        <h4>Game version</h4>
        <Row>
          <Btn $primary disabled={Boolean(reason)} title={reason || undefined} onClick={() => open('update')}>Update to latest main</Btn>
          <Btn disabled={Boolean(reason)} title={reason || undefined} onClick={() => open('seed')}>Seed from git</Btn>
        </Row>
        <Note>{SEED_NOTE}</Note>
        {jobRunning(job) && <Note>A job is running: {job.kind}.</Note>}
      </Box>
      <TunnelBox name="ngrok" label="ngrok" tunnel={t.ngrok} reason={reason} open={open} />
      <TunnelBox name="cloudflare" label="Cloudflare" tunnel={t.cloudflare} reason={reason} open={open} />
      <LastAction job={job} reason={reason} open={open} />
      {dialog && (
        <Dialog kind={dialog} status={status} preview={preview} onConfirm={confirm} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}
