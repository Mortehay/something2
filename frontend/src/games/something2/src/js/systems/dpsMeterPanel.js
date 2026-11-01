// Training-dummy DPS meter: a compact panel on the game canvas.
// layoutDpsMeter is pure (state + clock -> lines or null); drawDpsMeter paints it.
import { GAME_WIDTH } from "../core/constants.js";

export const DPS_VISIBLE_MS = 8000;
export const DPS_IDLE_MS = 1500;
const PANEL_W = 230;
const PANEL_H = 84;
const PANEL_Y = 64; // below the top-row HUD, clear of the left quest tracker

const fmtInt = (n) => Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");

export function layoutDpsMeter(meter, now) {
  if (!meter || !Number.isFinite(meter.at)) return null;
  const age = now - meter.at;
  if (age >= DPS_VISIBLE_MS) return null;
  const idle = age >= DPS_IDLE_MS;
  const secs = Number(meter.secs) || 0;
  return {
    x: Math.round((GAME_WIDTH - PANEL_W) / 2),
    y: PANEL_Y,
    w: PANEL_W,
    h: PANEL_H,
    idle,
    title: idle ? "\uD83C\uDFAF Training Dummy (idle)" : "\uD83C\uDFAF Training Dummy",
    big: `DPS ${fmtInt(meter.dps)}`,
    line1: `Avg ${fmtInt(meter.avg)} \u00b7 Max hit ${fmtInt(meter.max)}`,
    line2: `Total ${fmtInt(meter.total)} in ${secs.toFixed(1)}s \u00b7 ${fmtInt(meter.hits)} hits`,
  };
}

export function drawDpsMeter(ctx, meter, now) {
  const L = layoutDpsMeter(meter, now);
  if (!ctx || !L) return null;
  ctx.save();
  ctx.fillStyle = "rgba(12, 10, 20, 0.78)";
  ctx.fillRect(L.x, L.y, L.w, L.h);
  ctx.strokeStyle = L.idle ? "#475569" : "#f59e0b";
  ctx.lineWidth = 1;
  ctx.strokeRect(L.x + 0.5, L.y + 0.5, L.w - 1, L.h - 1);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const cx = L.x + L.w / 2;
  ctx.font = "bold 11px sans-serif";
  ctx.fillStyle = L.idle ? "#94a3b8" : "#fbbf24";
  ctx.fillText(L.title, cx, L.y + 6);
  ctx.font = "bold 24px sans-serif";
  ctx.fillStyle = L.idle ? "#cbd5e1" : "#ffffff";
  ctx.fillText(L.big, cx, L.y + 20);
  ctx.font = "11px sans-serif";
  ctx.fillStyle = "#cbd5e1";
  ctx.fillText(L.line1, cx, L.y + 50);
  ctx.fillText(L.line2, cx, L.y + 66);
  ctx.restore();
  return L;
}
