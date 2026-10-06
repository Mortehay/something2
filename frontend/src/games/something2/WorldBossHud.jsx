import { useEffect, useState } from 'react';
import styled, { keyframes } from 'styled-components';

const pulseGlow = keyframes`
  0% { box-shadow: 0 0 15px rgba(255, 71, 87, 0.4), inset 0 0 15px rgba(255, 71, 87, 0.2); }
  50% { box-shadow: 0 0 25px rgba(255, 71, 87, 0.8), inset 0 0 25px rgba(255, 71, 87, 0.4); }
  100% { box-shadow: 0 0 15px rgba(255, 71, 87, 0.4), inset 0 0 15px rgba(255, 71, 87, 0.2); }
`;

const warningFlash = keyframes`
  0% { border-color: rgba(255, 177, 66, 0.5); transform: translateY(0); }
  50% { border-color: rgba(255, 71, 87, 1); transform: translateY(-2px); }
  100% { border-color: rgba(255, 177, 66, 0.5); transform: translateY(0); }
`;

const BossContainer = styled.div`
  position: absolute;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 100;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  pointer-events: none;
  width: min(540px, 90vw);
`;

const WarningBanner = styled.div`
  background: rgba(15, 15, 26, 0.85);
  border: 1px solid #ffb142;
  backdrop-filter: blur(10px);
  padding: 8px 18px;
  border-radius: 20px;
  color: #ffd166;
  font-size: 0.88rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  display: flex;
  align-items: center;
  gap: 8px;
  animation: ${warningFlash} 2s infinite ease-in-out;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.6);
`;

const BossCard = styled.div`
  background: linear-gradient(180deg, rgba(26, 26, 46, 0.95) 0%, rgba(15, 15, 26, 0.95) 100%);
  border: 1px solid ${(p) => p.$elementColor || '#ff4757'};
  border-radius: 12px;
  padding: 10px 16px;
  width: 100%;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.7);
  animation: ${pulseGlow} 2.5s infinite ease-in-out;
  backdrop-filter: blur(12px);
  pointer-events: auto;
`;

const BossHeader = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
`;

const BossTitle = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 800;
  font-size: 1rem;
  color: #f1f2f6;
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.8);
`;

const ElementBadge = styled.span`
  font-size: 0.72rem;
  text-transform: uppercase;
  font-weight: 800;
  padding: 2px 8px;
  border-radius: 6px;
  background: ${(p) => p.$bg || 'rgba(255, 71, 87, 0.2)'};
  color: ${(p) => p.$color || '#ff4757'};
  border: 1px solid ${(p) => p.$color || '#ff4757'};
`;

const BossHpTrack = styled.div`
  position: relative;
  width: 100%;
  height: 14px;
  background: rgba(0, 0, 0, 0.6);
  border-radius: 7px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.15);
`;

const BossHpFill = styled.div`
  height: 100%;
  width: ${(p) => p.$pct}%;
  background: linear-gradient(90deg, #ff4757 0%, #ff6b81 50%, #ffa502 100%);
  border-radius: 7px;
  transition: width 0.15s ease-out;
`;

const HpLabel = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.68rem;
  font-weight: 700;
  color: #ffffff;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);
`;

const LeaderboardRow = styled.div`
  display: flex;
  justify-content: space-between;
  font-size: 0.72rem;
  color: var(--s2-text-dim, #a4b0be);
  margin-top: 6px;
  padding-top: 4px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);

  strong {
    color: #ffd166;
  }
`;

const LocationBadge = styled.div`
  font-size: 0.72rem;
  color: #a4b0be;
  margin-top: 4px;
  display: flex;
  align-items: center;
  gap: 4px;

  span {
    color: #ffd166;
    font-weight: 600;
  }
`;

const ELEMENT_STYLES = {
  fire: { color: '#ff4757', bg: 'rgba(255, 71, 87, 0.25)', icon: '🔥 Fire' },
  ice: { color: '#70a1ff', bg: 'rgba(112, 161, 255, 0.25)', icon: '❄️ Frost' },
  arcane: { color: '#a55eea', bg: 'rgba(165, 94, 234, 0.25)', icon: '🔮 Void' },
  lightning: { color: '#eccc68', bg: 'rgba(236, 204, 104, 0.25)', icon: '⚡ Thunder' },
};

function formatTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

const TeleportButton = styled.button`
  background: rgba(45, 152, 218, 0.25);
  border: 1px solid rgba(45, 152, 218, 0.7);
  color: #70a1ff;
  font-size: 0.75rem;
  font-weight: 700;
  padding: 3px 8px;
  border-radius: 6px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: all 0.2s;
  pointer-events: auto;

  &:hover {
    background: rgba(45, 152, 218, 0.5);
    color: #ffffff;
    border-color: #70a1ff;
    transform: scale(1.04);
  }
