// The clip library tab (SOMET-591, game audio slice 2): every stored clip,
// independent of any subject, with the tools to reuse or clean one up.
// Binding-to-a-subject itself happens from AudioSlotCard's "+ From library"
// picker, not from here -- this tab only plays, labels and deletes.
import { useState } from 'react';
import styled from 'styled-components';
import {
  useAudioClips, useDeleteClip, useDeleteUnboundClips,
} from './useAudioAdmin.js';
import { assetUrl } from './src/js/net/assets.js';
import { API_URL } from '../../config.js';
import AdminLoading from './AdminLoading.jsx';

const Wrap = styled.div`padding: 1rem 0;`;
const Bar = styled.div`
  display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: center; margin-bottom: 0.75rem;
`;
const Field = styled.label`
  display: flex; align-items: center; gap: 0.4rem; font-size: 0.85rem; color: var(--s2-text-muted);
  select {
    background: var(--s2-bg-sunken); color: var(--s2-text); border: 1px solid var(--s2-border-strong);
    border-radius: 4px; padding: 0.3rem; font-size: 0.85rem;
  }
`;
const Button = styled.button`
  background: var(--s2-accent); color: var(--s2-on-accent); border: none; border-radius: 6px;
  padding: 0.35rem 0.8rem; font-weight: bold; cursor: pointer; font-size: 0.8rem;
  &:disabled { opacity: 0.5; cursor: default; }
`;
const Secondary = styled(Button)`background: var(--s2-btn-grey);`;
const Table = styled.table`
  width: 100%; border-collapse: collapse; font-size: 0.85rem;
  th, td { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--s2-border); }
  th { color: var(--s2-text-muted); font-weight: 600; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.03em; }
`;
const IconButton = styled.button`
  background: none; border: 1px solid var(--s2-border-strong); border-radius: 4px;
  color: var(--s2-text); width: 1.8rem; height: 1.8rem; cursor: pointer;
  display: flex; align-items: center; justify-content: center; font-size: 0.75rem;
  &:hover { background: var(--s2-overlay); }
`;
const Drop = styled.button`
  background: none; border: none; color: var(--s2-text-muted); cursor: pointer;
  font-size: 1rem; line-height: 1; padding: 0 0.2rem;
  &:hover { color: var(--s2-danger); }
`;
const Pill = styled.span`
  font-size: 0.72rem; padding: 0.05rem 0.4rem; border-radius: 999px;
  background: var(--s2-bg-sunken); color: var(--s2-text-muted);
`;
const Hint = styled.p`color: var(--s2-text-muted); font-size: 0.85rem; margin: 0.25rem 0;`;
const Pager = styled.div`display: flex; gap: 0.5rem; align-items: center; margin: 0.75rem 0; font-size: 0.85rem;`;

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
const formatKb = (bytes) => (Number.isFinite(bytes) ? `${Math.round(bytes / 1024)} KB` : '—');

const KINDS = ['music', 'ambience', 'sfx'];

function ClipRow({
  clip, playing, onPlay, onStop,
}) {
  const del = useDeleteClip();
  return (
    <tr>
      <td>
        <IconButton
          type="button"
          aria-label={playing ? `Stop ${clip.label}` : `Play ${clip.label}`}
          onClick={() => (playing ? onStop() : onPlay(clip.id, assetUrl(API_URL, clip.storage_key)))}
        >
          {playing ? '■' : '▶'}
        </IconButton>
      </td>
      <td title={clip.label}>{clip.label}</td>
      <td>{clip.kind}</td>
      <td>{formatDuration(clip.duration_ms)}</td>
      <td>{formatKb(clip.bytes)}</td>
      <td><Pill>{clip.binding_count}</Pill></td>
      <td>
        <Drop
          type="button"
          aria-label={`Delete ${clip.label}`}
          disabled={del.isPending}
          onClick={() => {
            const bound = clip.binding_count
              ? ` It is bound to ${clip.binding_count} slot(s); those will lose it.`
              : '';
            if (window.confirm(`Delete "${clip.label}"?${bound} This cannot be undone.`)) del.mutate(clip.id);
          }}
        >×</Drop>
      </td>
    </tr>
  );
}

// `playback` is lifted from AudioAdmin (the same shared <audio> the slot
// cards use) so at most one clip plays at once across the whole tab.
function AudioLibrary({ playback }) {
  const [kind, setKind] = useState('');
  const [unbound, setUnbound] = useState(false);
  const [page, setPage] = useState(1);
  const {
    clips, total, pageSize, isLoadingClips, clipsError,
  } = useAudioClips({ kind: kind || undefined, unbound, page });
  // A SEPARATE query, always `unbound: true` regardless of the checkbox
  // above -- "Delete all unbound" always means every unbound clip of the
  // current kind filter, not "however many rows the current page/filter
  // combo happens to be showing". Same query key as the row list whenever
  // the checkbox is already ticked (page 1), so TanStack Query dedupes it
  // rather than firing a second request.
  const { total: unboundTotal } = useAudioClips({ kind: kind || undefined, unbound: true, page: 1 });
  const deleteUnbound = useDeleteUnboundClips();

  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <Wrap>
      <Bar>
        <Field>
          Kind
          <select value={kind} onChange={(e) => { setKind(e.target.value); setPage(1); }}>
            <option value="">All</option>
            {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </Field>
        <Field>
          <input
            type="checkbox"
            checked={unbound}
            onChange={(e) => { setUnbound(e.target.checked); setPage(1); }}
          />
          Unbound only
        </Field>
        <Secondary
          type="button"
          disabled={deleteUnbound.isPending || unboundTotal === 0}
          onClick={() => {
            if (window.confirm(
              `Delete all ${unboundTotal} unbound${kind ? ` ${kind}` : ''} clip(s)? This cannot be undone.`,
            )) {
              deleteUnbound.mutate(kind || undefined);
            }
          }}
        >
          Delete all unbound ({unboundTotal})
        </Secondary>
      </Bar>

      {clipsError && <Hint>{String(clipsError.message)}</Hint>}
      {isLoadingClips && <AdminLoading label="Loading clips…" inline size={16} />}
      {!isLoadingClips && clips.length === 0 && <Hint>No clips match.</Hint>}

      {clips.length > 0 && (
        <Table>
          <thead>
            <tr>
              <th /><th>Label</th><th>Kind</th><th>Duration</th><th>Size</th><th>Bound</th><th />
            </tr>
          </thead>
          <tbody>
            {clips.map((c) => (
              <ClipRow
                key={c.id}
                clip={c}
                playing={playback.playingId === c.id}
                onPlay={playback.play}
                onStop={playback.stop}
              />
            ))}
          </tbody>
        </Table>
      )}

      {pages > 1 && (
        <Pager>
          <Secondary type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</Secondary>
          <span>Page {page} of {pages} ({total} total)</span>
          <Secondary type="button" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Secondary>
        </Pager>
      )}
    </Wrap>
  );
}

export default AudioLibrary;
