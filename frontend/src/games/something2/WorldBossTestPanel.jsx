import { useEffect, useState } from 'react';
import styled from 'styled-components';

const FloatButton = styled.button`
  position: absolute;
  bottom: 24px;
  right: 24px;
  z-index: 350;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: linear-gradient(135deg, #e94560 0%, #0f3460 100%);
  color: #ffffff;
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 12px;
  font-weight: 700;
  font-size: 0.88rem;
  box-shadow: 0 8px 24px rgba(233, 69, 96, 0.4);
  cursor: pointer;
  pointer-events: auto;
  transition: all 0.2s ease-in-out;

  &:hover {
    transform: translateY(-2px);
    box-shadow: 0 12px 30px rgba(233, 69, 96, 0.6);
    border-color: #ffd166;
  }
`;

const ModalBackdrop = styled.div`
  position: absolute;
  inset: 0;
  z-index: 500;
  background: rgba(10, 10, 20, 0.7);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
`;

const ModalCard = styled.div`
  background: #161623;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 16px;
  padding: 24px;
  width: min(520px, 92vw);
  max-height: 85vh;
  overflow-y: auto;
  color: #e2e8f0;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.8);

  h2 {
    margin: 0 0 4px;
    color: #ffd166;
    font-size: 1.35rem;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  p.sub {
    margin: 0 0 18px;
    color: #94a3b8;
    font-size: 0.86rem;
  }
`;

const CloseButton = styled.button`
  float: right;
  background: transparent;
  border: none;
  color: #94a3b8;
  font-size: 1.5rem;
  cursor: pointer;
  line-height: 1;

  &:hover {
    color: #ffffff;
  }
`;

const StatusBox = styled.div`
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  padding: 12px 16px;
  margin-bottom: 18px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  font-size: 0.84rem;

  .item {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .label {
    color: #64748b;
    text-transform: uppercase;
    font-size: 0.7rem;
    font-weight: 700;
  }

  .val {
    color: #f8fafc;
    font-weight: 600;
  }
`;

const SectionTitle = styled.div`
  font-size: 0.78rem;
  text-transform: uppercase;
  font-weight: 800;
  letter-spacing: 0.05em;
  color: #38bdf8;
  margin: 16px 0 8px;
`;

const ButtonGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
`;

const ActionBtn = styled.button`
  padding: 10px 14px;
  border-radius: 8px;
  border: 1px solid ${(p) => p.$border || 'rgba(255, 255, 255, 0.15)'};
  background: ${(p) => p.$bg || 'rgba(255, 255, 255, 0.05)'};
  color: ${(p) => p.$color || '#f1f5f9'};
  font-size: 0.84rem;
  font-weight: 700;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: all 0.15s ease;

  &:hover {
    background: ${(p) => p.$hoverBg || 'rgba(255, 255, 255, 0.15)'};
    transform: translateY(-1px);
  }
