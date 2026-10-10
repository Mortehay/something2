// SOMET-606 (S4). Client reading of the OWN state frame's aura fields
// (backend world.js selfAuraFields). Pure and canvas-free so vitest can pin it;
// Game.js assigns the results every frame (the server omits both fields when
// clear, so a guarded assignment would leave a stale slow / stale icon).
import { elementColor } from "./blasts.js";

const DOT_ICON = { fire: "🔥", ice: "❄️", lightning: "⚡", arcane: "🔮", physical: "🩸" };

export function selfSpeedMult(msg) {
  const v = msg && msg.speedMult;
  return Number.isFinite(v) && v > 0 ? v : 1;
}

export function prettyAuraName(name) {
  return String(name || "")
    .split(/[_\s]+/).filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

const pct = (m) => Math.round((1 - m) * 100);

export function debuffHudEntries(debuffs) {
  if (!Array.isArray(debuffs) || debuffs.length === 0) return [];
  return debuffs.map((d) => {
    const parts = [];
    if (d.s < 1) parts.push(`-${pct(d.s)}% spd`);
    if (d.d < 1) parts.push(`-${pct(d.d)}% dmg`);
    if (d.f < 1) parts.push(`-${pct(d.f)}% def`);
    if (d.dps > 0) parts.push(`${Math.round(d.dps * 10) / 10} ${d.el || "physical"}/s`);
    return {
      id: `aura:${d.n}`,
      nameEn: prettyAuraName(d.n),
      icon: d.dps > 0 ? (DOT_ICON[d.el] || "🩸") : "☠️",
      iconColor: d.dps > 0 ? elementColor(d.el || "physical") : "#a855f7",
      persistent: true,
      detail: parts.join(" "),
    };
  });
}
