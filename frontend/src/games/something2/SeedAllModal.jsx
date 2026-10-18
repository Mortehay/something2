// SOMET-638. "Seed all…": one preview modal over every group that has an
// export file, one section per group in registry (= dependency) order, one
// Apply. Sections reuse PreviewSection; decisions live here, per group, keyed
// to the preview's signature so a reloaded diff resets only that group.
import { useState } from 'react';
import styled from 'styled-components';
import { useSeedPreviews, useApplyAll } from './useSeedExport.js';
import {
  initialDecisions, previewSignature, seedRequestBody, seedAllGate, applyGate, pluralize,
} from './seedExportModel.js';
import { Btn, Muted, Modal } from './seedUi.jsx';
import PreviewSection from './SeedPreviewSection.jsx';
import { Foot, Err } from './SeedPreviewModal.jsx';

const Head = styled.button`
  display: flex; width: 100%; align-items: center; gap: 8px; text-align: left; cursor: pointer;
  padding: 6px 8px; margin-top: 0.6rem; border-radius: 6px; font-size: 1.5rem; font-weight: 600;
  background: var(--s2-surface-raised); color: var(--s2-text); border: 1px solid var(--s2-border-strong);
`;
const Res = styled.div`
  margin: 0.6rem 0; padding: 0.5rem 0.8rem; border-radius: 6px; font-size: 1.4rem;
  border: 1px solid var(--s2-border-strong); background: var(--s2-surface-raised);
`;

const counts = (s) => `${s.updated || 0} updated, ${s.created || 0} created, ${s.deleted || 0} deleted, ${s.kept || 0} kept, ${s.adopted || 0} adopted`;

function Section({ group, query, state, setState, done, open, toggle }) {
  const data = query.error ? undefined : query.data;
  const rows = data ? data.rows || [] : [];
  const sig = data ? previewSignature(group.id, data) : null;
  const decisions = data && state && state.sig === sig ? state.d : (data ? initialDecisions(rows) : {});
  const setDecisions = (fn) => setState(group.id, sig, fn, decisions);
  const gate = data ? applyGate(rows, decisions) : null;
  let tag = 'loading…';
  if (done) tag = 'seeded';
  else if (query.error) tag = 'failed to load';
  else if (data) tag = rows.length === 0 ? 'nothing to change' : `${rows.length} row${rows.length === 1 ? '' : 's'}${gate.undecided ? ` · ${gate.undecided} to choose` : ''}`;
  return (
    <section>
      <Head aria-expanded={open} onClick={toggle}>{open ? '▾' : '▸'} {group.label} <Muted>{tag}</Muted></Head>
      {open && (
        <div style={{ paddingLeft: 6 }}>
          {done && <p>Seeded.</p>}
          {!done && query.isLoading && <Muted>Loading preview…</Muted>}
          {!done && query.error && <Err>{query.error.message}</Err>}
          {!done && data && <PreviewSection key={sig} data={data} decisions={decisions} setDecisions={setDecisions} />}
        </div>
      )}
    </section>
  );
}

