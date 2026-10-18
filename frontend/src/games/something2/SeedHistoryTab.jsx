// SOMET-638. History sub-tab: every export / seed run, paged on the server.
import { useState } from 'react';
import styled from 'styled-components';
import { useSeedRuns } from './useSeedExport.js';
import { HISTORY_PER_PAGE, historyPageCount } from './seedExportModel.js';
import { Btn, Muted, fmtTime } from './seedUi.jsx';

const Table = styled.table`
  width: 100%; border-collapse: collapse; margin-top: 0.8rem; font-size: 1.4rem;
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--s2-border); vertical-align: middle; }
  th { color: var(--s2-text-muted); font-weight: 500; font-size: 1.2rem; }
`;
const Bar = styled.div`display: flex; gap: 8px; align-items: center; margin-top: 0.8rem; flex-wrap: wrap;`;
const Select = styled.select`
  background: var(--s2-bg-sunken); color: var(--s2-text); border: 1px solid var(--s2-border-strong);
  border-radius: 6px; padding: 0.25rem 0.5rem; font-size: 1.4rem;
`;

export default function SeedHistoryTab({ groups }) {
  const [group, setGroup] = useState('');
  const [page, setPage] = useState(0);
  const runs = useSeedRuns({ group, page, perPage: HISTORY_PER_PAGE });
  const total = runs.data?.total ?? 0;
  const pages = historyPageCount(total, HISTORY_PER_PAGE);
  const list = runs.data?.runs || [];

  return (
    <div>
      <Bar>
        <label>Group{' '}
          <Select value={group} onChange={(e) => { setGroup(e.target.value); setPage(0); }}>
            <option value="">All</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
          </Select>
        </label>
      </Bar>
      {runs.isLoading && <Muted>Loading…</Muted>}
      {runs.error && <p style={{ color: 'var(--s2-danger)' }}>{runs.error.message}</p>}
      {runs.data && list.length === 0 && <p><Muted>No runs yet.</Muted></p>}
      {list.length > 0 && (
        <Table>
          <thead><tr><th>When</th><th>Group</th><th>Action</th><th>Status</th><th>PC</th><th>Result</th></tr></thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id}>
                <td>{fmtTime(r.started_at)}</td><td>{r.group_id}</td><td>{r.action}</td>
                <td>{r.status}</td><td>{r.pc_label}</td>
                <td>{r.error ? <span style={{ color: 'var(--s2-danger)' }}>{r.error}</span>
                  : Object.entries(r.summary || {}).map(([k, v]) => `${k} ${v}`).join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Bar>
        <Btn disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Prev</Btn>
        <span>Page {page + 1} of {pages}</span>
        <Btn disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Next</Btn>
        <Muted>{total} run{total === 1 ? '' : 's'}</Muted>
      </Bar>
    </div>
  );
}
