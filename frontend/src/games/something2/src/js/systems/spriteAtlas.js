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

// --- Tiles -----------------------------------------------------------------
// Tile atlases are keyed by bare frame index ("0","1",...), not "DIR/idx".

// The current tile animation frame key at `timeMs`, cycling at `fps`. Null if
// the manifest has no frames.
export function tileFrameKey(manifest, timeMs, fps = 4) {
  const frames = (manifest && manifest.frames) || {};
  const idxs = Object.keys(frames)
    .map((k) => parseInt(k, 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (!idxs.length) return null;
  const i = Math.floor((timeMs / 1000) * fps) % idxs.length;
  return String(idxs[i]);
}

// Decide what to draw for a tile: the animated atlas frame, the static image,
// or nothing (draw the flat color). Returns { img, crop, cacheKey } or null.
// `crop` is an [x,y,w,h] rect into `img`, or null to use the whole image.
// Pure: reads imageManager.get(key) (null until loaded) so a not-yet-loaded
// texture degrades to color rather than a hole.
export function resolveTileVisual(tileName, def, imageManager, nowMs, override = null) {
  if (!def || !imageManager) return null;
  const mode = override || def.render_mode || def.renderMode || 'color';
  if (mode === 'color') return null;

  if (mode === 'animated' && def.sprite && def._manifest) {
    const fkey = tileFrameKey(def._manifest, nowMs);
    const rect = fkey ? frameRect(def._manifest, fkey) : null;
    const atlas = def.sprite.atlas_key ? imageManager.get(def.sprite.atlas_key) : null;
    if (atlas && rect) {
      return { img: atlas, crop: rect, cacheKey: `${tileName}|animated|${fkey}` };
    }
    // fall through to the static image if the atlas/manifest isn't usable
  }

  if (def.image) {
    const img = imageManager.get(def.image);
    if (img) return { img, crop: null, cacheKey: `${tileName}|image` };
  }
  return null;
}
