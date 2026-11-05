// backend/src/services/questNodes.js
//
// Quest nodes: fixed interactable points a player walks up to and presses E on
// (gather a herb, sever a tendril, touch an obelisk, take a leader's crystal).
//
// DERIVED, NOT STORED -- the same decision the bank post made (see
// villageBankPost in mapService): positions are a pure function of the village
// box, so every village (seeded, generated, hand-authored) gets its nodes with
// no placement migration, and the position can never drift from the geometry.
// The catalog below says WHICH villages (by spec_key) host WHICH groups.
//
// A node is a point, not an item: interacting credits the character's active
// quests whose objective is `interact` on that group (questsService.recordNode).

const TILE = 100;

// group -> display name. `key` of a node is `${specKey}:${group}:${index}`.
const GROUPS = {
  elemental_crystal: 'Elemental Crystal',
  luminous_herb: 'Luminous Herb',
  corrupted_tendril: 'Corrupted Tendril',
  sunken_cargo: 'Sunken Reliquary Compass',
  starlight_prism: 'Starlight Prism',
  obelisk: 'Desert Obelisk',
  abyssal_diadem: 'Abyssal Diadem',
};

// spec_key -> [[group, count], ...]: which village hosts which quest nodes.
//
// Every host here is a village that a map spec really builds (tests/quest_progress_and_completion.test.js
// pins that, and that every `interact` quest finds enough nodes in them). They were once parked in
// emberfall / sylvan_haven / abyssal_tideport / ashen_oasis, villages no spec has, so those quests could
// never be finished. Each group sits in the village whose biomes fit it:
//   sunscar    (Arid Dunes, Ashfields)       Crystal of Flame, the desert's starlight prisms and obelisks
//   thornbriar (Deep Forest, Verdant Jungle) Crystal of Nature, luminous herbs, corrupted tendrils
//   blackfen   (Storm Coast, Mire)           Crystal of Tides, the sunken cargo, the Abyssal Diadem
//   windwatch  (Meadow, Highlands)           Crystal of Sun
// The four Elemental Crystals are in four DIFFERENT villages (act2_elemental_seals needs that).
// Order inside a village is the order tiles are handed out, so the Abyssal Diadem stays first in blackfen
// and keeps the tile it always had.
const CATALOG = {
  sunscar: [['elemental_crystal', 1], ['starlight_prism', 3], ['obelisk', 4]],
  thornbriar: [['elemental_crystal', 1], ['luminous_herb', 3], ['corrupted_tendril', 3]],
  blackfen: [['abyssal_diadem', 1], ['elemental_crystal', 1], ['sunken_cargo', 1]],
  windwatch: [['elemental_crystal', 1]],
};

// Tiles a node must not share: the village's own posts.
function postTiles(v) {
  const tiles = new Set();
  const add = (x, y) => {
    if (x == null || y == null) return;
    tiles.add(`${Math.floor(x / TILE)},${Math.floor(y / TILE)}`);
  };
  add(v.merchantX, v.merchantY);
  add(v.bankX, v.bankY);
  add(v.gemMerchantX, v.gemMerchantY);
  add(v.skillMerchantX, v.skillMerchantY);
  add(v.spawnX, v.spawnY);
  return tiles;
}

// Free tiles for one village, interior first (walkable by construction), then
// the one-tile yard around the box when the interior is too small.
function candidateTiles(v) {
  const c0 = Number(v.minCol), r0 = Number(v.minRow);
  const w = Number(v.width), h = Number(v.height);
  if (![c0, r0, w, h].every(Number.isFinite)) return [];
  const taken = postTiles(v);
  const interior = [];
  const yard = [];
  for (let r = r0 - 1; r <= r0 + h; r++) {
    for (let c = c0 - 1; c <= c0 + w; c++) {
      if (taken.has(`${c},${r}`)) continue;
      const inside = c > c0 && c < c0 + w - 1 && r > r0 && r < r0 + h - 1;
      const onWall = c >= c0 && c <= c0 + w - 1 && r >= r0 && r <= r0 + h - 1;
      if (inside) interior.push({ c, r });
      else if (!onWall) yard.push({ c, r });
    }
  }
  return [...interior, ...yard];
}

function villageQuestNodes(village) {
  const wanted = CATALOG[village.specKey];
  if (!wanted) return [];
  const tiles = candidateTiles(village);
  const out = [];
  let t = 0;
  for (const [group, count] of wanted) {
    for (let i = 0; i < count; i++) {
      const tile = tiles[t++];
      if (!tile) return out; // box too small: host what fits
      out.push({
        key: `${village.specKey}:${group}:${i}`,
        group,
        name: GROUPS[group],
        x: tile.c * TILE + TILE / 2,
        y: tile.r * TILE + TILE / 2,
      });
    }
  }
  return out;
}

function worldQuestNodes(villages) {
  return (villages || []).flatMap(villageQuestNodes);
}

// Closest node within `radius` of (x, y), or null.
function nearestQuestNode(nodes, x, y, radius) {
  let best = null;
  let bestD = radius;
  for (const n of nodes || []) {
    const d = Math.hypot(n.x - x, n.y - y);
    if (d <= bestD) { best = n; bestD = d; }
  }
  return best ? { node: best, distance: bestD } : null;
}

module.exports = { GROUPS, CATALOG, villageQuestNodes, worldQuestNodes, nearestQuestNode };
