// backend/tests/vfx_sprite.test.js
// Sprite sheets for attack effects: the field rules, the PNG inspection behind the upload route,
// and (as source guards, like vfx_admin_crud.test.js) that the upload is admin-only, parsed
// after the guard, and that both writes carry the sprite columns.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  spriteFieldsError, spriteValues, inspectPng, MAX_FRAMES, MAX_SIZE, MAX_BYTES,
} = require('../src/services/vfxSprite.js');

const KEY = 'vfx/0b7e2f6e-1c3a-4d52-9a47-6f1d2c3b4a5e.png';

// A PNG header (signature + IHDR) of the given size; enough for inspectPng, which reads no further.
function png(width, height, pad = 0) {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

test('an effect with no sprite fields is valid (every old row, every old caller)', () => {
  assert.equal(spriteFieldsError({}), null);
  assert.equal(spriteFieldsError({ sprite_image: null, sprite_frames: 1, sprite_size: 0 }), null);
  assert.equal(spriteFieldsError({ sprite_image: '' }), null);
});

test('sprite_image must be a key the upload issued, never a path or URL', () => {
  assert.equal(spriteFieldsError({ sprite_image: KEY }), null);
  for (const bad of ['http://evil/x.png', '../secrets.png', 'sprites/objects/Wolf/static.png', 'vfx/x.png',
    `${KEY}?x=1`, 'vfx/0b7e2f6e-1c3a-4d52-9a47-6f1d2c3b4a5e.svg']) {
    assert.match(spriteFieldsError({ sprite_image: bad }), /sprite_image/, bad);
  }
});

test('frames and size are bounded', () => {
  assert.match(spriteFieldsError({ sprite_frames: 0 }), /sprite_frames/);
  assert.match(spriteFieldsError({ sprite_frames: 2.5 }), /sprite_frames/);
  assert.match(spriteFieldsError({ sprite_frames: MAX_FRAMES + 1 }), /sprite_frames/);
  assert.equal(spriteFieldsError({ sprite_frames: MAX_FRAMES }), null);
  assert.match(spriteFieldsError({ sprite_size: -1 }), /sprite_size/);
  assert.match(spriteFieldsError({ sprite_size: MAX_SIZE + 1 }), /sprite_size/);
  assert.match(spriteFieldsError({ sprite_size: 'big' }), /sprite_size/);
  assert.equal(spriteFieldsError({ sprite_size: MAX_SIZE }), null);
});

test('spriteValues are in column order, with safe defaults', () => {
  assert.deepEqual(spriteValues({}), [null, 1, 0, false, false, null, false]);
  assert.deepEqual(spriteValues({ sprite_image: KEY, sprite_frames: 8, sprite_size: 320, sprite_additive: true }), [KEY, 8, 320, true, false, null, false]);
  assert.deepEqual(spriteValues({ sprite_image: '', sprite_additive: 'yes' }), [null, 1, 0, false, false, null, false], 'only a real true switches glow on');
});

test('inspectPng reads the real dimensions of a PNG', () => {
  assert.deepEqual(inspectPng(png(256, 64)), { width: 256, height: 64 });
});

test('inspectPng refuses what is not a usable PNG, with a status', () => {
  assert.equal(inspectPng(Buffer.alloc(0)).status, 400);
  assert.equal(inspectPng('not a buffer').status, 400);
  assert.match(inspectPng(Buffer.from('GIF89a'.repeat(10))).error, /PNG/);
  const noIhdr = png(10, 10);
  noIhdr.write('IDAT', 12, 'ascii');
  assert.match(inspectPng(noIhdr).error, /PNG/);
  assert.match(inspectPng(png(0, 10)).error, /pixels/);
  assert.match(inspectPng(png(10, 0)).error, /pixels/);
  assert.match(inspectPng(png(8193, 10)).error, /pixels/);
  assert.match(inspectPng(png(10, 2049)).error, /pixels/);
  const big = inspectPng(png(10, 10, MAX_BYTES));
  assert.equal(big.status, 413);
  assert.match(big.error, /KB/);
});

// ---- source guards -------------------------------------------------------------------------

const src = fs.readFileSync(path.resolve(__dirname, '../src/index.js'), 'utf8');

test('the sprite upload is admin-only and parses its own, larger body after the guard', () => {
  const i = src.indexOf("app.post('/api/vfx-effects/sprite'");
  assert.ok(i > -1, 'upload route missing');
  const decl = src.slice(i, i + 140);
  assert.match(decl, /adminGuard, express\.json\(\{ limit: '1mb' \}\)/, 'guard first, then its own parser');
  // The global 256kb parser must step aside for exactly this path, or the upload is a 413 before it starts.
  assert.match(src, /VFX_SPRITE_PATH = '\/api\/vfx-effects\/sprite'/);
  assert.match(src, /req\.path === VFX_SPRITE_PATH/);
});

test('the upload route is registered before the generic /:id routes and stores under vfx/', () => {
  const upload = src.indexOf("app.post('/api/vfx-effects/sprite'");
  const create = src.indexOf("app.post('/api/vfx-effects', adminGuard");
  assert.ok(upload > -1 && create > upload);
  const body = src.slice(upload, create);
  assert.match(body, /vfx\/\$\{require\('crypto'\)\.randomUUID\(\)\}\.png/);
  assert.match(body, /assetStore\.putObject\(key, buf, 'image\/png'\)/);
});

test('both writes persist the sprite columns, and validation covers them', () => {
  const create = src.slice(src.indexOf("app.post('/api/vfx-effects', adminGuard"), src.indexOf("app.put('/api/vfx-effects/:id'"));
  const update = src.slice(src.indexOf("app.put('/api/vfx-effects/:id'"), src.indexOf("app.delete('/api/vfx-effects/:id'"));
  assert.match(create, /sprite_image, sprite_frames, sprite_size, sprite_additive/);
  assert.match(create, /\.\.\.vfxSpriteValues\(b\)/);
  assert.match(update, /sprite_image=\$15, sprite_frames=\$16, sprite_size=\$17, sprite_additive=\$18/);
  assert.match(update, /\.\.\.vfxSpriteValues\(b\), req\.params\.id/);
  assert.match(src.slice(src.indexOf('function validateVfxEffect'), src.indexOf('async function vfxReferences')), /return vfxSpriteError\(body\)/);
});

test('sprite_fps: empty or (0, 60]', () => {
  assert.equal(spriteFieldsError({ sprite_fps: null }), null);
  assert.equal(spriteFieldsError({ sprite_fps: '' }), null);
  assert.equal(spriteFieldsError({ sprite_fps: 12 }), null);
  assert.equal(spriteFieldsError({ sprite_fps: 60 }), null);
  assert.match(spriteFieldsError({ sprite_fps: 0 }), /sprite_fps/);
  assert.match(spriteFieldsError({ sprite_fps: 61 }), /sprite_fps/);
});
test('sprite_loop / sprite_stretch must be booleans', () => {
  assert.match(spriteFieldsError({ sprite_loop: 'yes' }), /sprite_loop must be true or false/);
  assert.match(spriteFieldsError({ sprite_stretch: 1 }), /sprite_stretch must be true or false/);
});
test('spriteValues appends loop, fps, stretch in column order', () => {
  assert.deepEqual(spriteValues({ sprite_image: 'vfx/' + 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12) + '.png',
    sprite_frames: 4, sprite_loop: true, sprite_fps: 12, sprite_stretch: true }).slice(4), [true, 12, true]);
  assert.deepEqual(spriteValues({}).slice(4), [false, null, false]);
});

// Task 7: a seeded PC holds the key uploadGitAssets wrote (<bucket>/seedsync/<sha256>/<file>.png);
// the VFX tab must still be able to save that row. Free-form paths and URLs stay rejected.
test('a seed-synced key is a valid sprite_image; arbitrary paths are not', () => {
  assert.equal(spriteFieldsError({ sprite_image: `sprites/seedsync/${'a'.repeat(64)}/textures_vfx_bolt_fire.png` }), null);
  assert.match(spriteFieldsError({ sprite_image: 'https://evil/x.png' }), /sprite_image/);
  assert.match(spriteFieldsError({ sprite_image: '../vfx/x.png' }), /sprite_image/);
  assert.match(spriteFieldsError({ sprite_image: `sprites/seedsync/${'a'.repeat(63)}/x.png` }), /sprite_image/);
  assert.match(spriteFieldsError({ sprite_image: `sprites/seedsync/${'a'.repeat(64)}/../x.png` }), /sprite_image/);
  assert.match(spriteFieldsError({ sprite_image: `sprites/seedsync/${'a'.repeat(64)}/x.jpg` }), /sprite_image/);
});
