const test = require('node:test');
const assert = require('node:assert');
const { generatePassiveTree } = require('../seeds/generatePassiveTree.js');
const { PASSIVE_TREE_SPEC } = require('../seeds/data/passiveTree.js');

test('passive tree planarity and overlap validation', () => {
  const tree = generatePassiveTree(PASSIVE_TREE_SPEC);
  const nodeMap = new Map(tree.nodes.map(n => [n.key, n]));

  function ccw(a, b, c) { return (c.y - a.y) * (b.x - a.x) > (b.y - a.y) * (c.x - a.x); }
  function intersect(p1, q1, p2, q2) {
    return (ccw(p1, p2, q2) !== ccw(q1, p2, q2)) && (ccw(p1, q1, p2) !== ccw(p1, q1, q2));
  }

  const badEdges = [];
  for (let i = 0; i < tree.edges.length; i++) {
    const p1 = nodeMap.get(tree.edges[i][0]);
    const q1 = nodeMap.get(tree.edges[i][1]);
    for (let j = i + 1; j < tree.edges.length; j++) {
      if (tree.edges[i][0] === tree.edges[j][0] || tree.edges[i][0] === tree.edges[j][1] || tree.edges[i][1] === tree.edges[j][0] || tree.edges[i][1] === tree.edges[j][1]) continue;
      const p2 = nodeMap.get(tree.edges[j][0]);
      const q2 = nodeMap.get(tree.edges[j][1]);
      if (intersect(p1, q1, p2, q2)) {
        badEdges.push([tree.edges[i], tree.edges[j]]);
      }
    }
  }

  const badNodes = [];
  const R = { minor: 7, notable: 12, keystone: 18, start: 16 };
  for (let i = 0; i < tree.nodes.length; i++) {
    for (let j = i + 1; j < tree.nodes.length; j++) {
      const a = tree.nodes[i], b = tree.nodes[j];
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      const min = (R[a.kind] || 7) + (R[b.kind] || 7);
      if (d < min) {
        badNodes.push([a.key, b.key, d, min]);
      }
    }
  }

  console.log(`Bad edges count: ${badEdges.length}`);
  if (badEdges.length > 0) console.log('Sample bad edges:', badEdges.slice(0, 5));
  console.log(`Bad nodes count: ${badNodes.length}`);
  if (badNodes.length > 0) console.log('Sample bad nodes:', badNodes.slice(0, 5));
});
