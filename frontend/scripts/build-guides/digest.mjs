// Prints what each build's route picks, so the weights can be judged by eye.
//   npx vite-node scripts/build-guides/digest.mjs [variantId]
import fs from 'node:fs';
import { buildGraph, buildRoute, sumGrants } from './path.mjs';
import { WEIGHTS } from './weights.mjs';

const tree = JSON.parse(fs.readFileSync(new URL('./.tree.json', import.meta.url), 'utf8'));
const graph = buildGraph(tree);
const only = process.argv[2];

const fmtSum = (s) => {
  const parts = [];
  for (const [k, v] of Object.entries(s.stat)) if (v) parts.push(`${k.slice(0, 3).toUpperCase()} ${v}`);
  for (const [k, v] of Object.entries(s.pool)) if (v) parts.push(`${k} ${v}`);
  const dmg = Object.entries(s.damage).filter(([, v]) => v).map(([k, v]) => `${k} +${v}%`).join(' ');
  if (dmg) parts.push(dmg);
  return parts.join(' · ');
};

for (const [id, w] of Object.entries(WEIGHTS)) {
  if (only && id !== only) continue;
  const route = buildRoute(graph, { startKey: w.startKey, weights: w, must: w.must, total: 150 });
  console.log(`\n=== ${id}  (${route.length} steps, unique ${new Set(route).size})`);
  const kinds = {};
  route.forEach((k) => { const n = graph.nodes.get(k); kinds[n.kind] = (kinds[n.kind] || 0) + 1; });
  console.log('kinds:', JSON.stringify(kinds));
  route.forEach((k, i) => {
    const n = graph.nodes.get(k);
    if (n.kind === 'keystone' || n.kind === 'greater') console.log(`  ${String(i + 1).padStart(3)} ${n.kind.padEnd(8)} ${n.label.slice(0, 90)}`);
  });
  const notables = route.map((k, i) => [i + 1, graph.nodes.get(k)]).filter(([, n]) => n.kind === 'notable').map(([i, n]) => `${i}:${n.label}`);
  console.log('  notables:', notables.slice(0, 40).join(' | '));
  for (const at of [30, 60, 100, 150]) console.log(`  @${at}: ${fmtSum(sumGrants(graph, route.slice(0, at)))}`);
}
