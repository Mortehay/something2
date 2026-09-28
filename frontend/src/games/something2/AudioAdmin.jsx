// The Audio admin tab (SOMET-590, game audio slice 1): worlds and biomes
// today, more subject kinds arrive in later slices as audioSubjects.js grows.
// Left column is the subject tree (with a filled/total badge per subject) and
// the missing-sounds to-do list; right column is the selected subject's slot
// cards, each driving suggest/generate/upload/play/remove for one slot.
//
// EVERY RULE about what a slot accepts lives on the backend (audioSubjects.js,
// audioLibrary.js) -- this file and its slot cards render what the registry
// and the bindings say, the same split ArtConsoleAdmin uses against
// artSelection.js.
import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { Link } from 'react-router-dom';
import styled from 'styled-components';
import {
  useAudioSubjects, useAudioMisses, useSubjectSlots, slotRows,
} from './useAudioAdmin.js';
import { useAiProviders } from './useAiProviders.js';
import AdminLoading from './AdminLoading.jsx';
import AudioSlotCard from './AudioSlotCard.jsx';

const Wrap = styled.div`
  padding: 2rem; color: var(--s2-text); max-width: 1200px; margin: 0 auto;
  height: 100%; overflow-y: auto; background-color: var(--s2-surface);
`;
const Hint = styled.p`color: var(--s2-text-muted); font-size: 0.85rem; margin: 0.25rem 0;`;
const Err = styled.p`color: var(--s2-danger); font-size: 0.85rem; margin: 0.25rem 0;`;
const Columns = styled.div`
  display: grid; grid-template-columns: 22rem 1fr; gap: 1.25rem; align-items: start;
  @media (max-width: 900px) { grid-template-columns: 1fr; }
`;
const Left = styled.div`
  border: 1px solid var(--s2-border); border-radius: 8px;
  background: var(--s2-surface-raised); padding: 0.75rem;
  input {
    width: 100%; box-sizing: border-box; background: var(--s2-bg-sunken); color: var(--s2-text);
    border: 1px solid var(--s2-border-strong); border-radius: 4px; padding: 0.4rem; font-size: 0.85rem;
    margin-bottom: 0.75rem;
  }
`;
const Right = styled.div`min-width: 0;`;
const Group = styled.div`
  margin-bottom: 0.75rem;
  h3 { margin: 0 0 0.35rem; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--s2-text-muted); }
  ul { list-style: none; margin: 0; padding: 0; }
`;
const SubjectButton = styled.button`
  width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;
  background: ${(p) => (p.$active ? 'var(--s2-overlay)' : 'none')};
  border: none; border-radius: 4px; padding: 0.35rem 0.5rem; cursor: pointer;
  color: var(--s2-text); font-size: 0.85rem; text-align: left;
  &:hover { background: var(--s2-overlay); }
`;
const Pill = styled.span`
  font-size: 0.72rem; padding: 0.05rem 0.4rem; border-radius: 999px; flex: none;
  background: var(--s2-bg-sunken); color: var(--s2-text-muted);
`;
const Missing = styled.div`
  border-top: 1px solid var(--s2-border); padding-top: 0.75rem; margin-top: 0.5rem;
  h3 { margin: 0 0 0.35rem; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--s2-text-muted); }
  ul { list-style: none; margin: 0; padding: 0; }
`;
const MissRow = styled.button`
  width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;
  background: none; border: none; border-radius: 4px; padding: 0.3rem 0.5rem; cursor: pointer;
  color: var(--s2-text); font-size: 0.78rem; text-align: left;
  &:hover { background: var(--s2-overlay); }
`;
const MissMeta = styled.span`font-size: 0.7rem; color: var(--s2-text-muted); display: block;`;

const rowKey = (kind, key) => `${kind}/${key}`;

// A single shared <audio> across the whole page: only one preview plays at a
// time, no matter which card or which subject it came from. Recreated per
// play rather than reused, so a new src always starts clean.
function useAudioPreview() {
  const audioRef = useRef(null);
  const [playingId, setPlayingId] = useState(null);

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
      audioRef.current = null;
    }
    setPlayingId(null);
  }, []);

  const play = useCallback((id, url) => {
    stop();
    const audio = new Audio(url);
    audio.addEventListener('ended', () => setPlayingId((cur) => (cur === id ? null : cur)));
    audio.play().catch(() => {});
    audioRef.current = audio;
    setPlayingId(id);
  }, [stop]);

  useEffect(() => () => { if (audioRef.current) audioRef.current.pause(); }, []);

  return { playingId, play, stop };
}

