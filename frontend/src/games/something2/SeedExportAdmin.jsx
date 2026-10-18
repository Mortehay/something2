// SOMET-638. Seed / Export tab: per-group export (this PC -> git files) and
// seed (git files -> this PC) with a mass-check preview. All rules about what
// a decision may be live in seedExportModel.js and, authoritatively, on the
// backend; this file fetches and renders.
import { useState } from 'react';
import styled from 'styled-components';
import { useSeedGroups, useSeedRuns, useRestartStatus, useExportGroup, useRestartBackend } from './useSeedExport.js';
import { statusBadge, exportBlocked as isExportBlocked } from './seedExportModel.js';
import { Btn, Badge, Muted, Modal, fmtTime } from './seedUi.jsx';
import AdminLoading from './AdminLoading.jsx';
import SeedStatusPopup from './SeedStatusPopup.jsx';
import SeedPreviewModal from './SeedPreviewModal.jsx';

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

const runLine = (r) => (r ? `${fmtTime(r.finished_at || r.started_at)} · ${r.pc_label}` : 'never');

export default function SeedExportAdmin() {
  const groups = useSeedGroups();
  const runs = useSeedRuns();
  const restart = useRestartStatus();
  const exportGroup = useExportGroup();
  const restartBackend = useRestartBackend();
  const [popupId, setPopupId] = useState(null);
  const [previewId, setPreviewId] = useState(null);
  const [confirmRestart, setConfirmRestart] = useState(false);

  if (groups.isLoading) return <Page><AdminLoading /></Page>;
  if (groups.error) return <Page><Err>{groups.error.message}</Err></Page>;

  const list = groups.data || [];
  const byId = (id) => list.find((g) => g.id === id);
  const popup = byId(popupId);
  const preview = byId(previewId);
  const doExport = (g) => exportGroup.mutate({ groupId: g.id });

  return (
    <Page>
      <h2 style={{ marginTop: 0 }}>Seed / Export</h2>
      <Muted>Export writes this PC's data to the seed files in git. Seed reads them back after a pull, with a preview.</Muted>

      {restart.data?.required && (
        <Banner>
          <span><b>Seeded data is applied on restart</b></span>
          <Btn $primary onClick={() => setConfirmRestart(true)} disabled={restartBackend.isPending}>Restart backend</Btn>
        </Banner>
      )}

      <Table>
        <thead>
          <tr><th>Group</th><th>Last export (this PC)</th><th>In git (time · PC)</th><th>Last seed (this PC)</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          {list.map((g) => {
            const badge = statusBadge(g);
            const exportBlocked = isExportBlocked(g);
            return (
              <tr key={g.id}>
                <td><b>{g.label}</b></td>
                <td>{runLine(g.lastExport)}</td>
                <td>{g.inGit ? `${fmtTime(g.inGit.exported_at)} · ${g.inGit.exported_by}` : '—'}</td>
                <td>{runLine(g.lastSeed)}</td>
                <td><Badge as="button" $tone={badge.tone} onClick={() => setPopupId(g.id)}>{badge.label}</Badge></td>
                <td><Acts>
                  <Btn disabled={exportBlocked || exportGroup.isPending || g.status === 'bad_file'}
                    title={exportBlocked ? 'seed (preview) first' : undefined}
                    onClick={() => doExport(g)}>Export</Btn>
                  <Btn disabled={!g.inGit} title={g.inGit ? undefined : g.status === 'bad_file' ? 'fix or delete the export file first' : 'nothing in git yet'}
                    onClick={() => setPreviewId(g.id)}>Seed…</Btn>
                </Acts></td>
              </tr>
            );
          })}
        </tbody>
      </Table>

      <h3 style={{ marginTop: '1.6rem' }}>History</h3>
      {runs.isLoading && <Muted>Loading…</Muted>}
      {runs.error && <Err>{runs.error.message}</Err>}
      {runs.data && runs.data.length === 0 && <Muted>No runs yet.</Muted>}
      {runs.data && runs.data.length > 0 && (
        <Table>
          <thead><tr><th>When</th><th>Group</th><th>Action</th><th>Status</th><th>PC</th><th>Result</th></tr></thead>
          <tbody>
            {runs.data.map((r) => (
              <tr key={r.id}>
                <td>{fmtTime(r.started_at)}</td><td>{r.group_id}</td><td>{r.action}</td>
                <td>{r.status}</td><td>{r.pc_label}</td>
                <td>{r.error ? <span style={{ color: 'var(--s2-danger)' }}>{r.error}</span>
                  : Object.entries(r.summary || {}).map(([k, v]) => `${k} ${v}`).join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {popup && (
        <SeedStatusPopup group={popup} exporting={exportGroup.isPending}
          onClose={() => setPopupId(null)}
          onExport={() => { doExport(popup); setPopupId(null); }}
          onSeed={() => { setPreviewId(popup.id); setPopupId(null); }} />
      )}
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
