// SOMET-718. The left column of the Orange Pi tab: game version, the two
// tunnel links, the last action, and the confirm dialogs. Presentational; the
// parent passes onAction(kind) and everything the boxes need to decide.
import { useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import toast from 'react-hot-toast';
import { Btn, Muted, Modal } from './seedUi.jsx';
import {
  confirmText, playersOnlineCount, seedBlockers, safeUrl, tunnelLink, tunnelState, actionReason, jobRunning, jobTitle, jobResultText, logTail,
  previewExpired, dialogLabels, canOfferRestart, updateLabel, tunnelStartAction, ngrokUsageText, cloudflareAgeText, SEED_NOTE, RESTART_NOTE_TEXT, PREVIEW_LOADING_TEXT, elapsedSeconds,
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
const Result = styled.p`
  margin: 0.3rem 0 0.5rem; font-size: 1.4rem; font-weight: 600;
  color: ${(p) => (p.$tone === 'ok' ? 'var(--s2-success)' : 'var(--s2-danger)')};
`;
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

const NGROK_BILLING_URL = 'https://dashboard.ngrok.com/billing';

function NgrokUsage({ tunnel }) {
  const u = ngrokUsageText(tunnel);
  if (!u) return null;
  return (
    <>
      {u.limit && <Err role="alert">{u.limit}</Err>}
      <Note style={u.warn ? { color: 'var(--s2-danger)' } : undefined}>This month: {u.out}, {u.requests}.</Note>
      <Note>Estimate from this board since {u.since}, by calendar month. ngrok's billing cycle and other use of the account can differ. <ExternalLink href={NGROK_BILLING_URL}>ngrok's own figures</ExternalLink></Note>
    </>
  );
}

function CloudflareAge({ tunnel }) {
  const a = cloudflareAgeText(tunnel);
  return <Note>{a.up && <>{a.up} </>}{a.note} {a.past}</Note>;
}

function TunnelBox({ name, label, tunnel, other, online, reason, open }) {
  const state = tunnelState(tunnel);
  // Offline: the helper's last answer is history, not a link to hand out.
  const link = online ? tunnelLink(tunnel) : null;
  let body;
  let buttons = null;
  const disabled = Boolean(reason);
  const stop = <Btn disabled={disabled} title={reason || undefined} onClick={() => open(`${name}-stop`)}>Stop</Btn>;
  if (!online) body = <Muted>Unknown while the board is offline</Muted>;
  else if (state === 'unknown') body = <Muted>Unknown</Muted>;
  else if (state === 'off') {
    const start = tunnelStartAction(name, other);
    body = <Muted>Stopped</Muted>;
    buttons = <Btn disabled={disabled} title={reason || undefined} onClick={() => open(start.kind)}>{start.label}</Btn>;
  } else if (link) {
    body = <div><ExternalLink href={link} /></div>;
    buttons = <><Btn onClick={() => copyLink(link)}>Copy</Btn>{stop}</>;
  } else {
    body = <Muted>Running, but the link isn't answering</Muted>;
    buttons = stop;
  }
  return (
    <Box aria-label={`${label} link`}>
      <h4>{label} link</h4>
      {body}
      {buttons && <Row>{buttons}</Row>}
      {buttons && reason && <Note role="status">{reason}. Start, Stop and Switch work again once it finishes.</Note>}
      {online && name === 'ngrok' && <NgrokUsage tunnel={tunnel} />}
      {online && name === 'cloudflare' && <CloudflareAge tunnel={tunnel} />}
    </Box>
  );
}

// A tail: shows the newest lines as the log grows, unless the user scrolled up.
function LogBox({ text }) {
  const ref = useRef(null);
  const stuck = useRef(true);
  const onScroll = () => {
    const el = ref.current;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  useEffect(() => {
    const el = ref.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [text]);
  return <Pre ref={ref} onScroll={onScroll}>{text}</Pre>;
}

function LastAction({ job, notice, reason, open }) {
  if (!job) {
    return (
      <Box aria-label="Last action"><h4>Last action</h4>
        {notice && <Err role="alert">{notice}</Err>}
        <Muted>Nothing has run yet</Muted>
      </Box>
    );
  }
  const ci = safeUrl(job.ciUrl);
  const log = logTail(job.log);
  const result = jobResultText(job);
  return (
    <Box aria-label="Last action">
      <h4>{jobTitle(job)}</h4>
      {result && <Result $tone={result.tone} role="status">{result.text}</Result>}
      {notice && <Err role="alert">{notice}</Err>}
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
      {canOfferRestart(job) && (
        <>
          <Note>{RESTART_NOTE_TEXT}</Note>
          <Row><Btn disabled={Boolean(reason)} title={reason || undefined} onClick={() => open('restart')}>Restart</Btn></Row>
        </>
      )}
      {log && <LogBox text={log} />}
    </Box>
  );
}

const STALE_TEXT = 'This preview is more than 5 minutes old. Preview it again before applying.';

// The preview reads eleven groups on a small board and can take a minute or two: say so, and count.
function PreviewLoading({ startedAt }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <p role="status">{PREVIEW_LOADING_TEXT} <Muted>{elapsedSeconds(startedAt, now)} s</Muted></p>;
}

function SeedBody({ preview, expired }) {
  if (!preview || preview.state === 'loading') return <PreviewLoading startedAt={preview?.startedAt} />;
  if (preview.state === 'error') return <Err>{preview.message}</Err>;
  const data = preview.data;
  if (data?.needsUpdate) return <p>The board must be updated first, then seeded.</p>;
  const blocked = seedBlockers(data);
  return (
    <>
      <p>{confirmText('seed', data)}</p>
      {blocked && <Err>{blocked}</Err>}
      {expired && <Err>{STALE_TEXT}</Err>}
    </>
  );
}

// null when the seed may be applied, else why not.
function seedApplyBlock(preview, now) {
  if (!preview || preview.state !== 'ready') return 'Waiting for the preview';
  if (preview.data?.needsUpdate) return 'The board must be updated first';
  if (previewExpired(preview, now)) return STALE_TEXT;
  return seedBlockers(preview.data);
}

// The confirm button re-checks everything on every render: a job can start, a
// request can be in flight, or the board can go offline while the dialog is open.
export function ConfirmDialog({ kind, status, job, pending, preview, now, players, onConfirm, onClose, onPreviewAgain }) {
  const isSeed = kind === 'seed';
  const labels = dialogLabels(kind, status);
  const expired = isSeed && previewExpired(preview, now);
  const text = kind === 'update' ? confirmText('update', status, playersOnlineCount(players)) : confirmText(kind, preview?.data);
  const block = actionReason(status, job, pending) || (isSeed ? seedApplyBlock(preview, now) : null);
  const canRefresh = isSeed && (expired || preview?.state === 'error');
  return (
    <Modal $w="520px" onClose={onClose} label={labels.title}>
      <h3 style={{ marginTop: 0 }}>{labels.title}</h3>
      {isSeed ? <SeedBody preview={preview} expired={expired} /> : <p>{text}</p>}
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 8 }}>
        <Btn onClick={onClose}>Cancel</Btn>
        {canRefresh && <Btn onClick={onPreviewAgain}>Preview again</Btn>}
        {!(isSeed && preview?.data?.needsUpdate) && (
          <Btn $primary disabled={Boolean(block)} title={block || undefined} onClick={onConfirm}>{labels.confirm}</Btn>
        )}
      </div>
    </Modal>
  );
}

export default function BoardActions({ status, job, preview, players, pending = false, notice = null, now, onAction }) {
  const [dialog, setDialog] = useState(null);
  const reason = actionReason(status, job, pending);
  const online = status.online !== false;
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
          <Btn $primary disabled={Boolean(reason)} title={reason || undefined} onClick={() => open('update')}>{updateLabel(status)}</Btn>
          <Btn disabled={Boolean(reason)} title={reason || undefined} onClick={() => open('seed')}>Seed from git</Btn>
          <Btn disabled={Boolean(reason)} title={reason || undefined} onClick={() => open('maps')}>Apply maps</Btn>
        </Row>
        <Note>{SEED_NOTE}</Note>
        {jobRunning(job) && <Note>A job is running: {job.kind}.</Note>}
      </Box>
      <TunnelBox name="ngrok" label="ngrok" tunnel={t.ngrok} other={t.cloudflare} online={online} reason={reason} open={open} />
      <TunnelBox name="cloudflare" label="Cloudflare" tunnel={t.cloudflare} other={t.ngrok} online={online} reason={reason} open={open} />
      <LastAction job={job} notice={notice} reason={reason} open={open} />
      {dialog && (
        <ConfirmDialog kind={dialog} status={status} job={job} pending={pending} preview={preview} now={now} players={players}
          onConfirm={confirm} onClose={() => setDialog(null)} onPreviewAgain={() => onAction('seed-preview')} />
      )}
    </div>
  );
}