function AudioAdmin() {
  const { subjects, isLoadingSubjects, subjectsError } = useAudioSubjects();
  const { misses } = useAudioMisses();
  const { activeAudioProvider, isLoadingProviders } = useAiProviders();
  const rows = useMemo(() => slotRows(subjects), [subjects]);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(null);
  const preview = useAudioPreview();

  const grouped = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const byKind = new Map();
    for (const r of rows) {
      if (q && !`${r.key} ${r.kind}`.toLowerCase().includes(q)) continue;
      if (!byKind.has(r.kind)) byKind.set(r.kind, { label: r.label, rows: [] });
      byKind.get(r.kind).rows.push(r);
    }
    return [...byKind.values()];
  }, [rows, filter]);

  const selectedRow = selected
    && rows.find((r) => r.kind === selected.kind && r.key === selected.key);
  const { slots: bindings, isLoadingSlots } = useSubjectSlots(selected?.kind, selected?.key);

  if (subjectsError) return <Err>{String(subjectsError.message)}</Err>;

  if (!isLoadingSubjects && !isLoadingProviders && !activeAudioProvider) {
    return (
      <Wrap>
        <h2>Audio</h2>
        <Hint>
          No audio provider — add one under{' '}
          <Link to="/game/settings">AI Providers</Link> with modality Audio.
        </Hint>
      </Wrap>
    );
  }

  return (
    <Wrap>
      <h2>Audio</h2>
      {isLoadingSubjects && <AdminLoading label="Loading subjects…" inline size={16} />}
      <Columns>
        <Left>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter subjects"
            aria-label="Filter subjects"
          />
          {grouped.map((g) => (
            <Group key={g.label}>
              <h3>{g.label}</h3>
              <ul>
                {g.rows.map((r) => {
                  const active = Boolean(selected) && selected.kind === r.kind && selected.key === r.key;
                  return (
                    <li key={rowKey(r.kind, r.key)}>
                      <SubjectButton
                        type="button"
                        $active={active}
                        onClick={() => setSelected({ kind: r.kind, key: r.key })}
                      >
                        <span>{r.key}</span>
                        <Pill>{r.filled}/{r.slots.length}</Pill>
                      </SubjectButton>
                    </li>
                  );
                })}
                {g.rows.length === 0 && <Hint>No subjects match.</Hint>}
              </ul>
            </Group>
          ))}

          <Missing>
            <h3>Missing sounds</h3>
            {misses.length === 0 && <Hint>Nothing missing.</Hint>}
            <ul>
              {misses.map((m) => (
                <li key={`${m.subject_kind}/${m.subject_key}/${m.slot}`}>
                  <MissRow
                    type="button"
                    onClick={() => setSelected({ kind: m.subject_kind, key: m.subject_key })}
                  >
                    <span>
                      {m.subject_kind}/{m.subject_key} · {m.slot}
                      <MissMeta>last seen {String(m.last_seen).slice(0, 10)}</MissMeta>
                    </span>
                    <Pill>{m.count}×</Pill>
                  </MissRow>
                </li>
              ))}
            </ul>
          </Missing>
        </Left>

        <Right>
          {!selectedRow && <Hint>Pick a subject on the left.</Hint>}
          {selectedRow && (
            <>
              <h3>{selectedRow.label} · {selectedRow.key}</h3>
              {isLoadingSlots && <AdminLoading label="Loading clips…" inline size={16} />}
              {selectedRow.slots.map((s) => (
                <AudioSlotCard
                  // Keyed by subject too, not just slot: every world has the
                  // same slot names as every other world (music, ambience),
                  // so a slot-only key let React reuse a mounted card across
                  // a subject switch -- carrying over its draft prompt and
                  // (before the mutationKey fix in useAudioAdmin.js) letting
                  // a pending generation for one subject read as pending for
                  // whichever subject the card next rendered.
                  key={`${selectedRow.kind}/${selectedRow.key}/${s.slot}`}
                  subject={selectedRow}
                  slot={s.slot}
                  clipKind={s.clipKind}
                  rows={bindings[s.slot] || []}
                  playingId={preview.playingId}
                  onPlay={preview.play}
                  onStop={preview.stop}
                />
              ))}
            </>
          )}
        </Right>
      </Columns>
    </Wrap>
  );
}

export default AudioAdmin;
