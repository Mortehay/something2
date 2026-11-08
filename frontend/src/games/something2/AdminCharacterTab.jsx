import { useEffect, useMemo, useState } from 'react';
import styled from 'styled-components';
import { useItemTypes } from './useMaps.js';
import {
  GOLD_PRESETS, LEVEL_PRESETS, XP_PRESETS, RARITY_OPTIONS,
  goldAction, levelAction, xpAction, pointsAction, restoreAction, itemAction,
  isGearCategory, filterItems, logLine,
} from './adminMenuActions.js';

// The "Character" tab of the in-game admin panel: gold, level, xp, passive points, a full restore
// and an item at your feet. Everything goes to the server's debugAdmin handler (admin only there);
// its answer comes back through game.setOnAdminResult and is kept in a short log, so the menu
// says what actually happened (capped values included) instead of leaving you to guess.
//
// The panel is a dark overlay on the dark game canvas, like the rest of WorldBossTestPanel, so its
// colours are the panel's own (s2-theme-exempt) rather than the app theme.

const Section = styled.h3`
  margin: 16px 0 8px; font-size: 0.95rem; color: #e2e8f0; /* s2-theme-exempt(#e2e8f0): admin overlay on the dark canvas */
`;
const Row = styled.div`display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px;`;
const Input = styled.input`
  background: rgba(0, 0, 0, 0.35); /* s2-theme-exempt(rgba(0,0,0,0.35)): admin overlay */
  border: 1px solid rgba(255, 255, 255, 0.18); /* s2-theme-exempt(rgba(255,255,255,0.18)): admin overlay */
  color: #f8fafc; /* s2-theme-exempt(#f8fafc): admin overlay */
  border-radius: 6px; padding: 7px 10px; width: ${(p) => p.$w || '120px'};
`;
const Select = styled.select`
  background: rgba(0, 0, 0, 0.35); /* s2-theme-exempt(rgba(0,0,0,0.35)): admin overlay */
  border: 1px solid rgba(255, 255, 255, 0.18); /* s2-theme-exempt(rgba(255,255,255,0.18)): admin overlay */
  color: #f8fafc; /* s2-theme-exempt(#f8fafc): admin overlay */
  border-radius: 6px; padding: 7px 10px; max-width: 100%;
`;
const Btn = styled.button`
  background: ${(p) => p.$bg || 'rgba(56, 189, 248, 0.15)'}; /* s2-theme-exempt(rgba(56,189,248,0.15)): admin overlay */
  border: 1px solid ${(p) => p.$border || 'rgba(56, 189, 248, 0.45)'}; /* s2-theme-exempt(rgba(56,189,248,0.45)): admin overlay */
  color: ${(p) => p.$color || '#7dd3fc'}; /* s2-theme-exempt(#7dd3fc): admin overlay */
  border-radius: 8px; padding: 7px 12px; font-size: 0.82rem; font-weight: 600; cursor: pointer;
  &:hover { filter: brightness(1.25); }
`;
const Log = styled.ul`
  list-style: none; margin: 14px 0 0; padding: 8px 10px; max-height: 150px; overflow-y: auto;
  background: rgba(0, 0, 0, 0.4); /* s2-theme-exempt(rgba(0,0,0,0.4)): admin overlay */
  border-radius: 8px; font-size: 0.8rem; font-family: ui-monospace, monospace;
  li { padding: 2px 0; }
  li.ok { color: #86efac; } /* s2-theme-exempt(#86efac): admin overlay */
  li.bad { color: #fca5a5; } /* s2-theme-exempt(#fca5a5): admin overlay */
`;

const fmt = (n) => n.toLocaleString('en-US');

