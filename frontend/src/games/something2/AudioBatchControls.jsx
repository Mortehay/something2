// The batch-mode selection controls (SOMET-591, game audio slice 2): a slot
// chooser + optional style override per subject kind, and the "Queue N
// jobs" button. Split out of AudioAdmin.jsx (which was pushing past ~400
// lines with this inline) -- it owns no data fetching of its own, only the
// batch-specific local state; everything it reads (the registry, the ticked
// subjects, the misses added via "Add to batch") is passed in from there.
import { useMemo, useState } from 'react';
import styled from 'styled-components';
import { useEnqueueAudioJobs } from './useAudioAdmin.js';
import { buildBatchItems, mergeItems } from './audioBatch.js';

const SFX_ENGINES = [['realistic', 'Realistic'], ['retro', 'Retro']];

const BatchCard = styled.section`
  border: 1px solid var(--s2-border); border-radius: 8px;
  background: var(--s2-surface-raised); padding: 0.75rem 1rem; margin-bottom: 0.75rem;
`;
const KindBlock = styled.div`
  & + & { margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid var(--s2-border); }
  h4 { margin: 0 0 0.35rem; font-size: 0.9rem; }
`;
const SlotToggles = styled.div`display: flex; gap: 1rem; flex-wrap: wrap; align-items: center;`;
const CheckLabel = styled.label`display: flex; align-items: center; gap: 0.3rem; font-size: 0.85rem;`;
const StyleSelect = styled.select`
  background: var(--s2-bg-sunken); color: var(--s2-text); border: 1px solid var(--s2-border-strong);
  border-radius: 4px; padding: 0.3rem; font-size: 0.85rem; margin-left: auto;
`;
const Button = styled.button`
  background: var(--s2-accent); color: var(--s2-on-accent); border: none; border-radius: 6px;
  padding: 0.35rem 0.8rem; font-weight: bold; cursor: pointer; font-size: 0.8rem;
  &:disabled { opacity: 0.5; cursor: default; }
`;
const Secondary = styled(Button)`background: var(--s2-btn-grey);`;
const Hint = styled.p`color: var(--s2-text-muted); font-size: 0.85rem; margin: 0.25rem 0;`;
const EngineSelect = styled.select`
  background: var(--s2-bg-sunken); color: var(--s2-text); border: 1px solid var(--s2-border-strong);
  border-radius: 4px; padding: 0.3rem; font-size: 0.85rem;
`;
const SkippedList = styled.ul`
  list-style: none; margin: 0.5rem 0; padding: 0;
  li { font-size: 0.78rem; color: var(--s2-text-muted); text-decoration: line-through; padding: 0.1rem 0; }
`;

// SOMET-591: same tooltip as AudioSlotCard's Suggest/Generate and
// AudioBatchPanel's Start, so the reason a generation control is disabled
// reads the same everywhere in the tab.
const NO_PROVIDER_TITLE = 'No audio provider — add one under AI Providers';

// The slot names a kind can batch, in registry order. sfx slots are included
// (game audio slice 3) -- buildBatchItems is what drops the upload-only ones,
// per subject, since that depends on the subject's own cue map, not the kind.
function kindSlots(group) {
  return Object.entries(group.slots || {}).map(([s]) => s);
}

// Whether a kind's slots are all sfx (creature, world_point, attack_type,
// item, skill) -- those have no "style" concept (spec §4: sfx is cue-driven,
// not style/prompt-driven), so the per-kind style override select is only
// shown for kinds that carry a music/ambience slot.
function isSfxOnlyKind(group) {
  const kinds = Object.values(group.slots || {});
  return kinds.length > 0 && kinds.every((k) => k === 'sfx');
}

