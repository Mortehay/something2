// backend/seeds/generatePassiveTree.js
//
// Expands the authored spec in data/passiveTree.js into the ~1800 rows the
// database holds. PURE, and deterministic in the strongest sense the contract
// asks for: no Math.random(), no Date.now(), no Object key iteration whose
// order is not fixed by an array in the spec. Two runs are byte-identical, so
// a tree change is a reviewable diff.
//
// SHAPE (spec §5.2). A shared core disc, six 60-degree sectors radiating out
// of it, three ring bands per sector. Each ring band is a rows x cols polar
// grid: rows are concentric arcs, columns are angular positions.
//
// EDGES. Rows are paths (col j <-> col j+1). Rungs join row i to row i+1 every
// LAYOUT.rungStride columns STARTING AT COLUMN 0 -- starting at 0 is what makes
// every row reachable from row 0, and therefore what makes the whole ring
// reachable from the one edge that enters it. Three transition edges carry each
// ring to the next at its left edge, middle and right edge, so a player has
// real routing choice rather than a single mandatory corridor.
const DEG = Math.PI / 180;

// Math.round(-0.4) is -0. -0 serialises to 0 in JSON but compares false under
// Object.is, so a determinism test that uses Object.is (and the one next door
// does) would flag it. `|| 0` normalises it before the divide.
function round2(v) {
  return (Math.round(v * 100) || 0) / 100;
}

function polar(radius, angleDeg) {
  return {
    x: round2(radius * Math.cos(angleDeg * DEG)),
    y: round2(radius * Math.sin(angleDeg * DEG)),
  };
}

// `count` positions spread evenly over `total` slots, each at the centre of
// its share. Integer arithmetic on the same inputs every time -- no rng, no
// accumulating float drift.
function spreadIndices(total, count) {
  const out = [];
  for (let k = 0; k < count; k += 1) out.push(Math.floor(((k + 0.5) * total) / count));
  return out;
}

// Which flat index in a ring gets which kind. Keystones are placed first (they
// are the scarcest and the most position-sensitive), then notables, then
// everything else is a minor. The forward-scan collision handling is a safety
// net rather than the mechanism: with the authored numbers the placements do
// not collide, and the guard test's exact per-kind counts would fail loudly if
// a future retune made them collide in a way this loop could not resolve.
function ringKinds(total, notableCount, keystoneCount, layout) {
  const kinds = new Array(total).fill('minor');
  const taken = new Set();
  const place = (raw, kind) => {
    let i = ((raw % total) + total) % total;
    while (taken.has(i)) i = (i + 1) % total;
    taken.add(i);
    kinds[i] = kind;
  };
  spreadIndices(total, keystoneCount).forEach((i, k) => {
    // Without the offset and stagger, total/count divides evenly for both
    // rings that carry keystones, so every keystone in a sector would land in
    // the same column -- one radial line of keystones and nothing elsewhere.
    place(i + layout.keystoneOffset + k * layout.keystoneStagger, 'keystone');
  });
  spreadIndices(total, notableCount).forEach((i) => place(i, 'notable'));
  return kinds;
}

// `sectors: '*'` means every stat sector and never the core: a core node has
// no sector stat, so a '@sector' template would have nothing to substitute.
function templatePool(templates, kind, sector, ring) {
  return templates.filter((t) => t.kind === kind
    && (t.sectors === '*' ? sector !== 'core' : t.sectors.includes(sector))
    && t.rings.includes(ring));
}

// Fresh objects every time: the same template object serves ~100 nodes, and a
// shared reference would let one admin edit (or one test mutation) rewrite
// every node built from that template.
function grantsFor(template, sector) {
  return template.grants.map((g) => (g.stat === '@sector' ? { ...g, stat: sector } : { ...g }));
}

