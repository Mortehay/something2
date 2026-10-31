// SOMET-638. The seed preview: every difference between git and this PC, one
// decision per row. Nothing is written until Apply; Apply always posts the
// FULL decision map (defaults included) so the server never guesses.
import { useRef, useState } from 'react';
import styled from 'styled-components';
import { useSeedPreview, useApplySeed } from './useSeedExport.js';
import {
  initialDecisions, applyGate, pluralize, previewSignature, seedRequestBody, seedAllGate, BUSY_TEXT, submitOnce,
} from './seedExportModel.js';
import { Btn, Muted, Modal } from './seedUi.jsx';
import PreviewSection from './SeedPreviewSection.jsx';

const Foot = styled.div`
  display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap;
  margin-top: 0.8rem; padding-top: 0.7rem; border-top: 1px solid var(--s2-border);
`;
export const Err = styled.p`color: var(--s2-danger); font-size: 1.4rem;`;
export { Foot };

// busy: a background job (SOMET-640) is running; Apply waits for it.
export default function SeedPreviewModal({ group, onClose, busy = false }) {
  const preview = useSeedPreview(group.id, true);
  if (preview.isLoading) return <Shell group={group} onClose={onClose}><Muted>Loading preview…</Muted></Shell>;
  if (preview.error) {
    return <Shell group={group} onClose={onClose}><Err>{preview.error.message}</Err>{preview.error.file && <Muted>{preview.error.file}</Muted>}</Shell>;
  }
  // Keyed on the diff's content, not the fetch time: a same-content refetch
  // keeps the decisions, a changed diff (after stale_preview) resets them.
  return (
    <PreviewBody key={previewSignature(group.id, preview.data)} group={group} data={preview.data}
      onClose={onClose} reload={() => preview.refetch()} busy={busy} />
  );
}

function Shell({ group, onClose, children }) {
  return (
    <Modal $w="860px" onClose={onClose} closeOnBackdrop={false} label={`Seed preview: ${group.label}`}>
      <h3 style={{ margin: 0 }}>Seed preview: {group.label}</h3>
      {children}
      <Foot><span /><Btn onClick={onClose}>Close</Btn></Foot>
    </Modal>
  );
}

function PreviewBody({ group, data, onClose, reload, busy }) {
  const rows = data.rows || [];
  const apply = useApplySeed();
  const [decisions, setDecisions] = useState(() => initialDecisions(rows));
  const gate = applyGate(rows, decisions);
  const canApply = seedAllGate([{ rows, decisions }]).canApply;

  // A binary group answers 202 { job }: the modal closes and the group's row
  // shows the job. A busy refusal keeps it open (the decisions survive).
  // A double click sends one request (submitOnce), not a second one that is
  // refused busy while the first succeeds.
  const inFlight = useRef(false);
  const submit = () => submitOnce(inFlight, (done) => apply.mutate(
    { groupId: group.id, label: group.label, body: seedRequestBody(decisions, data) },
    {
      onSuccess: onClose,
      // The diff moved under the preview: show the fresh one.
      onError: (err) => { if (err.code === 'stale_preview') reload(); },
      onSettled: done,
    },
  ));

  return (
    // A stray backdrop click must not throw away the admin's decisions:
    // only Escape and Cancel close it.
    <Modal $w="900px" onClose={onClose} closeOnBackdrop={false} label={`Seed preview: ${group.label}`}>
      <>
        <h3 style={{ margin: 0 }}>Seed preview: {group.label}</h3>
        <Muted>
          git export{data.header ? ` from ${data.header.exported_by}, ${new Date(data.header.exported_at).toLocaleString()}` : ''} → this PC.
          Nothing is written until Apply.
        </Muted>
        <PreviewSection data={data} decisions={decisions} setDecisions={setDecisions} />
        {apply.error && apply.error.code === 'busy' && <Err role="alert">{BUSY_TEXT}</Err>}
        <Foot>
          <Muted>
            Will write: {gate.summary.updated} updates, {gate.summary.created} creates, {gate.summary.deleted} deletes, {gate.summary.kept} kept, {gate.summary.adopted} adopted
            {gate.undecided > 0 && ` · ${gate.undecided === 1 ? '1 row still needs' : `${gate.undecided} rows still need`} a choice`}
          </Muted>
          <span style={{ display: 'flex', gap: 6 }}>
            <Btn onClick={onClose}>Cancel</Btn>
            <Btn $primary disabled={busy || !canApply || apply.isPending} title={busy ? BUSY_TEXT : undefined} onClick={submit}>
              {gate.canApply ? 'Apply' : `Apply (choose ${pluralize(gate.undecided, 'red row')} first)`}
            </Btn>
          </span>
        </Foot>
      </>
    </Modal>
  );
}
