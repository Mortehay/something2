// The quest tracker card (top-left HUD) and its compass arrow.
//
// Lives in its own module, not in RenderSystem.js (which is already thousands
// of lines): everything it needs arrives as arguments, so it draws against any
// 2d context and is tested without a RenderSystem.
//
//   ctx           2d context
//   trackedQuest  { key, act, title, objective, target_count, progress_count, ... }
//   player        the local player (x, y, width, height)
//   camera        for the off-screen compass arrow; null skips the arrow
//   opts.questRoute  the server's route answer (services/questRoute.js), or null
//   opts.width       card width in canvas px (the player's setting), default 300
import { GAME_WIDTH, GAME_HEIGHT } from "../core/constants.js";
import { worldToScreen } from "../core/iso.js";

export function drawQuestTracker(ctx, trackedQuest, player, camera, { questRoute = null, width = 300 } = {}) {
  if (!ctx || !trackedQuest) return;

  // Where to go comes from the SERVER (questsClient.fetchQuestRoute ->
  // services/questRoute.js): the distance is the walking distance across every
  // map on the way, not just the one on screen. The hardcoded village table
  // that used to live here held coordinates for maps that do not exist.
  const route = questRoute && questRoute.questKey === trackedQuest.key
    ? questRoute : null;
  const pcx = player ? (player.x || 0) + (player.width || 0) / 2 : 0;
  const pcy = player ? (player.y || 0) + (player.height || 0) / 2 : 0;
  let loc = null;      // compass point in THIS world (px)
  let distM = null;    // total walking distance, tiles ("m")
  let whereLine = "";
  let routeMaps = 0;   // maps crossed on the way
  if (route && route.found && route.first) {
    loc = route.first;
    const totalPx = Math.hypot(route.first.x - pcx, route.first.y - pcy) + (route.restPx || 0);
    distM = Math.max(1, Math.round(totalPx / 100));
    const verb = { turn_in: "Turn in", gather: "Gather", hunt: "Hunt", climb: "Climb" }[route.mode] || "Start";
    routeMaps = Math.max(0, (route.hops ? route.hops.length : 1) - 1);
    const what = (route.mode === "hunt" || route.mode === "climb") && route.huntLabel ? ` ${route.huntLabel}` : "";
    whereLine = `${verb}${what}: ${route.placeName || "?"}`;
    // Already standing in the hunting grounds: say so instead of a 3m arrow.
    if ((route.mode === "hunt") && route.sameWorld && totalPx < 900) {
      whereLine = `Hunt${what}: you are in the right place`;
      distM = null;
      loc = null;
    }
  } else if (route && route.found === false && route.huntLabel) {
    whereLine = `No ${route.huntLabel} found yet — explore`;
  } else if (route && route.found === false) {
    whereLine = "Destination unknown";
  }
  const w = width || 300;
  const textW = w - 24;
  // Word-wrap into at most `maxLines` lines; only the very last line is ever
  // cut with an ellipsis, so the player reads the whole objective instead of
  // "Slay 25 Rogue Bandits near Sunspir…".
  const wrap = (text, font, maxLines) => {
    ctx.font = font;
    const words = String(text || "").split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = "";
    const cut = (s) => {
      if (ctx.measureText(s).width <= textW) return s;
      let t = s;
      while (t.length > 1 && ctx.measureText(`${t}…`).width > textW) t = t.slice(0, -1);
      return `${t}…`;
    };
    for (const word of words) {
      const next = cur ? `${cur} ${word}` : word;
      if (cur && ctx.measureText(next).width > textW) { lines.push(cur); cur = word; } else cur = next;
    }
    if (cur) lines.push(cur);
    if (lines.length > maxLines) {
      const kept = lines.slice(0, maxLines);
      kept[maxLines - 1] = cut(`${kept[maxLines - 1]} ${lines.slice(maxLines).join(" ")}`);
      return kept;
    }
    return lines.map(cut);
  };

  const TITLE_FONT = "bold 12px monospace";
  const BODY_FONT = "11px monospace";
  const targetCnt = trackedQuest.target_count || 1;
  const progCnt = Math.min(trackedQuest.progress_count || 0, targetCnt);
  const left = Math.max(0, targetCnt - progCnt);
  const titleLines = wrap(trackedQuest.title, TITLE_FONT, 2);
  const objLines = wrap(`🎯 ${trackedQuest.objective || trackedQuest.description || ""}`, BODY_FONT, 3);
  // What is left to do, in one short line.
  const progressLine = targetCnt > 1
    ? (left > 0 ? `Progress ${progCnt}/${targetCnt} • ${left} left` : `Progress ${progCnt}/${targetCnt} • done`)
    : (left > 0 ? "Not done yet" : "Objective done");
  const distLine = distM != null
    ? `${distM}m${routeMaps > 0 ? ` • +${routeMaps} map${routeMaps > 1 ? "s" : ""}` : ""}`
    : "";
  const whereLines = whereLine ? wrap(whereLine, BODY_FONT, 2) : [];

  const LH = 15;
  const h = 10 + 14 + titleLines.length * LH + 2 + objLines.length * 14 + 16
    + (distLine ? 17 : 0) + whereLines.length * 14 + 10;
  // Positioned in top-left corner with 16px margins, matching game UI button styling
  const x = 16;
  const y = 16;
  const r = 10;

  ctx.save();
  // Dark glassmorphic card matching game UI panels (e.g. Minimap, HowToButton)
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  ctx.fillStyle = "rgba(15, 15, 26, 0.85)";
  ctx.fill();
  ctx.strokeStyle = "#2e2e3e";
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // Left accent indicator bar
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, 4, h, [r, 0, 0, r]);
  } else {
    ctx.rect(x, y, 4, h);
  }
  ctx.fillStyle = "#38bdf8";
  ctx.fill();

  ctx.textBaseline = "top";

  // Title label
  ctx.fillStyle = "#fde047";
  ctx.font = "bold 11px monospace";
  ctx.fillText(`📌 TRACKED: Act ${trackedQuest.act}`, x + 12, y + 10);

  // Quest title (wrapped)
  let ty = y + 24;
  ctx.fillStyle = "#ffffff";
  ctx.font = TITLE_FONT;
  for (const line of titleLines) { ctx.fillText(line, x + 12, ty); ty += LH; }

  // Objective (wrapped) and what is left
  ty += 2;
  ctx.fillStyle = "#60a5fa";
  ctx.font = BODY_FONT;
  for (const line of objLines) { ctx.fillText(line, x + 12, ty); ty += 14; }
  ctx.fillStyle = left > 0 ? "#fbbf24" : "#4ade80";
  ctx.font = "bold 11px monospace";
  ctx.fillText(progressLine, x + 12, ty);
  ty += 16;

  // Distance (summed over every map on the way) behind an arrow that turns
  // toward the next point to walk to, then where/what to do there.
  ctx.fillStyle = "#a7f3d0";
  ctx.font = BODY_FONT;
  if (distLine) {
    if (loc && player) {
      // Heading on screen (the world is isometric): player -> next point.
      const a = worldToScreen(pcx, pcy);
      const b = worldToScreen(loc.x, loc.y);
      const heading = Math.atan2(b.y - a.y, b.x - a.x);
      ctx.save();
      ctx.translate(x + 19, ty + 6);
      ctx.rotate(heading);
      ctx.beginPath();
      ctx.moveTo(8, 0);
      ctx.lineTo(-6, -6);
      ctx.lineTo(-3, 0);
      ctx.lineTo(-6, 6);
      ctx.closePath();
      ctx.fillStyle = "#f59e0b";
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }
    ctx.fillStyle = "#a7f3d0";
    ctx.fillText(distLine, x + 34, ty);
    ty += 17;
  }
  for (const line of whereLines) { ctx.fillText(line, x + 12, ty); ty += 14; }

  // Draw Screen Edge Compass Arrow pointing toward the next point to walk to
  // (the doorway out of this map, or the destination itself when it is here)
  if (camera && player && loc) {
    const targetScreen = worldToScreen(loc.x, loc.y);
    const camScreenX = targetScreen.x - camera.x;
    const camScreenY = targetScreen.y - camera.y;

    const isOffScreen = camScreenX < 40 || camScreenX > GAME_WIDTH - 40 || camScreenY < 40 || camScreenY > GAME_HEIGHT - 40;

    if (isOffScreen) {
      const cx = GAME_WIDTH / 2;
      const cy = GAME_HEIGHT / 2;
      const angle = Math.atan2(camScreenY - cy, camScreenX - cx);

      const edgeX = cx + Math.cos(angle) * (GAME_WIDTH / 2 - 40);
      const edgeY = cy + Math.sin(angle) * (GAME_HEIGHT / 2 - 40);

      ctx.translate(edgeX, edgeY);
      ctx.rotate(angle);

      ctx.beginPath();
      ctx.moveTo(14, 0);
      ctx.lineTo(-10, -9);
      ctx.lineTo(-4, 0);
      ctx.lineTo(-10, 9);
      ctx.closePath();
      ctx.fillStyle = "#f59e0b";
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.rotate(-angle);
      ctx.fillStyle = "#fde047";
      ctx.font = "bold 11px monospace";
      ctx.textAlign = "center";
      ctx.fillText(`📌 ${distM}m`, 0, 18);
    } else {
      // Floating 3D Waypoint Pin on-screen
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.005);
      ctx.beginPath();
      ctx.arc(camScreenX, camScreenY - 30 - pulse * 6, 8, 0, Math.PI * 2);
      ctx.fillStyle = "#f59e0b";
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 10px monospace";
      ctx.textAlign = "center";
      ctx.fillText("📌", camScreenX, camScreenY - 30 - pulse * 6);
    }
  }

  ctx.restore();
}
