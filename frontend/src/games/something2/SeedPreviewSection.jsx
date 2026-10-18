// SOMET-638. One group's diff rows: filters, bulk set, per-row decisions.
// Controlled: the decision map lives in the parent (the single-group modal or
// the Seed all modal), so Apply can read every section's decisions.
import { useMemo, useState } from 'react';
import styled from 'styled-components';
import {
  KINDS, kindLabel, allowedDecisions, bulkSet, decisionLabel,
} from './seedExportModel.js';
import { Btn, Muted } from './seedUi.jsx';

const Chips = styled.div`display: flex; gap: 6px; flex-wrap: wrap; margin: 0.6rem 0; align-items: center;`;
const Chip = styled.button`
  padding: 2px 10px; border-radius: 999px; font-size: 1.2rem; cursor: pointer;
  background: ${p => (p.$on ? 'var(--s2-accent)' : 'var(--s2-surface-raised)')};
  color: ${p => (p.$on ? 'var(--s2-on-accent)' : 'var(--s2-text)')};
  border: 1px solid var(--s2-border-strong);
`;
const Input = styled.input`
  background: var(--s2-bg-sunken); color: var(--s2-text); border: 1px solid var(--s2-border-strong);
  border-radius: 6px; padding: 0.25rem 0.5rem; margin-left: auto; width: 180px;
`;
const Bulk = styled.div`
  display: flex; gap: 6px; align-items: center; flex-wrap: wrap; padding: 6px 8px; margin-bottom: 0.5rem;
  background: var(--s2-surface-raised); border: 1px solid var(--s2-border); border-radius: 6px;
`;
const RowBox = styled.div`
  display: grid; grid-template-columns: 22px 1fr 210px; gap: 8px; align-items: start; padding: 6px 0;
  border-bottom: 1px solid var(--s2-border);
  ${p => (p.$red ? 'box-shadow: inset 3px 0 0 var(--s2-danger); padding-left: 6px;' : '')}
`;
const Kind = styled.span`
  display: inline-block; margin-left: 6px; padding: 0 7px; border-radius: 8px; font-size: 1.1rem; font-weight: 700;
  border: 1px solid var(--s2-border-strong); color: var(--s2-text-muted);
`;
const Mono = styled.div`font-family: ui-monospace, monospace; font-size: 1.2rem; word-break: break-all;`;
const Old = styled.span`color: var(--s2-danger);`;
const New = styled.span`color: var(--s2-success);`;
const Seg = styled.div`display: flex; border: 1px solid var(--s2-border-strong); border-radius: 5px; overflow: hidden;`;
const SegBtn = styled.button`
  flex: 1; padding: 3px 6px; font-size: 1.2rem; cursor: pointer; border: 0;
  background: ${p => (p.$on ? 'var(--s2-btn-primary)' : 'var(--s2-surface-raised)')};
  color: ${p => (p.$on ? 'var(--s2-on-accent)' : 'var(--s2-text)')};
  &:disabled { opacity: 0.4; cursor: not-allowed; }
`;
export const Warn = styled.p`color: var(--s2-warning); font-size: 1.4rem; margin: 0.4rem 0;`;

const WARNINGS = {
  schema_older: 'This export is from an older database schema; fields added since then will be cleared on rows you take from git.',
};
export const NOTHING_TO_CHANGE = 'Nothing to change — this PC already matches git.';

const show = (v) => (v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v));

export default function PreviewSection({ data, decisions, setDecisions }) {
  const rows = data.rows || [];
  const [kinds, setKinds] = useState(() => new Set());
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState(() => new Set());

  const visible = useMemo(() => rows.filter((r) => (kinds.size === 0 || kinds.has(r.kind))
    && (!q || String(r.key).toLowerCase().includes(q.toLowerCase()))), [rows, kinds, q]);
  const kindCounts = useMemo(() => {
    const c = {};
    for (const r of rows) c[r.kind] = (c[r.kind] || 0) + 1;
    return c;
  }, [rows]);

  const toggleKind = (k) => setKinds((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const togglePick = (u) => setPicked((s) => { const n = new Set(s); if (n.has(u)) n.delete(u); else n.add(u); return n; });
  const allPicked = visible.length > 0 && visible.every((r) => picked.has(r.syncUuid));
  // Only selected rows that are visible under the active filter.
  const pickedVisible = visible.filter((r) => picked.has(r.syncUuid)).map((r) => r.syncUuid);
  const bulk = (d) => setDecisions((cur) => bulkSet(cur, pickedVisible, d, rows));

  return (
    <>
      {(data.warnings || []).map((w) => <Warn key={w}>{WARNINGS[w] || w}</Warn>)}
      {rows.length === 0 && <p>{NOTHING_TO_CHANGE}</p>}
      {rows.length > 0 && (
        <>
          <Chips>
            <Chip $on={kinds.size === 0} onClick={() => setKinds(new Set())}>All {rows.length}</Chip>
            {KINDS.filter((k) => kindCounts[k]).map((k) => (
              <Chip key={k} $on={kinds.has(k)} onClick={() => toggleKind(k)}>{kindLabel(k)} {kindCounts[k]}</Chip>
            ))}
            <Input placeholder="filter by name…" value={q} onChange={(e) => setQ(e.target.value)} />
          </Chips>
          <Bulk>
            <input type="checkbox" checked={allPicked} aria-label="select all listed rows"
              onChange={() => setPicked(allPicked ? new Set() : new Set(visible.map((r) => r.syncUuid)))} />
            <b>{pickedVisible.length} selected</b>
            <Muted>→ set to</Muted>
            <Btn $primary disabled={!pickedVisible.length} onClick={() => bulk('git')}>Take git</Btn>
            <Btn disabled={!pickedVisible.length} onClick={() => bulk('local')}>Keep local</Btn>
            <Btn disabled={!pickedVisible.length} onClick={() => bulk('delete')}>Delete local</Btn>
            <Muted style={{ marginLeft: 'auto' }}>Red rows have no default: you must choose.</Muted>
          </Bulk>
          {visible.map((r) => (
            <RowBox key={r.syncUuid} $red={r.defaultDecision == null && !decisions[r.syncUuid]}>
              <input type="checkbox" checked={picked.has(r.syncUuid)} onChange={() => togglePick(r.syncUuid)}
                aria-label={`select ${r.key}`} />
              <div>
                <b>{String(r.key)}</b><Kind>{kindLabel(r.kind)}</Kind>
                {r.fields.map((f) => (
                  <Mono key={f.name}>{f.name}: <Old>{show(f.local)}</Old> → <New>{show(f.git)}</New></Mono>
                ))}
                {r.blockedReason && <Muted>{r.blockedReason}</Muted>}
              </div>
              <Seg>
                {['git', 'delete', 'local'].filter((d) => allowedDecisions({ ...r, blockedReason: null }).includes(d)).map((d) => (
                  <SegBtn key={d} $on={decisions[r.syncUuid] === d}
                    disabled={!allowedDecisions(r).includes(d)}
                    title={r.blockedReason && !allowedDecisions(r).includes(d) ? r.blockedReason : undefined}
                    onClick={() => setDecisions((cur) => bulkSet(cur, [r.syncUuid], d, rows))}>
                    {decisionLabel(r, d)}
                  </SegBtn>
                ))}
              </Seg>
            </RowBox>
          ))}
        </>
      )}
    </>
  );
}
