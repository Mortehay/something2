import { useEffect, useState, useMemo } from 'react';
import styled from 'styled-components';
import { useWorlds } from './useWorlds.js';

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
  background: rgba(10, 10, 20, 0.75);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
`;

const ModalCard = styled.div`
  background: #141422;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 16px;
  padding: 24px;
  width: min(620px, 94vw);
  max-height: 88vh;
  overflow-y: auto;
  color: #e2e8f0;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.85);

  h2 {
    margin: 0 0 4px;
    color: #ffd166;
    font-size: 1.35rem;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  p.sub {
    margin: 0 0 14px;
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

const TabBar = styled.div`
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.12);
  padding-bottom: 8px;
`;

const TabButton = styled.button`
  padding: 8px 16px;
  border-radius: 8px;
  border: 1px solid ${(p) => (p.$active ? '#38bdf8' : 'rgba(255, 255, 255, 0.1)')};
  background: ${(p) => (p.$active ? 'rgba(56, 189, 248, 0.2)' : 'rgba(255, 255, 255, 0.05)')};
  color: ${(p) => (p.$active ? '#38bdf8' : '#94a3b8')};
  font-weight: 700;
  font-size: 0.88rem;
  cursor: pointer;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
  gap: 6px;

  &:hover {
    color: #ffffff;
    background: rgba(255, 255, 255, 0.12);
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
  gap: 10px;

  .item {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .label {
    font-size: 0.75rem;
    color: #94a3b8;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .val {
    font-size: 1.05rem;
    font-weight: 700;
    color: #f1f5f9;
  }
`;

const SectionTitle = styled.h3`
  font-size: 0.95rem;
  color: #38bdf8;
  margin: 18px 0 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  display: flex;
  align-items: center;
  gap: 6px;
`;

const ButtonGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 8px;
  margin-bottom: 12px;
`;

const ActionBtn = styled.button`
  background: ${(p) => p.$bg || '#1e293b'};
  color: ${(p) => p.$color || '#f8fafc'};
  border: 1px solid ${(p) => p.$border || 'rgba(255, 255, 255, 0.15)'};
  border-radius: 8px;
  padding: 9px 12px;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;

  &:hover {
    transform: translateY(-1px);
    filter: brightness(1.2);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
  }

  &:active {
    transform: translateY(0);
  }
`;

const SettlementCard = styled.div`
  background: ${(p) => p.$bg || 'rgba(255, 255, 255, 0.04)'};
  border: 1px solid ${(p) => p.$border || 'rgba(255, 255, 255, 0.1)'};
  border-radius: 10px;
  padding: 12px 14px;
  margin-bottom: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  transition: all 0.2s ease;

  &:hover {
    border-color: ${(p) => p.$color || '#38bdf8'};
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .title {
    font-size: 0.98rem;
    font-weight: 700;
    color: ${(p) => p.$color || '#f1f5f9'};
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .tag {
    font-size: 0.72rem;
    padding: 2px 8px;
    border-radius: 9999px;
    background: rgba(255, 255, 255, 0.1);
    color: #e2e8f0;
    font-weight: 600;
  }

  .desc {
    font-size: 0.82rem;
    color: #cbd5e1;
    line-height: 1.35;
  }

  .meta {
    font-size: 0.75rem;
    color: #94a3b8;
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 4px;
  }
`;

const TeleportBtn = styled.button`
  background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%);
  color: #ffffff;
  border: 1px solid rgba(56, 189, 248, 0.4);
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 0.8rem;
  font-weight: 700;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: all 0.15s ease;

  &:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(56, 189, 248, 0.4);
    border-color: #7dd3fc;
  }
`;

const TeleportPanel = styled.div`
  background: rgba(15, 23, 42, 0.6);
  border: 1px solid rgba(56, 189, 248, 0.2);
  border-radius: 12px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
`;

const SelectBox = styled.select`
  width: 100%;
  padding: 8px 12px;
  background: #0f172a;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 8px;
  color: #f8fafc;
  font-size: 0.85rem;
  outline: none;

  &:focus {
    border-color: #38bdf8;
  }
`;

const SearchInput = styled.input`
  width: 100%;
  box-sizing: border-box;
  padding: 8px 12px;
  background: #0f172a;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 8px;
  color: #f8fafc;
  font-size: 0.84rem;
  outline: none;

  &:focus {
    border-color: #38bdf8;
  }
`;

const ChipContainer = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
`;

const QuickChip = styled.button`
  padding: 6px 12px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 6px;
  color: #cbd5e1;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
  gap: 4px;

  &:hover {
    background: rgba(56, 189, 248, 0.2);
    border-color: #38bdf8;
    color: #ffffff;
    transform: translateY(-1px);
  }
`;

const SETTLEMENTS = [
  {
    id: "b7678836-8a10-47e2-82aa-32bf458b4182",
    name: "Vale Crossing",
    tag: "🌲 Starting Village",
    biome: "River Valley / Forest",
    desc: "Peaceful settlement: merchants, skill trainer, elder quest lodge, and secure bank vault.",
    spawnX: 4650,
    spawnY: 4550,
    color: "#4ade80",
    bg: "rgba(34, 197, 94, 0.12)",
    border: "rgba(34, 197, 94, 0.3)",
  },
  {
    id: "dc20d773-129a-46c5-93bd-dff895aab86c",
    name: "Thornbriar Reach",
    tag: "🌿 Forest Outpost",
    biome: "Southern Brambles",
    desc: "Fortified hunter camp, wooden gate, potion brewers, and elder scouts.",
    spawnX: 4550,
    spawnY: 4250,
    color: "#2dd4bf",
    bg: "rgba(45, 212, 191, 0.12)",
    border: "rgba(45, 212, 191, 0.3)",
  },
  {
    id: "0c131f37-eb02-4718-b113-dfee570648ab",
    name: "Old Trailhead",
    tag: "⛰️ Trade Crossroads",
    biome: "Mountain Foothills",
    desc: "Caravan stop at the base of the peaks: ore dealers, blacksmith, and cache vault.",
    spawnX: 4750,
    spawnY: 4850,
    color: "#f59e0b",
    bg: "rgba(245, 158, 11, 0.12)",
    border: "rgba(245, 158, 11, 0.3)",
  },
  {
    id: "dc0e0fdf-f38c-4e7e-941e-0d756bc04bba",
    name: "Windwatch Pass",
    tag: "💨 Highland Sanctuary",
    biome: "Stormy Peaks",
    desc: "Ridge sentinel fort: stone towers, scenic lookout post, and elemental altar.",
    spawnX: 7150,
    spawnY: 5750,
    color: "#38bdf8",
    bg: "rgba(56, 189, 248, 0.12)",
    border: "rgba(56, 189, 248, 0.3)",
  },
  {
    id: "72f7acd7-9b86-44f1-be0e-ea76cf250a00",
    name: "The Rimevault: Hold",
    tag: "❄️ Subterranean Citadel",
    biome: "Glacial Caverns",
    desc: "Monumental underground dwarf citadel amidst eternal permafrost: secret cold forge and icy gates.",
    spawnX: 7850,
    spawnY: 7750,
    color: "#a78bfa",
    bg: "rgba(167, 139, 250, 0.12)",
    border: "rgba(167, 139, 250, 0.3)",
  },
];

const DUNGEONS = [
  { id: "c6dfd629-83fc-4c63-9bb6-d33c9a0d741f", name: "Sunscar Flats", label: "☀️ Sunscar Flats" },
  { id: "b2cfc268-5928-4c51-837d-9a1cd84befd1", name: "Blackfen Sinks", label: "🕸️ Blackfen Sinks" },
  { id: "b945704f-31d1-4531-98bf-71846bbb1de8", name: "Glacier's End", label: "❄️ Glacier's End" },
  { id: "56ce6759-d3cf-43fc-84bc-92b41737de50", name: "The Rimevault: Coldforge", label: "🏛️ Coldforge" },
  { id: "2eccc8fe-9d95-4806-919f-19734065f618", name: "Frozen Ossuary Heart", label: "💀 Ossuary Heart" },
  { id: "8baed022-e5ba-4ea7-8368-3b9ef8a990dc", name: "The Sunscar Hollows: Threshold", label: "🗝️ Hollows Threshold" },
  { id: "5d435c49-95a1-418d-8d78-5803833f0b9b", name: "Ashfang Den", label: "🐺 Ashfang Den" },
];

export default function WorldBossTestPanel({ gameRef }) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('boss'); // 'boss' | 'settlements'
  const [status, setStatus] = useState(null);
  const [selectedWorldId, setSelectedWorldId] = useState('');
  const [searchTerm, setSearchTerm] = useState('');

  const { worlds = [] } = useWorlds();

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

  const filteredWorlds = useMemo(() => {
    if (!worlds || !Array.isArray(worlds)) return [];
    if (!searchTerm.trim()) return worlds;
    const q = searchTerm.toLowerCase();
    return worlds.filter((w) => {
      const name = (w.name || '').toLowerCase();
      const id = String(w.id || '').toLowerCase();
      return name.includes(q) || id.includes(q);
    });
  }, [worlds, searchTerm]);

  useEffect(() => {
    if (!selectedWorldId && worlds && worlds.length > 0) {
      setSelectedWorldId(worlds[0].id);
    }
  }, [worlds, selectedWorldId]);

  const handleTeleportToWorld = (targetId, targetName) => {
    if (!targetId) return;
    sendAction('teleport_to_world', {
      worldId: targetId,
      worldName: targetName,
    });
  };

  const handleTeleportToCoords = (targetId, targetName, x, y) => {
    if (!targetId) return;
    sendAction('teleport_to_world', {
      worldId: targetId,
      worldName: targetName,
      x,
      y,
    });
  };

  return (
    <>
      <FloatButton onClick={() => setOpen(true)} title="Open World Boss & Teleport Panel">
        <span>👹</span>
        <span>World Boss & Fast Travel</span>
      </FloatButton>

      {open && (
        <ModalBackdrop onClick={() => setOpen(false)}>
          <ModalCard onClick={(e) => e.stopPropagation()}>
            <CloseButton onClick={() => setOpen(false)}>×</CloseButton>
            <h2>👹 World Boss & Fast Travel Panel</h2>
            <p className="sub">World Boss testing and fast teleportation to settlements, outposts, and dungeons.</p>

            <TabBar>
              <TabButton
                $active={activeTab === 'boss'}
                onClick={() => setActiveTab('boss')}
              >
                <span>👹</span>
                <span>World Boss</span>
              </TabButton>
              <TabButton
                $active={activeTab === 'settlements'}
                onClick={() => setActiveTab('settlements')}
              >
                <span>🏰</span>
                <span>Settlements & Fast Travel</span>
              </TabButton>
            </TabBar>

            {activeTab === 'boss' && (
              <>
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
                    onClick={() => sendAction('spawn', { bossName: 'Ignis, the Magma Colossus' })}
                  >
                    🔥 Spawn Ignis (Fire)
                  </ActionBtn>
                  <ActionBtn
                    $bg="rgba(112, 161, 255, 0.15)"
                    $border="rgba(112, 161, 255, 0.4)"
                    $color="#70a1ff"
                    onClick={() => sendAction('spawn', { bossName: 'Glacius, the Frost Leviathan' })}
                  >
                    ❄️ Spawn Glacius (Ice)
                  </ActionBtn>
                  <ActionBtn
                    $bg="rgba(165, 94, 234, 0.15)"
                    $border="rgba(165, 94, 234, 0.4)"
                    $color="#a55eea"
                    onClick={() => sendAction('spawn', { bossName: 'Abyssor, the Voidreaver' })}
                  >
                    🔮 Spawn Abyssor (Void)
                  </ActionBtn>
                  <ActionBtn
                    $bg="rgba(236, 204, 104, 0.15)"
                    $border="rgba(236, 204, 104, 0.4)"
                    $color="#eccc68"
                    onClick={() => sendAction('spawn', { bossName: 'Gorgon, the Thunder Titan' })}
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
              </>
            )}

            {activeTab === 'settlements' && (
              <>
                <SectionTitle>🏡 Major Settlements & Villages (Hubs & Outposts)</SectionTitle>
                <div>
                  {SETTLEMENTS.map((s) => (
                    <SettlementCard key={s.id} $bg={s.bg} $border={s.border} $color={s.color}>
                      <div className="header">
                        <div className="title">
                          <span>{s.name}</span>
                        </div>
                        <span className="tag">{s.tag}</span>
                      </div>
                      <div className="desc">{s.desc}</div>
                      <div className="meta">
                        <span>📍 Spawn: [{s.spawnX}, {s.spawnY}] • {s.biome}</span>
                        <TeleportBtn
                          onClick={() => handleTeleportToCoords(s.id, s.name, s.spawnX, s.spawnY)}
                        >
                          <span>🚀</span>
                          <span>Teleport</span>
                        </TeleportBtn>
                      </div>
                    </SettlementCard>
                  ))}
                </div>

                <SectionTitle>🌋 Quick Travel: Dungeons & Regions</SectionTitle>
                <ChipContainer>
                  {DUNGEONS.map((d) => (
                    <QuickChip
                      key={d.id}
                      onClick={() => handleTeleportToWorld(d.id, d.name)}
                    >
                      <span>{d.label}</span>
                    </QuickChip>
                  ))}
                </ChipContainer>

                <SectionTitle>🔍 Custom World Teleport (Search All Worlds)</SectionTitle>
                <TeleportPanel>
                  <SearchInput
                    placeholder="🔍 Search world or dungeon by name..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />

                  <SelectBox
                    value={selectedWorldId}
                    onChange={(e) => setSelectedWorldId(e.target.value)}
                  >
                    {filteredWorlds.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </SelectBox>

                  <ActionBtn
                    $bg="linear-gradient(135deg, #0284c7 0%, #0369a1 100%)"
                    $border="rgba(56, 189, 248, 0.6)"
                    $color="#ffffff"
                    style={{ fontWeight: 800, padding: '10px 16px' }}
                    onClick={() => {
                      const target = worlds.find((w) => String(w.id) === String(selectedWorldId));
                      handleTeleportToWorld(selectedWorldId, target?.name);
                    }}
                  >
                    ✨ Teleport to Selected Location
                  </ActionBtn>
                </TeleportPanel>
              </>
            )}
          </ModalCard>
        </ModalBackdrop>
      )}
    </>
  );
}
