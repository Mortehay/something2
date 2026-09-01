// backend/seeds/generatePassiveTree.js
//
// Expands the authored spec in data/passiveTree.js into the ~1800 rows the
// database holds. PURE, and deterministic in the strongest sense the contract
// asks for: no Math.random(), no Date.now(), no Object key iteration whose
// order is not fixed by an array in the spec. Two runs are byte-identical, so
// a tree change is a reviewable diff.
//
// SHAPE: Authentic Path of Exile celestial passive tree.
// True "через 1" double-spacing layout with rich shortcuts, expressway radial
// elevators between rings, star spoke hubs, and cross-class bridges.
const DEG = Math.PI / 180;

function round2(v) {
  return (Math.round(v * 100) || 0) / 100;
}

function polar(radius, angleDeg) {
  return {
    x: round2(radius * Math.cos(angleDeg * DEG)),
    y: round2(radius * Math.sin(angleDeg * DEG)),
  };
}

function spreadIndices(total, count) {
  const out = [];
  for (let k = 0; k < count; k += 1) out.push(Math.floor(((k + 0.5) * total) / count));
  return out;
}

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
    place(i + layout.keystoneOffset + k * layout.keystoneStagger, 'keystone');
  });
  spreadIndices(total, notableCount).forEach((i) => place(i, 'notable'));
  return kinds;
}

// SOMET-515. The pool a (kind, sector, ring) draws from, EXPANDED BY WEIGHT.
//
// Selection below is `pool[i % pool.length]`, so before weights existed the
// own/off-stat ratio was an accident of how many template OBJECTS happened to
// sit in the array -- adding one off-stat template moved it. A template's
// `weight` is how many slots it occupies, which makes the ratio something the
// data file states rather than something the array length implies.
//
// Weight defaults to 1, so every pre-515 template keeps exactly its old share.
function templatePool(templates, kind, sector, ring) {
  const matching = templates.filter((t) => t.kind === kind
    && (t.sectors === '*' ? sector !== 'core' : t.sectors.includes(sector))
    && t.rings.includes(ring));
  const pool = [];
  for (const t of matching) {
    const weight = Number.isFinite(t.weight) && t.weight > 0 ? Math.floor(t.weight) : 1;
    for (let i = 0; i < weight; i += 1) pool.push(t);
  }
  return pool;
}

// SOMET-515. The off-stat a `@other` grant resolves to.
//
// Round-robin through the five stats that are NOT this sector's own, in
// sector-declaration order, advanced by a per-sector counter. Two properties
// matter and both are load-bearing:
//
//   DETERMINISTIC. The generator is contractually free of Math.random() and
//   byte-identical across runs, which is what makes a tree change a reviewable
//   diff. Generation order is fixed, so a counter is as deterministic as an
//   index -- and unlike a raw node index it cannot be knocked out of step by
//   the four different call sites using four different loop variables.
//
//   EVEN. Over a sector's ~295 nodes each of the other five stats receives
//   close to a fifth of the off-stat budget, which is the distribution this
//   epic chose. A hash would clump; a round-robin cannot.
//
// The stat list comes from the SPEC's own sectors rather than a re-declared
// STAT_KEYS, so the generator stays a pure function of the spec it is handed
// and cannot drift from the six sectors that actually exist.
function nextOtherStat(sectorKeys, sector, otherSeq) {
  const others = sectorKeys.filter((k) => k !== sector);
  const n = otherSeq.get(sector) || 0;
  otherSeq.set(sector, n + 1);
  return others[n % others.length];
}

// `@sector` -> this sector's own stat. `@other` -> one of the other five.
// A core node has no sector stat, so `@other` must never appear on a core
// template; the spec guard test enforces that rather than a silent fallback
// here, because a fallback would make the mistake invisible.
function grantsFor(template, sector, sectorKeys, otherSeq) {
  return template.grants.map((g) => {
    if (g.stat === '@sector') return { ...g, stat: sector };
    if (g.stat === '@other') return { ...g, stat: nextOtherStat(sectorKeys, sector, otherSeq) };
    return { ...g };
  });
}

