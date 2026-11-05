// SOMET-732. The Action history panel of the Orange Pi tab: the last finished actions, newest first,
// and the log of the one that is opened. Presentational. Every value from the helper (a log, an error,
// a name) is a text child, never markup.
import styled from 'styled-components';
import { Badge, Muted } from './seedUi.jsx';
import { fmtTime } from './seedUi.jsx';
import { historyRow } from './boardModel.js';

export const Box = styled.section`
  border: 1px solid var(--s2-border); border-radius: 8px; padding: 0.8rem 1rem; margin-bottom: 0.8rem;
  background: var(--s2-surface-raised);
  h4 { margin: 0 0 0.5rem; font-size: 1.3rem; color: var(--s2-text-strong); }
`;
const List = styled.ul`list-style: none; margin: 0; padding: 0;`;
const RowBtn = styled.button`
  display: flex; gap: 0.6rem; align-items: baseline; flex-wrap: wrap; width: 100%; text-align: left;
  background: none; border: 0; border-top: 1px solid var(--s2-border); color: var(--s2-text);
  padding: 0.4rem 0; font-size: 1.2rem; cursor: pointer;
`;
const Pre = styled.pre`
  font-size: 1.1rem; background: var(--s2-bg-sunken); color: var(--s2-text-secondary); padding: 0.5rem 0.7rem;
  border-radius: 6px; max-height: 18rem; overflow: auto; white-space: pre-wrap; word-break: break-word; margin: 0.2rem 0 0.5rem;
`;
const Err = styled.p`color: var(--s2-danger); margin: 0.3rem 0; font-size: 1.2rem;`;

export default function ActionHistory({ entries, selectedId = null, entry = null, error = null, onSelect = () => {} }) {
  const list = Array.isArray(entries) ? entries : null;
  return (
    <Box aria-label="Action history">
      <h4>Action history</h4>
      {error && <Err role="alert">{error}</Err>}
      {list === null && !error && <Muted>Loading…</Muted>}
      {list !== null && list.length === 0 && <Muted>No actions recorded yet</Muted>}
      {list !== null && list.length > 0 && (
        <List>
          {list.map((e) => {
            const row = historyRow(e);
            const open = e.id === selectedId;
            return (
              <li key={e.id}>
                <RowBtn type="button" aria-expanded={open} onClick={() => onSelect(open ? null : e.id)}>
                  <Muted>{fmtTime(e.finishedAt || e.startedAt)}</Muted>
                  <b>{row.name}</b>
                  <Badge $tone={row.tone}>{row.result}</Badge>
                  {row.duration && <Muted>{row.duration}</Muted>}
                </RowBtn>
                {open && (
                  <div>
                    {e.state === 'failed' && (entry?.error || e.error) && <Err>{entry?.error || e.error}</Err>}
                    {entry && entry.id === e.id
                      ? (entry.log ? <Pre>{entry.log}</Pre> : <Muted>No log was recorded</Muted>)
                      : <Muted>Loading the log…</Muted>}
                  </div>
                )}
              </li>
            );
          })}
        </List>
      )}
    </Box>
  );
}
