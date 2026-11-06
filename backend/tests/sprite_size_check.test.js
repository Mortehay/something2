const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeRGBA } = require('../src/services/pngTrim.js');
const { sizeJumpFlags, withSizeJumpFlags, mergeQuality } = require('../src/services/spriteSizeCheck.js');

const CW = 40, CH = 40;

// Sheet of rows x frames cells; areas[r][f] = opaque pixel count (filled row-major).
function sheet(areas, action = 'idle') {
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
    manifest.rows.push({ row: r, action, direction, frames });
    for (let f = 0; f < frames; f += 1) manifest.frames[`${action}/${direction}/${f}`] = [f * CW, r * CH, CW, CH];
  });
  return { png: encodeRGBA(W, H, px), manifest };
}

test('a frame 1.30x its row baseline is flagged with its percentage', () => {
  const { png, manifest } = sheet([[100, 130]]);
  const flags = sizeJumpFlags(png, manifest);
  assert.deepEqual(flags, [{
    action: 'idle', direction: 's', frame: 1, passed: false, source: 'something2', check: 'size_jump', failed_checks: ['size_jump'],
    reason: 'size jump: figure area +30% vs the smallest frame of idle/s (may be a close-up, or just a pose change)',
  }]);
});

test('the bigger frame can be first: in a 2-frame row the smaller is the baseline', () => {
  const { png, manifest } = sheet([[130, 100]]);
  assert.deepEqual(sizeJumpFlags(png, manifest).map((f) => f.frame), [0]);
});

test('SOMET-703: a cut-off smallest frame is flagged, the good frames are not', () => {
  const { png, manifest } = sheet([[702, 914, 827, 941, 1010, 986]]);
  const flags = sizeJumpFlags(png, manifest);
  assert.deepEqual(flags.map((f) => f.frame), [0]);
  assert.equal(flags[0].reason, 'size jump: figure area -24% vs the median frame of idle/s (may be cut off, or just a pose change)');
});

test('SOMET-703: close-ups in a row of mostly normal frames are both flagged', () => {
  const { png, manifest } = sheet([[990, 933, 1048, 1322, 1058, 1235]]);
  const flags = sizeJumpFlags(png, manifest);
  assert.deepEqual(flags.map((f) => f.frame), [3, 5]);
  assert.match(flags[0].reason, /^size jump: figure area \+26% vs the median frame of idle\/s \(may be a close-up, or just a pose change\)$/);
});

test('SOMET-703: SPRITE_SIZE_SHRINK_RATIO overrides the shrink limit; invalid values fall back', () => {
  const { png, manifest } = sheet([[702, 914, 827, 941, 1010, 986]]);
  try {
    process.env.SPRITE_SIZE_SHRINK_RATIO = '0.7';
    assert.deepEqual(sizeJumpFlags(png, manifest), []);
    process.env.SPRITE_SIZE_SHRINK_RATIO = '1.5';
    assert.equal(sizeJumpFlags(png, manifest).length, 1);
  } finally { delete process.env.SPRITE_SIZE_SHRINK_RATIO; }
});

