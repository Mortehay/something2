// Procedural Training Dummy: wooden post, cross-arm, straw target body.
export function isTrainingDummy(e) {
  return !!e && (e.type === "Training Dummy" || e.dummy === 1 || e.dummy === true);
}

// (drawX, drawY, w, h) is the creature box; feet at drawY + h.
export function drawTrainingDummy(ctx, drawX, drawY, w, h) {
  const cx = drawX + w / 2;
  const feet = drawY + h;
  const r = Math.min(w, h) * 0.34;
  const bodyY = drawY + h * 0.42;
  ctx.save();
  // ground shadow
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.beginPath();
  ctx.ellipse(cx, feet - 2, w * 0.3, h * 0.07, 0, 0, Math.PI * 2);
  ctx.fill();
  // post
  ctx.fillStyle = "#7c4a21";
  ctx.fillRect(cx - w * 0.05, bodyY, w * 0.1, feet - bodyY - 2);
  // cross-arm
  ctx.fillStyle = "#8b5a2b";
  ctx.fillRect(cx - w * 0.36, bodyY - h * 0.02, w * 0.72, h * 0.07);
  // straw body: concentric rings
  const rings = ["#c9a227", "#b91c1c", "#f5f5f4", "#b91c1c", "#f5f5f4"];
  for (let i = 0; i < rings.length; i++) {
    ctx.fillStyle = rings[i];
    ctx.beginPath();
    ctx.arc(cx, bodyY - r * 0.25, r * (1 - i * 0.2), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = "#451a03";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, bodyY - r * 0.25, r, 0, Math.PI * 2);
  ctx.stroke();
  // name
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.strokeText("Training Dummy", cx, feet + 2);
  ctx.fillStyle = "#fde68a";
  ctx.fillText("Training Dummy", cx, feet + 2);
  ctx.restore();
}
