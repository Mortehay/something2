// frontend/src/games/something2/PassiveNodesAdmin.jsx
//
// The passive-node browser and single-node editor (spec §10.5, SOMET-477).
// Search by key or label, filter by sector and kind, page through the 1806
// rows, and edit the three columns the API allows: label, kind and grants.
//
// PAGED, NOT SCROLLED. 1806 rows is far past the point where one render pass is
// reasonable, so the page size is fixed and the server does the LIMIT/OFFSET --
// the table never holds more than PAGE rows.
//
// STRUCTURE IS NOT EDITABLE. key/sector/ring/x/y are shown read-only, because
// moving a node is how an admin would accidentally disconnect one, and a
// disconnected node is unallocatable forever with no visible symptom.
//
// Every rule lives in passiveNodeForm.js and is unit-tested there; this file
// renders them. Validation runs BEFORE the save rather than relying on the
// server's 400, because a mistyped stat is the failure this whole editor is
// most likely to introduce.
import { useState } from 'react';
import styled from 'styled-components';
import { usePassiveNodes, useUpdatePassiveNode } from './usePassiveNodes.js';
import {
  KINDS, SECTORS, GRANT_TYPES, nodeToForm, formToPayload, validateNodeForm, grantSummary,
} from './passiveNodeForm.js';

const PAGE = 50;

const Wrap = styled.div`color: var(--s2-text);`;
const Filters = styled.div`display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: flex-end; margin-bottom: 0.75rem;`;
const Field = styled.label`
  display: flex; flex-direction: column; gap: 0.25rem;
  font-size: 0.8rem; color: var(--s2-text-muted);

  input, select {
    background: var(--s2-bg-sunken); color: var(--s2-text);
    border: 1px solid var(--s2-border-strong); border-radius: 4px;
    padding: 0.4rem; min-width: 140px; font-size: 0.9rem;
  }
`;
const Hint = styled.p`color: var(--s2-text-muted); font-size: 0.85rem; margin: 0.25rem 0;`;
const Err = styled.p`color: var(--s2-danger); font-size: 0.85rem; margin: 0.25rem 0;`;
const TableWrap = styled.div`
  overflow-x: auto; border: 1px solid var(--s2-border); border-radius: 8px;
  background: var(--s2-surface-raised);
`;
const Table = styled.table`
  width: 100%; border-collapse: collapse; font-size: 0.85rem;

  th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--s2-border); }
  th { color: var(--s2-text-muted); font-weight: normal; }
  tbody tr { cursor: pointer; }
  tbody tr:hover { background: var(--s2-overlay); }
  tbody tr[aria-selected='true'] { background: var(--s2-accent-tint); }
`;
const Mono = styled.td`font-family: ui-monospace, SFMono-Regular, Menlo, monospace;`;
const Pager = styled.div`display: flex; gap: 0.5rem; align-items: center; margin: 0.75rem 0;`;
const Button = styled.button`
  background: var(--s2-accent); color: var(--s2-on-accent); border: none; border-radius: 6px;
  padding: 0.4rem 0.9rem; font-weight: bold; cursor: pointer; font-size: 0.85rem;
  &:disabled { opacity: 0.5; cursor: default; }
`;
const Secondary = styled(Button)`background: var(--s2-btn-grey);`;
const Editor = styled.form`
  margin-top: 1rem; padding: 1rem;
  background: var(--s2-surface-raised); border: 1px solid var(--s2-border); border-radius: 8px;
  display: flex; flex-direction: column; gap: 0.75rem;
`;
const EditorTitle = styled.h3`
  margin: 0; font-size: 1rem; color: var(--s2-text-strong);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
`;
const GrantRow = styled.div`display: flex; gap: 0.5rem; align-items: flex-end; flex-wrap: wrap;`;
const Errors = styled.ul`color: var(--s2-danger); font-size: 0.85rem; margin: 0; padding-left: 1.25rem;`;
const Actions = styled.div`display: flex; gap: 0.5rem; align-items: center;`;