test('a 2-frame row flags only the larger frame (the median would hide +30%)', () => {
  const { png, manifest } = sheet([[100, 90], [130, 100]]);
  assert.deepEqual(sizeJumpFlags(png, manifest).map((f) => [f.direction, f.frame]), [['n', 0]]);
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

test('SOMET-697: an undecodable sheet keeps the size flags already on the manifest', () => {
  const m = { rows: [], frames: {}, quality: [{ action: 'idle', direction: 's', frame: 1, passed: false, check: 'size_jump', failed_checks: ['size_jump'], reason: 'R' }] };
  assert.equal(withSizeJumpFlags(Buffer.from('nope'), m), m);
});

test('SOMET-697: --apply skips an undecodable sheet instead of wiping its flags', async () => {
  const { run } = require('../scripts/sprite-size-check.js');
  const manifest = { rows: [], frames: {}, quality: [{ action: 'idle', direction: 's', frame: 1, passed: false, check: 'size_jump', failed_checks: ['size_jump'], reason: 'R' }] };
  const objects = { 'x/sheet.json': Buffer.from(JSON.stringify(manifest)), 'x/sheet.png': Buffer.from('nope') };
  const puts = [];
  const store = {
    getObjectStream: async (k) => [objects[k]],
    putObject: async (k) => { puts.push(k); },
  };
  const db = { query: async () => ({ rows: [{ id: 'id-1', creature: 'Wolf', atlas_key: 'x/sheet.png', manifest_key: 'x/sheet.json' }] }) };
  const lines = [];
  await run({ db, store, apply: true, id: null, out: (l) => lines.push(l) });
  assert.deepEqual(puts, []);
  assert.match(lines[0], /skipped/);
});

const boxEntry = (direction, frame, over = {}) => ({
  action: 'idle', direction, frame, attempts: 1, passed: true, failed_checks: [], row_redrawn: false, ...over,
});
const flag = (direction, frame) => ({
  action: 'idle', direction, frame, passed: false, source: 'something2', check: 'size_jump',
  failed_checks: ['size_jump'], reason: 'R',
});

test('merges into the box passed:true entry, keeping its other fields', () => {
  const q = [boxEntry('s', 0), boxEntry('s', 1)];
  const m = mergeQuality(q, [flag('s', 1)]);
  assert.deepEqual(m[0], boxEntry('s', 0));
  assert.deepEqual(m[1], boxEntry('s', 1, {
    passed: false, failed_checks: ['size_jump'], check: 'size_jump', reason: 'R', source: 'something2',
  }));
  assert.equal(q[1].passed, true, 'input not mutated');
});

test('a frame the box failed keeps its reasons and gains size_jump', () => {
  const q = [boxEntry('s', 1, { passed: false, failed_checks: ['torso_cut'], reason: 'box' })];
  const [e] = mergeQuality(q, [flag('s', 1)]);
  assert.deepEqual(e.failed_checks, ['torso_cut', 'size_jump']);
  assert.equal(e.reason, 'box');
  assert.equal(e.size_jump_reason, 'R');
  assert.equal(e.passed, false);
});

test('with no entry for the frame the flag is appended', () => {
  assert.deepEqual(mergeQuality([boxEntry('s', 0)], [flag('s', 1)]), [boxEntry('s', 0), flag('s', 1)]);
});

test('merging twice gives the same result', () => {
  const q = [boxEntry('s', 0), boxEntry('s', 1), boxEntry('n', 1, { passed: false, failed_checks: ['torso_cut'] })];
  const flags = [flag('s', 1), flag('n', 1), flag('e', 0)];
  const once = mergeQuality(q, flags);
  assert.deepEqual(mergeQuality(once, flags), once);
});

test('a stale size_jump goes back to the box state, or is removed if it was ours', () => {
  const q = [boxEntry('s', 0), boxEntry('s', 1), boxEntry('n', 1, { passed: false, failed_checks: ['torso_cut'] })];
  const flagged = mergeQuality(q, [flag('s', 1), flag('n', 1), flag('e', 0)]);
  assert.deepEqual(mergeQuality(flagged, []), q);
});

test('SOMET-697: a box failure with no listed checks stays failed after flag-then-clear', () => {
  const q = [boxEntry('s', 1, { passed: false, failed_checks: [], reason: 'box' })];
  const flagged = mergeQuality(q, [flag('s', 1)]);
  assert.deepEqual(mergeQuality(flagged, []), q);
});

test('SOMET-697: re-flagging a box failure keeps the box reason', () => {
  const q = [boxEntry('s', 1, { passed: false, failed_checks: [], reason: 'box' })];
  const once = mergeQuality(q, [flag('s', 1)]);
  const twice = mergeQuality(once, [flag('s', 1)]);
  assert.deepEqual(twice, once);
  assert.equal(twice[0].reason, 'box');
  assert.equal(twice[0].size_jump_reason, 'R');
});

test('withSizeJumpFlags clears a stale mark even when nothing flags now', () => {
  const { png, manifest } = sheet([[100, 105]]);
  const stale = { ...manifest, quality: mergeQuality([boxEntry('s', 1)], [flag('s', 1)]) };
  assert.deepEqual(withSizeJumpFlags(png, stale).quality, [boxEntry('s', 1)]);
});

test('SOMET-704: +14% is a close-up now, +12% is not (grow limit 1.13)', () => {
  const { png, manifest } = sheet([[906, 1092, 888, 1007, 870, 1130].map((a) => Math.round(a / 2))]);
  assert.deepEqual(sizeJumpFlags(png, manifest).map((f) => f.frame), [1, 5]);
});

test('SOMET-704: a good frame at +12.4% (Warrior:2 ne/3) stays unflagged', () => {
  const { png, manifest } = sheet([[453, 546, 444, 504, 435, 435]]);
  // median 448.5: 504 is +12.4%, 546 is +21.7%
  assert.deepEqual(sizeJumpFlags(png, manifest).map((f) => f.frame), [1]);
});

test('SOMET-710: attack, cast, damage and use rows are never size-flagged (the pose changes the silhouette)', () => {
  for (const action of ['attack', 'cast', 'damage', 'use', 'some_custom_action']) {
    const { png, manifest } = sheet([[700, 1000, 1180, 1360, 840, 1000]], action);
    assert.deepEqual(sizeJumpFlags(png, manifest), [], action);
  }
});

test('SOMET-710: idle, walk and sway rows are still size-checked', () => {
  for (const action of ['idle', 'walk', 'sway']) {
    const { png, manifest } = sheet([[1000, 1000, 1360, 1000, 1000, 1000]], action);
    assert.deepEqual(sizeJumpFlags(png, manifest).map((f) => `${f.action}/${f.frame}`), [`${action}/2`], action);
  }
});

test('SOMET-710: a stale size_jump mark on an attack row is cleared', () => {
  const { png, manifest } = sheet([[700, 1000, 1360, 1000]], 'attack');
  manifest.quality = [{ action: 'attack', direction: 's', frame: 2, passed: false, source: 'something2', check: 'size_jump', failed_checks: ['size_jump'], reason: 'size jump' }];
  assert.deepEqual(withSizeJumpFlags(png, manifest).quality, []);
});