export default function AdminCharacterTab({ gameRef }) {
  const [gold, setGold] = useState('1000000');
  const [level, setLevel] = useState('50');
  const [xp, setXp] = useState('100000');
  const [points, setPoints] = useState('10');
  const [query, setQuery] = useState('');
  const [itemId, setItemId] = useState('');
  const [rarity, setRarity] = useState('foxy');
  const [itemLevel, setItemLevel] = useState('100');
  const [qty, setQty] = useState('1');
  const [log, setLog] = useState([]);

  const { itemTypes } = useItemTypes();
  const shown = useMemo(() => filterItems(itemTypes, query), [itemTypes, query]);
  const picked = useMemo(
    () => (itemTypes || []).find((t) => String(t.id) === String(itemId)) || null,
    [itemTypes, itemId],
  );
  const gear = picked ? isGearCategory(picked.category) : false;

  const say = (entry) => setLog((l) => [entry, ...l].slice(0, 12));

  // The server's answers land here for as long as the tab is open.
  useEffect(() => {
    const g = gameRef.current;
    if (!g || !g.setOnAdminResult) return undefined;
    g.setOnAdminResult((msg) => say(logLine(msg)));
    return () => g.setOnAdminResult(null);
  }, [gameRef]);

  const run = (built) => {
    if (built.error) { say({ ok: false, text: built.error }); return; }
    const g = gameRef.current;
    if (!g || !g.debugAdmin || !g.debugAdmin(built.action, built.opts)) {
      say({ ok: false, text: 'not connected to a world' });
    }
  };

  return (
    <>
      <Section>💰 Gold</Section>
      <Row>
        <Input value={gold} onChange={(e) => setGold(e.target.value)} aria-label="Gold amount" />
        <Btn onClick={() => run(goldAction(gold))}>Give gold</Btn>
        {GOLD_PRESETS.map((n) => (
          <Btn key={n} $bg="rgba(250, 204, 21, 0.12)" $border="rgba(250, 204, 21, 0.4)" $color="#fde047" onClick={() => run(goldAction(n))}>
            +{fmt(n)}
          </Btn>
        ))}
      </Row>

      <Section>⭐ Level, XP & passive points</Section>
      <Row>
        <Input value={level} onChange={(e) => setLevel(e.target.value)} aria-label="Level" $w="90px" />
        <Btn onClick={() => run(levelAction(level))}>Set level</Btn>
        {LEVEL_PRESETS.map((n) => (
          <Btn key={n} $bg="rgba(167, 139, 250, 0.14)" $border="rgba(167, 139, 250, 0.4)" $color="#c4b5fd" onClick={() => run(levelAction(n))}>
            Lv {n}
          </Btn>
        ))}
      </Row>
      <Row>
        <Input value={xp} onChange={(e) => setXp(e.target.value)} aria-label="XP amount" />
        <Btn onClick={() => run(xpAction(xp))}>Give XP</Btn>
        {XP_PRESETS.map((n) => (
          <Btn key={n} $bg="rgba(167, 139, 250, 0.14)" $border="rgba(167, 139, 250, 0.4)" $color="#c4b5fd" onClick={() => run(xpAction(n))}>
            +{fmt(n)}
          </Btn>
        ))}
      </Row>
      <Row>
        <Input value={points} onChange={(e) => setPoints(e.target.value)} aria-label="Passive points" $w="90px" />
        <Btn onClick={() => run(pointsAction(points))}>Give passive points</Btn>
      </Row>

      <Section>❤️ Restore</Section>
      <Row>
        <Btn $bg="rgba(74, 222, 128, 0.14)" $border="rgba(74, 222, 128, 0.4)" $color="#86efac" onClick={() => run(restoreAction())}>
          Full HP, mana & stamina
        </Btn>
      </Row>

      <Section>🎒 Item at your feet</Section>
      <Row>
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name or category…" $w="220px" aria-label="Search items" />
        <Select value={itemId} onChange={(e) => setItemId(e.target.value)} aria-label="Item">
          <option value="">— pick an item ({shown.length}{shown.length === 200 ? '+' : ''}) —</option>
          {shown.map((t) => (
            <option key={t.id} value={t.id}>{t.name} · {t.category}</option>
          ))}
        </Select>
      </Row>
      <Row>
        {gear ? (
          <Select value={rarity} onChange={(e) => setRarity(e.target.value)} aria-label="Rarity">
            {RARITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        ) : (
          <>
            <span style={{ color: '#94a3b8' }}>Quantity</span> {/* s2-theme-exempt(#94a3b8): admin overlay */}
            <Input value={qty} onChange={(e) => setQty(e.target.value)} aria-label="Quantity" $w="80px" />
          </>
        )}
        <span style={{ color: '#94a3b8' }}>Item level</span> {/* s2-theme-exempt(#94a3b8): admin overlay */}
        <Input value={itemLevel} onChange={(e) => setItemLevel(e.target.value)} aria-label="Item level" $w="80px" />
        <Btn
          onClick={() => run(itemAction({ itemTypeId: itemId, rarity: gear ? rarity : 'white', level: itemLevel, quantity: gear ? 1 : qty }))}
        >
          Drop item
        </Btn>
      </Row>

      <Log aria-label="Admin log">
        {log.length === 0 && <li>Nothing yet — every action reports what it did here.</li>}
        {log.map((l, i) => <li key={i} className={l.ok ? 'ok' : 'bad'}>{l.ok ? '✓' : '✗'} {l.text}</li>)}
      </Log>
    </>
  );
}
