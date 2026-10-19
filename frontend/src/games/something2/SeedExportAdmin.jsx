// SOMET-638. Seed / Export tab: per-group export (this PC -> git files) and
// seed (git files -> this PC) with a mass-check preview. All rules about what
// a decision may be live in seedExportModel.js and, authoritatively, on the
// backend; this file fetches and renders.
import { useState } from 'react';
import styled from 'styled-components';
import { useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  useSeedGroups, useRestartStatus, useExportGroup, useExportAll, useRestartBackend, useSeedMeta,
  useSeedJob, useCancelSeedJob,
} from './useSeedExport.js';
import {
  statusBadge, exportBlockReason, seedBlockReason, seedButtonLabel, exportAllPlan, seedAllGroups, exportAllMessage,
  binaryGroups, separateNote, BUSY_TEXT, jobRunning, jobProgressText, jobErrorRowsText,
} from './seedExportModel.js';
import { Btn, Badge, Muted, Modal, fmtTime, StatusHead, PcLabelHint } from './seedUi.jsx';
import AdminLoading from './AdminLoading.jsx';
import SeedStatusPopup from './SeedStatusPopup.jsx';
import SeedPreviewModal from './SeedPreviewModal.jsx';
import SeedAllModal from './SeedAllModal.jsx';
import SeedHistoryTab from './SeedHistoryTab.jsx';

const Page = styled.div`
  padding: 2rem; color: var(--s2-text); max-width: 1200px; margin: 0 auto;
  height: 100%; overflow-y: auto; background-color: var(--s2-surface);
`;
const Banner = styled.div`
  display: flex; align-items: center; gap: 1rem; justify-content: space-between; margin: 0.8rem 0;
  padding: 0.6rem 0.9rem; border-radius: 8px; border: 1px solid var(--s2-warning);
  background: var(--s2-surface-raised); color: var(--s2-text);
`;
const Table = styled.table`
  width: 100%; border-collapse: collapse; margin-top: 0.8rem; font-size: 1.4rem;
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--s2-border); vertical-align: middle; }
  th { color: var(--s2-text-muted); font-weight: 500; font-size: 1.2rem; }
`;
const Acts = styled.div`display: flex; gap: 6px; justify-content: flex-end;`;
const Err = styled.p`color: var(--s2-danger);`;

const Tabs = styled.div`display: flex; gap: 4px; margin: 0.8rem 0; border-bottom: 1px solid var(--s2-border);`;
const Tab = styled.button`
  padding: 0.4rem 1rem; font-size: 1.4rem; cursor: pointer; background: transparent; color: var(--s2-text);
  border: 0; border-bottom: 2px solid ${p => (p.$on ? 'var(--s2-accent)' : 'transparent')};
  font-weight: ${p => (p.$on ? 700 : 400)};
`;
const AllBar = styled.div`display: flex; gap: 6px; margin-top: 0.8rem; align-items: center; flex-wrap: wrap;`;
const JobBox = styled.div`
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 4px; font-size: 1.2rem;
  progress { width: 140px; height: 10px; accent-color: var(--s2-accent); }
`;
const JobErr = styled.span`color: var(--s2-danger);`;

const runLine = (r) => (r ? `${fmtTime(r.finished_at || r.started_at)} · ${r.pc_label}` : 'never');

// SOMET-640. A binary group's background job, under its status badge: a
// progress bar and Cancel while it runs, the outcome once it ends.
export function JobStatus({ job, label, onCancel, cancelling }) {
  const text = jobProgressText(job, label);
  if (!jobRunning(job)) {
    const rows = jobErrorRowsText(job);
    const Line = job.status === 'failed' ? JobErr : Muted;
    return <JobBox role="status"><Line>{text}</Line>{rows && <Muted>{rows}</Muted>}</JobBox>;
  }
  const total = Number(job.total) || 0;
  return (
    <JobBox role="status">
      {/* No value while there is nothing to count: an indeterminate bar. */}
      {total > 0
        ? <progress max={total} value={Number(job.done) || 0} aria-label={text} />
        : <progress aria-label={text} />}
      <Muted>{text}</Muted>
      <Btn onClick={onCancel} disabled={Boolean(cancelling || job.cancelRequested)}>Cancel</Btn>
    </JobBox>
  );
}

// One group's table row. `job` is the current job (any group, or null):
// while it runs every Export / Seed is disabled with BUSY_TEXT.
export function GroupRow({ g, job, exporting, onExport, onSeed, onBadge, onCancel, cancelling }) {
  const badge = statusBadge(g);
  const busy = jobRunning(job);
  const exportWhy = busy ? BUSY_TEXT : exportBlockReason(g);
  const seedWhy = busy ? BUSY_TEXT : seedBlockReason(g);
  const own = job && job.groupId === g.id ? job : null;
  return (
    <tr>
      <td><b>{g.label}</b></td>
      <td>{runLine(g.lastExport)}</td>
      <td>{g.inGit ? `${fmtTime(g.inGit.exported_at)} · ${g.inGit.exported_by}` : '—'}</td>
      <td>{runLine(g.lastSeed)}</td>
      <td>
        <Badge as="button" $tone={badge.tone} onClick={onBadge}>{badge.label}</Badge>
        {own && <JobStatus job={own} label={g.label} onCancel={onCancel} cancelling={cancelling} />}
      </td>
      <td><Acts>
        <Btn disabled={Boolean(exportWhy) || Boolean(exporting)}
          title={exportWhy || undefined}
          onClick={onExport}>Export</Btn>
        <Btn disabled={Boolean(seedWhy)} title={seedWhy || undefined}
          onClick={onSeed}>{seedButtonLabel(g)}</Btn>
      </Acts></td>
    </tr>
  );
}