function AudioBatchControls({
  subjects, selectedSubjects, extraItems, setExtraItems, styleNames, canGenerate = true,
}) {
  const [slotChoice, setSlotChoice] = useState({});
  const [styleChoice, setStyleChoice] = useState({});
  const [engineChoice, setEngineChoice] = useState('realistic');
  const enqueue = useEnqueueAudioJobs();

  const groups = useMemo(() => new Map(subjects.map((g) => [g.kind, g])), [subjects]);

  // Every kind gets an entry -- an untouched kind defaults to ALL its slots
  // ticked, so a fresh admin can select subjects and press Queue without
  // first visiting every slot chooser. Recomputed each render off `subjects`
  // + the explicit overrides so it stays a pure derivation, not a second copy
  // of state that could drift from the registry.
  const effectiveSlotChoice = useMemo(() => {
    const out = {};
    for (const g of subjects) out[g.kind] = slotChoice[g.kind] || new Set(kindSlots(g));
    return out;
  }, [subjects, slotChoice]);

  const toggleSlot = (kind, group, slot) => setSlotChoice((prev) => {
    const current = new Set(prev[kind] || kindSlots(group));
    if (current.has(slot)) current.delete(slot); else current.add(slot);
    return { ...prev, [kind]: current };
  });

  const { items, skipped } = useMemo(() => {
    const built = buildBatchItems(selectedSubjects, effectiveSlotChoice, subjects);
    const merged = mergeItems(built.items, extraItems).map((it) => {
      const clipKind = groups.get(it.subject_kind)?.slots?.[it.slot];
      if (clipKind === 'sfx') return { ...it, engine: engineChoice };
      return styleChoice[it.subject_kind] ? { ...it, style: styleChoice[it.subject_kind] } : it;
    });
    return { items: merged, skipped: built.skipped };
  }, [selectedSubjects, effectiveSlotChoice, subjects, extraItems, styleChoice, engineChoice, groups]);

  const onQueue = () => {
    if (items.length === 0) return;
    enqueue.mutate({ items }, {
      onSuccess: () => setExtraItems([]),
    });
  };

  return (
    <BatchCard>
      <h3>Batch settings</h3>
      <Hint>Tick subjects on the left, choose slots per kind below, then queue.</Hint>
      {subjects.map((g) => {
        const slots = kindSlots(g);
        if (slots.length === 0) return null;
        const chosen = effectiveSlotChoice[g.kind] || new Set(slots);
        const sfxOnly = isSfxOnlyKind(g);
        return (
          <KindBlock key={g.kind}>
            <h4>{g.label}</h4>
            <SlotToggles>
              {slots.map((slot) => (
                <CheckLabel key={slot}>
                  <input
                    type="checkbox"
                    checked={chosen.has(slot)}
                    onChange={() => toggleSlot(g.kind, g, slot)}
                  />
                  {slot}
                </CheckLabel>
              ))}
              {!sfxOnly && (
                <StyleSelect
                  value={styleChoice[g.kind] || ''}
                  aria-label={`Style override for ${g.label}`}
                  onChange={(e) => setStyleChoice((prev) => ({ ...prev, [g.kind]: e.target.value }))}
                >
                  <option value="">Suggest per subject</option>
                  {styleNames.map((s) => <option key={s} value={s}>{s}</option>)}
                </StyleSelect>
              )}
            </SlotToggles>
          </KindBlock>
        );
      })}
      {skipped.length > 0 && (
        <SkippedList>
          {skipped.map((s) => (
            <li key={`${s.subject_kind}/${s.subject_key}/${s.slot}`}>
              {s.subject_kind}/{s.subject_key} · {s.slot} — {s.reason}
            </li>
          ))}
        </SkippedList>
      )}
      {extraItems.length > 0 && (
        <Hint>
          {extraItems.length} item(s) added from Missing sounds.{' '}
          <Secondary type="button" onClick={() => setExtraItems([])}>Clear</Secondary>
        </Hint>
      )}
      <SlotToggles>
        <CheckLabel as="span">
          SFX engine:
          <EngineSelect
            value={engineChoice}
            aria-label="Engine for sfx batch items"
            onChange={(e) => setEngineChoice(e.target.value)}
          >
            {SFX_ENGINES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </EngineSelect>
        </CheckLabel>
      </SlotToggles>
      <Button
        type="button"
        disabled={items.length === 0 || enqueue.isPending || !canGenerate}
        title={canGenerate ? undefined : NO_PROVIDER_TITLE}
        onClick={onQueue}
      >
        {enqueue.isPending ? 'Queuing…' : `Queue ${items.length} job${items.length === 1 ? '' : 's'}`}
      </Button>
    </BatchCard>
  );
}

export default AudioBatchControls;
