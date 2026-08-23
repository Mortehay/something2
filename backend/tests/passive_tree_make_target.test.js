// backend/tests/passive_tree_make_target.test.js
//
// A make target is the documented way to run the seeder, so a missing or
// misspelled one is a real defect -- and the only place it can be caught
// without a container is the Makefile's own text (compose/orangepi's
// Caddyfile test takes the same route for the same reason).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const makefile = fs.readFileSync(path.resolve(__dirname, '../../Makefile'), 'utf8');

test('seed-passive-tree is declared .PHONY', () => {
  const phony = makefile.slice(0, makefile.indexOf('COMPOSE_FILE'));
  assert.ok(/\bseed-passive-tree\b/.test(phony),
    'seed-passive-tree missing from the .PHONY list -- a stray file of that name would shadow the target');
});

test('seed-passive-tree runs the seeder inside the backend container', () => {
  const target = makefile.match(/^seed-passive-tree:\n((?:\t.*\n)+)/m);
  assert.ok(target, 'no seed-passive-tree target found');
  assert.match(target[1], /node scripts\/seed-passive-tree\.js/);
  assert.match(target[1], /exec -T backend/);
});

test('FORCE=1 is the way to overwrite admin edits, and is off by default', () => {
  const target = makefile.match(/^seed-passive-tree:\n((?:\t.*\n)+)/m);
  assert.match(target[1], /--force/);
  assert.match(target[1], /FORCE/);
});
