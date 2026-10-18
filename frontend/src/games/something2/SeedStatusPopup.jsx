// SOMET-638. The popup a status badge opens: what differs, since when, and the
// one button that fixes it (status-popup mockup).
import { Link } from 'react-router-dom';
import styled from 'styled-components';
import { useSeedPreview } from './useSeedExport.js';
import { statusBadge, kindLabel } from './seedExportModel.js';
import { Btn, Badge, Muted, Backdrop, Dialog, fmtTime } from './seedUi.jsx';

const Table = styled.table`
  width: 100%; border-collapse: collapse; font-size: 0.85rem; margin-top: 0.5rem;
  th, td { text-align: left; padding: 4px; border-bottom: 1px solid var(--s2-border); }
  th { color: var(--s2-text-muted); font-weight: 500; font-size: 0.75rem; }
`;
const Err = styled.p`color: var(--s2-danger); font-size: 0.85rem;`;
const Acts = styled.div`display: flex; gap: 6px; justify-content: flex-end; margin-top: 0.8rem;`;
const MAX_ROWS = 8;

const WHY = {
  local_edits: (g) => `These rows changed on this PC after the last export${g.lastExport ? ` (${fmtTime(g.lastExport.started_at)})` : ''}. The other PC won't see them until you export and push.`,
  git_newer: (g) => `The files in git were exported${g.inGit ? ` by ${g.inGit.exported_by} on ${fmtTime(g.inGit.exported_at)}` : ''}. This PC last seeded ${g.label}${g.lastSeed ? ` on ${fmtTime(g.lastSeed.started_at)}` : ' never'}, so it may be running older data.`,
  never_exported: () => 'Nothing in git yet. Export to start.',
  tokens_missing: () => 'Some rows need a token that never travels through git. Set them on this PC.',
  in_sync: () => 'This PC and git agree.',
};

export default function SeedStatusPopup({ group, onClose, onExport, onSeed, exporting }) {
  const badge = statusBadge(group);
  const wantsRows = group.status === 'local_edits' || group.status === 'git_newer';
  const preview = useSeedPreview(group.id, wantsRows);
  const rows = preview.data?.rows || [];
  const exportBlocked = group.status === 'git_newer';

  return (
    <Backdrop onClick={onClose}>
      <Dialog onClick={(e) => e.stopPropagation()}>
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
          <p style={{ fontSize: '0.85rem' }}>{(WHY[group.status] || WHY.in_sync)(group)}</p>
        )}

        {wantsRows && preview.isLoading && <Muted>Loading rows…</Muted>}
        {wantsRows && preview.error && <Err>{preview.error.message}</Err>}
        {wantsRows && !preview.isLoading && !preview.error && rows.length > 0 && (
          <Table>
            <thead><tr><th>Row</th><th>What</th><th>Fields</th></tr></thead>
            <tbody>
              {rows.slice(0, MAX_ROWS).map((r) => (
                <tr key={r.syncUuid}>
                  <td>{String(r.key)}</td>
                  <td>{kindLabel(r.kind)}</td>
                  <td>{r.fields.map((f) => f.name).join(', ')}</td>
                </tr>
              ))}
              {rows.length > MAX_ROWS && <tr><td colSpan={3}><Muted>+ {rows.length - MAX_ROWS} more…</Muted></td></tr>}
            </tbody>
          </Table>
        )}

        {group.status === 'git_newer' && group.inGit && (
          <Muted>
            In git: {group.inGit.row_count} rows · {fmtTime(group.inGit.exported_at)} · {group.inGit.exported_by}.
            Edited here since last seed: {group.counts?.edited_here || 0}.
          </Muted>
        )}

        <Acts>
          {group.status === 'tokens_missing' && <Link to="/game/settings"><Btn as="span">Set token (AI Providers)</Btn></Link>}
          {group.inGit && wantsRows && <Btn $primary={group.status === 'git_newer'} onClick={onSeed}>Seed {group.label} (preview)…</Btn>}
          {group.status !== 'bad_file' && (
            <Btn $primary={!exportBlocked} disabled={exportBlocked || exporting}
              title={exportBlocked ? 'seed (preview) first' : undefined} onClick={onExport}>
              Export {group.label}
            </Btn>
          )}
        </Acts>
      </Dialog>
    </Backdrop>
  );
}