export default function SeedExportAdmin() {
  const groups = useSeedGroups();
  const restart = useRestartStatus();
  const meta = useSeedMeta();
  const exportGroup = useExportGroup();
  const exportAll = useExportAll();
  const restartBackend = useRestartBackend();
  const jobQuery = useSeedJob();
  const cancelJob = useCancelSeedJob();
  const [popupId, setPopupId] = useState(null);
  const [previewId, setPreviewId] = useState(null);
  const [seedAllOpen, setSeedAllOpen] = useState(false);
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'history' ? 'history' : 'groups';
  const setTab = (t) => setParams((p) => { const n = new URLSearchParams(p); if (t === 'groups') n.delete('tab'); else n.set('tab', t); return n; }, { replace: true });
  const [confirmRestart, setConfirmRestart] = useState(false);

  if (groups.isLoading) return <Page><AdminLoading /></Page>;
  if (groups.error) return <Page><Err>{groups.error.message}</Err></Page>;

  const list = groups.data || [];
  const byId = (id) => list.find((g) => g.id === id);
  const popup = byId(popupId);
  const preview = byId(previewId);
  const doExport = (g) => exportGroup.mutate({ groupId: g.id });
  const plan = exportAllPlan(list);
  const seedable = seedAllGroups(list);
  const binary = binaryGroups(list);
  const job = jobQuery.data || null;
  const busy = jobRunning(job);
  const doExportAll = async () => {
    const results = await exportAll.mutateAsync(plan.toExport);
    const msg = exportAllMessage(results, plan.skipped);
    const opts = { style: { whiteSpace: 'pre-line' }, duration: 8000 };
    if (results.some((r) => !r.ok)) toast.error(msg, opts);
    else toast.success(msg, opts);
  };

  return (
    <Page>
      <h2 style={{ marginTop: 0 }}>Seed / Export</h2>
      <Muted>Export writes this PC's data to the seed files in git. Seed reads them back after a pull, with a preview.</Muted>
      <PcLabelHint meta={meta.data} />

      {restart.data?.required && (
        <Banner>
          <span><b>Seeded data is applied on restart</b></span>
          <Btn $primary onClick={() => setConfirmRestart(true)} disabled={restartBackend.isPending}>Restart backend</Btn>
        </Banner>
      )}

      <Tabs role="tablist" aria-label="Seed / Export sections">
        {[['groups', 'Groups'], ['history', 'History']].map(([id, label]) => (
          <Tab key={id} role="tab" id={`seed-tab-${id}`} aria-selected={tab === id} $on={tab === id}
            onClick={() => setTab(id)}>{label}</Tab>
        ))}
      </Tabs>

      {tab === 'history' && <SeedHistoryTab groups={list} />}
      {tab === 'groups' && (<>
      <AllBar>
        <Btn disabled={busy || exportAll.isPending || (plan.toExport.length === 0 && plan.skipped.length === 0)}
          title={busy ? BUSY_TEXT : (plan.toExport.length === 0 ? 'nothing to export' : undefined)}
          onClick={doExportAll}>Export all</Btn>
        <Btn disabled={busy || seedable.length === 0} title={busy ? BUSY_TEXT : undefined}
          onClick={() => setSeedAllOpen(true)}>Seed all…</Btn>
        {binary.length > 0 && (<>
          <Muted style={{ marginLeft: 8 }}>{separateNote(binary)}:</Muted>
          {binary.map((g) => {
            const why = busy ? BUSY_TEXT : exportBlockReason(g);
            return (
              <Btn key={g.id} disabled={Boolean(why) || exportGroup.isPending} title={why || undefined}
                onClick={() => doExport(g)}>{`Export ${g.label}`}</Btn>
            );
          })}
        </>)}
      </AllBar>

      <Table>
        <thead>
          <tr><th>Group</th><th>Last export (this PC)</th><th>In git (time · PC)</th><th>Last seed (this PC)</th><th><StatusHead restartRequired={Boolean(restart.data?.required)} /></th><th /></tr>
        </thead>
        <tbody>
          {list.map((g) => (
            <GroupRow key={g.id} g={g} job={job} exporting={exportGroup.isPending}
              onExport={() => doExport(g)} onSeed={() => setPreviewId(g.id)} onBadge={() => setPopupId(g.id)}
              onCancel={() => cancelJob.mutate()} cancelling={cancelJob.isPending} />
          ))}
        </tbody>
      </Table>
      </>)}

      {popup && (
        <SeedStatusPopup group={popup} exporting={exportGroup.isPending} busy={busy}
          onClose={() => setPopupId(null)}
          onExport={() => { doExport(popup); setPopupId(null); }}
          onSeed={() => { setPreviewId(popup.id); setPopupId(null); }} />
      )}
      {seedAllOpen && (
        <SeedAllModal groups={seedable} binaryGroups={binary} busy={busy} onClose={() => setSeedAllOpen(false)}
          onSeedGroup={(id) => { setSeedAllOpen(false); setPreviewId(id); }} />
      )}
      {preview && <SeedPreviewModal group={preview} busy={busy} onClose={() => setPreviewId(null)} />}
      {confirmRestart && (
        <Modal $w="420px" onClose={() => setConfirmRestart(false)} label="Restart backend">
          <>
            <p>Restarting the backend interrupts any running art, sprite or audio batch. Restart now?</p>
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <Btn onClick={() => setConfirmRestart(false)}>Cancel</Btn>
              <Btn $primary onClick={() => { restartBackend.mutate(); setConfirmRestart(false); }}>Restart</Btn>
            </div>
          </>
        </Modal>
      )}
    </Page>
  );
}
