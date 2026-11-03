// frontend/src/games/something2/src/js/systems/achievementsPanel.js
//
// Pure layout and Canvas 2D renderer for the Achievements journal (hotkey 'H').

import { GAME_WIDTH, GAME_HEIGHT } from "../core/constants.js";
import { t as tr } from "../i18n/i18n.js";

export const ACH_PANEL_W = 640;
export const ACH_PANEL_H = 520;
const TITLE_H = 40;
const TAB_H = 24;
export const ACH_ROW_H = 62;
const TITLE_ROW_H = 40;
const ROW_GAP = 6;

export const ACH_TABS = [
  { key: "all", label: "All" },
  { key: "combat", label: "Combat" },
  { key: "exploration", label: "Exploration" },
  { key: "quests", label: "Quests" },
  { key: "progression", label: "Progression" },
  { key: "skills", label: "Skills" },
  { key: "titles", label: "Titles" },
];

export function achProgress(a) {
  const target = Number(a && a.target) || 0;
  if (a && a.unlocked) return 1;
  if (target <= 0) return 0;
  return Math.max(0, Math.min(Number(a.counter) || 0, target) / target);
}

export function filterAchievements(list, tab) {
  const all = Array.isArray(list) ? list : [];
  if (tab === "all") return all.slice();
  return all.filter((a) => a.category === tab);
}

