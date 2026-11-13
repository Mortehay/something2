// Pure shrink transforms: images, sprite sheets, strips -> WebP web copies.
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { shrinkImage, shrinkSheet, shrinkStrip, ShrinkError } = require('../src/services/imageShrink');

const raw = (buf) => sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const isWebp = (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP';
const solid = (w, h, c) => sharp({ create: { width: w, height: h, channels: 4, background: c } }).png().toBuffer();

// Frame 0 solid red, frame 1 solid blue, bottom row transparent.
async function makeSheet() {
  const red = await solid(96, 128, { r: 255, g: 0, b: 0, alpha: 1 });
  const blue = await solid(96, 128, { r: 0, g: 0, b: 255, alpha: 1 });
  return sharp({ create: { width: 384, height: 256, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: red, left: 0, top: 0 }, { input: blue, left: 96, top: 0 }])
    .png().toBuffer();
}
const manifest = () => ({
  cell: [96, 128],
  frames: { 'idle/s/0': [0, 0, 96, 128], 'idle/s/1': [96, 0, 96, 128], 'walk/s/0': [0, 128, 96, 128] },
  quality: [{ x: 1 }],
});

test('shrinkImage caps longest edge and keeps aspect', async () => {
  const buf = await solid(944, 758, { r: 10, g: 20, b: 30, alpha: 1 });
  const r = await shrinkImage(buf, { maxEdge: 256 });
  assert.equal(r.width, 256);
  assert.equal(r.height, 206);
  assert.equal(r.srcWidth, 944);
  assert.equal(r.srcHeight, 758);
  assert.ok(isWebp(r.buffer));
  const m = await sharp(r.buffer).metadata();
  assert.equal(m.width, 256);
  assert.equal(m.height, 206);
});

test('shrinkImage never upscales', async () => {
  const buf = await solid(100, 80, { r: 1, g: 2, b: 3, alpha: 1 });
  const r = await shrinkImage(buf, { maxEdge: 256 });
  assert.equal(r.width, 100);
  assert.equal(r.height, 80);
  assert.ok(isWebp(r.buffer));
});

test('shrinkImage keeps alpha', async () => {
  const buf = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await solid(32, 32, { r: 0, g: 255, b: 0, alpha: 1 }), left: 32, top: 32 }])
    .png().toBuffer();
  const r = await shrinkImage(buf, { maxEdge: 32 });
  const { data } = await raw(r.buffer);
  assert.equal(data[3], 0, 'top-left corner stays transparent');
  assert.equal(data[data.length - 1], 255, 'bottom-right stays opaque');
});

test('shrinkImage rejects garbage with bad_image', async () => {
  await assert.rejects(shrinkImage(Buffer.from('not an image'), { maxEdge: 64 }),
    (e) => e instanceof ShrinkError && e.code === 'bad_image');
});

test('shrinkSheet scales cell and every frame', async () => {
  const r = await shrinkSheet(await makeSheet(), manifest(), { scale: 0.5 });
  assert.equal(r.width, 192);
  assert.equal(r.height, 128);
  assert.deepEqual(r.manifest.cell, [48, 64]);
  assert.deepEqual(r.manifest.frames['idle/s/0'], [0, 0, 48, 64]);
  assert.deepEqual(r.manifest.frames['idle/s/1'], [48, 0, 48, 64]);
  assert.deepEqual(r.manifest.frames['walk/s/0'], [0, 64, 48, 64]);
  assert.deepEqual(r.manifest.quality, [{ x: 1 }]);
  assert.ok(isWebp(r.buffer));
  const m = await sharp(r.buffer).metadata();
  assert.equal(m.width, 192);
  assert.equal(m.height, 128);
});

test('shrinkSheet does not mutate the input manifest', async () => {
  const mf = manifest();
  await shrinkSheet(await makeSheet(), mf, { scale: 0.5 });
  assert.deepEqual(mf, manifest());
});

test('shrinkSheet has no bleed between frames', async () => {
  const r = await shrinkSheet(await makeSheet(), manifest(), { scale: 0.5 });
  const { data, info } = await raw(r.buffer);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 48; x++) {
      assert.ok(data[(y * info.width + x) * 4 + 2] < 8, `blue leaked at ${x},${y}`);
    }
  }
});

test('shrinkSheet refuses fractional cells', async () => {
  await assert.rejects(shrinkSheet(await makeSheet(), manifest(), { scale: 0.3 }),
    (e) => e instanceof ShrinkError && e.code === 'fractional_cell');
});

test('shrinkStrip keeps width = frames x cell', async () => {
  const strip = await solid(768, 128, { r: 5, g: 5, b: 5, alpha: 1 });
  const r = await shrinkStrip(strip, 6, { scale: 0.5 });
  assert.equal(r.width, 384);
  assert.equal(r.height, 64);
  assert.ok(isWebp(r.buffer));
  await assert.rejects(shrinkStrip(strip, 6, { scale: 0.3 }),
    (e) => e instanceof ShrinkError && e.code === 'fractional_cell');
});

test('scale 1.0 converts format only', async () => {
  const sheet = await makeSheet();
  const r = await shrinkSheet(sheet, manifest(), { scale: 1 });
  assert.equal(r.width, 384);
  assert.equal(r.height, 256);
  assert.deepEqual(r.manifest, manifest());
  assert.ok(isWebp(r.buffer));
});
