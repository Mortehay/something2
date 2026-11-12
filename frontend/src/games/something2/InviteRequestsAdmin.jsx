// Admin "Invites" tab: review invite-code requests. Pending requests get Approve / Reject; History lists decided
// ones with the code (and a copy button) for approved rows.
import { useState } from 'react';
import styled from 'styled-components';
import toast from 'react-hot-toast';
import { Btn, Badge, Muted, fmtTime } from './seedUi.jsx';
import AdminLoading from './AdminLoading.jsx';
import { t } from './src/js/i18n/i18n.js';
import { useLang } from './src/js/i18n/useLang.js';
import { statusLabel, canDecide, STATUS_FILTERS } from './inviteRequestsModel.js';
import { usePendingRequests, useHistoryRequests, useApprove, useReject } from './useInviteRequests.js';

const Page = styled.div`padding: 1rem 1.4rem; color: var(--s2-text); h2 { margin: 0 0 0.8rem; color: var(--s2-text-strong); }`;
const Box = styled.section`
  border: 1px solid var(--s2-border); border-radius: 8px; padding: 0.8rem 1rem; margin-bottom: 1rem;
  background: var(--s2-surface-raised);
  h3 { margin: 0 0 0.5rem; font-size: 1.5rem; color: var(--s2-text-strong); }
`;
const List = styled.ul`list-style: none; margin: 0; padding: 0;`;
const Item = styled.li`
  display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; padding: 0.45rem 0; border-top: 1px solid var(--s2-border);
  font-size: 1.3rem;
`;
const Email = styled.strong`color: var(--s2-text-strong);`;
const CodeText = styled.code`font-size: 1.3rem; background: var(--s2-bg-sunken); padding: 1px 6px; border-radius: 4px;`;
const Err = styled.p`color: var(--s2-danger); margin: 0.4rem 0; font-size: 1.3rem;`;
const Select = styled.select`
  background: var(--s2-bg-sunken); color: var(--s2-text); border: 1px solid var(--s2-border-strong);
  border-radius: 6px; padding: 0.3rem 0.5rem; font-size: 1.3rem;
`;

async function copyCode(code) {
  try {
    await navigator.clipboard.writeText(code);
    toast.success(t('Code copied'));
  } catch {
    toast.error(t('Could not copy. Copy the code by hand: {code}', { code }), { duration: 15000 });
  }
}

const tone = (r) => (r.status === 'approved' ? (r.codeUsed ? 'info' : 'ok') : r.status === 'rejected' ? 'bad' : 'warn');
const labelText = (r) => t(statusLabel(r));

function Meta({ r }) {
  return (
    <>
      <Email>{r.email}</Email>
      {r.note && <Muted>{String(r.note).trim()}</Muted>}
      <Muted>{fmtTime(r.createdAt)}</Muted>
    </>
  );
}

function PendingRow({ r, approve, reject }) {
  const busy = (approve.isPending && approve.variables === r.id) || (reject.isPending && reject.variables === r.id);
  return (
    <Item>
      <Meta r={r} />
      <Btn $primary disabled={busy || !canDecide(r)} onClick={() => approve.mutate(r.id)}>{t('Approve')}</Btn>
      <Btn disabled={busy || !canDecide(r)} onClick={() => reject.mutate(r.id)}>{t('Reject')}</Btn>
    </Item>
  );
}

function HistoryRow({ r }) {
  return (
    <Item>
      <Meta r={r} />
      <Badge $tone={tone(r)}>{labelText(r)}</Badge>
      {r.status === 'approved' && r.inviteCode && (
        <>
          <CodeText>{r.inviteCode}</CodeText>
          <Btn onClick={() => copyCode(r.inviteCode)}>{t('Copy')}</Btn>
        </>
      )}
      {r.decidedAt && <Muted>{fmtTime(r.decidedAt)}</Muted>}
    </Item>
  );
}

export default function InviteRequestsAdmin() {
  useLang();
  const [filter, setFilter] = useState('all');
  const pending = usePendingRequests();
  const history = useHistoryRequests(filter);
  const approve = useApprove();
  const reject = useReject();
  const decided = (history.data || []).filter((r) => r.status !== 'pending');

  return (
    <Page>
      <h2>{t('Invites')}</h2>
      <Box aria-label={t('Pending requests')}>
        <h3>{t('Pending requests')}</h3>
        {pending.isLoading && <AdminLoading />}
        {pending.error && <Err role="alert">{t('Could not load the requests.')}</Err>}
        {pending.data && pending.data.length === 0 && <Muted>{t('No pending requests.')}</Muted>}
        {pending.data && pending.data.length > 0 && (
          <List>{pending.data.map((r) => <PendingRow key={r.id} r={r} approve={approve} reject={reject} />)}</List>
        )}
      </Box>
      <Box aria-label={t('History')}>
        <h3>{t('History')}</h3>
        <label>
          <Muted>{t('Show')} </Muted>
          <Select aria-label={t('Status filter')} value={filter} onChange={(e) => setFilter(e.target.value)}>
            {STATUS_FILTERS.map((s) => <option key={s} value={s}>{t(s === 'all' ? 'All decided' : s === 'approved' ? 'Approved' : 'Rejected')}</option>)}
          </Select>
        </label>
        {history.isLoading && <AdminLoading />}
        {history.error && <Err role="alert">{t('Could not load the requests.')}</Err>}
        {history.data && decided.length === 0 && <p><Muted>{t('Nothing here yet.')}</Muted></p>}
        {decided.length > 0 && <List>{decided.map((r) => <HistoryRow key={r.id} r={r} />)}</List>}
      </Box>
    </Page>
  );
}
