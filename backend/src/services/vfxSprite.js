// Sprite sheets for attack effects (vfx_effects.sprite_*; migration 1714440873000). Pure -- no
// database, no store -- so the rules the upload route and the effect CRUD share are testable.
//
// A sheet is a PNG laid out as a horizontal strip of equal frames. The row stores the asset key
// the upload route issued, never a free-form path or URL: an effect row must not be able to point
// the client at an arbitrary asset.

const MAX_FRAMES = 64;
const MAX_FPS = 60;
const MAX_SIZE = 2000;                 // world units across
const MAX_BYTES = 600 * 1024;          // of PNG
const MAX_WIDTH = 8192;
const MAX_HEIGHT = 2048;
const KEY = /^vfx\/[0-9a-f-]{36}\.png$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The sprite part of an effect body, as an error string or null.
function spriteFieldsError(body) {
  if (body.sprite_image != null && body.sprite_image !== '' && !KEY.test(String(body.sprite_image))) {
    return 'sprite_image must be a key returned by the sprite upload';
  }
  const frames = Number(body.sprite_frames ?? 1);
  if (!Number.isInteger(frames) || frames < 1 || frames > MAX_FRAMES) {
    return `sprite_frames must be a whole number between 1 and ${MAX_FRAMES}`;
  }
  const size = Number(body.sprite_size ?? 0);
  if (!(size >= 0 && size <= MAX_SIZE)) return `sprite_size must be between 0 and ${MAX_SIZE}`;
  const fps = body.sprite_fps;
  if (fps != null && fps !== '' && !(Number(fps) > 0 && Number(fps) <= MAX_FPS)) {
    return `sprite_fps must be empty or between 0 and ${MAX_FPS}`;
  }
  for (const col of ['sprite_loop', 'sprite_stretch']) {
    if (body[col] != null && typeof body[col] !== 'boolean') return `${col} must be true or false`;
  }
  return null;
}

// The sprite columns as query parameters, in column order: image, frames, size, additive, loop,
// fps, stretch.
function spriteValues(b) {
  const img = b.sprite_image ? String(b.sprite_image) : null;
  const fps = b.sprite_fps == null || b.sprite_fps === '' ? null : Number(b.sprite_fps);
  return [img, Number(b.sprite_frames ?? 1), Number(b.sprite_size ?? 0), b.sprite_additive === true,
    b.sprite_loop === true, fps, b.sprite_stretch === true];
}

// What an upload is: { width, height } of a real PNG within the size limits, or { error, status }.
// Reads the signature and the IHDR chunk; the file name and the declared type are never trusted.
function inspectPng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return { error: 'data (base64 PNG) is required', status: 400 };
  if (buf.length > MAX_BYTES) {
    return { error: `sprite must be ${Math.floor(MAX_BYTES / 1024)} KB or smaller`, status: 413 };
  }
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE) || buf.toString('ascii', 12, 16) !== 'IHDR') {
    return { error: 'sprite must be a PNG image', status: 400 };
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!(width > 0 && height > 0 && width <= MAX_WIDTH && height <= MAX_HEIGHT)) {
    return { error: `sprite must be at most ${MAX_WIDTH}x${MAX_HEIGHT} pixels`, status: 400 };
  }
  return { width, height };
}

module.exports = {
  spriteFieldsError, spriteValues, inspectPng, MAX_FRAMES, MAX_FPS, MAX_SIZE, MAX_BYTES, KEY,
};
