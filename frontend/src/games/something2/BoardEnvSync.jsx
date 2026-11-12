// .env sync box (email accounts, Task 15), left column of the Orange Pi tab under Invite codes. Presentational: the
// parent passes the statuses and the copy action. Values never reach the browser; the helper reads this PC's .env
// and writes the chosen keys into the board's .env itself.
import { useState } from 'react';
import styled from 'styled-components';
import { Btn, Muted, Badge } from './seedUi.jsx';
import { t } from './src/js/i18n/i18n.js';
import { useLang } from './src/js/i18n/useLang.js';
import {
  statusLabel, statusTone, copyable, visibleRows, envSummary, effectiveSelection, LOCKED_TIP, RESTART_ENV_NOTE, ENV_HELP,
} from './boardEnvModel.js';

const Box = styled.section`
  border: 1px solid var(--s2-border); border-radius: 8px; padding: 0.8rem 1rem; margin-bottom: 0.8rem;
  background: var(--s2-surface-raised);
  h4 { margin: 0 0 0.5rem; font-size: 1.3rem; color: var(--s2-text-strong); }
`;
const Row = styled.div`display: flex; gap: 0.6rem; flex-wrap: wrap; align-items: center; margin-top: 0.4rem;`;
const Note = styled.p`margin: 0.5rem 0 0; font-size: 1.2rem; color: var(--s2-text-muted);`;
const Err = styled.p`color: var(--s2-danger); margin: 0.4rem 0; font-size: 1.3rem;`;
const Scroll = styled.div`max-height: 26rem; overflow-y: auto; margin-top: 0.5rem;`;
const Table = styled.table`
  width: 100%; border-collapse: collapse; font-size: 1.25rem;
  td { padding: 0.25rem 0.3rem; border-top: 1px solid var(--s2-border); vertical-align: middle; }
`;
const Key = styled.code`font-size: 1.25rem; color: var(--s2-text); word-break: break-all;`;
const Lock = styled.span`display: inline-flex; color: var(--s2-text-muted); cursor: help;`;

function LockIcon() {
  const tip = t(LOCKED_TIP);
  return (
    <Lock title={tip} aria-label={tip} role="img">
      <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
        <path d="M4 7V5a4 4 0 1 1 8 0v2h1a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h1zm2 0h4V5a2 2 0 1 0-4 0v2z" />
      </svg>
    </Lock>
  );
}

export default function BoardEnvSync({ data, loading = false, error = null, pending = false, disabledReason = null, onRefresh, onCopy }) {
  useLang();
  const [selected, setSelected] = useState(() => new Set());
  const [hidePassed, setHidePassed] = useState(false);
  const rows = Array.isArray(data?.keys) ? data.keys : [];
  const shown = visibleRows(rows, hidePassed);
  const chosen = effectiveSelection(rows, selected);
  const counts = envSummary(rows);
  const toggle = (key) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  // The ticks stay on a failure, so the admin can retry the same keys.
  const copy = () => { onCopy(chosen, { onSuccess: () => setSelected(new Set()) }); };
  const copyBlocked = pending || Boolean(disabledReason) || chosen.length === 0;
  return (
    <Box aria-label={t('.env sync')}>
      <h4>{t('.env sync')}</h4>
      <Note style={{ marginTop: 0 }}>{t(ENV_HELP)}</Note>
      <Row>
        <label>
          <input type="checkbox" checked={hidePassed} onChange={(e) => setHidePassed(e.target.checked)} /> <Muted>{t('Hide passed')}</Muted>
        </label>
        <Btn disabled={loading || Boolean(disabledReason)} title={disabledReason || undefined} onClick={onRefresh}>{t('Refresh')}</Btn>
        <Btn $primary disabled={copyBlocked} title={disabledReason || undefined} onClick={copy}>{t('Copy to board')}</Btn>
      </Row>
      {rows.length > 0 && (
        <Note>{t('{passed} passed · {not_passed} not passed · {different} different · {board_only} only on board', counts)}</Note>
      )}
      {error && <Err role="alert">{error}</Err>}
      {loading && !data && <p>{t("Reading the board's .env…")}</p>}
      {data && rows.length === 0 && <Note>{t('Neither .env has any keys.')}</Note>}
      {shown.length > 0 && (
        <Scroll>
          <Table aria-label={t('.env keys')}>
            <tbody>
              {shown.map((r) => (
                <tr key={r.key}>
                  <td style={{ width: '1.6rem' }}>
                    {copyable(r) && (
                      <input type="checkbox" aria-label={t('Copy {key}', { key: r.key })} checked={selected.has(r.key)} disabled={pending} onChange={() => toggle(r.key)} />
                    )}
                  </td>
                  <td><Key>{r.key}</Key></td>
                  <td>{statusLabel(r.status) && <Badge $tone={statusTone(r.status)}>{t(statusLabel(r.status))}</Badge>}</td>
                  <td style={{ width: '1.6rem' }}>{r.locked && <LockIcon />}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Scroll>
      )}
      <Note>{t(RESTART_ENV_NOTE)}</Note>
    </Box>
  );
}
