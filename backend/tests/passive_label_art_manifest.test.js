// SOMET-672: passive node icons are looked up by label text, and the seeder
// replays the checked-in manifest. When the generator's labels changed
// (35961d34, then the v2 tree), the manifest silently kept the old keys and a
// fresh `seed-passive-tree --force` + `art-seed` left every keystone without an
// icon, while the dev DB (old rows still present) hid the gap. This test reads
// only checked-in files, so it fails on a machine with no DB or GPU.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { generatePassiveTree } = require('../seeds/generatePassiveTree.js');
const { PASSIVE_TREE_SPEC } = require('../seeds/data/passiveTree.js');

const TEXTURES = path.join(__dirname, '../seeds/textures');
const manifest = JSON.parse(fs.readFileSync(path.join(TEXTURES, 'passives.json'), 'utf8'));
const { nodes } = generatePassiveTree(PASSIVE_TREE_SPEC);

test('the generator produces labels to check (guards against an empty tree)', () => {
  assert.ok(nodes.length > 1000, `only ${nodes.length} nodes`);
  assert.ok(nodes.some((n) => n.kind === 'keystone'));
});

test('every generated node label has a passives.json entry', () => {
  const keys = new Set(manifest.map((e) => e.key));
  const missing = new Map();
  for (const n of nodes) {
    if (!keys.has(n.label)) missing.set(n.label, n.kind);
  }
  assert.deepEqual(
    [...missing].map(([label, kind]) => `${kind}: ${label}`),
    [],
    'labels with no checked-in art; run `make art-export KIND=passive_label` '
      + '(generate the art first if the DB lacks it)',
  );
});

test('every manifest entry points at a PNG that is checked in', () => {
  const gone = manifest
    .filter((e) => !fs.existsSync(path.join(TEXTURES, 'passives', e.file)))
    .map((e) => e.key);
  assert.deepEqual(gone, []);
});
