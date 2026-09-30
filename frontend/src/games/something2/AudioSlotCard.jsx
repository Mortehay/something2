// One slot's card in the Audio admin tab (SOMET-590): the clips already bound
// to it, plus the four ways to add one more (suggest a prompt, generate on
// the box, upload an .ogg, or reuse one already in the library). Split out of
// AudioAdmin.jsx so that file stays a layout shell -- this is where the
// per-slot state (draft prompt, upload file, elapsed generation time) lives.
import { useEffect, useRef, useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import styled from 'styled-components';
import {
  useProposeAudio, useGenerateAudio, useUploadAudio, useUpdateBinding, useUnbind, generateMutationKey,
  generateBody, useAudioClips, useBindFromLibrary, loopEditable, useSetClipLoopable,
  useSavePrompt, useWritePrompt, writePromptMutationKey,
} from './useAudioAdmin.js';
import { draftText, isDirty } from './artDescriptionDraft.js';
import { provenanceText, generatePromptFields } from './audioPromptDraft.js';
import { assetUrl } from './src/js/net/assets.js';
import { API_URL } from '../../config.js';

const Card = styled.section`
  border: 1px solid var(--s2-border); border-radius: 8px;
  background: var(--s2-surface-raised); padding: 0.75rem 1rem; margin-bottom: 0.75rem;
  h4 { margin: 0 0 0.5rem; font-size: 0.95rem; color: var(--s2-text); }
`;
const ClipList = styled.ul`list-style: none; margin: 0 0 0.5rem; padding: 0;`;
const ClipRowWrap = styled.li`
  display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
  padding: 0.35rem 0; border-bottom: 1px solid var(--s2-border);
  &:last-child { border-bottom: none; }
`;
const Meta = styled.span`font-size: 0.8rem; color: var(--s2-text-muted); min-width: 3.5rem;`;
const Label = styled.span`font-size: 0.85rem; color: var(--s2-text); flex: 1; min-width: 8rem;`;
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
const Slider = styled.input`width: 6rem;`;
const WeightInput = styled.input`width: 3.5rem; background: var(--s2-bg-sunken); color: var(--s2-text);
  border: 1px solid var(--s2-border-strong); border-radius: 4px; padding: 0.15rem 0.3rem; font-size: 0.8rem;`;
const Controls = styled.div`display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; margin-top: 0.5rem;`;
const Button = styled.button`
  background: var(--s2-accent); color: var(--s2-on-accent); border: none; border-radius: 6px;
  padding: 0.35rem 0.8rem; font-weight: bold; cursor: pointer; font-size: 0.8rem;
  &:disabled { opacity: 0.5; cursor: default; }
`;
const Secondary = styled(Button)`background: var(--s2-btn-grey);`;
const PromptRow = styled.div`
  display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.5rem;
  input {
    background: var(--s2-bg-sunken); color: var(--s2-text);
    border: 1px solid var(--s2-border-strong); border-radius: 4px;
    padding: 0.35rem; font-size: 0.85rem; flex: 1; min-width: 10rem;
  }
`;
const Err = styled.p`color: var(--s2-danger); font-size: 0.8rem; margin: 0.35rem 0 0;`;
const Hint = styled.p`color: var(--s2-text-muted); font-size: 0.8rem; margin: 0.35rem 0 0;`;
// The stale badge (Task 12): this card's own Pill, not AudioSlotTable's --
// that one is scoped to the table and importing it here would reach across
// components for a one-line styled span.
const Pill = styled.span`
  font-size: 0.75rem; padding: 0.1rem 0.4rem; border-radius: 999px; margin-left: 0.35rem;
  background: var(--s2-bg-sunken); color: var(--s2-warning, var(--s2-danger)); white-space: nowrap;
`;
const EngineSelect = styled.select`
  background: var(--s2-bg-sunken); color: var(--s2-text); border: 1px solid var(--s2-border-strong);
  border-radius: 4px; padding: 0.3rem; font-size: 0.8rem;
`;
const VariantsInput = styled.input`
  width: 3rem; background: var(--s2-bg-sunken); color: var(--s2-text);
  border: 1px solid var(--s2-border-strong); border-radius: 4px; padding: 0.3rem; font-size: 0.8rem;
`;
const InlineLabel = styled.label`display: flex; align-items: center; gap: 0.3rem; font-size: 0.8rem; color: var(--s2-text-muted);`;
const HintInput = styled.input`
  background: var(--s2-bg-sunken); color: var(--s2-text);
  border: 1px solid var(--s2-border-strong); border-radius: 4px;
  padding: 0.3rem 0.35rem; font-size: 0.8rem; min-width: 10rem; flex: 1;
`;

// The two engines the box offers for sfx (spec §4): realistic is the
// default, retro is cheaper (no model load) but lower fidelity.
const SFX_ENGINES = [['realistic', 'Realistic'], ['retro', 'Retro']];

// SOMET-591: shown on Suggest/Generate (here) and the batch Queue/Start
// buttons (AudioSlotTable.jsx, AudioBatchPanel.jsx) whenever `canGenerate`
// is false -- the one line of text repeated everywhere a generation control
// is disabled for lack of a provider.
const NO_PROVIDER_TITLE = 'No audio provider — add one under AI Providers';

// Task 12 controller ruling: for sfx, Generate never sends a request-level
// prompt -- the stored text becomes the box `entity` server-side. A dirty
// (unsaved) sfx draft would therefore generate from the OLD stored text
// with no visible warning, so Generate is disabled until it's saved.
const SFX_DIRTY_TITLE = 'Save the prompt first — SFX use the saved prompt';

// The "+ From library" picker (SOMET-591): a small inline list, not a modal --
// it only ever shows clips of THIS slot's clip kind, which keeps it short.
const Picker = styled.div`
  border: 1px solid var(--s2-border); border-radius: 6px; background: var(--s2-bg-sunken);
  margin-top: 0.5rem; padding: 0.5rem; max-height: 12rem; overflow-y: auto;
`;
const PickerRow = styled.div`
  display: flex; align-items: center; gap: 0.5rem; padding: 0.25rem 0;
  &:not(:last-child) { border-bottom: 1px solid var(--s2-border); }
`;
const PickerLabel = styled.span`font-size: 0.8rem; color: var(--s2-text); flex: 1; min-width: 6rem;`;
// Paging footer (SOMET-591 review fix): the library can hold far more than
// one page's worth of clips of a given kind, and the picker used to show
// only the newest CLIPS_PAGE_SIZE with no way to reach the rest. The
// backend has no label/text filter today, so this is paging only -- "x-y of
// N" rather than a search box that could not actually narrow anything past
// the current page.
const PickerFooter = styled.div`
  display: flex; align-items: center; gap: 0.5rem; margin-top: 0.4rem; padding-top: 0.4rem;
  border-top: 1px solid var(--s2-border); font-size: 0.75rem; color: var(--s2-text-muted);
`;

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
const formatKb = (bytes) => (Number.isFinite(bytes) ? `${Math.round(bytes / 1024)} KB` : '—');

// Seconds since mount. A separate component rather than state in the parent
// so the reset-on-stop is "unmount" instead of a setState call inside an
// effect body (which react-hooks/set-state-in-effect flags) -- mounted only
// while a generation is in flight, via `{generating && <Elapsed />}`.
function Elapsed() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => setSeconds(Math.round((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return seconds;
}

function ClipRow({
  row, subject, slot, playingId, onPlay, onStop,
}) {
  const update = useUpdateBinding();
  const unbind = useUnbind();
  const setLoop = useSetClipLoopable();
  const [volume, setVolume] = useState(row.volume);
  const [weight, setWeight] = useState(row.weight);
  const playing = playingId === row.binding_id;
  const commit = (patch) => update.mutate({
    id: row.binding_id, subjectKind: subject.kind, subjectKey: subject.key, ...patch,
  });

  return (
    <ClipRowWrap>
      <IconButton
        type="button"
        aria-label={playing ? `Stop ${row.label}` : `Play ${row.label}`}
        onClick={() => (playing ? onStop() : onPlay(row.binding_id, assetUrl(API_URL, row.storage_key)))}
      >
        {playing ? '■' : '▶'}
      </IconButton>
      <Label title={row.label}>{row.label}</Label>
      <Meta>{formatDuration(row.duration_ms)}</Meta>
      <Meta>{formatKb(row.bytes)}</Meta>
      <Slider
        type="range" min={0} max={1} step={0.05} value={volume}
        aria-label={`Volume for ${row.label}`}
        onChange={(e) => setVolume(Number(e.target.value))}
        onMouseUp={() => commit({ volume })}
        onTouchEnd={() => commit({ volume })}
        onKeyUp={() => commit({ volume })}
      />
      <WeightInput
        type="number" min={0.01} step={0.1} value={weight}
        aria-label={`Weight for ${row.label}`}
        onChange={(e) => setWeight(Number(e.target.value))}
        onBlur={() => weight > 0 && commit({ weight })}
      />
      {/* SOMET-592 (I2): a world point's nearby clip loops while the player
          is in range only when it is marked Loop; otherwise it plays on the
          creature-style cadence. The flag is the clip's, not the binding's. */}
      {loopEditable(subject.kind, slot) && (
        <InlineLabel title="Loop this clip while the player is in range, instead of repeating it every few seconds">
          <input
            type="checkbox"
            checked={Boolean(row.loopable)}
            disabled={setLoop.isPending}
            aria-label={`Loop ${row.label}`}
            onChange={(e) => setLoop.mutate({ clipId: row.clip_id, loopable: e.target.checked })}
          />
          Loop
        </InlineLabel>
      )}
      <Drop
        type="button"
        aria-label={`Remove ${row.label}`}
        title="Remove this clip from the slot"
        disabled={unbind.isPending}
        onClick={() => {
          if (window.confirm(`Remove "${row.label}" from ${subject.key}/${slot}?`)) {
            unbind.mutate({ id: row.binding_id, subjectKind: subject.kind, subjectKey: subject.key });
          }
        }}
      >×</Drop>
    </ClipRowWrap>
  );
}

// SOMET-591: the "+ From library" list for one slot. Fetched only while
// open (`enabled` inside useAudioClips would need a flag this hook doesn't
// take, so the component itself is only mounted while open -- same net
// effect as useArtHistory's `enabled`, without adding a param this hook has
// no other caller for).
function LibraryPicker({
  subject, slot, clipKind, onBound,
}) {
  const [page, setPage] = useState(1);
  const {
    clips, total, pageSize, isLoadingClips,
  } = useAudioClips({ kind: clipKind, page });
  const bind = useBindFromLibrary();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <Picker>
      {isLoadingClips && <AdminLoadingInline />}
      {!isLoadingClips && clips.length === 0 && <Hint>No {clipKind} clips in the library yet.</Hint>}
      {clips.map((c) => (
        <PickerRow key={c.id}>
          <PickerLabel title={c.label}>{c.label}</PickerLabel>
          <Secondary
            type="button"
            disabled={bind.isPending}
            onClick={() => bind.mutate(
              {
                subjectKind: subject.kind, subjectKey: subject.key, slot, clipId: c.id,
              },
              { onSuccess: onBound },
            )}
          >
            Bind
          </Secondary>
        </PickerRow>
      ))}
      {total > pageSize && (
        <PickerFooter>
          <Secondary type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</Secondary>
          <span>showing {from}–{to} of {total}</span>
          <Secondary type="button" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Secondary>
        </PickerFooter>
      )}
    </Picker>
  );
}

// A tiny inline loading line -- pulling in AdminLoading here would add a
// second import just for one word; this matches its "inline" look without it.
function AdminLoadingInline() { return <Hint>Loading…</Hint>; }

// SOMET-590: `subject` is `{ kind, key, label }`; `slot`/`clipKind` come from
// the registry entry (audioBatch.subjectSlotsFor); `rows` are this slot's bound
// clips from useSubjectSlots. Play/stop are lifted to AudioAdmin so only one
// preview plays across every card on the page.
//
// `cue` (game audio slice 3) is this subject's cue for THIS slot, from the
// registry's `cues` map (undefined for a music/ambience slot, which has no
// cue concept at all): `null` means upload-only (spec §4 -- three slots have
// no cue on the box today), any string means the slot can generate.
function AudioSlotCard({
  subject, slot, clipKind, rows, playingId, onPlay, onStop, canGenerate = true, cue, prompt,
}) {
  const isSfx = clipKind === 'sfx';
  const uploadOnly = isSfx && cue === null;
  const propose = useProposeAudio();
  const generate = useGenerateAudio(subject.kind, subject.key, slot);
  const upload = useUploadAudio();
  const [engine, setEngine] = useState('realistic');
  const [variants, setVariants] = useState(1);
  // What Suggest returned: its style and the box slots for THAT style.
  const [proposal, setProposal] = useState(null);
  const [showPicker, setShowPicker] = useState(false);
  const [loopUpload, setLoopUpload] = useState(false);
  const canLoop = loopEditable(subject.kind, slot);
  const fileRef = useRef(null);

  // The slot's stored prompt (Task 12): `prompt` is `{ active, history,
  // stale, currentInput }` or undefined while the parent's usePrompts() is
  // still loading. null = nobody typed (show stored); '' = cleared. This
  // replaces the old useState('') style/prompt pair, which could not tell
  // "matches the stored prompt" from "deliberately blank".
  const active = prompt ? prompt.active : null;
  const [styleDraft, setStyleDraft] = useState(null);
  const [textDraft, setTextDraft] = useState(null);
  const [hint, setHint] = useState('');
  const save = useSavePrompt(subject.kind, subject.key);
  const write = useWritePrompt(subject.kind, subject.key, slot);
  const writing = useIsMutating({ mutationKey: writePromptMutationKey(subject.kind, subject.key, slot) }) > 0;
  const styleShown = draftText(styleDraft, active ? { text: active.style || '' } : null);
  const textShown = draftText(textDraft, active);
  const dirty = isDirty(styleDraft, active ? { text: active.style || '' } : null) || isDirty(textDraft, active);

  // NOT generate.isPending: that comes from THIS hook instance, which is
  // fresh (isPending=false) every time this card remounts -- switching
  // subjects, or navigating away and back while a generation is still
  // running on the GPU box. useIsMutating reads the GLOBAL mutation cache by
  // mutationKey instead, so the pending state (and therefore the disabled
  // button) survives the remount and a second click can't fire a duplicate
  // request at the box.
  const generating = useIsMutating({ mutationKey: generateMutationKey(subject.kind, subject.key, slot) }) > 0;

  const onSuggest = () => {
    propose.mutate(
      { subject_kind: subject.kind, subject_key: subject.key, slot },
      {
        onSuccess: (r) => {
          // Suggest fills the drafts as UNSAVED edits -- it never writes the
          // prompt store itself, so Save stays the one path that commits it.
          setStyleDraft(r.style || '');
          setTextDraft(r.prompt || '');
          setProposal({ style: r.style || '', slots: r.slots || null });
        },
      },
    );
  };

  const onGenerate = () => {
    generate.mutate(generateBody(isSfx
      ? { subject, slot, engine, variants }
      : {
        subject, slot, ...generatePromptFields({
          isSfx, styleDraft, textDraft, active,
        }), proposal,
      }));
  };

  const onSave = () => {
    save.mutate(
      {
        slot, style: isSfx ? null : styleShown, text: textShown, expectActiveId: active ? active.id : null,
      },
      { onSuccess: () => { setStyleDraft(null); setTextDraft(null); } },
    );
  };

  const onWrite = () => {
    write.mutate({ hint }, { onSuccess: () => { setStyleDraft(null); setTextDraft(null); } });
  };

  const onUpload = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    upload.mutate({
      subjectKind: subject.kind, subjectKey: subject.key, slot, file, loopable: canLoop ? loopUpload : undefined,
    });
  };

  return (
    <Card>
      <h4>{slot} <Hint as="span">({clipKind})</Hint></h4>
      <ClipList>
        {rows.map((row) => (
          <ClipRow
            key={row.binding_id}
            row={row}
            subject={subject}
            slot={slot}
            playingId={playingId}
            onPlay={onPlay}
            onStop={onStop}
          />
        ))}
      </ClipList>
      {rows.length === 0 && <Hint>No clips bound to this slot yet.</Hint>}

      {uploadOnly && <Hint>Upload only — the provider has no cue for this slot.</Hint>}

      {/* The prompt editor (Task 12, spec §9): every slot that can generate
          gets one, sfx included -- an sfx slot edits its "sound source"
          text (no style field; see SFX_ENGINES above for its only other
          knob), which becomes the box's `entity` server-side rather than a
          request-level prompt. Upload-only slots have no cue and no prompt
          row at all. */}
      {!uploadOnly && (
        <>
          <PromptRow>
            {!isSfx && (
              <input
                value={styleShown}
                onChange={(e) => setStyleDraft(e.target.value)}
                placeholder="style"
                aria-label={`Style for ${slot}`}
              />
            )}
            <input
              value={textShown}
              onChange={(e) => setTextDraft(e.target.value)}
              placeholder={isSfx ? 'sound source, e.g. "a heavy iron mace"' : 'prompt'}
              aria-label={`${isSfx ? 'Sound source' : 'Prompt'} for ${slot}`}
            />
          </PromptRow>
          <Hint>
            {provenanceText(active)}
            {prompt && prompt.stale && (
              <Pill title={`Written from: ${active.source_input}\nNow: ${prompt.currentInput}`}> stale</Pill>
            )}
          </Hint>
          <Controls>
            <Secondary type="button" disabled={!dirty || save.isPending} onClick={onSave}>
              {save.isPending ? 'Saving…' : 'Save prompt'}
            </Secondary>
            <HintInput
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              placeholder="hint (optional)"
              aria-label={`Hint for ${slot}`}
            />
            <Secondary type="button" disabled={writing} onClick={onWrite}>
              {writing ? <>Writing… <Elapsed />s</> : 'Write with model'}
            </Secondary>
          </Controls>
          {write.isError && <Err>{write.error.message}</Err>}
          {save.isError && <Err>{save.error.message}</Err>}
        </>
      )}

      <Controls>
        {!isSfx && (
          <Secondary
            type="button"
            disabled={propose.isPending || !canGenerate}
            title={canGenerate ? undefined : NO_PROVIDER_TITLE}
            onClick={onSuggest}
          >
            {propose.isPending ? 'Suggesting…' : 'Suggest'}
          </Secondary>
        )}
        {isSfx && !uploadOnly && (
          <>
            <InlineLabel>
              Engine
              <EngineSelect
                value={engine}
                aria-label={`Engine for ${slot}`}
                onChange={(e) => setEngine(e.target.value)}
              >
                {SFX_ENGINES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </EngineSelect>
            </InlineLabel>
            <InlineLabel>
              Variants
              <VariantsInput
                type="number" min={1} max={5} value={variants}
                aria-label={`Variants for ${slot}`}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isInteger(n) && n >= 1 && n <= 5) setVariants(n);
                }}
              />
            </InlineLabel>
          </>
        )}
        {!uploadOnly && (
          <Button
            type="button"
            disabled={generating || !canGenerate || (isSfx && dirty)}
            title={!canGenerate ? NO_PROVIDER_TITLE : ((isSfx && dirty) ? SFX_DIRTY_TITLE : undefined)}
            onClick={onGenerate}
          >
            {generating ? <>Generating… <Elapsed />s</> : 'Generate'}
          </Button>
        )}
        <Secondary type="button" onClick={() => fileRef.current?.click()} disabled={upload.isPending}>
          {upload.isPending ? 'Uploading…' : 'Upload .ogg'}
        </Secondary>
        {canLoop && (
          <InlineLabel title="Upload the clip as a loop (it plays continuously while the player is in range)">
            <input
              type="checkbox"
              checked={loopUpload}
              aria-label={`Upload as a loop for ${slot}`}
              onChange={(e) => setLoopUpload(e.target.checked)}
            />
            Loop
          </InlineLabel>
        )}
        <input
          ref={fileRef}
          type="file"
          accept=".ogg,audio/ogg"
          onChange={onUpload}
          style={{ display: 'none' }}
          aria-label={`Upload an .ogg for ${slot}`}
        />
        <Secondary type="button" onClick={() => setShowPicker((v) => !v)}>
          {showPicker ? 'Hide library' : '+ From library'}
        </Secondary>
      </Controls>
      {generate.isError && <Err>{generate.error.message}</Err>}
      {propose.isError && <Err>{propose.error.message}</Err>}
      {upload.isError && <Err>{upload.error.message}</Err>}
      {showPicker && (
        <LibraryPicker
          subject={subject}
          slot={slot}
          clipKind={clipKind}
          onBound={() => setShowPicker(false)}
        />
      )}
    </Card>
  );
}

export default AudioSlotCard;
