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

// SOMET-591: same tooltip as AudioSlotCard's Suggest/Generate and
// AudioBatchPanel's Start, so the reason a generation control is disabled
// reads the same everywhere in the tab.
const NO_PROVIDER_TITLE = 'No audio provider — add one under AI Providers';

// The slot names a kind can batch, in registry order, sfx excluded (spec:
// sfx batches arrive in slice 3).
function kindSlots(group) {
  return Object.entries(group.slots || {}).filter(([, clipKind]) => clipKind !== 'sfx').map(([s]) => s);
}

function AudioBatchControls({
  subjects, selectedSubjects, extraItems, setExtraItems, styleNames, canGenerate = true,
}) {
  const [slotChoice, setSlotChoice] = useState({});
  const [styleChoice, setStyleChoice] = useState({});
  const enqueue = useEnqueueAudioJobs();

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

  const items = useMemo(() => {
    const built = buildBatchItems(selectedSubjects, effectiveSlotChoice, subjects);
    return mergeItems(built, extraItems).map((it) => (
      styleChoice[it.subject_kind] ? { ...it, style: styleChoice[it.subject_kind] } : it
    ));
  }, [selectedSubjects, effectiveSlotChoice, subjects, extraItems, styleChoice]);

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
              <StyleSelect
                value={styleChoice[g.kind] || ''}
                aria-label={`Style override for ${g.label}`}
                onChange={(e) => setStyleChoice((prev) => ({ ...prev, [g.kind]: e.target.value }))}
              >
                <option value="">Suggest per subject</option>
                {styleNames.map((s) => <option key={s} value={s}>{s}</option>)}
              </StyleSelect>
            </SlotToggles>
          </KindBlock>
        );
      })}
      {extraItems.length > 0 && (
        <Hint>
          {extraItems.length} item(s) added from Missing sounds.{' '}
          <Secondary type="button" onClick={() => setExtraItems([])}>Clear</Secondary>
        </Hint>
      )}
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
