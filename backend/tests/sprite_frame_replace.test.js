const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeRGBA } = require('../src/services/pngAlpha.js');
const { encodeRGBA } = require('../src/services/pngTrim.js');
const { replaceFrames, flaggedTargets } = require('../src/services/spriteFrameReplace.js');

const CW = 4;
const CH = 4;
const N = 5;
// One row per [action, direction]; every frame is a distinct solid-ish colour with a unique top row.
function makeSheet(rowDefs) {
  const W = CW * N;
  const H = CH * rowDefs.length;
  const px = Buffer.alloc(W * H * 4);
  const frames = {};
  rowDefs.forEach(([action, direction], r) => {
    for (let i = 0; i < N; i += 1) {
      frames[`${action}/${direction}/${i}`] = [i * CW, r * CH, CW, CH];
      for (let y = 0; y < CH; y += 1) {
        for (let x = 0; x < CW; x += 1) {
          const o = ((r * CH + y) * W + i * CW + x) * 4;
          px[o] = 10 + i * 20; px[o + 1] = 50 + r * 30; px[o + 2] = 20 + y * 40; px[o + 3] = 255;
        }
      }
    }
  });
  const rows = rowDefs.map(([action, direction], row) => ({ row, action, direction, frames: N }));
  return { png: encodeRGBA(W, H, px), manifest: { version: 1, rows, frames, frames_per_action: N }, px, W };
}
const cell = (img, rect) => {
  const [x, y, w, h] = rect;
  const rows = [];
  for (let j = 0; j < h; j += 1) rows.push(img.px.subarray(((y + j) * img.width + x) * 4, ((y + j) * img.width + x + w) * 4));
  return rows;
};
const t = (action, direction, frame) => ({ action, direction, frame });

test('walk frame is copied as-is from the nearest good frame; others byte-identical', () => {
  const s = makeSheet([['walk', 'e'], ['idle', 'e']]);
  const out = replaceFrames(s.png, s.manifest, [t('walk', 'e', 2)]);
  assert.deepEqual(out.replaced, [{ frame: 'walk/e/2', from: 'walk/e/1' }]); // tie 1 vs 3 -> lower
  const a = decodeRGBA(s.png);
  const b = decodeRGBA(out.png);
  assert.deepEqual(cell(b, s.manifest.frames['walk/e/2']), cell(a, s.manifest.frames['walk/e/1']));
  for (const [k, rect] of Object.entries(s.manifest.frames)) {
    if (k === 'walk/e/2') continue;
    assert.deepEqual(cell(b, rect), cell(a, rect), k);
  }
});

test('idle copies shift up 1 px with a transparent bottom row; sway too', () => {
  for (const action of ['idle', 'sway']) {
    const s = makeSheet([[action, 's']]);
    const out = replaceFrames(s.png, s.manifest, [t(action, 's', 0)]);
    assert.equal(out.replaced[0].from, `${action}/s/1`);
    const a = cell(decodeRGBA(s.png), s.manifest.frames[`${action}/s/1`]);
    const b = cell(decodeRGBA(out.png), s.manifest.frames[`${action}/s/0`]);
    for (let y = 0; y < CH - 1; y += 1) assert.deepEqual(b[y], a[y + 1], `${action} row ${y}`);
    assert.ok(b[CH - 1].every((v) => v === 0), 'bottom row transparent');
  }
});

test('nearest by index distance; failed quality entries and other targets are not sources', () => {
  const s = makeSheet([['walk', 'e']]);
  s.manifest.quality = [
    { action: 'walk', direction: 'e', frame: 1, passed: false, failed_checks: ['x'] },
    { action: 'walk', direction: 'e', frame: 2, passed: false, failed_checks: ['x'] },
    { action: 'walk', direction: 'e', frame: 3, passed: true },
  ];
  const out = replaceFrames(s.png, s.manifest, [t('walk', 'e', 2)]);
  // 1 is failed (not a source even though it is not a target), 3 is the nearest good.
  assert.equal(out.replaced[0].from, 'walk/e/3');
  const two = replaceFrames(s.png, s.manifest, [t('walk', 'e', 2), t('walk', 'e', 3)]);
  assert.equal(two.replaced.find((r) => r.frame === 'walk/e/2').from, 'walk/e/0'); // 0 and 4 tie at distance 2 -> lower
});

test('a row with no good frame is skipped with a reason and left untouched', () => {
  const s = makeSheet([['idle', 'e']]);
  const all = [0, 1, 2, 3, 4].map((i) => t('idle', 'e', i));
  const out = replaceFrames(s.png, s.manifest, all);
  assert.deepEqual(out.replaced, []);
  assert.equal(out.skipped.length, 5);
  assert.equal(out.skipped[0].reason, 'no good frame in idle/e');
  assert.deepEqual(decodeRGBA(out.png).px, decodeRGBA(s.png).px);
});

test('manifest: replaced entries become passed with replaced_from, keep attempts, drop reasons', () => {
  const s = makeSheet([['walk', 'e']]);
  s.manifest.quality = [
    { action: 'walk', direction: 'e', frame: 2, attempts: 3, passed: false, failed_checks: ['size'], reason: 'r', check: 'c', size_jump_reason: 'j' },
  ];
  const out = replaceFrames(s.png, s.manifest, flaggedTargets(s.manifest));
  assert.deepEqual(out.manifest.quality, [
    { action: 'walk', direction: 'e', frame: 2, attempts: 3, passed: true, failed_checks: [], replaced_from: 'walk/e/1' },
  ]);
  assert.equal(s.manifest.quality[0].passed, false, 'input manifest not mutated');
});

test('flaggedTargets lists passed:false entries only', () => {
  assert.deepEqual(flaggedTargets({ quality: [
    { action: 'a', direction: 'e', frame: 1, passed: false },
    { action: 'a', direction: 'e', frame: 2, passed: true },
    { action: 'a', direction: 'e', frame: 3 },
  ] }), [t('a', 'e', 1)]);
});

test('mirrored western rows are skipped; as-is western rows (manifest.unmirrored) are edited', () => {
  const s = makeSheet([['walk', 'w']]);
  const mirrored = replaceFrames(s.png, s.manifest, [t('walk', 'w', 2)]);
  assert.deepEqual(mirrored.replaced, []);
  assert.deepEqual(mirrored.skipped, [{ frame: 'walk/w/2', reason: 'mirrored in game — edit the eastern row instead' }]);
  const asIs = replaceFrames(s.png, { ...s.manifest, unmirrored: { walk: ['w'] } }, [t('walk', 'w', 2)]);
  assert.equal(asIs.replaced.length, 1);
});