`;

const PhaseBadge = styled.span`
  font-size: 0.72rem;
  text-transform: uppercase;
  font-weight: 800;
  padding: 2px 8px;
  border-radius: 6px;
  background: ${(p) => (p.$phase >= 4 ? 'rgba(235, 59, 90, 0.4)' : p.$phase >= 3 ? 'rgba(250, 130, 49, 0.35)' : p.$phase >= 2 ? 'rgba(247, 183, 49, 0.3)' : 'rgba(32, 191, 107, 0.25)')};
  color: ${(p) => (p.$phase >= 4 ? '#eb3b5a' : p.$phase >= 3 ? '#fa8231' : p.$phase >= 2 ? '#f7b731' : '#20bf6b')};
  border: 1px solid ${(p) => (p.$phase >= 4 ? '#eb3b5a' : p.$phase >= 3 ? '#fa8231' : p.$phase >= 2 ? '#f7b731' : '#20bf6b')};
  letter-spacing: 0.05em;
`;

const PhaseMarker = styled.div`
  position: absolute;
  top: 0;
  bottom: 0;
  left: ${(p) => p.$pos}%;
  width: 2px;
  background: rgba(255, 255, 255, 0.4);
  z-index: 2;
`;

const PhaseBonusRow = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.72rem;
  color: #fa8231;
  font-weight: 700;
  margin-top: 4px;
`;

export default function WorldBossHud({ gameRef }) {
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

    if (g.setOnWorldBossStatusChange) {
      g.setOnWorldBossStatusChange((s) => {
        setStatus(s || (g.getWorldBossStatus ? g.getWorldBossStatus() : null));
      });
    }

    const interval = setInterval(read, 150);
    return () => clearInterval(interval);
  }, [gameRef]);

  if (!status || status.state === 'idle' || (status.state === 'active' && status.currentHp <= 0)) {
    return null;
  }

  const elem = ELEMENT_STYLES[status.bossElement] || ELEMENT_STYLES.fire;
  const hpPct = status.maxHp > 0 ? Math.max(0, Math.min(100, (status.currentHp / status.maxHp) * 100)) : 100;
  const locationLabel = status.arenaName ? `${status.arenaName} (${status.worldName})` : status.worldName;
  const phase = status.phase || 1;
  const phaseName = status.phaseName || `Phase ${phase}`;

  if (status.state === 'warning') {
    return (
      <BossContainer>
        <WarningBanner>
          <span>⚠️</span>
          <span>World Boss Emerges in {formatTime(status.timeToSpawnMs)}: <strong>{status.bossName}</strong> {locationLabel ? `at ${locationLabel}` : ''}</span>
        </WarningBanner>
      </BossContainer>
    );
  }

  if (status.state === 'active') {
    const top3 = Array.isArray(status.topDamagers) ? status.topDamagers : [];

    return (
      <BossContainer>
        <BossCard $elementColor={elem.color}>
          <BossHeader>
            <BossTitle>
              <span>⚔️ {status.bossName}</span>
            </BossTitle>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <PhaseBadge $phase={phase}>
                Phase {phase}/4: {phaseName}
              </PhaseBadge>
              <TeleportButton
                title="Instantly teleport to this World Boss"
                onClick={() => {
                  const g = gameRef.current;
                  if (g && g.debugWorldBoss) {
                    g.debugWorldBoss('teleport_to_boss');
                  }
                }}
              >
                🚀 Teleport
              </TeleportButton>
              <ElementBadge $color={elem.color} $bg={elem.bg}>
                {elem.icon}
              </ElementBadge>
            </div>
          </BossHeader>

          <BossHpTrack>
            <BossHpFill $pct={hpPct} />
            <PhaseMarker $pos={75} title="Phase 2 (75% HP)" />
            <PhaseMarker $pos={50} title="Phase 3 (50% HP)" />
            <PhaseMarker $pos={25} title="Phase 4 (25% HP)" />
            <HpLabel>
              {Math.round(status.currentHp || 0)} / {status.maxHp} ({Math.round(hpPct)}%)
            </HpLabel>
          </BossHpTrack>

          {status.phaseBonus && (
            <PhaseBonusRow>
              <span>🔥 Boss Empowered:</span>
              <span>{status.phaseBonus}</span>
            </PhaseBonusRow>
          )}

          {locationLabel && (
            <LocationBadge>
              📍 Arena: <span>{locationLabel}</span>
            </LocationBadge>
          )}

          {top3.length > 0 && (
            <LeaderboardRow>
              <span>Top Contributors (Guaranteed Legendary):</span>
              <span>
                {top3.map((d, i) => (
                  <strong key={d.userId} style={{ marginLeft: 6 }}>
                    #{i + 1} Player {d.userId} ({d.damage})
                  </strong>
                ))}
              </span>
            </LeaderboardRow>
          )}
        </BossCard>
      </BossContainer>
    );
  }

  return null;
}
