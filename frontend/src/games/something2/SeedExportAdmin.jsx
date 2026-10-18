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
} from './useSeedExport.js';
import {
  statusBadge, exportBlockReason, seedBlockReason, seedButtonLabel, exportAllPlan, seedAllGroups, exportAllMessage,
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
const AllBar = styled.div`display: flex; gap: 6px; margin-top: 0.8rem;`;

const runLine = (r) => (r ? `${fmtTime(r.finished_at || r.started_at)} · ${r.pc_label}` : 'never');

export default function SeedExportAdmin() {
  const groups = useSeedGroups();
  const restart = useRestartStatus();
  const meta = useSeedMeta();
  const exportGroup = useExportGroup();
  const exportAll = useExportAll();
  const restartBackend = useRestartBackend();
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
        <Btn disabled={exportAll.isPending || (plan.toExport.length === 0 && plan.skipped.length === 0)}
          title={plan.toExport.length === 0 ? 'nothing to export' : undefined}
          onClick={doExportAll}>Export all</Btn>
        <Btn disabled={seedable.length === 0} onClick={() => setSeedAllOpen(true)}>Seed all…</Btn>
      </AllBar>

      <Table>
        <thead>
          <tr><th>Group</th><th>Last export (this PC)</th><th>In git (time · PC)</th><th>Last seed (this PC)</th><th><StatusHead restartRequired={Boolean(restart.data?.required)} /></th><th /></tr>
        </thead>
        <tbody>
          {list.map((g) => {
            const badge = statusBadge(g);
            const exportWhy = exportBlockReason(g);
            const seedWhy = seedBlockReason(g);
            return (
              <tr key={g.id}>
                <td><b>{g.label}</b></td>
                <td>{runLine(g.lastExport)}</td>
                <td>{g.inGit ? `${fmtTime(g.inGit.exported_at)} · ${g.inGit.exported_by}` : '—'}</td>
                <td>{runLine(g.lastSeed)}</td>
                <td><Badge as="button" $tone={badge.tone} onClick={() => setPopupId(g.id)}>{badge.label}</Badge></td>
                <td><Acts>
                  <Btn disabled={Boolean(exportWhy) || exportGroup.isPending}
                    title={exportWhy || undefined}
                    onClick={() => doExport(g)}>Export</Btn>
                  <Btn disabled={Boolean(seedWhy)} title={seedWhy || undefined}
                    onClick={() => setPreviewId(g.id)}>{seedButtonLabel(g)}</Btn>
                </Acts></td>
              </tr>
            );
          })}
        </tbody>
      </Table>
      </>)}

      {popup && (
        <SeedStatusPopup group={popup} exporting={exportGroup.isPending}
          onClose={() => setPopupId(null)}
          onExport={() => { doExport(popup); setPopupId(null); }}
          onSeed={() => { setPreviewId(popup.id); setPopupId(null); }} />
      )}
      {seedAllOpen && <SeedAllModal groups={seedable} onClose={() => setSeedAllOpen(false)} />}
      {preview && <SeedPreviewModal group={preview} onClose={() => setPreviewId(null)} />}
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
