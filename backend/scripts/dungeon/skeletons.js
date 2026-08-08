// backend/scripts/dungeon/skeletons.js
//
// Three reusable dungeon room-graph shapes for P5 (SOMET-251), each a
// literal re-shape of one of the 3 already-shipped example specs in
// backend/seeds/maps/ -- same grid deltas and link structure, generic role
// keys instead of flavor names. See
// docs/superpowers/specs/2026-08-08-p5-map-content-design.md's "The
// 8-dungeon chain" section for why reuse (not new topology math) is the
// design.
//
// Every skeleton's rooms/links stay in LOCAL coordinates (skeleton's own
// grid origin at [0,0]) -- the generator (Task 4) relabels `key` per
// dungeon instance and offsets `grid` by that dungeon's grid origin.

// Re-shape of spine-descent.map.json (8 rooms): a linear critical path
// with two opt-in dead-end branches off it.
const SPINE = {
  rooms: [
    { role: 'entry', key: 'entry', grid: [0, 0] },
    { role: 'critical', key: 'pass', grid: [1, 0] },
    { role: 'branch', key: 'cache', grid: [1, -1] },
    { role: 'branch', key: 'elite', grid: [1, 1] },
    { role: 'critical', key: 'gorge', grid: [2, 0] },
    { role: 'branch', key: 'shrine', grid: [2, 1] },
    { role: 'critical', key: 'deep', grid: [3, 0] },
    { role: 'exit', key: 'end', grid: [4, 0] },
  ],
  links: [
    { from: 'entry', edge: 'E', to: 'pass' },
    { from: 'pass', edge: 'N', to: 'cache' },
    { from: 'pass', edge: 'S', to: 'elite' },
    { from: 'pass', edge: 'E', to: 'gorge' },
    { from: 'gorge', edge: 'S', to: 'shrine' },
    { from: 'gorge', edge: 'E', to: 'deep' },
    { from: 'deep', edge: 'E', to: 'end' },
  ],
  entryRoleKey: 'entry',
  exitRoleKey: 'end',
  // branch room key -> the critical-path room it attaches to, for the
  // generator's "branch inherits its attachment point's hop-distance
  // band/density" rule.
  branchAttachment: { cache: 'pass', elite: 'pass', shrine: 'gorge' },
};

// Re-shape of hub-vale.map.json (5 rooms) plus one extra sub-branch off
// the east spoke, to bring it to 6 rooms.
const HUB = {
  rooms: [
    { role: 'entry', key: 'hub', grid: [0, 0] },
    { role: 'spoke', key: 'spokeN', grid: [0, -1] },
    { role: 'spoke', key: 'spokeE', grid: [1, 0] },
    { role: 'spoke', key: 'spokeS', grid: [0, 1] },
    { role: 'spoke', key: 'spokeW', grid: [-1, 0] },
    { role: 'exit', key: 'subBranch', grid: [1, -1] },
  ],
  links: [
    { from: 'hub', edge: 'N', to: 'spokeN' },
    { from: 'hub', edge: 'E', to: 'spokeE' },
    { from: 'hub', edge: 'S', to: 'spokeS' },
    { from: 'hub', edge: 'W', to: 'spokeW' },
    { from: 'spokeE', edge: 'N', to: 'subBranch' },
  ],
  entryRoleKey: 'hub',
  exitRoleKey: 'subBranch',
  branchAttachment: { spokeN: 'hub', spokeE: 'hub', spokeS: 'hub', spokeW: 'hub', subBranch: 'spokeE' },
  // Hub topology needs a village in the hub (map-planner rule) -- the
  // generator attaches a `village` block to whichever room has role 'entry'
  // in a hub skeleton.
  needsVillageAtEntry: true,
};

// Re-shape of loop-catacombs.map.json (7 rooms): a 6-room cycle that
// closes back on the entry, plus one dead-end spur off the entry.
const LOOP = {
  rooms: [
    { role: 'entry', key: 'entry', grid: [0, 0] },
    { role: 'branch', key: 'spur', grid: [-1, 0] },
    { role: 'critical', key: 'eastwing', grid: [1, 0] },
    { role: 'critical', key: 'farhall', grid: [2, 0] },
    { role: 'exit', key: 'heart', grid: [2, 1] },
    { role: 'critical', key: 'deepvault', grid: [1, 1] },
    { role: 'critical', key: 'southwing', grid: [0, 1] },
  ],
  links: [
    { from: 'entry', edge: 'E', to: 'eastwing' },
    { from: 'entry', edge: 'W', to: 'spur' },
    { from: 'eastwing', edge: 'E', to: 'farhall' },
    { from: 'farhall', edge: 'S', to: 'heart' },
    { from: 'heart', edge: 'W', to: 'deepvault' },
    { from: 'deepvault', edge: 'W', to: 'southwing' },
    { from: 'southwing', edge: 'N', to: 'entry' },
  ],
  entryRoleKey: 'entry',
  exitRoleKey: 'heart',
  branchAttachment: { spur: 'entry' },
};

const SKELETONS = { spine: SPINE, hub: HUB, loop: LOOP };

module.exports = { SKELETONS };
