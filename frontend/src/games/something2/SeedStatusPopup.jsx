// SOMET-638. The popup a status badge opens: what differs, since when, and the
// one button that fixes it (status-popup mockup).
import { Link } from 'react-router-dom';
import styled from 'styled-components';
import { useSeedPreview } from './useSeedExport.js';
import { statusBadge, kindLabel, tableLabel, exportBlockReason, seedBlockReason, BUSY_TEXT } from './seedExportModel.js';
import { Btn, Badge, Muted, Modal, fmtTime } from './seedUi.jsx';

const Table = styled.table`
  width: 100%; border-collapse: collapse; font-size: 1.4rem; margin-top: 0.5rem;
  th, td { text-align: left; padding: 4px; border-bottom: 1px solid var(--s2-border); }
  th { color: var(--s2-text-muted); font-weight: 500; font-size: 1.2rem; }
`;
const Err = styled.p`color: var(--s2-danger); font-size: 1.4rem;`;
const Acts = styled.div`display: flex; gap: 6px; justify-content: flex-end; margin-top: 0.8rem;`;
const MAX_ROWS = 8;

const WHY = {
  local_edits: (g) => `These rows changed on this PC after the last export${g.lastExport ? ` (${fmtTime(g.lastExport.started_at)})` : ''}. The other PC won't see them until you export and push.`,
  git_newer: (g) => `The files in git were exported${g.inGit ? ` by ${g.inGit.exported_by} on ${fmtTime(g.inGit.exported_at)}` : ''}. This PC last seeded ${g.label}${g.lastSeed ? ` on ${fmtTime(g.lastSeed.started_at)}` : ' never'}, so it may be running older data.`,
  never_exported: () => 'Nothing in git yet. Export to start.',
  tokens_missing: () => 'Some rows need a token that never travels through git. Set them on this PC.',
  in_sync: () => 'This PC and git agree.',
  file_missing: () => 'This PC exported this group before, but the file is not in backend/seeds/sync — pull from git or export again.',
  schema_newer: (g) => `The file in git was exported from a newer database schema${g.inGit ? ` (${g.inGit.schema_version})` : ''}. Run migrations on this PC before seeding or exporting ${g.label}.`,
};

// busy: a background job (SOMET-640) is running; Export and Seed wait for it.
export default function SeedStatusPopup({ group, onClose, onExport, onSeed, exporting, busy, hints }) {
  const badge = statusBadge(group);
  const wantsRows = group.status === 'local_edits' || group.status === 'git_newer';
  const preview = useSeedPreview(group.id, wantsRows);
  const rows = preview.data?.rows || [];
  const tables = preview.data?.tables || [];
  const multi = tables.length > 1;
  const exportWhy = busy ? BUSY_TEXT : exportBlockReason(group);
  const seedWhy = busy ? BUSY_TEXT : seedBlockReason(group);

  return (
    <Modal onClose={onClose} label={`${group.label}: ${badge.label}`}>
      <>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>{group.label} <Badge $tone={badge.tone}>{badge.label}</Badge></h3>
          <Btn onClick={onClose} aria-label="close">✕</Btn>
        </div>

        {group.status === 'bad_file' ? (
          <>
            <Err>{group.error}</Err>
            <Muted>{group.file}</Muted>
          </>
        ) : (
          <p style={{ fontSize: '1.4rem' }}>{(WHY[group.status] || WHY.in_sync)(group)}</p>
        )}

        {(hints || []).map((h) => <div key={h} role="note"><Muted>{h}</Muted></div>)}

        {wantsRows && preview.isLoading && <Muted>Loading rows…</Muted>}
        {wantsRows && preview.error && <Err>{preview.error.message}</Err>}
        {wantsRows && !preview.isLoading && !preview.error && rows.length > 0 && (
          <Table>
            <thead><tr>{multi && <th>Table</th>}<th>Row</th><th>What</th><th>Fields</th></tr></thead>
            <tbody>
              {rows.slice(0, MAX_ROWS).map((r) => (
                <tr key={r.syncUuid}>
                  {multi && <td>{tableLabel(r.table)}</td>}
                  <td>{String(r.key)}</td>
                  <td>{kindLabel(r.kind)}</td>
                  <td>{r.fields.map((f) => f.name).join(', ')}</td>
                </tr>
              ))}
              {rows.length > MAX_ROWS && <tr><td colSpan={multi ? 4 : 3}><Muted>+ {rows.length - MAX_ROWS} more…</Muted></td></tr>}
            </tbody>
          </Table>
        )}

        {wantsRows && multi && !preview.isLoading && (
          <Muted>
            {tables.map((t) => {
              const n = Object.values(t.counts || {}).reduce((a, b) => a + b, 0);
              return `${tableLabel(t.table)}: ${n}`;
            }).join(' · ')}
          </Muted>
        )}

        {group.status === 'git_newer' && group.inGit && (
          <Muted>
            In git: {group.inGit.row_count} rows · {fmtTime(group.inGit.exported_at)} · {group.inGit.exported_by}.
            Edited here since last seed: {group.counts?.edited_here || 0}.
          </Muted>
        )}

        <Acts>
          {group.status === 'tokens_missing' && <Link to="/game/settings"><Btn as="span">Set token (AI Providers)</Btn></Link>}
          {group.inGit && wantsRows && (
            <Btn $primary={group.status === 'git_newer'} disabled={Boolean(seedWhy)} title={seedWhy || undefined}
              onClick={onSeed}>Seed {group.label} (preview)…</Btn>
          )}
          {group.status !== 'bad_file' && (
            <Btn $primary={!exportWhy} disabled={Boolean(exportWhy) || exporting}
              title={exportWhy || undefined} onClick={onExport}>
              Export {group.label}
            </Btn>
          )}
        </Acts>
      </>
    </Modal>
  );
}
