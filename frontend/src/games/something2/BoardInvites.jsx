// SOMET-734. The Invite codes box (left column of the Orange Pi tab). Presentational: the parent passes the
// list and the two actions. Registration on the board stays invite-only; this only makes, shows and revokes codes.
import { useState } from 'react';
import styled from 'styled-components';
import toast from 'react-hot-toast';
import { Btn, Muted, Badge, Modal, fmtTime } from './seedUi.jsx';
import {
  INVITE_COUNT_MAX, INVITE_NOTE_MAX, INVITES_HELP, INVITES_UPDATE_TEXT, inviteDraft, inviteStatus, canRevoke, madeText, listSummary,
} from './boardInvitesModel.js';

const Box = styled.section`
  border: 1px solid var(--s2-border); border-radius: 8px; padding: 0.8rem 1rem; margin-bottom: 0.8rem;
  background: var(--s2-surface-raised);
  h4 { margin: 0 0 0.5rem; font-size: 1.3rem; color: var(--s2-text-strong); }
`;
const Row = styled.div`display: flex; gap: 0.6rem; flex-wrap: wrap; align-items: center; margin-top: 0.4rem;`;
const Note = styled.p`margin: 0.5rem 0 0; font-size: 1.2rem; color: var(--s2-text-muted);`;
const Err = styled.p`color: var(--s2-danger); margin: 0.4rem 0; font-size: 1.3rem;`;
const Field = styled.input`
  background: var(--s2-bg-sunken); color: var(--s2-text); border: 1px solid var(--s2-border-strong);
  border-radius: 6px; padding: 0.3rem 0.5rem; font-size: 1.3rem;
`;
const List = styled.ul`list-style: none; margin: 0.5rem 0 0; padding: 0; max-height: 22rem; overflow-y: auto;`;
const Item = styled.li`
  display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; padding: 0.3rem 0; border-top: 1px solid var(--s2-border);
  opacity: ${(p) => (p.$spent ? 0.75 : 1)};
`;
const CodeText = styled.code`font-size: 1.3rem; background: var(--s2-bg-sunken); padding: 1px 6px; border-radius: 4px;`;

async function copyCode(code) {
  try {
    await navigator.clipboard.writeText(code);
    toast.success('Code copied');
  } catch {
    toast.error(`Could not copy. Copy the code by hand: ${code}`, { duration: 15000 });
  }
}

function CodeRow({ invite, onAskRevoke, locked }) {
  const st = inviteStatus(invite);
  return (
    <Item $spent={!canRevoke(invite)}>
      <CodeText>{invite.code}</CodeText>
      <Badge $tone={st.tone}>{st.label}</Badge>
      {invite.note && <Muted>{String(invite.note).trim()}</Muted>}
      {invite.createdAt && <Muted>{fmtTime(invite.createdAt)}</Muted>}
      <Btn onClick={() => copyCode(invite.code)}>Copy</Btn>
      {canRevoke(invite) && <Btn disabled={locked} onClick={() => onAskRevoke(invite.code)}>Revoke</Btn>}
    </Item>
  );
}

export function RevokeDialog({ code, onConfirm, onClose }) {
  return (
    <Modal $w="440px" onClose={onClose} label="Revoke invite code">
      <h3 style={{ marginTop: 0 }}>Revoke this code?</h3>
      <p><CodeText>{code}</CodeText> will stop working. Nobody can use it to register, and it cannot be made valid again.</p>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 8 }}>
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn $primary onClick={onConfirm}>Revoke</Btn>
      </div>
    </Modal>
  );
}

export default function BoardInvites({ data, loading = false, error = null, made = null, pending = false, disabledReason = null, onMake, onRevoke }) {
  const [count, setCount] = useState('1');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState(null);
  const [revoking, setRevoking] = useState(null);
  const locked = pending || Boolean(disabledReason);
  const make = () => {
    const d = inviteDraft({ count, note });
    if (!d.ok) { setProblem(d.message); return; }
    setProblem(null);
    onMake({ count: d.count, note: d.note });
  };
  const summary = listSummary(data);
  const madeLine = madeText(made);
  return (
    <Box aria-label="Invite codes">
      <h4>Invite codes</h4>
      <Row>
        <label>
          <Muted>How many </Muted>
          <Field aria-label="How many codes" inputMode="numeric" size={3} value={count} onChange={(e) => setCount(e.target.value)} />
        </label>
        <label>
          <Muted>Note </Muted>
          <Field aria-label="Note for the codes" placeholder="optional, e.g. for Alice" maxLength={INVITE_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <Btn $primary disabled={locked} title={disabledReason || undefined} onClick={make}>Make codes</Btn>
      </Row>
      <Note>{INVITES_HELP} Up to {INVITE_COUNT_MAX} codes at a time.</Note>
      {problem && <Err role="alert">{problem}</Err>}
      {madeLine && (
        <div role="status">
          <p style={{ margin: '0.5rem 0 0' }}>{madeLine}</p>
          <List>
            {(made.codes || []).map((c) => (
              <Item key={c}><CodeText>{c}</CodeText><Btn onClick={() => copyCode(c)}>Copy</Btn></Item>
            ))}
          </List>
        </div>
      )}
      {error && <Err role="alert">{error}</Err>}
      {loading && !data && <p>Loading the invite codes…</p>}
      {data?.needsUpdate && <Note>{INVITES_UPDATE_TEXT}</Note>}
      {summary && <Note>{summary}</Note>}
      {data && !data.needsUpdate && data.invites?.length > 0 && (
        <List aria-label="Invite code list">
          {data.invites.map((i) => <CodeRow key={i.code} invite={i} locked={locked} onAskRevoke={setRevoking} />)}
        </List>
      )}
      {revoking && (
        <RevokeDialog code={revoking} onClose={() => setRevoking(null)} onConfirm={() => { const c = revoking; setRevoking(null); onRevoke(c); }} />
      )}
    </Box>
  );
}