// Unlocked first, then closest to done; name keeps the order stable.
export function sortAchievements(list) {
  return list.slice().sort((a, b) => {
    if (!!a.unlocked !== !!b.unlocked) return a.unlocked ? -1 : 1;
    const d = achProgress(b) - achProgress(a);
    if (d !== 0) return d;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
}

export function formatUnlockDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

export function layoutAchievementsPanel(state = {}) {
  const {
    achievements = [], titles = [], activeTitle = null, tab: tabIn = "all", scroll = 0,
  } = state;
  const tab = ACH_TABS.some((t) => t.key === tabIn) ? tabIn : "all";
  const px = (GAME_WIDTH - ACH_PANEL_W) / 2;
  const py = (GAME_HEIGHT - ACH_PANEL_H) / 2;
  const panel = { x: px, y: py, w: ACH_PANEL_W, h: ACH_PANEL_H };
  const titleBar = { x: px, y: py, w: ACH_PANEL_W, h: TITLE_H };
  const close = { x: px + ACH_PANEL_W - 32, y: py + 8, w: 24, h: 24 };
  const hitAreas = [{ ...close, kind: "achclose", id: null }];

  const list = Array.isArray(achievements) ? achievements : [];
  const unlockedCount = list.filter((a) => a.unlocked).length;
  const headerText = tr("🏆 Achievements  {done}/{total}", { done: unlockedCount, total: list.length });

  const tabs = [];
  const tabW = Math.floor((ACH_PANEL_W - 28 - 4 * (ACH_TABS.length - 1)) / ACH_TABS.length);
  ACH_TABS.forEach((def, i) => {
    const count = def.key === "titles" ? (titles || []).length : filterAchievements(list, def.key).length;
    const t = {
      x: px + 14 + i * (tabW + 4), y: py + TITLE_H + 10, w: tabW, h: TAB_H,
      kind: "achtab", tab: def.key, label: tr(def.label), count, selected: def.key === tab,
    };
    tabs.push(t);
    hitAreas.push(t);
  });

  const listArea = {
    x: px + 14, y: py + TITLE_H + 10 + TAB_H + 8, w: ACH_PANEL_W - 28,
    h: ACH_PANEL_H - TITLE_H - 10 - TAB_H - 8 - 14,
  };

  // Achievement rows or title entries, as one flat scrollable column.
  let items;
  if (tab === "titles") {
    items = [{ title: null, label: tr("No title"), sourceName: tr("Clear your title"), active: activeTitle == null }];
    for (const t of titles || []) {
      items.push({
        title: t.title, label: tr(t.title), source: t.source,
        sourceName: t.source === "quest" ? tr("Quest: {name}", { name: tr(t.sourceName) }) : tr("Achievement: {name}", { name: tr(t.sourceName) }),
        active: t.title === activeTitle,
      });
    }
  } else {
    items = sortAchievements(filterAchievements(list, tab));
  }

  const rowH = tab === "titles" ? TITLE_ROW_H : ACH_ROW_H;
  const totalH = items.length ? items.length * (rowH + ROW_GAP) - ROW_GAP : 0;
  const maxScroll = Math.max(0, totalH - listArea.h);
  const scrollY = Math.max(0, Math.min(maxScroll, Number(scroll) || 0));

  const rows = [];
  items.forEach((it, i) => {
    const y = listArea.y + i * (rowH + ROW_GAP) - scrollY;
    if (y + rowH < listArea.y || y > listArea.y + listArea.h) return; // off-screen
    const rect = { x: listArea.x, y, w: listArea.w - 8, h: rowH };
    const r = tab === "titles"
      ? { ...rect, kind: "achtitle", title: it.title, item: it }
      : { ...rect, kind: "achrow", key: it.key, item: it, progress: achProgress(it) };
    rows.push(r);
    // The hit area is clipped to the visible list so a half-hidden row can't be hit outside it.
    const cy = Math.max(y, listArea.y);
    const cb = Math.min(y + rowH, listArea.y + listArea.h);
    hitAreas.push({ ...r, y: cy, h: cb - cy });
  });

  return {
    panel, title: titleBar, close, headerText, tabs, tab, listArea, items, rows,
    totalH, maxScroll, scrollY, activeTitle, hitAreas, empty: items.length === 0,
  };
}

function truncateText(ctx, text, maxWidth) {
  const s0 = String(text ?? "");
  if (ctx.measureText(s0).width <= maxWidth) return s0;
  let s = s0;
  while (s.length > 0 && ctx.measureText(s + "…").width > maxWidth) s = s.slice(0, -1);
  return s + "…";
}

function roundRect(ctx, x, y, w, h, r = 0) {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

export function drawAchievementsPanel(ctx, layout) {
  if (!layout) return;
  const { panel, title, close, headerText, tabs, listArea, rows, tab, maxScroll, scrollY, totalH, empty } = layout;
  ctx.save();
  ctx.textBaseline = "top";

  roundRect(ctx, panel.x, panel.y, panel.w, panel.h, 14);
  ctx.fillStyle = "rgba(15, 15, 26, 0.95)";
  ctx.fill();
  ctx.strokeStyle = "#2e2e3e";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  roundRect(ctx, title.x, title.y, title.w, title.h, [14, 14, 0, 0]);
  ctx.fillStyle = "rgba(22, 22, 38, 0.98)";
  ctx.fill();
  ctx.fillStyle = "#fde047";
  ctx.font = "bold 14px monospace";
  ctx.fillText(headerText, title.x + 16, title.y + 11);

  ctx.fillStyle = "#94a3b8";
  ctx.font = "bold 14px monospace";
  ctx.fillText("✕", close.x + 6, close.y + 5);

  ctx.font = "11px monospace";
  for (const t of tabs) {
    roundRect(ctx, t.x, t.y, t.w, t.h, 6);
    ctx.fillStyle = t.selected ? "rgba(250, 204, 21, 0.18)" : "rgba(255,255,255,0.05)";
    ctx.fill();
    ctx.strokeStyle = t.selected ? "#facc15" : "#2e2e3e";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = t.selected ? "#fde047" : "#cbd5e1";
    const label = truncateText(ctx, t.label, t.w - 6);
    ctx.fillText(label, t.x + (t.w - ctx.measureText(label).width) / 2, t.y + 7);
  }

  // Clip the list so scrolled rows do not bleed over the tabs / panel edge.
  ctx.save();
  ctx.beginPath();
  ctx.rect(listArea.x, listArea.y, listArea.w, listArea.h);
  ctx.clip();

  for (const r of rows) {
    if (r.kind === "achtitle") {
      const it = r.item;
      roundRect(ctx, r.x, r.y, r.w, r.h, 8);
      ctx.fillStyle = it.active ? "rgba(250, 204, 21, 0.16)" : "rgba(255,255,255,0.04)";
      ctx.fill();
      ctx.strokeStyle = it.active ? "#facc15" : "#2e2e3e";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.font = it.title ? "italic bold 13px monospace" : "13px monospace";
      ctx.fillStyle = it.title ? "#fde047" : "#94a3b8";
      ctx.fillText(truncateText(ctx, (it.active ? "▶ " : "") + it.label, r.w - 24), r.x + 12, r.y + 6);
      ctx.font = "10px monospace";
      ctx.fillStyle = "#94a3b8";
      ctx.fillText(truncateText(ctx, it.sourceName, r.w - 24), r.x + 12, r.y + 24);
      continue;
    }
    const a = r.item;
    roundRect(ctx, r.x, r.y, r.w, r.h, 8);
    ctx.fillStyle = a.unlocked ? "rgba(250, 204, 21, 0.08)" : "rgba(255,255,255,0.04)";
    ctx.fill();
    ctx.strokeStyle = a.unlocked ? "rgba(250, 204, 21, 0.45)" : "#2e2e3e";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.font = "26px sans-serif";
    ctx.globalAlpha = a.unlocked ? 1 : 0.45;
    ctx.fillStyle = "#fff";
    ctx.fillText(a.icon || "🏆", r.x + 10, r.y + 16);
    ctx.globalAlpha = 1;

    const tx = r.x + 54;
    const tw = r.w - 54 - 12;
    ctx.font = "bold 13px monospace";
    ctx.fillStyle = a.unlocked ? "#fde047" : "#e2e8f0";
    const nameStr = truncateText(ctx, tr(a.name || a.key), tw - (a.title ? 150 : 0));
    ctx.fillText(nameStr, tx, r.y + 6);
    const nameW = ctx.measureText(nameStr).width;

    if (a.title) {
      ctx.font = "italic 10px monospace";
      const tag = truncateText(ctx, `« ${tr(a.title)} »`, 140);
      const tagW = ctx.measureText(tag).width;
      roundRect(ctx, tx + nameW + 8, r.y + 5, tagW + 10, 16, 8);
      ctx.fillStyle = "rgba(250, 204, 21, 0.14)";
      ctx.fill();
      ctx.fillStyle = a.unlocked ? "#fde047" : "#a8a29e";
      ctx.fillText(tag, tx + nameW + 13, r.y + 8);
    }

    ctx.font = "10px monospace";
    ctx.fillStyle = "#94a3b8";
    ctx.fillText(truncateText(ctx, tr(a.description || ""), tw), tx, r.y + 24);

    const barW = tw - 140;
    const by = r.y + 42;
    roundRect(ctx, tx, by, barW, 8, 4);
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fill();
    if (r.progress > 0) {
      roundRect(ctx, tx, by, Math.max(4, barW * r.progress), 8, 4);
      ctx.fillStyle = a.unlocked ? "#facc15" : "#38bdf8";
      ctx.fill();
    }
    ctx.font = "10px monospace";
    const shown = a.unlocked ? a.target : Math.min(Number(a.counter) || 0, Number(a.target) || 0);
    ctx.fillStyle = "#cbd5e1";
    ctx.fillText(`${shown}/${a.target}`, tx + barW + 8, by - 1);
    if (a.unlocked) {
      ctx.fillStyle = "#facc15";
      ctx.fillText(`✔ ${formatUnlockDate(a.unlockedAt)}`.trim(), tx + barW + 8 + 58, by - 1);
    }
  }

  if (empty) {
    ctx.font = "12px monospace";
    ctx.fillStyle = "#64748b";
    ctx.fillText(tab === "titles" ? tr("No titles earned yet.") : tr("Nothing here yet."), listArea.x + 8, listArea.y + 8);
  }
  ctx.restore();

  if (maxScroll > 0) {
    const thumbH = Math.max(24, listArea.h * (listArea.h / totalH));
    const thumbY = listArea.y + (listArea.h - thumbH) * (scrollY / maxScroll);
    roundRect(ctx, listArea.x + listArea.w - 5, thumbY, 4, thumbH, 2);
    ctx.fillStyle = "rgba(148, 163, 184, 0.5)";
    ctx.fill();
  }
  ctx.restore();
}