export default function SeedAllModal({ groups, onClose }) {
  const queries = useSeedPreviews(groups.map((g) => g.id));
  const apply = useApplyAll();
  const [states, setStates] = useState({});
  const [closed, setClosed] = useState(() => new Set());
  const [done, setDone] = useState(() => new Set());
  const [results, setResults] = useState(null);

  const setState = (id, sig, fn, base) => setStates((all) => {
    const cur = all[id] && all[id].sig === sig ? all[id].d : base;
    return { ...all, [id]: { sig, d: fn(cur) } };
  });
  const decisionsOf = (g, q) => {
    if (!q.data) return {};
    const st = states[g.id];
    return st && st.sig === previewSignature(g.id, q.data) ? st.d : initialDecisions(q.data.rows || []);
  };

  // Groups already seeded in this session are finished; a failed load blocks
  // nothing (it is simply not applied).
  const failed = groups.filter((g, i) => !done.has(g.id) && queries[i].error);
  const live = groups.map((g, i) => ({ g, q: queries[i] })).filter(({ g, q }) => !done.has(g.id) && q.data && !q.error);
  const loading = groups.some((g, i) => !done.has(g.id) && (queries[i].isLoading || queries[i].isFetching));
  const sections = live.map(({ g, q }) => ({ rows: q.data.rows || [], decisions: decisionsOf(g, q) }));
  const gate = seedAllGate(sections);

  const submit = () => {
    const items = live.filter(({ q }) => (q.data.rows || []).length > 0).map(({ g, q }) => ({
      id: g.id, label: g.label, body: seedRequestBody(decisionsOf(g, q), q.data),
    }));
    apply.mutate(items, {
      onSuccess: (res) => {
        setResults(res);
        setDone((d) => new Set([...d, ...res.filter((r) => r.ok).map((r) => r.id)]));
        // The diff moved under a group's preview: reload just that one.
        res.filter((r) => r.code === 'stale_preview').forEach((r) => {
          const i = groups.findIndex((g) => g.id === r.id);
          if (i >= 0) queries[i].refetch();
        });
      },
    });
  };

  // Back from the result panel: reload every group not yet seeded.
  const reviewAgain = () => {
    setResults(null);
    groups.forEach((g, i) => { if (!done.has(g.id)) queries[i].refetch(); });
  };
  const okRes = (results || []).filter((r) => r.ok);
  const badRes = (results || []).filter((r) => !r.ok);
  return (
    <Modal $w="960px" onClose={onClose} closeOnBackdrop={false} label="Seed all groups">
      <>
        <h3 style={{ margin: 0 }}>Seed all groups</h3>
        <Muted>Every group with an export file, in dependency order. Nothing is written until Apply.</Muted>
        {results && (
          <Res role="status">
            <b>Seeded {okRes.length} of {results.length} groups</b>
            {okRes.map((r) => <div key={r.id}>{r.label}: {counts(r.summary)}</div>)}
            {failed.map((g) => <div key={g.id} style={{ color: 'var(--s2-danger)' }}>Not applied: {g.label} — preview failed to load</div>)}
            {badRes.map((r) => (
              <div key={r.id} style={{ color: 'var(--s2-danger)' }}>
                Refused: {r.label} — {r.code ? `${r.code}: ` : ''}{r.error}
                {r.code === 'stale_preview' && ' (preview reloaded, review and apply again)'}
              </div>
            ))}
          </Res>
        )}
        {!results && groups.map((g, i) => (
          <Section key={g.id} group={g} query={queries[i]} done={done.has(g.id)}
            state={states[g.id]} setState={setState}
            open={!closed.has(g.id)}
            toggle={() => setClosed((c) => { const n = new Set(c); if (n.has(g.id)) n.delete(g.id); else n.add(g.id); return n; })} />
        ))}
        {results ? (
          <Foot>
            <span />
            <span style={{ display: 'flex', gap: 6 }}>
              {badRes.length > 0 && <Btn onClick={reviewAgain}>Review again</Btn>}
              <Btn $primary onClick={onClose}>Close</Btn>
            </span>
          </Foot>
        ) : (
          <Foot>
            <Muted>
              {gate.rows === 0 && !loading ? 'Nothing to change — this PC already matches git.' : `${pluralize(gate.rows, 'row')} across ${pluralize(sections.filter((s) => s.rows.length).length, 'group')}`}
              {gate.undecided > 0 && ` · ${gate.undecided === 1 ? '1 row still needs' : `${gate.undecided} rows still need`} a choice`}
              {failed.length > 0 && ` · Not applied: ${failed.map((g) => g.label).join(', ')} — preview failed to load`}
            </Muted>
            <span style={{ display: 'flex', gap: 6 }}>
              <Btn onClick={onClose}>Cancel</Btn>
              <Btn $primary disabled={!gate.canApply || loading || apply.isPending} onClick={submit}>
                {gate.undecided > 0 ? `Apply (choose ${pluralize(gate.undecided, 'red row')} first)` : 'Apply all'}
              </Btn>
            </span>
          </Foot>
        )}
      </>
    </Modal>
  );
}
