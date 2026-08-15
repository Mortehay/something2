// SOMET-346: turning a ready-made sprite sheet from a remote service into the
// atlas + manifest the renderer already knows how to draw.
//
// THE DIVISION OF LABOUR, which SOMET-327 originally got wrong: the other
// machine draws the pixels, including all the frames. This side prepares the
// request, waits, receives the sheet, and stores it. It does not decide what
// the remote is capable of, and it does not stitch anything -- the sheet
// arrives whole.
//
// So the only real work here is arithmetic: given the sheet's pixel size and
// the grid the admin declared, produce the frame rects. No image library is
// needed for that, and none is added.

// The manifest contract, defined by frontend spriteAtlas.js and produced today
// by sprite-gen's pack_atlas:
//
//   { cell: [w, h], frames: { "S/0": [x, y, w, h], ... } }
//
// Two key styles, and they are NOT interchangeable:
//   directional  "DIR/idx"  -- creatures; animatedFrameKey() looks up by facing
//   flat         "0","1",…  -- tiles and objects; tileFrameKey() cycles them
//
// Row order for a directional sheet. This is the order the ROWS of the image
// are assumed to be in, so it is configurable per provider -- a service that
// lays its sheet out differently is a settings change, not a code change.
const DEFAULT_DIRECTIONS = ['S', 'SW', 'W', 'NW', 'N', 'NE', 'E', 'SE'];

const VALID_DIRECTIONS = new Set(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']);

// PNG dimensions straight out of the IHDR chunk.
//
// A PNG is: 8-byte signature, then a chunk whose 4-byte length and 4-byte type
// ("IHDR") are followed by width and height as big-endian uint32. So width is
// at byte 16 and height at byte 20, always.
//
// Doing this by hand rather than adding sharp/jimp is deliberate: the whole
// need is two integers, and it doubles as proof the bytes really are a PNG
// rather than an HTML error page the service returned with a 200.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

// Normalises the grid an admin declared into { columns, rows, layout,
// directions }, or returns an error. Defaults are chosen so a provider that
// says nothing about sheets still behaves: one frame, one cell.
function resolveSheetSpec(provider = {}, frames = 1) {
  const layout = provider.sheet_layout || 'flat';
  if (layout !== 'flat' && layout !== 'directional') {
    return { error: `sheet_layout must be 'flat' or 'directional', got '${layout}'` };
  }

  const directions = (provider.sheet_directions
    ? String(provider.sheet_directions).split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_DIRECTIONS);
  for (const d of directions) {
    if (!VALID_DIRECTIONS.has(d)) {
      return { error: `sheet_directions contains '${d}', which is not one of ${[...VALID_DIRECTIONS].join(', ')}` };
    }
  }

  // Columns default to the frame count, rows to one line of frames -- i.e. the
  // obvious "a strip of N frames" layout -- and to one row per direction when
  // the sheet is directional.
  //
  // "not configured" and "configured to something invalid" are distinguished
  // deliberately: `Number(x) || fallback` would swallow an explicit 0 into the
  // default and silently produce a 1-column grid instead of reporting the
  // nonsense the admin actually typed.
  const unset = (v) => v === null || v === undefined || v === '';
  const columns = unset(provider.sheet_columns)
    ? (Number(frames) || 1)
    : Number(provider.sheet_columns);
  const rows = unset(provider.sheet_rows)
    ? (layout === 'directional' ? directions.length : 1)
    : Number(provider.sheet_rows);

  if (!Number.isInteger(columns) || columns < 1) return { error: 'sheet_columns must be a positive integer' };
  if (!Number.isInteger(rows) || rows < 1) return { error: 'sheet_rows must be a positive integer' };
  if (layout === 'directional' && rows > directions.length) {
    return {
      error: `sheet_rows is ${rows} but only ${directions.length} directions are configured; `
        + 'add them to sheet_directions or reduce the rows',
    };
  }
  return { spec: { layout, columns, rows, directions } };
}

// Builds the manifest for a sheet of `width` x `height` pixels.
//
// Returns { manifest, frames } or { error }. The cell size must divide the
// sheet EXACTLY: a remainder means the declared grid does not match the image,
// and every crop would be silently off by a pixel or two -- which looks like a
// bad generation rather than a bad setting, and is miserable to diagnose.
function buildSheetManifest({ width, height, spec }) {
  const { layout, columns, rows, directions } = spec;
  if (width % columns !== 0 || height % rows !== 0) {
    return {
      error: `sheet is ${width}x${height}px, which does not divide evenly into `
        + `${columns}x${rows} cells (${width / columns}x${height / rows}). `
        + 'Check sheet_columns / sheet_rows against what the service returns.',
    };
  }
  const cellW = width / columns;
  const cellH = height / rows;

  const frames = {};
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      const key = layout === 'directional' ? `${directions[row]}/${col}` : String(row * columns + col);
      frames[key] = [col * cellW, row * cellH, cellW, cellH];
    }
  }
  return { manifest: { cell: [cellW, cellH], frames }, frames: columns * rows };
}

// The whole job, from received bytes to a storable manifest.
// Returns { manifest, frameCount, cell } or { error }.
function manifestForSheet(buffer, provider, frames) {
  const size = pngSize(buffer);
  if (!size) {
    return { error: 'the response is not a readable PNG (a sprite sheet must be PNG)' };
  }
  const resolved = resolveSheetSpec(provider, frames);
  if (resolved.error) return { error: resolved.error };
  const built = buildSheetManifest({ width: size.width, height: size.height, spec: resolved.spec });
  if (built.error) return { error: built.error };
  return { manifest: built.manifest, frameCount: built.frames, cell: built.manifest.cell };
}

module.exports = {
  pngSize, resolveSheetSpec, buildSheetManifest, manifestForSheet,
  DEFAULT_DIRECTIONS, VALID_DIRECTIONS,
};