function generatePassiveTree(spec) {
  const { sectors, layout, templates, keystones, startNodes } = spec;
  const nodes = [];
  const edgeKeys = new Set();
  // SOMET-515. The six stat keys, straight off the spec, and the per-sector
  // round-robin cursor `@other` advances. Declared once here so every call
  // site below shares ONE cursor per sector -- a cursor per call site would
  // restart the rotation four times and clump the distribution.
  const sectorKeys = sectors.map((s) => s.key);
  const otherSeq = new Map();

  const addEdge = (a, b) => {
    if (!a || !b || a === b) return;
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
      kind: 'minor', label: t.label, grants: grantsFor(t, 'core', sectorKeys, otherSeq), start_class: null,
    }));
  }
  const rowB = [];
  for (let k = 0; k < layout.core.rowB.count; k += 1) {
    const t = corePool[k % corePool.length];
    const { x, y } = polar(layout.core.rowB.radius,
      layout.sectorAxisDeg0 + (k * 360) / layout.core.rowB.count);
    rowB.push(push({
      key: `core-b-${k}`, sector: 'core', ring: 0, x, y,
      kind: 'minor', label: t.label, grants: grantsFor(t, 'core', sectorKeys, otherSeq), start_class: null,
    }));
  }
  const spokeStep = layout.core.rowB.count / layout.core.rowA.count; // 24 / 6 = 4
  for (let i = 0; i < rowA.length; i += 1) {
    addEdge(rowA[i], rowA[(i + 1) % rowA.length]);
    addEdge(rowA[i], rowB[i * spokeStep]);
  }
  for (let k = 0; k < rowB.length; k += 1) addEdge(rowB[k], rowB[(k + 1) % rowB.length]);

  const sectorRings = {};

  // ---- sectors ----------------------------------------------------------
  for (let s = 0; s < sectors.length; s += 1) {
    const sector = sectors[s].key;
    const axis = layout.sectorAxisDeg0 + s * 60;
    const half = layout.sectorSpanDeg / 2;

    const startDef = startNodes.find((n) => n.sector === sector);
    const sp = polar(layout.startRadius, axis);
    const startKey = push({
      key: `start-${sector}`, sector, ring: 0, x: sp.x, y: sp.y,
      kind: 'start', label: startDef.label, start_class: startDef.start_class,
      grants: (startDef.grants || []).map((g) => ({ ...g })),
    });
    addEdge(startKey, rowB[s * spokeStep]);

    let keystoneSeq = 0;
    sectorRings[s] = {};

    for (let ring = 1; ring <= 3; ring += 1) {
      const rg = layout.rings[ring];
      const total = rg.rows * rg.cols;
      const kinds = ringKinds(total, rg.notable, rg.keystone, layout);

      // "Через 1" on the highway: 9, 15, 19 highway nodes
      let numHighwayCols = 9;
      let numClusters = 6;
      if (ring === 2) {
        numHighwayCols = 15;
        numClusters = 6;
      } else if (ring === 3) {
        numHighwayCols = 19;
        numClusters = 6;
      }

      const highwayNodes = [];
      let flatIdx = 0;

      // 1. Generate arterial highway on Row 0 with wide double spacing:
      for (let col = 0; col < numHighwayCols; col += 1) {
        const flat = flatIdx;
        flatIdx += 1;
        let kind = kinds[flat];
        if (kind !== 'minor' && flat < numHighwayCols) {
          const swapIdx = kinds.lastIndexOf('minor');
          if (swapIdx >= numHighwayCols) {
            kinds[flat] = 'minor';
            kinds[swapIdx] = kind;
            kind = 'minor';
          }
        }

        const hAngle = axis - half + (col * layout.sectorSpanDeg) / (numHighwayCols - 1);
        const hp = polar(rg.baseRadius, hAngle);

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
          grants = grantsFor(t, sector, sectorKeys, otherSeq);
        }

        const row = 0;
        const key = push({
          key: `${sector}-r${ring}-${row}-${col}`, sector, ring, x: hp.x, y: hp.y,
          kind, label, grants, start_class: null,
        });
        highwayNodes.push(key);
      }

      // Connect highway nodes sequentially:
      for (let col = 0; col + 1 < highwayNodes.length; col += 1) {
        addEdge(highwayNodes[col], highwayNodes[col + 1]);
      }

      // 2. Distribute all extra nodes into 6 spacious constellation wheels:
      const remainingNodesCount = total - numHighwayCols;
      const clusterWheels = [];

      for (let c = 0; c < numClusters; c += 1) {
        const cStart = Math.floor((c * remainingNodesCount) / numClusters);
        const cEnd = Math.floor(((c + 1) * remainingNodesCount) / numClusters);
        const cSize = cEnd - cStart;

        const frac = 0.15 + (c / (numClusters - 1 || 1)) * 0.70;
        let cRadius;
        if (ring === 1) {
          cRadius = (c % 2 === 0) ? 320 : 395;
        } else if (ring === 2) {
          cRadius = (c % 2 === 0) ? 540 : 620;
        } else {
          cRadius = (c % 2 === 0) ? 760 : 785;
        }

        const hIdx = Math.min(highwayNodes.length - 1, Math.round(frac * (highwayNodes.length - 1)));
        const cAngle = axis - half + frac * layout.sectorSpanDeg;
        const cp = polar(cRadius, cAngle);

        // Collect kinds for this cluster:
        const clusterKinds = [];
        for (let j = 0; j < cSize; j += 1) {
          clusterKinds.push(kinds[flatIdx + j]);
        }
        const keystonesInCluster = clusterKinds.filter(k => k === 'keystone');
        const notablesInCluster = clusterKinds.filter(k => k === 'notable');
        const minors = clusterKinds.filter(k => k === 'minor');

        // Central hub gets a minor node:
        let hubKind = 'minor';
        if (minors.length > 0) {
          minors.shift();
        } else if (notablesInCluster.length > 0) {
          hubKind = notablesInCluster.shift();
        } else if (keystonesInCluster.length > 0) {
          hubKind = keystonesInCluster.shift();
        }

        const totalPetals = cSize - 1;
        let innerCount = 0;
        let outerCount = totalPetals;
        let rInner = 0;
        let rOuter = Math.max(34, Math.ceil(11.0 / Math.sin(Math.PI / outerCount)));

        if (totalPetals >= 12) {
          innerCount = 5;
          outerCount = totalPetals - innerCount;
          rInner = 20;
          rOuter = (ring === 3) ? 40 : 42;
        }

        const outerKinds = new Array(outerCount).fill('minor');
        const innerKinds = new Array(innerCount).fill('minor');

        // Place Keystone strictly at outer apex:
        const apex = Math.floor(outerCount / 2);
        if (keystonesInCluster.length > 0) {
          outerKinds[apex] = keystonesInCluster.shift();
        }

        // Place Notables strictly at alternating even offsets:
        const outerOffsets = [2, -2, 4, -4, 6, -6];
        for (const off of outerOffsets) {
          const idx = apex + off;
          if (idx > 0 && idx < outerCount && notablesInCluster.length > 0) {
            outerKinds[idx] = notablesInCluster.shift();
          }
        }
        if (outerKinds[apex] === 'minor' && notablesInCluster.length > 0) {
          outerKinds[apex] = notablesInCluster.shift();
        }

        // Place any remaining notables on inner orbit:
        if (innerCount > 0) {
          const innerApex = Math.floor(innerCount / 2);
          const innerOffsets = [0, 2, -2];
          for (const off of innerOffsets) {
            const idx = innerApex + off;
            if (idx >= 0 && idx < innerCount && notablesInCluster.length > 0) {
              innerKinds[idx] = notablesInCluster.shift();
            }
          }
        }

        // Place any remaining keystones or notables:
        while (keystonesInCluster.length > 0) {
          const k = keystonesInCluster.shift();
          let placed = false;
          for (let j = 1; j < outerCount; j += 1) {
            if (outerKinds[j] === 'minor') { outerKinds[j] = k; placed = true; break; }
          }
          if (!placed && innerCount > 0) {
            for (let j = 0; j < innerCount; j += 1) {
              if (innerKinds[j] === 'minor') { innerKinds[j] = k; placed = true; break; }
            }
          }
        }
        while (notablesInCluster.length > 0) {
          const n = notablesInCluster.shift();
          let placed = false;
          for (let j = 1; j < outerCount; j += 1) {
            if (outerKinds[j] === 'minor') { outerKinds[j] = n; placed = true; break; }
          }
          if (!placed && innerCount > 0) {
            for (let j = 0; j < innerCount; j += 1) {
              if (innerKinds[j] === 'minor') { innerKinds[j] = n; placed = true; break; }
            }
          }
        }

        // 1. Create central hub node:
        const hubFlat = flatIdx;
        flatIdx += 1;
        let hubLabel;
        let hubGrants;
        if (hubKind === 'keystone') {
          const ks = keystones[sector][keystoneSeq];
          keystoneSeq += 1;
          hubLabel = ks.label;
          hubGrants = ks.grants.map((g) => ({ ...g }));
        } else {
          const pool = templatePool(templates, hubKind, sector, ring);
          const t = pool[hubFlat % pool.length];
          hubLabel = t.label;
          hubGrants = grantsFor(t, sector, sectorKeys, otherSeq);
        }
        const hubRow = 1 + Math.floor((hubFlat - numHighwayCols) / rg.cols);
        const hubCol = (hubFlat - numHighwayCols) % rg.cols;
        const hubKey = push({
          key: `${sector}-r${ring}-${hubRow}-${hubCol}`, sector, ring, x: cp.x, y: cp.y,
          kind: hubKind, label: hubLabel, grants: hubGrants, start_class: null,
        });

        // 2. Create inner orbit nodes:
        const innerKeys = [];
        for (let j = 0; j < innerCount; j += 1) {
          const flat = flatIdx;
          flatIdx += 1;
          const kind = innerKinds[j];
          const nodeR = kind === 'keystone' ? rInner + 8 : rInner;
          const wheelDir = cAngle * DEG + Math.PI + (j / innerCount) * Math.PI * 2;
          let wx = round2(cp.x + nodeR * Math.cos(wheelDir));
          let wy = round2(cp.y + nodeR * Math.sin(wheelDir));

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
            grants = grantsFor(t, sector, sectorKeys, otherSeq);
          }

          const row = 1 + Math.floor((flat - numHighwayCols) / rg.cols);
          const col = (flat - numHighwayCols) % rg.cols;
          const key = push({
            key: `${sector}-r${ring}-${row}-${col}`, sector, ring, x: wx, y: wy,
            kind, label, grants, start_class: null,
          });
          innerKeys.push(key);
        }

        // 3. Create outer petal nodes with wide spacing:
        const outerKeys = [];
        for (let j = 0; j < outerCount; j += 1) {
          const flat = flatIdx;
          flatIdx += 1;
          const kind = outerKinds[j];
          const nodeR = kind === 'keystone' ? rOuter + 8 : rOuter;
          const wheelDir = cAngle * DEG + Math.PI + (j / outerCount) * Math.PI * 2;
          let wx = round2(cp.x + nodeR * Math.cos(wheelDir));
          let wy = round2(cp.y + nodeR * Math.sin(wheelDir));

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
            grants = grantsFor(t, sector, sectorKeys, otherSeq);
          }

          const row = 1 + Math.floor((flat - numHighwayCols) / rg.cols);
          const col = (flat - numHighwayCols) % rg.cols;
          const key = push({
            key: `${sector}-r${ring}-${row}-${col}`, sector, ring, x: wx, y: wy,
            kind, label, grants, start_class: null,
          });
          outerKeys.push(key);
        }

        // Inner loop edges:
        for (let j = 0; j < innerKeys.length; j += 1) {
          addEdge(innerKeys[j], innerKeys[(j + 1) % innerKeys.length]);
        }
        // Outer loop edges:
        for (let j = 0; j < outerKeys.length; j += 1) {
          addEdge(outerKeys[j], outerKeys[(j + 1) % outerKeys.length]);
        }

        // Radial shortcuts through the central hub:
        if (innerKeys.length > 0) {
          // Hub connects to entry petal, apex petal, and side petals:
          addEdge(hubKey, innerKeys[0]);
          const innerApex = Math.floor(innerKeys.length / 2);
          addEdge(hubKey, innerKeys[innerApex]);
          if (innerKeys.length >= 4) {
            addEdge(hubKey, innerKeys[1]);
            addEdge(hubKey, innerKeys[innerKeys.length - 1]);
          }

          // Inner-to-outer radial spoke bridges:
          addEdge(innerKeys[0], outerKeys[0]);
          const outerApex = Math.floor(outerKeys.length / 2);
          addEdge(innerKeys[innerApex], outerKeys[outerApex]);
        } else if (outerKeys.length > 0) {
          addEdge(hubKey, outerKeys[0]);
          const outerApex = Math.floor(outerKeys.length / 2);
          addEdge(hubKey, outerKeys[outerApex]);
        }

        // Radial connection from highway to wheel entry:
        if (outerKeys.length > 0) {
          addEdge(highwayNodes[hIdx], outerKeys[0]);
        }

        clusterWheels.push({ hub: hubKey, inner: innerKeys, outer: outerKeys, cp, cAngle, cRadius });
      }

      sectorRings[s][ring] = { highway: highwayNodes, clusters: clusterWheels };
    }

    // Start node connects to Ring 1 middle highway node:
    const midH1 = Math.floor(sectorRings[s][1].highway.length / 2);
    addEdge(startKey, sectorRings[s][1].highway[midH1]);

    // Elevator shortcuts between Ring 1 clusters and Ring 2 highway / Ring 2 clusters and Ring 3 highway:
    const r1Clusters = sectorRings[s][1].clusters;
    const r2Clusters = sectorRings[s][2].clusters;
    const r2H = sectorRings[s][2].highway;
    const r3H = sectorRings[s][3].highway;

    for (let c of [1, 3, 5]) {
      if (r1Clusters[c]) {
        const c1Apex = Math.floor(r1Clusters[c].outer.length / 2);
        const frac = 0.15 + (c / (6 - 1 || 1)) * 0.70;
        const hIdx2 = Math.min(r2H.length - 1, Math.round(frac * (r2H.length - 1)));
        addEdge(r1Clusters[c].outer[c1Apex], r2H[hIdx2]);
      }
      if (r2Clusters[c]) {
        const c2Apex = Math.floor(r2Clusters[c].outer.length / 2);
        const frac = 0.15 + (c / (6 - 1 || 1)) * 0.70;
        const hIdx3 = Math.min(r3H.length - 1, Math.round(frac * (r3H.length - 1)));
        addEdge(r2Clusters[c].outer[c2Apex], r3H[hIdx3]);
      }
    }

    // Inter-ring highway radial spokes at sector boundaries:
    const r1H = sectorRings[s][1].highway;
    addEdge(r1H[0], r2H[0]);
    addEdge(r1H[r1H.length - 1], r2H[r2H.length - 1]);

    addEdge(r2H[0], r3H[0]);
    addEdge(r2H[r2H.length - 1], r3H[r3H.length - 1]);
  }

  // Cross-sector highways connecting adjacent classes on all 3 rings:
  for (let s = 0; s < sectors.length; s += 1) {
    const nextS = (s + 1) % sectors.length;
    for (let ring = 1; ring <= 3; ring += 1) {
      const curH = sectorRings[s][ring].highway;
      const nextH = sectorRings[nextS][ring].highway;
      addEdge(curH[curH.length - 1], nextH[0]);
    }
  }

  // Sorted rather than left in insertion order:
  const edges = [...edgeKeys]
    .map((k) => k.split('|'))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));

  return { nodes, edges };
}

module.exports = { generatePassiveTree };
