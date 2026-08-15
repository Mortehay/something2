const test = require('node:test');
const assert = require('node:assert');
const {
  pngSize, resolveSheetSpec, buildSheetManifest, manifestForSheet,
} = require('../src/services/spriteSheet');

// Build a byte-accurate PNG header for a given size. Only the first 24 bytes
// matter to pngSize, and constructing them by hand is the point: it proves the
// offsets against the format, not against our own writer.
function pngHeader(width, height, extra = 0) {
  const buf = Buffer.alloc(24 + extra);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);            // IHDR length
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

// --- Reading the sheet's size -------------------------------------------

test('pngSize reads width and height out of the IHDR chunk', () => {
  assert.deepStrictEqual(pngSize(pngHeader(512, 640)), { width: 512, height: 640 });
  assert.deepStrictEqual(pngSize(pngHeader(1, 1)), { width: 1, height: 1 });
});

test('pngSize rejects anything that is not a PNG', () => {
  // The realistic failure: a service returns an HTML error page with HTTP 200.
  assert.strictEqual(pngSize(Buffer.from('<!DOCTYPE html><html>oops</html>')), null);
  assert.strictEqual(pngSize(Buffer.alloc(10)), null, 'too short to hold a header');
  assert.strictEqual(pngSize(Buffer.from('not a buffer at all')), null);
  assert.strictEqual(pngSize(null), null);
  // Right signature, wrong chunk type.
  const bad = pngHeader(64, 64);
  bad.write('IDAT', 12, 'ascii');
  assert.strictEqual(pngSize(bad), null);
  // Zero dimensions are not a usable sheet.
  assert.strictEqual(pngSize(pngHeader(0, 64)), null);
});

// --- Grid resolution -----------------------------------------------------

test('a provider that says nothing about sheets behaves as it did before', () => {
  // The no-regression case: 1 frame, 1 cell, flat keys.
  const { spec } = resolveSheetSpec({}, 1);
  assert.deepStrictEqual(spec, {
    layout: 'flat', columns: 1, rows: 1, directions: ['S', 'SW', 'W', 'NW', 'N', 'NE', 'E', 'SE'],
  });
});

test('frames default to a single strip when no columns are configured', () => {
  const { spec } = resolveSheetSpec({}, 4);
  assert.strictEqual(spec.columns, 4, 'four frames in a row');
  assert.strictEqual(spec.rows, 1);
});

test('a directional sheet defaults to one row per direction', () => {
  const { spec } = resolveSheetSpec({ sheet_layout: 'directional' }, 4);
  assert.strictEqual(spec.rows, 8);
  assert.strictEqual(spec.columns, 4);
});

test('an unknown layout or direction is rejected with a readable message', () => {
  assert.match(resolveSheetSpec({ sheet_layout: 'diagonal' }).error, /flat.*directional/);
  assert.match(resolveSheetSpec({ sheet_directions: 'S,UP,W' }).error, /'UP'/);
  assert.match(resolveSheetSpec({ sheet_columns: 0 }).error, /positive integer/);
  assert.match(resolveSheetSpec({ sheet_rows: -2 }).error, /positive integer/);
});

test('more rows than configured directions is refused, not silently truncated', () => {
  const out = resolveSheetSpec({ sheet_layout: 'directional', sheet_directions: 'S,N', sheet_rows: 4 });
  assert.match(out.error, /only 2 directions/);
});

// --- Manifest arithmetic -------------------------------------------------

test('a flat strip produces the bare-index keys tiles already use', () => {
  const { spec } = resolveSheetSpec({}, 4);
  const { manifest, frames } = buildSheetManifest({ width: 512, height: 128, spec });
  assert.strictEqual(frames, 4);
  assert.deepStrictEqual(manifest.cell, [128, 128]);
  assert.deepStrictEqual(manifest.frames, {
    0: [0, 0, 128, 128],
    1: [128, 0, 128, 128],
    2: [256, 0, 128, 128],
    3: [384, 0, 128, 128],
  });
});

