// A GPU-box 3D turnaround fixture for spriteTurnaround / spriteDispatcher tests.
const { encodeRGBA } = require('../../src/services/pngTrim.js');

// A turnaround image: one 48x64 cell per row, row r filled with colour (r+1)*10.
function turnaroundFor(dirs, { w = 48, h = 64 } = {}) {
  const px = Buffer.alloc(w * h * dirs.length * 4);
  for (let r = 0; r < dirs.length; r += 1) {
    for (let i = r * w * h; i < (r + 1) * w * h; i += 1) px.fill((r + 1) * 10, i * 4, i * 4 + 4);
  }
  return {
    png: encodeRGBA(w, h * dirs.length, px),
    atlas: { cell: { w, h }, grid: { columns: 1, rows: dirs.length }, rows: dirs.map((direction, row) => ({ row, direction })) },
  };
}

module.exports = { turnaroundFor };
