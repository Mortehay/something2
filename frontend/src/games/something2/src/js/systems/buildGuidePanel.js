// Layout and Canvas 2D renderer for the Build Guide window (hotkey 'U').
//
// A "Path of Building"-style reference: the game's suggested build for the
// character's class -- stats, hotbar, passive route, gear -- with a switch to FOLLOW
// it (which lights the next steps up in the Passive Tree). Same split as
// achievementsPanel.js: layout is pure (a unit test, not a frame-rate
// observation) and the draw function paints exactly what layout returns.
import { GAME_WIDTH, GAME_HEIGHT } from "../core/constants.js";
import { t as tr } from "../i18n/i18n.js";

export const BG_PANEL_W = 980;
export const BG_PANEL_H = 620;
const TITLE_H = 40;
const TAB_H = 26;
const PAD = 16;
export const LINE_H = 17;
// 12px monospace is 7.2 px per glyph; the wrap budget is computed from it so layout
// needs no canvas (and tests need no fake context).
const CHAR_W = 7.2;
// How many upcoming passive steps the Passives tab lists.
const NEXT_STEPS_SHOWN = 12;

// The row of builds the class offers (shown only when there is more than one).
const VARIANT_GAP = 6;

export const BG_TABS = [
  { key: "overview", label: "Overview" },
  { key: "hotbar", label: "Skills & Hotbar" },
  { key: "passives", label: "Passive Route" },
  { key: "gear", label: "Gear & Tips" },
];

const C = {
  title: "#fde047", head: "#7dd3fc", text: "#e2e8f0", dim: "#94a3b8", ok: "#4ade80",
  warn: "#f59e0b", next: "#fde047", bad: "#f87171",
};

