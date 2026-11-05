// How a trade starts on the client: who the trade key (R by default) invites, and the small
// Accept/Decline card the invited player sees. Pure geometry and drawing; Game
// owns the state (`tradeInvite`), the keys and the frames, and the server decides
// every rule (range, world, busy, rate).

import { canvasToCameraPoint, pickDrawable } from "./inspect.js";
import { clipToWidth, MONOSPACE_ADVANCE } from "./itemDisplay.js";
import { t } from "../i18n/i18n.js";

// The server's TRADE_INVITE_RADIUS (the interact radius), in world pixels.
export const TRADE_INVITE_RADIUS = 120;

const centreOf = (o) => ({
  x: Number(o.x) + (Number(o.width) || 64) / 2,
  y: Number(o.y) + (Number(o.height) || 64) / 2,
});

const isAlive = (p) => !!p && p.dead !== true && !(Number.isFinite(p.hp) && p.hp <= 0);

// The remote player under the cursor as `p:<id>`, or null. A direct hit-test of the
// remote players with the helpers inspect.js exports: the renderer's own hover key
// exists only while the inspect card is switched on, and a trade must not depend on that.
export function hoverPlayerKey({ remotePlayers, cursorX, cursorY, camera }) {
  if (!remotePlayers || !camera || !Number.isFinite(cursorX) || !Number.isFinite(cursorY)) return null;
  if (!Number.isFinite(camera.screenX) || !Number.isFinite(camera.screenY)) return null;
  const drawables = [];
  for (const [userId, ref] of remotePlayers) {
    if (ref && isAlive(ref)) drawables.push({ kind: "remote", ref, userId });
  }
  const hit = pickDrawable(drawables, canvasToCameraPoint(cursorX, cursorY, camera));
  return hit ? `p:${hit.userId}` : null;
}

// The player to invite: the one under the cursor if within range, otherwise the
// nearest living player within range. Cursor first because a nearest-only rule makes
// the farther of two players unreachable.
export function pickTradeTarget({ me, remotePlayers, hoverKey = null, radius = TRADE_INVITE_RADIUS }) {
  if (!me || !remotePlayers || !Number.isFinite(Number(me.x)) || !Number.isFinite(Number(me.y))) return null;
  const from = centreOf(me);
  let hovered = null;
  let nearest = null;
  let nearestD = Infinity;
  for (const [id, p] of remotePlayers) {
    if (!isAlive(p)) continue;
    const c = centreOf(p);
    const d = Math.hypot(c.x - from.x, c.y - from.y);
    if (!Number.isFinite(d) || d > radius) continue;
    if (hoverKey != null && hoverKey === `p:${id}`) hovered = id;
    if (d < nearestD) { nearestD = d; nearest = id; }
  }
  return hovered != null ? hovered : nearest;
}

const CARD_W = 300;
const CARD_H = 72;
const CARD_TOP = 12;
const PAD = 10;
const TEXT_PX = 13;
const BTN_PX = 12;
const BTN_H = 26;
const BTN_GAP = 8;

// Geometry and hit areas of the card, or null when there is nothing to show
// (no invite, expired, or a clock that is not a number).
export function layoutInviteCard({ invite, nowMs, canvasW, canvasH }) {
  if (!invite || !Number.isFinite(nowMs) || !Number.isFinite(canvasW) || !Number.isFinite(canvasH)) return null;
  if (!Number.isFinite(invite.expiresAtMs) || nowMs >= invite.expiresAtMs) return null;
  const w = Math.min(CARD_W, Math.max(0, canvasW - 2 * PAD));
  const h = Math.min(CARD_H, Math.max(0, canvasH - 2 * CARD_TOP));
  const x = Math.round((canvasW - w) / 2);
  const y = CARD_TOP;
  const avail = w - 2 * PAD;

  // Clip the NAME so the whole sentence fits, whatever the language wraps around it.
  const frame = t("{name} wants to trade", { name: "" });
  const advance = TEXT_PX * MONOSPACE_ADVANCE;
  const nameBudget = avail - frame.length * advance;
  const raw = invite.fromName == null ? "" : String(invite.fromName);
  const name = clipToWidth(raw, nameBudget, TEXT_PX);
  const text = t("{name} wants to trade", { name });

  const btnW = (avail - BTN_GAP) / 2;
  const btnY = y + h - PAD - BTN_H;
  const accept = { x: x + PAD, y: btnY, w: btnW, h: BTN_H, label: clipToWidth(t("Accept (Y)"), btnW - 8, BTN_PX) };
  const decline = { x: x + PAD + btnW + BTN_GAP, y: btnY, w: btnW, h: BTN_H, label: clipToWidth(t("Decline (N)"), btnW - 8, BTN_PX) };
  const total = Number(invite.expiresInMs);
  const fraction = total > 0 ? Math.max(0, Math.min(1, (invite.expiresAtMs - nowMs) / total)) : 0;
  return {
    x, y, w, h, text, textY: y + PAD + TEXT_PX, accept, decline, fraction,
    hitAreas: [
      { kind: "tradeInviteAccept", box: { x: accept.x, y: accept.y, w: accept.w, h: accept.h } },
      { kind: "tradeInviteDecline", box: { x: decline.x, y: decline.y, w: decline.w, h: decline.h } },
    ],
  };
}

export function drawInviteCard(ctx, layout, nowMs) {
  if (!layout) return;
  const { x, y, w, h } = layout;
  ctx.save();
  ctx.fillStyle = "rgba(20,24,32,0.92)";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "#caa24a";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.font = `${TEXT_PX}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#f5f5f5";
  ctx.fillText(layout.text, x + w / 2, layout.textY);
  // Time left, as a thin bar under the sentence.
  if (Number.isFinite(layout.fraction)) {
    ctx.fillStyle = "rgba(202,162,74,0.7)";
    ctx.fillRect(x + PAD, y + h - PAD - BTN_H - 6, (w - 2 * PAD) * layout.fraction, 2);
  }
  for (const [b, fill] of [[layout.accept, "#2f6b3a"], [layout.decline, "#6b2f2f"]]) {
    ctx.fillStyle = fill;
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
    ctx.fillStyle = "#f5f5f5";
    ctx.font = `${BTN_PX}px monospace`;
    ctx.textBaseline = "middle";
    ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 1);
  }
  ctx.restore();
}