`;

export default function WorldBossTestPanel({ gameRef }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    const g = gameRef.current;
    if (!g) return undefined;

    const read = () => {
      if (g.getWorldBossStatus) {
        setStatus(g.getWorldBossStatus());
      }
    };
    read();

    const id = setInterval(read, 800);
    return () => clearInterval(id);
  }, [gameRef, open]);

  const sendAction = (action, opts = {}) => {
    const g = gameRef.current;
    if (g && g.debugWorldBoss) {
      g.debugWorldBoss(action, opts);
    }
  };

  return (
    <>
      <FloatButton onClick={() => setOpen(true)} title="Open World Boss Testing Panel">
        <span>👹</span>
        <span>World Boss Test</span>
      </FloatButton>

      {open && (
        <ModalBackdrop onClick={() => setOpen(false)}>
          <ModalCard onClick={(e) => e.stopPropagation()}>
            <CloseButton onClick={() => setOpen(false)}>×</CloseButton>
            <h2>👹 World Boss Test Panel</h2>
            <p className="sub">Debug & test world bosses, warnings, damage leaderboards, loot and buffs.</p>

            <StatusBox>
              <div className="item">
                <span className="label">State</span>
                <span className="val" style={{ color: status?.state === 'active' ? '#ff4757' : status?.state === 'warning' ? '#ffd166' : '#94a3b8' }}>
                  {(status?.state || 'idle').toUpperCase()}
                </span>
              </div>
              <div className="item">
                <span className="label">Next Spawn / Timer</span>
                <span className="val">{Math.round((status?.timeToSpawnMs || 0) / 1000)}s</span>
              </div>
              <div className="item">
                <span className="label">Current Boss</span>
                <span className="val">{status?.bossName || 'None'}</span>
              </div>
              <div className="item">
                <span className="label">Target World</span>
                <span className="val">{status?.worldName || 'The Wilds'}</span>
              </div>
              {status?.state === 'active' && (
                <>
                  <div className="item">
                    <span className="label">Boss HP</span>
                    <span className="val">{status.currentHp} / {status.maxHp}</span>
                  </div>
                  <div className="item">
                    <span className="label">Element</span>
                    <span className="val">{status.bossElement}</span>
                  </div>
                </>
              )}
            </StatusBox>

            <SectionTitle>⚡ Instant Boss Spawns</SectionTitle>
            <ButtonGrid>
              <ActionBtn
                $bg="rgba(255, 71, 87, 0.15)"
                $border="rgba(255, 71, 87, 0.4)"
                $color="#ff6b81"
                onClick={() => sendAction('spawn', { bossIndex: 0 })}
              >
                🔥 Spawn Ignis (Fire)
              </ActionBtn>
              <ActionBtn
                $bg="rgba(112, 161, 255, 0.15)"
                $border="rgba(112, 161, 255, 0.4)"
                $color="#70a1ff"
                onClick={() => sendAction('spawn', { bossIndex: 1 })}
              >
                ❄️ Spawn Glacius (Ice)
              </ActionBtn>
              <ActionBtn
                $bg="rgba(165, 94, 234, 0.15)"
                $border="rgba(165, 94, 234, 0.4)"
                $color="#a55eea"
                onClick={() => sendAction('spawn', { bossIndex: 2 })}
              >
                🔮 Spawn Abyssor (Void)
              </ActionBtn>
              <ActionBtn
                $bg="rgba(236, 204, 104, 0.15)"
                $border="rgba(236, 204, 104, 0.4)"
                $color="#eccc68"
                onClick={() => sendAction('spawn', { bossIndex: 3 })}
              >
                ⚡ Spawn Gorgon (Thunder)
              </ActionBtn>
            </ButtonGrid>

            <SectionTitle>⚔️ Combat, Loot & Buff Actions</SectionTitle>
            <ButtonGrid>
              <ActionBtn
                $bg="rgba(255, 177, 66, 0.15)"
                $border="rgba(255, 177, 66, 0.4)"
                $color="#ffd166"
                onClick={() => sendAction('damage', { amount: 3000 })}
              >
                💥 Deal 3,000 Damage
              </ActionBtn>
              <ActionBtn
                $bg="rgba(235, 77, 75, 0.2)"
                $border="rgba(235, 77, 75, 0.5)"
                $color="#ff4757"
                onClick={() => sendAction('slay')}
              >
                🏆 Slay Boss (Drop Legendary)
              </ActionBtn>
              <ActionBtn
                $bg="rgba(46, 213, 115, 0.15)"
                $border="rgba(46, 213, 115, 0.4)"
                $color="#2ed573"
                onClick={() => sendAction('buff')}
              >
                🛡️ Grant Victor's Boon Buff
              </ActionBtn>
              <ActionBtn
                $bg="rgba(45, 152, 218, 0.25)"
                $border="rgba(45, 152, 218, 0.7)"
                $color="#22a6b3"
                style={{ fontWeight: 800 }}
                onClick={() => sendAction('teleport_to_boss')}
              >
                🚀 Teleport to World Boss
              </ActionBtn>
              <ActionBtn
                $bg="rgba(149, 175, 192, 0.15)"
                $border="rgba(149, 175, 192, 0.4)"
                $color="#dff9fb"
                onClick={() => sendAction('despawn')}
              >
                🚪 Despawn Boss
              </ActionBtn>
            </ButtonGrid>

            <SectionTitle>📢 Announcements & Timers</SectionTitle>
            <ButtonGrid>
              <ActionBtn
                $bg="rgba(255, 121, 121, 0.15)"
                $border="rgba(255, 121, 121, 0.4)"
                $color="#ff7979"
                onClick={() => sendAction('warning', { seconds: 120 })}
              >
                ⚠️ Trigger 2-Min Warning
              </ActionBtn>
              <ActionBtn
                $bg="rgba(104, 109, 224, 0.15)"
                $border="rgba(104, 109, 224, 0.4)"
                $color="#686de0"
                onClick={() => sendAction('setTimer', { seconds: 5 })}
              >
                ⏱️ Set Timer to 5s
              </ActionBtn>
            </ButtonGrid>
          </ModalCard>
        </ModalBackdrop>
      )}
    </>
  );
}
