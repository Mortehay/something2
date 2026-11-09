// Lays out a build's passive route on the REAL passive tree.
//
// A route is "the order to take 150 nodes, each one touching a node already taken" (the start node is
// free and is not part of it). The generator below walks the actual graph, so every step is reachable
// when the player gets to it -- unlike a hand-written list, it cannot name a node that is not adjacent.
//
// How a build picks nodes: each build gives WEIGHTS (what it values: STR, crit, hp regen, fire damage...).
// A node's score is the weighted sum of what it grants. The route grows greedily: at every step, find
// the unowned node with the best "value per node spent" counting the nodes on the way to it, and take
// that whole path. That is what makes a build walk through a run of weak minor nodes to reach a strong
// notable or keystone, instead of nibbling the best adjacent node forever.

// Each rule's value, turned into "percent-like" points so weights are comparable across rules.
// `inverse` rules are better when LOWER (cost and cooldown multipliers).
const PCT = (v) => v * 100;
const MULT = (v) => (v - 1) * 100;
const INV = (v) => (1 - v) * 100;
const RULE_POINTS = {
  critChance: PCT, critDamage: PCT, dodgeChance: PCT, dodgeRiposte: PCT, stunChance: PCT,
  strengthSkillDamage: PCT, dexteritySkillDamage: PCT, constitutionSkillDamage: PCT,
  intelligenceSkillDamage: PCT, wisdomSkillDamage: PCT, charismaSkillDamage: PCT,
  fullManaDamage: PCT, lowLifeDamage: PCT, formPower: PCT, regenLifeShare: PCT, skillLeech: PCT,
  killHeal: PCT, meleeWaveShare: PCT, reflectShare: PCT,
  attackSpeedMult: MULT, castSpeedMult: MULT, aoeRadiusMult: MULT, projectileSpeedMult: MULT, skillDamageMult: MULT,
  skillCooldownMult: INV, manaCostMult: INV, staminaCostMult: INV, lifeCostMultiplier: INV,
  meleeDamageMult: MULT,
};

// Points one grant is worth to a build with these weights.
//   weights: { stat:{strength:1,...}, pool:{hp,mana,stamina}, damage:{physical,...}, resist:{...},
//              rule:{critChance:4,...}, status:{burn:..} , other: 0.02 }
export function grantScore(g, weights) {
  const w = weights;
  const v = Number(g.value) || 0;
  switch (g.type) {
    case 'stat': return v * (w.stat?.[g.stat] ?? w.stat?.default ?? 0.05);
    case 'resource': return (v / 10) * (w.pool?.[g.pool] ?? 0.02);
    case 'damage': return v * (w.damage?.[g.element] ?? w.damage?.default ?? 0.05);
    case 'resist': return v * (w.resist?.[g.element] ?? w.resist?.default ?? 0.05);
    case 'rule': {
      const weight = w.rule?.[g.rule] ?? 0;
      if (!weight) return 0;
      const pts = (RULE_POINTS[g.rule] || ((x) => x))(v);
      return pts * weight;
    }
    case 'status': return (w.status?.[g.status] ?? 0) * 10;
    default: return 0;
  }
}

export function nodeScore(node, weights, must) {
  let s = 0;
  for (const g of node.grants || []) s += grantScore(g, weights);
  if (must && must.has(node.key)) s += 1000;
  return s;
}

export function buildGraph(tree) {
  const nodes = new Map(tree.nodes.map((n) => [n.key, n]));
  const adj = new Map();
  for (const k of nodes.keys()) adj.set(k, []);
  for (const [a, b] of tree.edges) {
    if (!adj.has(a) || !adj.has(b)) continue;
    adj.get(a).push(b);
    adj.get(b).push(a);
  }
  return { nodes, adj };
}

// Returns the route: an array of node keys in take order (start node excluded).
export function buildRoute(graph, { startKey, weights, must = [], total = 150 }) {
  const { nodes, adj } = graph;
  const mustSet = new Set(must);
  const score = new Map();
  for (const [k, n] of nodes) score.set(k, n.kind === 'start' ? 0 : nodeScore(n, weights, mustSet));

  const owned = new Set([startKey]);
  const route = [];
  while (route.length < total) {
    const remaining = total - route.length;
    const dist = new Map();
    const val = new Map();
    const parent = new Map();
    let layer = [];
    for (const o of owned) {
      for (const v of adj.get(o)) {
        if (owned.has(v) || nodes.get(v).kind === 'start' || dist.has(v)) continue;
        dist.set(v, 1); val.set(v, score.get(v)); parent.set(v, null); layer.push(v);
      }
    }
    for (let d = 1; d < remaining && layer.length; d += 1) {
      const next = [];
      for (const u of layer) {
        for (const v of adj.get(u)) {
          if (owned.has(v) || nodes.get(v).kind === 'start') continue;
          const cand = val.get(u) + score.get(v);
          if (!dist.has(v)) {
            dist.set(v, d + 1); val.set(v, cand); parent.set(v, u); next.push(v);
          } else if (dist.get(v) === d + 1 && cand > val.get(v)) {
            val.set(v, cand); parent.set(v, u);
          }
        }
      }
      layer = next;
    }
    let best = null;
    let bestRatio = -Infinity;
    for (const [k, d] of dist) {
      if (d > remaining) continue;
      const ratio = val.get(k) / d;
      if (ratio > bestRatio + 1e-9 || (Math.abs(ratio - bestRatio) <= 1e-9 && d < dist.get(best))) { best = k; bestRatio = ratio; }
    }
    if (best == null) throw new Error(`no reachable node after ${route.length} steps`);
    const chain = [];
    for (let k = best; k != null; k = parent.get(k)) chain.push(k);
    chain.reverse();                       // nearest to the owned set first
    for (const k of chain) { owned.add(k); route.push(k); }
  }
  return route.slice(0, total);
}

// Sums what a prefix of the route grants, for the milestone lines.
export function sumGrants(graph, keys) {
  const out = { stat: {}, pool: {}, damage: {}, resist: {}, rule: {} };
  const add = (bucket, k, v) => { bucket[k] = (bucket[k] || 0) + v; };
  for (const key of keys) {
    for (const g of graph.nodes.get(key).grants || []) {
      const v = Number(g.value) || 0;
      if (g.type === 'stat') add(out.stat, g.stat, v);
      else if (g.type === 'resource') add(out.pool, g.pool, v);
      else if (g.type === 'damage') add(out.damage, g.element, v);
      else if (g.type === 'resist') add(out.resist, g.element, v);
      else if (g.type === 'rule') add(out.rule, g.rule, v);
    }
  }
  return out;
}
