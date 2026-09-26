import { resolveMove } from '../systems/movement.js';

// Snap the local player to the authoritative server position, then replay the
// still-unacked inputs plus any client-side unsent accumulated input so prediction
// stays responsive and avoids snapping backwards between input sends. Pure: returns
// a new position and the trimmed buffer.
export function reconcile(serverPos, ackSeq, buffer, map, dims, pendingUnsent = null) {
  const remaining = buffer.filter((i) => i.seq > ackSeq);
  const actor = {
    x: serverPos.x,
    y: serverPos.y,
    width: dims.width,
    height: dims.height,
    speed: dims.speed,
  };
  for (const inp of remaining) {
    const r = resolveMove(map, actor, inp.dx, inp.dy, inp.dt);
    actor.x = r.x;
    actor.y = r.y;
  }
  if (pendingUnsent && pendingUnsent.dt > 0 && (pendingUnsent.dx !== 0 || pendingUnsent.dy !== 0)) {
    const r = resolveMove(map, actor, pendingUnsent.dx, pendingUnsent.dy, pendingUnsent.dt);
    actor.x = r.x;
    actor.y = r.y;
  }
  return { x: actor.x, y: actor.y, buffer: remaining };
}