// Greedy word wrap to a character budget. A word longer than the budget is split so
// nothing can overflow the panel.
export function wrapText(text, maxChars) {
  const out = [];
  const budget = Math.max(8, Math.floor(maxChars));
  for (const para of String(text ?? "").split("\n")) {
    let line = "";
    for (let word of para.split(/\s+/).filter(Boolean)) {
      while (word.length > budget) {
        if (line) { out.push(line); line = ""; }
        out.push(word.slice(0, budget));
        word = word.slice(budget);
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= budget) line += ` ${word}`;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

const kindLabel = (k) => (k && k !== "minor" ? ` (${tr(k)})` : "");

// The logical content of one tab, before wrapping: [{text, color, bold, indent}].
export function guideContent(state) {
  const {
    guide, tab = "overview", progress = null, hotbar = [], allocatedCount = 0,
    treeLoaded = false, following = false,
  } = state;
  const L = [];
  const add = (text, color = C.text, extra = {}) => L.push({ text, color, ...extra });
  const gap = () => L.push({ text: "", color: C.text });
  if (!guide) return L;

  if (tab === "overview") {
    add(tr("{name}  —  {className}", { name: tr(guide.name), className: tr(guide.className) }), C.title, { bold: true });
    add(tr(guide.summary), C.text);
    gap();
    add(tr("PLAYSTYLE"), C.head, { bold: true });
    add(tr(guide.playstyle), C.text);
    gap();
    add(tr("STAT PRIORITY"), C.head, { bold: true });
    (guide.stats || []).forEach((s, i) => add(`${i + 1}. ${tr(s.stat)} - ${tr(s.why)}`, C.text, { indent: 2 }));
    gap();
    add(tr("WHERE YOU ARE"), C.head, { bold: true });
    if (!treeLoaded) {
      add(tr("Open the Passive Tree (P) once so the route can be matched against your tree."), C.dim, { indent: 2 });
    } else if (progress) {
      add(progress.offPlan > 0 ? tr("Passive route: {done}/{total} nodes taken  ({off} off-route)", { done: progress.done, total: progress.total, off: progress.offPlan }) : tr("Passive route: {done}/{total} nodes taken", { done: progress.done, total: progress.total }), C.text, { indent: 2 });
      if (progress.complete) add(tr("Route complete."), C.ok, { indent: 2 });
      else if (progress.nextStep) {
        add(tr("Next: step {n} - {label}", { n: progress.nextIndex + 1, label: tr(progress.nextStep.label) }) + kindLabel(progress.nextStep.kind), C.next, { indent: 2 });
      }
    }
    const ms = ((guide.passives && guide.passives.milestones) || []).find((m) => allocatedCount < m.points);
    if (ms) add(tr("Next milestone at {points} points: {summary}", { points: ms.points, summary: tr(ms.summary) }), C.dim, { indent: 2 });
    gap();
    add(following
      ? tr("Following is ON: the next steps are marked in the Passive Tree (P). Use the button above to stop.")
      : tr("Press 'Follow this build' above to mark the next steps in the Passive Tree (P)."), following ? C.ok : C.dim);
  } else if (tab === "hotbar") {
    add(tr("HOTBAR - 9 SLOTS"), C.head, { bold: true });
    for (const h of hotbar) {
      add(`[${h.slot}] ${tr(h.name)}   ${h.owned ? tr("learned") : tr("not yet")}`, h.owned ? C.ok : C.text, { bold: true });
      add(tr(h.unlock), C.warn, { indent: 4 });
      add(tr(h.why), C.dim, { indent: 4 });
    }
    if ((guide.earlySkills || []).length > 0) {
      gap();
      add(tr("LEARN THESE FIRST"), C.head, { bold: true });
      for (const e of guide.earlySkills) add(tr("Lv {level}  {name} - {note}", { level: e.level, name: tr(e.name), note: tr(e.note) }), C.text, { indent: 2 });
    }
  } else if (tab === "passives") {
    add(tr("PASSIVE ROUTE"), C.head, { bold: true });
    if (!treeLoaded || !progress) {
      add(tr("Open the Passive Tree (P) once so the route can be matched against your tree."), C.dim);
    } else {
      add(progress.offPlan > 0 ? tr("{done}/{total} nodes taken, {off} off-route", { done: progress.done, total: progress.total, off: progress.offPlan }) : tr("{done}/{total} nodes taken", { done: progress.done, total: progress.total }), C.text);
      gap();
      if (progress.complete) {
        add(tr("Route complete."), C.ok);
      } else {
        add(tr("NEXT STEPS"), C.head, { bold: true });
        const steps = progress.upcomingSteps || [];
        steps.slice(0, NEXT_STEPS_SHOWN).forEach((s, i) => {
          add(`${i === 0 ? ">" : " "} ${s.n}. ${tr(s.label)}${kindLabel(s.kind)}`, i === 0 ? C.next : C.text, { indent: 2 });
        });
        if (progress.detour) add(tr("Your tree has moved off the route: take the highlighted node first to get back on it."), C.warn);
      }
    }
    gap();
    add(tr("KEY NODES"), C.head, { bold: true });
    for (const k of (guide.passives && guide.passives.keystones) || []) {
      const taken = progress && progress.takenKeys ? progress.takenKeys.has(k.key) : false;
      add(`${taken ? "[x]" : "[ ]"} ` + tr("{label} - step {n}", { label: tr(k.label), n: k.atStep }), taken ? C.ok : C.text, { bold: true, indent: 2 });
      add(tr(k.note), C.dim, { indent: 6 });
    }
    gap();
    add(tr("MILESTONES"), C.head, { bold: true });
    for (const m of (guide.passives && guide.passives.milestones) || []) {
      add(`${allocatedCount >= m.points ? "[x]" : "[ ]"} ` + tr("{points} points: {summary}", { points: m.points, summary: tr(m.summary) }),
        allocatedCount >= m.points ? C.ok : C.text, { indent: 2 });
    }
  } else if (tab === "gear") {
    add(tr("GEAR"), C.head, { bold: true });
    for (const g of guide.gear || []) add(`- ${tr(g)}`, C.text, { indent: 2 });
    gap();
    add(tr("WEAKNESSES & HOW TO PLAY AROUND THEM"), C.head, { bold: true });
    for (const w of guide.weaknesses || []) add(`- ${tr(w)}`, C.text, { indent: 2 });
  }
  return L;
}

// Wraps content to the panel width and positions it for the scroll offset.
export function layoutBuildGuide(state = {}) {
  const { tab: tabIn = "overview", scroll = 0, following = false, guide = null, variants = [] } = state;
  const tab = BG_TABS.some((t) => t.key === tabIn) ? tabIn : "overview";
  const px = (GAME_WIDTH - BG_PANEL_W) / 2;
  const py = (GAME_HEIGHT - BG_PANEL_H) / 2;
  const panel = { x: px, y: py, w: BG_PANEL_W, h: BG_PANEL_H };
  const titleBar = { x: px, y: py, w: BG_PANEL_W, h: TITLE_H };
  const close = { x: px + BG_PANEL_W - 32, y: py + 8, w: 24, h: 24 };
  const follow = { x: px + BG_PANEL_W - 32 - 8 - 220, y: py + 7, w: 220, h: 26, on: Boolean(following) };
  const hitAreas = [{ ...close, kind: "bgclose" }];
  if (guide) hitAreas.push({ ...follow, kind: "bgfollow" });

  // One button per build of the class, above the section tabs; the rest of the window moves down to make room.
  const hasVariants = Array.isArray(variants) && variants.length > 1;
  const variantY = py + TITLE_H + 8;
  const variantTabs = [];
  if (hasVariants) {
    const vw = Math.floor((BG_PANEL_W - PAD * 2 - 4 * (variants.length - 1)) / variants.length);
    variants.forEach((v, i) => {
      const vt = {
        x: px + PAD + i * (vw + 4), y: variantY, w: vw, h: TAB_H,
        kind: "bgvariant", id: v.id, label: tr(v.name), selected: Boolean(v.selected),
      };
      hitAreas.push(vt);
      variantTabs.push(vt);
    });
  }
  const shift = hasVariants ? TAB_H + VARIANT_GAP : 0;

  const tabW = Math.floor((BG_PANEL_W - PAD * 2 - 4 * (BG_TABS.length - 1)) / BG_TABS.length);
  const tabs = BG_TABS.map((def, i) => {
    const t = {
      x: px + PAD + i * (tabW + 4), y: py + TITLE_H + 10 + shift, w: tabW, h: TAB_H,
      kind: "bgtab", tab: def.key, label: tr(def.label), selected: def.key === tab,
    };
    hitAreas.push(t);
    return t;
  });

  const area = {
    x: px + PAD, y: py + TITLE_H + 10 + shift + TAB_H + 10, w: BG_PANEL_W - PAD * 2,
    h: BG_PANEL_H - TITLE_H - 10 - shift - TAB_H - 10 - PAD,
  };

  const content = guideContent({ ...state, tab });
  const lines = [];
  for (const item of content) {
    const indent = item.indent || 0;
    const chars = (area.w - 14 - indent * CHAR_W) / CHAR_W;
    const wrapped = item.text === "" ? [""] : wrapText(item.text, chars);
    wrapped.forEach((text) => lines.push({
      text, color: item.color, bold: Boolean(item.bold),
      x: area.x + indent * CHAR_W,
    }));
  }
  const totalH = lines.length * LINE_H;
  const maxScroll = Math.max(0, totalH - area.h);
  const scrollY = Math.max(0, Math.min(maxScroll, Number(scroll) || 0));
  const rows = [];
  lines.forEach((ln, i) => {
    const y = area.y + i * LINE_H - scrollY;
    if (y + LINE_H < area.y || y > area.y + area.h) return;
    rows.push({ ...ln, y });
  });

  return {
    panel, title: titleBar, close, follow, tabs, variantTabs, tab, area, rows, lines,
    totalH, maxScroll, scrollY, hitAreas, hasGuide: Boolean(guide),
    headerText: guide ? tr("Build Guide  -  {className}: {name}", { className: tr(guide.className), name: tr(guide.name) }) : tr("Build Guide"),
  };
}

function roundRect(ctx, x, y, w, h, r = 0) {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

export function drawBuildGuide(ctx, layout) {
  if (!layout) return;
  const { panel, title, close, follow, tabs, variantTabs = [], area, rows, maxScroll, scrollY, totalH, hasGuide } = layout;
  ctx.save();
  ctx.textBaseline = "top";

  roundRect(ctx, panel.x, panel.y, panel.w, panel.h, 14);
  ctx.fillStyle = "rgba(15, 15, 26, 0.96)";
  ctx.fill();
  ctx.strokeStyle = "#2e2e3e";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  roundRect(ctx, title.x, title.y, title.w, title.h, [14, 14, 0, 0]);
  ctx.fillStyle = "rgba(22, 22, 38, 0.98)";
  ctx.fill();
  ctx.fillStyle = C.title;
  ctx.font = "bold 14px monospace";
  ctx.fillText(layout.headerText, title.x + 16, title.y + 12);

  ctx.fillStyle = "#94a3b8";
  ctx.fillText("✕", close.x + 6, close.y + 5);

  if (hasGuide) {
    roundRect(ctx, follow.x, follow.y, follow.w, follow.h, 6);
    ctx.fillStyle = follow.on ? "rgba(74, 222, 128, 0.18)" : "rgba(255,255,255,0.06)";
    ctx.fill();
    ctx.strokeStyle = follow.on ? C.ok : "#475569";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.font = "bold 12px monospace";
    ctx.fillStyle = follow.on ? C.ok : "#cbd5e1";
    const label = follow.on ? tr("Following this build: ON") : tr("Follow this build: OFF");
    ctx.fillText(label, follow.x + (follow.w - ctx.measureText(label).width) / 2, follow.y + 7);
  }

  // The builds of the class: gold, so they read as a different level from the section tabs below them.
  ctx.font = "bold 12px monospace";
  for (const v of variantTabs) {
    roundRect(ctx, v.x, v.y, v.w, v.h, 6);
    ctx.fillStyle = v.selected ? "rgba(253, 224, 71, 0.18)" : "rgba(255,255,255,0.05)";
    ctx.fill();
    ctx.strokeStyle = v.selected ? C.title : "#2e2e3e";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = v.selected ? C.title : "#cbd5e1";
    const label = v.label.length > 34 ? `${v.label.slice(0, 33)}…` : v.label;
    ctx.fillText(label, v.x + (v.w - ctx.measureText(label).width) / 2, v.y + 8);
  }

  ctx.font = "12px monospace";
  for (const t of tabs) {
    roundRect(ctx, t.x, t.y, t.w, t.h, 6);
    ctx.fillStyle = t.selected ? "rgba(125, 211, 252, 0.16)" : "rgba(255,255,255,0.05)";
    ctx.fill();
    ctx.strokeStyle = t.selected ? C.head : "#2e2e3e";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = t.selected ? C.head : "#cbd5e1";
    ctx.fillText(t.label, t.x + (t.w - ctx.measureText(t.label).width) / 2, t.y + 8);
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(area.x, area.y, area.w, area.h);
  ctx.clip();
  if (!hasGuide) {
    ctx.font = "13px monospace";
    ctx.fillStyle = C.dim;
    ctx.fillText(tr("There is no suggested build for this class yet."), area.x + 4, area.y + 6);
  }
  for (const r of rows) {
    ctx.font = `${r.bold ? "bold " : ""}12px monospace`;
    ctx.fillStyle = r.color;
    ctx.fillText(r.text, r.x, r.y + 2);
  }
  ctx.restore();

  if (maxScroll > 0) {
    const thumbH = Math.max(24, area.h * (area.h / totalH));
    const thumbY = area.y + (area.h - thumbH) * (scrollY / maxScroll);
    roundRect(ctx, area.x + area.w - 5, thumbY, 4, thumbH, 2);
    ctx.fillStyle = "rgba(148, 163, 184, 0.5)";
    ctx.fill();
    ctx.font = "10px monospace";
    ctx.fillStyle = "#64748b";
    ctx.fillText(tr("scroll: mouse wheel"), panel.x + panel.w - 150, panel.y + panel.h - 14);
  }
  ctx.restore();
}
