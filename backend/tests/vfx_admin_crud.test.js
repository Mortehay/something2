const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Slice E (SOMET-162): admin CRUD for vfx_effects.
//
// These are SOURCE-LEVEL guards, in the style of clear_maps.test.js: index.js
// builds its Express app at require time against a live pool, so mounting it
// here would need a database. What must not silently regress is (a) that every
// write is behind adminGuard, (b) that validation happens before the database
// sees the row, and (c) that the orphan guard exists on BOTH rename and
// delete -- the asymmetry SOMET-238 already had to fix once for tile types.
const src = fs.readFileSync(path.resolve(__dirname, '../src/index.js'), 'utf8');

// The three write routes, and the read route that must stay open.
const WRITE_ROUTES = [
  ["app.post('/api/vfx-effects'", 'create'],
  ["app.put('/api/vfx-effects/:id'", 'update'],
  ["app.delete('/api/vfx-effects/:id'", 'delete'],
];

test('every vfx-effects WRITE route is behind adminGuard', () => {
  for (const [route, verb] of WRITE_ROUTES) {
    const i = src.indexOf(route);
    assert.ok(i > -1, `${verb} route is missing entirely`);
    // The guard must be the argument immediately after the path -- a guard
    // placed later in the chain runs after the handler body has already read
    // req.body, and one omitted entirely is an unauthenticated write.
    const decl = src.slice(i, i + route.length + 40);
    assert.match(decl, /adminGuard/, `${verb} route does not name adminGuard`);
  }
});

test('the READ route stays open, like the other catalogs', () => {
  const i = src.indexOf("app.get('/api/vfx-effects'");
  assert.ok(i > -1);
  assert.doesNotMatch(src.slice(i, i + 60), /adminGuard/,
    'the client fetches the effect library on every join; guarding it would break rendering');
});

test('enum and particle_count validation runs BEFORE any write', () => {
  // The database CHECKs are the backstop, not the UX: a raw constraint
  // violation reaches the admin as a 500 with a Postgres string in it.
  assert.match(src, /const VFX_SHAPES = \['arc', 'line', 'ring', 'burst', 'bolt'\]/);
  assert.match(src, /const VFX_EASES = \['linear', 'out', 'in'\]/);
  assert.match(src, /VFX_MAX_PARTICLES = 64/);

  const fn = src.slice(src.indexOf('function validateVfxEffect'), src.indexOf('async function vfxReferences'));
  assert.match(fn, /shape must be one of/);
  assert.match(fn, /ease must be one of/);
  assert.match(fn, /particle_count must be a whole number/);
  assert.match(fn, /particle_lifetime_ms must be greater than 0/);

  // Called first thing in both write handlers, before the INSERT/UPDATE.
  for (const [route] of WRITE_ROUTES.slice(0, 2)) {
    const body = src.slice(src.indexOf(route));
    const validateAt = body.indexOf('validateVfxEffect');
    const writeAt = Math.min(
      ...[body.indexOf('INSERT INTO vfx_effects'), body.indexOf('UPDATE vfx_effects')]
        .filter((n) => n > -1),
    );
    assert.ok(validateAt > -1 && validateAt < writeAt,
      'validation must run before the statement, not after the database rejects it');
  }
});

test('the orphan guard covers BOTH rename and delete', () => {
  // Renaming an effect silently orphans every binding pointing at it --
  // item_types.vfx and entity_types.vfx are jsonb with no FK, which the design
  // accepted explicitly. Guarding rename but not delete is exactly the
  // asymmetry SOMET-238 had to fix for tile types; not repeating it.
  const put = src.slice(src.indexOf("app.put('/api/vfx-effects/:id'"), src.indexOf("app.delete('/api/vfx-effects/:id'"));
  assert.match(put, /vfxReferences\(/, 'rename is unguarded');
  assert.match(put, /oldName !== newName/, 'the guard must only fire on an ACTUAL rename');

  const del = src.slice(src.indexOf("app.delete('/api/vfx-effects/:id'"));
  assert.match(del.slice(0, 900), /vfxReferences\(/, 'delete is unguarded');
});

test('the orphan check looks at BOTH binding tables', () => {
  // item_types.vfx binds weapons, entity_types.vfx binds creatures (slice D).
  // Checking only one would let a rename break every creature binding.
  const fn = src.slice(src.indexOf('async function vfxReferences'), src.indexOf('function orphanConflict'));
  assert.match(fn, /FROM item_types/);
  assert.match(fn, /FROM entity_types/);
  // Matched by VALUE across every moment key, not by a guessed key name: a
  // binding can name the effect under attack, miss, impact or trail.
  assert.match(fn, /jsonb_each_text/);
});

test('the conflict response names what is still bound', () => {
  // A 409 saying only "cannot delete" leaves the admin with no way to find the
  // bindings blocking them.
  const fn = src.slice(src.indexOf('function orphanConflict'), src.indexOf("app.post('/api/vfx-effects'"));
  assert.match(fn, /409/);
  assert.match(fn, /referencing_item_types/);
  assert.match(fn, /referencing_entity_types/);
});
