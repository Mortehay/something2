// frontend/src/games/something2/PartyPanel.jsx
// Party Frames: one row per member (HP / mana bars, buffs), the pending-invite
// prompt, and the leader's controls. A thin view over Game's party state -- the
// server owns every rule (see backend/src/authority/party.js), this only sends
// the player's intent and renders whatever frame comes back.
import { useEffect, useState } from 'react';
import styled from 'styled-components';
import { t } from './src/js/i18n/i18n.js';
import { useLang } from './src/js/i18n/useLang.js';

const Wrap = styled.div`
  position: absolute;
  /* Bottom-left, above the health orb: the top-left corner belongs to the quest tracker,
     and a party panel anchored there drew over it. Anchored at the bottom the frames
     grow upward and never reach the tracker. */
  bottom: 200px;
  left: 16px;
  z-index: 20;
  width: 210px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  pointer-events: auto;
  font-size: 12px;
  color: #e5e7eb;
`;

const Card = styled.div`
  background: rgba(15, 15, 26, 0.82);
  border: 1px solid ${(p) => (p.$leader ? '#facc15' : '#2e2e3e')};
  border-radius: 8px;
  padding: 6px 8px;
  backdrop-filter: blur(6px);
  opacity: ${(p) => (p.$offline ? 0.55 : 1)};
`;

const Row = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
`;

const Bar = styled.div`
  height: ${(p) => p.$h || 8}px;
  margin-top: 3px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.1);
  overflow: hidden;
  & > i {
    display: block;
    height: 100%;
    width: ${(p) => Math.max(0, Math.min(100, p.$pct))}%;
    background: ${(p) => p.$color};
    transition: width 0.2s linear;
  }
`;

const Btn = styled.button`
  background: rgba(26, 26, 46, 0.9);
  border: 1px solid #3b3b52;
  border-radius: 6px;
  color: #e5e7eb;
  padding: 2px 6px;
  font-size: 11px;
  cursor: pointer;
  &:hover { border-color: #facc15; }
`;

const Buffs = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  margin-top: 3px;
  font-size: 12px;
`;

const pct = (v, max) => (max > 0 ? (v / max) * 100 : 0);

export default function PartyPanel({ gameRef }) {
  useLang();
  const [state, setState] = useState({ party: null, invite: null });

  useEffect(() => {
    const g = gameRef.current;
    if (!g || !g.setOnPartyChange) return undefined;
    const read = () => setState({ party: g.getParty(), invite: g.getPartyInvite() });
    read();
    g.setOnPartyChange((party, invite) => setState({ party, invite }));
    return () => g.setOnPartyChange(null);
  }, [gameRef]);

  const selfId = gameRef.current ? gameRef.current.localUserId : null;
  const client = () => gameRef.current && gameRef.current.authorityClient;
  const { party, invite } = state;
  const amLeader = party && String(party.leaderId) === String(selfId);

  return (
    <Wrap>
      {invite && (
        <Card $leader>
          <div>{t('{name} invites you to a party', { name: invite.fromName })}</div>
          <Row style={{ marginTop: 4 }}>
            <Btn type="button" onClick={() => client()?.sendPartyAccept()}>{t('Accept')}</Btn>
            <Btn type="button" onClick={() => client()?.sendPartyDecline()}>{t('Decline')}</Btn>
          </Row>
        </Card>
      )}
      {party && party.members.map((m) => (
        <Card key={m.id} $leader={String(m.id) === String(party.leaderId)} $offline={!m.online}>
          <Row>
            <strong>{String(m.id) === String(party.leaderId) ? '👑 ' : ''}{m.name}</strong>
            {amLeader && String(m.id) !== String(selfId) && (
              <span>
                <Btn type="button" title={t('Make leader')} onClick={() => client()?.sendPartyLeader(m.id)}>👑</Btn>{' '}
                <Btn type="button" title={t('Remove from party')} onClick={() => client()?.sendPartyKick(m.id)}>✕</Btn>
              </span>
            )}
          </Row>
          {m.online && (
            <>
              <Bar $pct={pct(m.hp, m.maxHp)} $color="#ef4444"><i /></Bar>
              <Bar $pct={pct(m.mana, m.maxMana)} $color="#3b82f6" $h={5}><i /></Bar>
              {m.buffs && m.buffs.length > 0 && (
                <Buffs>
                  {m.buffs.map((b) => (
                    <span key={b.id} title={`${b.id} (${Math.ceil(b.ms / 1000)}s)`} style={{ color: b.color }}>{b.icon}</span>
                  ))}
                </Buffs>
              )}
            </>
          )}
        </Card>
      ))}
      {party && (
        <Card>
          <Row>
            <label htmlFor="party-loot">{t('Loot')}</label>
            <select
              id="party-loot"
              value={party.lootMode}
              disabled={!amLeader}
              onChange={(e) => client()?.sendPartyLoot(e.target.value)}
            >
              <option value="free_for_all">{t('Free for all')}</option>
              <option value="individual">{t('Individual (rotating)')}</option>
              <option value="leader">{t('Party leader')}</option>
            </select>
          </Row>
          <Row style={{ marginTop: 4 }}>
            {party.members.length < party.maxSize && amLeader && (
              <Btn type="button" onClick={() => gameRef.current?.invitePartyNearest()}>{t('Invite nearest')}</Btn>
            )}
            <Btn type="button" onClick={() => client()?.sendPartyLeave()}>{t('Leave party')}</Btn>
          </Row>
        </Card>
      )}
      {!party && !invite && (
        <Btn type="button" onClick={() => gameRef.current?.invitePartyNearest()}>{t('Invite nearest player')}</Btn>
      )}
    </Wrap>
  );
}