function generatePassiveTree(spec) {
  const { sectors, layout, templates, keystones, startNodes } = spec;
  const nodes = [];
  const edgeKeys = new Set();

  // '|' separator: every generated key is lowercase letters, digits and
  // dashes, so a pipe cannot occur inside one and the join is unambiguous.
  // (Do NOT reach for a control character here: a NUL in a source file makes
  // grep treat the whole file as binary and skip it silently.)
  const addEdge = (a, b) => {
    if (a === b) return;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    edgeKeys.add(`${lo}|${hi}`);
  };

  const push = (n) => { nodes.push(n); return n.key; };

  // ---- core -------------------------------------------------------------
  const corePool = templatePool(templates, 'minor', 'core', 0);
  const rowA = [];
  for (let i = 0; i < layout.core.rowA.count; i += 1) {
    const t = corePool[i % corePool.length];
    const { x, y } = polar(layout.core.rowA.radius,
      layout.sectorAxisDeg0 + (i * 360) / layout.core.rowA.count);
    rowA.push(push({
      key: `core-a-${i}`, sector: 'core', ring: 0, x, y,
      kind: 'minor', label: t.label, grants: grantsFor(t, 'core'), start_class: null,
    }));
  }
  const rowB = [];
  for (let k = 0; k < layout.core.rowB.count; k += 1) {
    const t = corePool[k % corePool.length];
    const { x, y } = polar(layout.core.rowB.radius,
      layout.sectorAxisDeg0 + (k * 360) / layout.core.rowB.count);
    rowB.push(push({
      key: `core-b-${k}`, sector: 'core', ring: 0, x, y,
      kind: 'minor', label: t.label, grants: grantsFor(t, 'core'), start_class: null,
    }));
  }
  // Row A is a cycle, row B is a cycle, and six spokes tie them together. Two
  // cycles plus the spokes is what makes the core a single component that
  // every sector can cross to reach every other sector.
  const spokeStep = layout.core.rowB.count / layout.core.rowA.count; // 24 / 6 = 4
  for (let i = 0; i < rowA.length; i += 1) {
    addEdge(rowA[i], rowA[(i + 1) % rowA.length]);
    addEdge(rowA[i], rowB[i * spokeStep]);
  }
  for (let k = 0; k < rowB.length; k += 1) addEdge(rowB[k], rowB[(k + 1) % rowB.length]);

  // ---- sectors ----------------------------------------------------------
  for (let s = 0; s < sectors.length; s += 1) {
    const sector = sectors[s].key;
    const axis = layout.sectorAxisDeg0 + s * 60;
    const half = layout.sectorSpanDeg / 2;

    const startDef = startNodes.find((n) => n.sector === sector);
    const sp = polar(layout.startRadius, axis);
    // ring 0 means "not in a ring band" -- the core and the six starts. The
    // start node is GRANTED rather than allocated, so it grants nothing.
    const startKey = push({
      key: `start-${sector}`, sector, ring: 0, x: sp.x, y: sp.y,
      kind: 'start', label: startDef.label, grants: [], start_class: startDef.start_class,
    });
    addEdge(startKey, rowB[s * spokeStep]);

    const keys = {};
    let keystoneSeq = 0;
    for (let ring = 1; ring <= 3; ring += 1) {
      const rg = layout.rings[ring];
      const total = rg.rows * rg.cols;
      const kinds = ringKinds(total, rg.notable, rg.keystone, layout);
      keys[ring] = [];
      for (let row = 0; row < rg.rows; row += 1) {
        keys[ring][row] = [];
        for (let col = 0; col < rg.cols; col += 1) {
          const flat = row * rg.cols + col;
          const kind = kinds[flat];
          const angle = axis - half + (col * layout.sectorSpanDeg) / (rg.cols - 1);
          const { x, y } = polar(rg.baseRadius + row * rg.rowStep, angle);
          let label;
          let grants;
          if (kind === 'keystone') {
            const ks = keystones[sector][keystoneSeq];
            keystoneSeq += 1;
            label = ks.label;
            grants = ks.grants.map((g) => ({ ...g }));
          } else {
            const pool = templatePool(templates, kind, sector, ring);
            const t = pool[flat % pool.length];
            label = t.label;
            grants = grantsFor(t, sector);
          }
          keys[ring][row][col] = push({
            key: `${sector}-r${ring}-${row}-${col}`, sector, ring, x, y,
            kind, label, grants, start_class: null,
          });
        }
      }
      for (let row = 0; row < rg.rows; row += 1) {
        for (let col = 0; col + 1 < rg.cols; col += 1) {
          addEdge(keys[ring][row][col], keys[ring][row][col + 1]);
        }
      }
      for (let row = 0; row + 1 < rg.rows; row += 1) {
        for (let col = 0; col < rg.cols; col += layout.rungStride) {
          addEdge(keys[ring][row][col], keys[ring][row + 1][col]);
        }
      }
    }

    // The start node enters ring 1 at the middle column of its first row.
    addEdge(startKey, keys[1][0][Math.floor((layout.rings[1].cols - 1) / 2)]);

    // Ring transitions at the left edge, middle and right edge, so a build has
    // three ways outward instead of one mandatory corridor.
    for (const [from, to] of [[1, 2], [2, 3]]) {
      const f = layout.rings[from];
      const t = layout.rings[to];
      for (const frac of [0, 0.5, 1]) {
        addEdge(
          keys[from][f.rows - 1][Math.round(frac * (f.cols - 1))],
          keys[to][0][Math.round(frac * (t.cols - 1))],
        );
      }
    }
  }

  // Sorted rather than left in insertion order: the contract fixes the output
  // ordering, and sorting makes it independent of the traversal above, so a
  // future reordering of the build loops is not a spurious diff.
  const edges = [...edgeKeys]
    .map((k) => k.split('|'))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));

  return { nodes, edges };
}

module.exports = { generatePassiveTree };
