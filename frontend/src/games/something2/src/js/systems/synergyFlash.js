// Skill-synergy flash: a gold "SHATTER x1.30" and a cyan "Chain x2 (+12%)" that
// rise and fade above the skill bar. layoutSynergyFlash is pure; drawSynergyFlash paints.
import { GAME_WIDTH, GAME_HEIGHT } from "../core/constants.js";
import { t as tr } from "../i18n/i18n.js";

export const SYNERGY_FLASH_MS = 1800;
const BASE_Y = GAME_HEIGHT - 150; // above the skill bar + its form badge
const RISE_PX = 28;

export function layoutSynergyFlash(fx, now) {
  if (!fx || !Number.isFinite(fx.at)) return null;
  const age = now - fx.at;
  if (age < 0 || age >= SYNERGY_FLASH_MS) return null;
  const t = age / SYNERGY_FLASH_MS;
  const alpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
  const chain = Math.max(0, Math.min(3, Math.floor(Number(fx.chain) || 0)));
  const hasName = typeof fx.name === "string" && fx.name.length > 0;
  if (!hasName && chain <= 0) return null;
  const x = Math.round(GAME_WIDTH / 2);
  const y = Math.round(BASE_Y - RISE_PX * t);
  return {
    x, y, alpha, t,
    title: hasName ? `${tr(fx.name).toUpperCase()} x${Number(fx.mult).toFixed(2)}` : null,
    chainText: chain > 0 ? tr("Chain x{n} (+{pct}%)", { n: chain, pct: chain * 6 }) : null,
    chainY: y + (hasName ? 22 : 0),
    ringR: 20 + 50 * Math.min(1, t / 0.4),
    ringAlpha: Math.max(0, 1 - t / 0.4),
  };
}

export function drawSynergyFlash(ctx, fx, now) {
  const L = layoutSynergyFlash(fx, now);
  if (!ctx || !L) return null;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (L.title) {
    if (L.ringAlpha > 0) {
      ctx.globalAlpha = L.ringAlpha * 0.6;
      ctx.strokeStyle = "#fcd34d";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(L.x, L.y, L.ringR * 2, L.ringR * 0.5, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = L.alpha;
    ctx.font = "bold 26px sans-serif";
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(20, 10, 0, 0.85)";
    ctx.strokeText(L.title, L.x, L.y);
    ctx.fillStyle = "#fbbf24";
    ctx.fillText(L.title, L.x, L.y);
    const w = ctx.measureText(L.title).width;
    ctx.fillStyle = "#fde68a";
    ctx.fillRect(L.x - w / 2, L.y + 14, w * Math.min(1, L.t / 0.2), 2);
  }
  if (L.chainText) {
    ctx.globalAlpha = L.alpha;
    ctx.font = "bold 15px sans-serif";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0, 20, 30, 0.85)";
    ctx.strokeText(L.chainText, L.x, L.chainY);
    ctx.fillStyle = "#22d3ee";
    ctx.fillText(L.chainText, L.x, L.chainY);
  }
  ctx.restore();
  return L;
}
