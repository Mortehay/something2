const test = require('node:test');
const assert = require('node:assert/strict');
const { generatePassiveTree } = require('../seeds/generatePassiveTree.js');
const { PASSIVE_TREE_SPEC } = require('../seeds/data/passiveTree.js');

test('Asymmetrical Passive Tree layout generation and zero node overlapping', () => {
  const tree = generatePassiveTree(PASSIVE_TREE_SPEC);
  assert.ok(tree.nodes.length > 0, 'Tree should have nodes');

  // 1. Verify ZERO overlapping nodes
  const R = { minor: 7, notable: 12, greater: 15, keystone: 18, start: 16 };
  const overlappingPairs = [];

  for (let i = 0; i < tree.nodes.length; i++) {
    const a = tree.nodes[i];
    const ra = R[a.kind] || 7;
    for (let j = i + 1; j < tree.nodes.length; j++) {
      const b = tree.nodes[j];
      const rb = R[b.kind] || 7;
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      const minRequired = ra + rb;
      if (d < minRequired) {
        overlappingPairs.push({ a: a.key, b: b.key, dist: d, minRequired });
      }
    }
  }

  assert.strictEqual(overlappingPairs.length, 0, `Expected 0 overlapping nodes, found ${overlappingPairs.length}`);

  // 2. Verify sector asymmetry (sector bounding distances / radii differ organically across sectors)
  const sectorRadii = {};
  for (const n of tree.nodes) {
    if (n.sector && n.sector !== 'core') {
      const dist = Math.hypot(n.x, n.y);
      if (!sectorRadii[n.sector]) sectorRadii[n.sector] = [];
      sectorRadii[n.sector].push(dist);
    }
  }

  const sectorAvgRadii = {};
  for (const [sec, list] of Object.entries(sectorRadii)) {
    const sum = list.reduce((a, b) => a + b, 0);
    sectorAvgRadii[sec] = Math.round(sum / list.length);
  }

  // Check that sector average radii are not identical across all sectors
  const uniqueAverages = new Set(Object.values(sectorAvgRadii));
  assert.ok(uniqueAverages.size > 1, 'Passive tree sectors should have asymmetric, organic radii variations');
});