function PassiveNodesAdmin() {
  const [filters, setFilters] = useState({ search: '', sector: '', kind: '' });
  const [offset, setOffset] = useState(0);
  const [form, setForm] = useState(null);

  const {
    nodes, total, isLoadingNodes, nodesError,
  } = usePassiveNodes({ ...filters, offset, limit: PAGE });
  const update = useUpdatePassiveNode();

  const setFilter = (key, value) => {
    setOffset(0); // a filter change invalidates the page index
    setFilters((f) => ({ ...f, [key]: value }));
  };

  const validation = form ? validateNodeForm(form) : { ok: false, errors: [] };
  // A start node is browsable but not editable: its grants are structural and
  // the next reseed rewrites them, so an edit here would silently disappear.
  const readOnly = form != null && form.kind === 'start';

  const submit = (e) => {
    e.preventDefault();
    if (!form || readOnly || !validation.ok) return;
    update.mutate({ id: form.id, body: formToPayload(form) });
  };

  const setGrant = (i, patch) => setForm((f) => ({
    ...f,
    grants: f.grants.map((g, j) => (j === i ? { ...g, ...patch } : g)),
  }));

  const page = Math.floor(offset / PAGE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <Wrap>
      <Hint>
        {isLoadingNodes
          ? 'Loading…'
          : `${total} node(s) match — showing ${nodes.length} at a time. Structure (key, sector, ring, position) comes from the generator and is read-only here.`}
      </Hint>
      {nodesError && <Err role="alert">{nodesError.message}</Err>}

      <Filters>
        <Field>
          Search key or label
          <input
            value={filters.search}
            onChange={(e) => setFilter('search', e.target.value)}
            placeholder="blood pact"
          />
        </Field>
        <Field>
          Sector
          <select value={filters.sector} onChange={(e) => setFilter('sector', e.target.value)}>
            <option value="">All</option>
            {SECTORS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field>
          Kind
          <select value={filters.kind} onChange={(e) => setFilter('kind', e.target.value)}>
            <option value="">All</option>
            {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            <option value="start">start (read-only)</option>
          </select>
        </Field>
      </Filters>

      <TableWrap>
        <Table>
          <thead>
            <tr>
              <th>Key</th><th>Sector</th><th>Ring</th><th>Kind</th><th>Label</th><th>Grants</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((n) => (
              <tr
                key={n.id}
                aria-selected={form != null && form.id === n.id}
                onClick={() => setForm(nodeToForm(n))}
              >
                <Mono>{n.key}</Mono>
                <td>{n.sector}</td>
                <td>{n.ring}</td>
                <td>{n.kind}</td>
                <td>{n.label}</td>
                <td>{grantSummary(n.grants)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>

      <Pager>
        <Secondary type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
          Previous
        </Secondary>
        <Secondary type="button" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
          Next
        </Secondary>
        <Hint>{`Page ${page} of ${pages}`}</Hint>
      </Pager>

      {form && (
        <Editor onSubmit={submit}>
          <EditorTitle>{form.key}</EditorTitle>
          <Hint>{`sector ${form.sector} · ring ${form.ring} — these cannot be changed here`}</Hint>
          {readOnly && (
            <Err role="alert">
              A start node&apos;s label and grants are structural: the seeder rewrites them on
              every reseed, so an edit here would be silently reverted.
            </Err>
          )}

          <Field>
            Label
            <input
              value={form.label}
              disabled={readOnly}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
            />
          </Field>

          <Field>
            Kind
            <select
              value={form.kind}
              disabled={readOnly}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
            >
              {form.kind === 'start' && <option value="start">start</option>}
              {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </Field>

          {form.grants.map((g, i) => {
            const def = GRANT_TYPES.find((t) => t.type === g.type);
            return (
              // eslint-disable-next-line react/no-array-index-key
              <GrantRow key={i}>
                <Field>
                  Type
                  <select
                    value={g.type}
                    disabled={readOnly}
                    onChange={(e) => setGrant(i, { type: e.target.value })}
                  >
                    {GRANT_TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
                  </select>
                </Field>
                {def && (
                  <Field>
                    {def.label}
                    <select
                      value={g[def.field] || ''}
                      disabled={readOnly}
                      onChange={(e) => setGrant(i, { [def.field]: e.target.value })}
                    >
                      <option value="">—</option>
                      {def.options.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </Field>
                )}
                <Field>
                  Value
                  <input
                    value={g.value}
                    disabled={readOnly}
                    onChange={(e) => setGrant(i, { value: e.target.value })}
                  />
                </Field>
                <Secondary
                  type="button"
                  disabled={readOnly}
                  onClick={() => setForm({ ...form, grants: form.grants.filter((_, j) => j !== i) })}
                >
                  Remove
                </Secondary>
              </GrantRow>
            );
          })}

          <Actions>
            <Secondary
              type="button"
              disabled={readOnly}
              onClick={() => setForm({
                ...form,
                grants: [...form.grants, { type: 'stat', stat: 'strength', value: 0 }],
              })}
            >
              Add grant
            </Secondary>
          </Actions>

          {!readOnly && validation.errors.length > 0 && (
            <Errors role="alert">{validation.errors.map((e) => <li key={e}>{e}</li>)}</Errors>
          )}

          <Actions>
            <Button type="submit" disabled={readOnly || !validation.ok || update.isPending}>
              {update.isPending ? 'Saving…' : 'Save'}
            </Button>
            <Secondary type="button" onClick={() => setForm(null)}>Close</Secondary>
          </Actions>
        </Editor>
      )}
    </Wrap>
  );
}

export default PassiveNodesAdmin;
