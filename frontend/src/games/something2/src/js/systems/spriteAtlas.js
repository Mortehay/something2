// Helpers for cropping a frame out of a generated sprite atlas.
//
// Manifest shape (from sprite-gen pack_atlas):
//   { cell: [w, h], frames: { "S/0": [x, y, w, h], "N/0": [...], ... } }
// Frame keys are "DIR/frameIndex"; values are [x, y, w, h] rects in the atlas.

// The [x, y, w, h] rect for a frame key, or null if absent.
export function frameRect(manifest, key) {
  const r = manifest && manifest.frames && manifest.frames[key];
  return Array.isArray(r) && r.length === 4 ? r : null;
}

// Which frame to show in static mode: the sprite's declared static_frame when
// present in the manifest, else "S/0" (south = toward the camera), else the
// first available frame, else null.
export function staticFrameKey(sprite, manifest) {
  const frames = (manifest && manifest.frames) || {};
  if (sprite && sprite.static_frame && frames[sprite.static_frame]) return sprite.static_frame;
  if (frames["S/0"]) return "S/0";
  const keys = Object.keys(frames);
  return keys.length ? keys[0] : null;
}

const DIRS = new Set(["N", "NE", "E", "SE", "S", "SW", "W", "NW"]);

// Facing (already a DIR string in this engine) -> a valid manifest direction,
// defaulting to "S" for entities that don't face (obstacles).
export function facingToDir(facing) {
  return DIRS.has(facing) ? facing : "S";
}

// The animated frame key for a direction at time `timeMs`: cycles that
// direction's frames at `fps`. Returns null if the direction has no frames.
export function animatedFrameKey(manifest, dir, timeMs, fps = 6) {
  const frames = (manifest && manifest.frames) || {};
  const prefix = `${dir}/`;
  const idxs = Object.keys(frames)
    .filter((k) => k.startsWith(prefix))
    .map((k) => parseInt(k.slice(prefix.length), 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (!idxs.length) return null;
  const i = Math.floor((timeMs / 1000) * fps) % idxs.length;
  return `${dir}/${idxs[i]}`;
}