test('a directional sheet produces DIR/idx keys, one row per direction', () => {
  const { spec } = resolveSheetSpec(
    { sheet_layout: 'directional', sheet_directions: 'S,E', sheet_rows: 2 }, 2,
  );
  const { manifest } = buildSheetManifest({ width: 256, height: 320, spec });
  assert.deepStrictEqual(manifest.cell, [128, 160]);
  assert.deepStrictEqual(manifest.frames, {
    'S/0': [0, 0, 128, 160],
    'S/1': [128, 0, 128, 160],
    'E/0': [0, 160, 128, 160],
    'E/1': [128, 160, 128, 160],
  });
});

test('a sheet that does not divide evenly is refused rather than cropped wrong', () => {
  // Off-by-a-pixel crops look like a bad generation, not a bad setting, and
  // are miserable to diagnose from the rendered result.
  const { spec } = resolveSheetSpec({}, 3);
  const out = buildSheetManifest({ width: 500, height: 128, spec });
  assert.ok(out.error, 'must not produce a manifest');
  assert.match(out.error, /does not divide evenly/);
  assert.match(out.error, /500x128/);
});

// --- The whole job -------------------------------------------------------

test('manifestForSheet turns received bytes into a renderer-ready manifest', () => {
  const out = manifestForSheet(pngHeader(512, 128), {}, 4);
  assert.ok(!out.error, out.error);
  assert.strictEqual(out.frameCount, 4);
  assert.deepStrictEqual(out.cell, [128, 128]);
});

test('a non-PNG response is refused before anything is stored', () => {
  const out = manifestForSheet(Buffer.from('<html>error</html>'), {}, 4);
  assert.match(out.error, /not a readable PNG/);
});

// --- The manifest must satisfy the RENDERER's contract, not just ours ----
// These re-implement spriteAtlas.js's lookups. If the frontend helpers and
// this generator ever disagree about key format, the sprite renders as a
// missing frame -- which is exactly the kind of silent breakage that survives
// a green backend suite.

function frameRect(manifest, key) {
  const r = manifest && manifest.frames && manifest.frames[key];
  return Array.isArray(r) && r.length === 4 ? r : null;
}
function animatedFrameKey(manifest, dir, timeMs, fps = 6) {
  const frames = (manifest && manifest.frames) || {};
  const prefix = `${dir}/`;
  const idxs = Object.keys(frames)
    .filter((k) => k.startsWith(prefix))
    .map((k) => parseInt(k.slice(prefix.length), 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (!idxs.length) return null;
  return `${dir}/${idxs[Math.floor((timeMs / 1000) * fps) % idxs.length]}`;
}
function tileFrameKey(manifest, timeMs, fps = 4) {
  const frames = (manifest && manifest.frames) || {};
  const idxs = Object.keys(frames).map((k) => parseInt(k, 10))
    .filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!idxs.length) return null;
  return String(idxs[Math.floor((timeMs / 1000) * fps) % idxs.length]);
}

test('a directional manifest resolves through the renderer\'s own lookups', () => {
  const out = manifestForSheet(
    pngHeader(512, 1280), { sheet_layout: 'directional' }, 4,
  );
  assert.ok(!out.error, out.error);
  // Every direction the engine can face must resolve to a real rect.
  for (const dir of ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']) {
    const key = animatedFrameKey(out.manifest, dir, 0);
    assert.ok(key, `no frames for facing ${dir}`);
    assert.ok(frameRect(out.manifest, key), `no rect for ${key}`);
  }
  // And the static fallback the renderer prefers must exist.
  assert.ok(frameRect(out.manifest, 'S/0'), 'S/0 is the static fallback and must exist');
  // Cycling advances through that direction's frames.
  const first = animatedFrameKey(out.manifest, 'S', 0);
  const later = animatedFrameKey(out.manifest, 'S', 500);
  assert.notStrictEqual(first, later, 'the animation must actually advance');
});

test('a flat manifest resolves through the tile lookup', () => {
  const out = manifestForSheet(pngHeader(512, 128), {}, 4);
  const key = tileFrameKey(out.manifest, 0);
  assert.strictEqual(key, '0');
  assert.deepStrictEqual(frameRect(out.manifest, key), [0, 0, 128, 128]);
  assert.notStrictEqual(tileFrameKey(out.manifest, 300), key, 'tiles must cycle too');
});
