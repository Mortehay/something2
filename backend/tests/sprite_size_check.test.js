const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeRGBA } = require('../src/services/pngTrim.js');
const { sizeJumpFlags, withSizeJumpFlags, mergeQuality } = require('../src/services/spriteSizeCheck.js');

const CW = 20, CH = 20;

// Sheet of rows x frames cells; areas[r][f] = opaque pixel count (filled row-major).
function sheet(areas) {
  const frames = areas[0].length;
  const W = CW * frames, H = CH * areas.length;
  const px = Buffer.alloc(W * H * 4);
  areas.forEach((row, r) => row.forEach((area, f) => {
    for (let i = 0; i < area; i += 1) {
      const x = f * CW + (i % CW);
      const y = r * CH + Math.floor(i / CW);
      px.set([10, 200, 10, 255], (y * W + x) * 4);
    }
  }));
  const manifest = { rows: [], frames: {} };
  areas.forEach((row, r) => {
    const direction = ['s', 'n', 'e'][r];
    manifest.rows.push({ row: r, action: 'idle', direction, frames });
    for (let f = 0; f < frames; f += 1) manifest.frames[`idle/${direction}/${f}`] = [f * CW, r * CH, CW, CH];
  });
  return { png: encodeRGBA(W, H, px), manifest };
}

test('a frame 1.30x its row baseline is flagged with its percentage', () => {
  const { png, manifest } = sheet([[100, 130]]);
  const flags = sizeJumpFlags(png, manifest);
  assert.deepEqual(flags, [{
    action: 'idle', direction: 's', frame: 1, passed: false, source: 'something2', check: 'size_jump', failed_checks: ['size_jump'],
    reason: 'size jump: figure area +30% vs the smallest frame of idle/s (likely a close-up)',
  }]);
});

test('the bigger frame can be first: the smallest is the baseline', () => {
  const { png, manifest } = sheet([[130, 100]]);
  assert.deepEqual(sizeJumpFlags(png, manifest).map((f) => f.frame), [0]);
});

test('1.10x is under the threshold', () => {
  const { png, manifest } = sheet([[100, 110]]);
  assert.deepEqual(sizeJumpFlags(png, manifest), []);
});

test('a one-frame row never flags', () => {
  const { png, manifest } = sheet([[100]]);
  assert.deepEqual(sizeJumpFlags(png, manifest), []);
});

test('an empty frame is not flagged and is not the baseline', () => {
  const { png, manifest } = sheet([[0, 100], [100, 0]]);
  assert.deepEqual(sizeJumpFlags(png, manifest), []);
});

test('rows are judged independently', () => {
  const { png, manifest } = sheet([[100, 140], [300, 310], [50, 50]]);
  const flags = sizeJumpFlags(png, manifest);
  assert.deepEqual(flags.map((f) => [f.direction, f.frame]), [['s', 1]]);
});

test('SPRITE_SIZE_JUMP_RATIO overrides the threshold', () => {
  const { png, manifest } = sheet([[100, 110]]);
  process.env.SPRITE_SIZE_JUMP_RATIO = '1.05';
  try {
    assert.equal(sizeJumpFlags(png, manifest).length, 1);
  } finally { delete process.env.SPRITE_SIZE_JUMP_RATIO; }
});

test('an undecodable sheet yields no flags and withSizeJumpFlags returns the manifest unchanged', () => {
  const m = { rows: [], frames: {}, quality: [{ action: 'idle', direction: 's', frame: 0, passed: false }] };
  assert.deepEqual(sizeJumpFlags(Buffer.from('nope'), m), []);
  assert.equal(withSizeJumpFlags(Buffer.from('nope'), m), m);
  const logged = [];
  const bad = { rows: [{ action: 'idle', direction: 's', frames: 2 }], get frames() { throw new Error('boom'); } };
  assert.equal(withSizeJumpFlags(sheet([[1, 1]]).png, bad, (s) => logged.push(s)), bad);
  assert.match(logged[0], /boom/);
});

test('mergeQuality keeps other entries, replaces old size_jump ones, defers to another check on the same frame', () => {
  const box = { action: 'idle', direction: 's', frame: 0, passed: false, failed_checks: ['cut'] };
  const oldJump = { action: 'idle', direction: 'n', frame: 1, passed: false, check: 'size_jump', reason: 'old' };
  const f = (direction, frame) => ({ action: 'idle', direction, frame, passed: false, check: 'size_jump', reason: 'new' });
  const merged = mergeQuality([box, oldJump], [f('s', 0), f('e', 1)]);
  assert.deepEqual(merged, [box, f('e', 1)]);
});
