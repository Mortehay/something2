// SOMET-450. What makes a dungeon a dungeon: you have to get past its guard.
//
// WHY THIS IS NOT KEYED ON NAMES OR PREFIXES. map_spec_fixtures.test.js
// already carries a fast-travel invariant ("no dungeon room is a fast-travel
// target"), and it discriminates dungeon rooms with the regex
// /^The .+: .+$/ -- the naming convention p5-descent's generator happens to
// use. vale-region's rooms are hand-named "Catacomb Threshold", "Farrow
// Hall", "Frozen Ossuary Heart". None of them matches, so all seven carried
// allows_fast_travel: true for the entire life of that test, with it green
// the whole time (SOMET-447 turned them off). A key-prefix list would be the
// same guard with a different blind spot: correct until someone adds a
// dungeon whose prefix nobody added to the list.
//
// So membership here is derived from the GRAPH: a world is BEHIND A GUARD if
// it cannot be reached from the spec's entry world without crossing a portal
// link that carries a `guard`. That definition needs no list, applies to any
// spec dropped into seeds/maps, and cannot be outgrown by new content.
//
// WHY THE FLAG STILL MATTERS. Fast travel as a travel mechanism was retired
// by SOMET-293 -- clicking the World Map no longer authorizes a join. But
// `allows_fast_travel` survives as the sole input to joinPolicy's `first-join`
// leg (src/services/joinPolicy.js:157):
//
//     if (!facts.hasHistory && (facts.isEntry || facts.allowsFastTravel))
//
// A character with no history may join ANY flagged world. That leg's own
// comment argues it is "not a hole" because "flagged worlds are safe surface
// locations by construction (slice 2 flags no dungeon room, and
// map_spec_fixtures.test.js keeps it that way)". The premise was false for
// vale-region. This file is what actually keeps it that way.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MAPS_DIR = path.join(__dirname, '..', 'seeds', 'maps');

const specFiles = () => fs.readdirSync(MAPS_DIR).filter((f) => f.endsWith('.map.json'));
const readSpec = (f) => JSON.parse(fs.readFileSync(path.join(MAPS_DIR, f), 'utf8'));

const isGuardedPortal = (l) => l.kind === 'portal' && l.guard != null;

// Everything reachable from the entry WITHOUT crossing a guarded portal.
// Guarded portals are simply absent from the adjacency, so anything that only
// hangs off the far side of one falls out of the reachable set.
function reachableWithoutGuards(spec) {
  const entry = spec.worlds.find((w) => w.is_entry === true);
  assert.ok(entry, 'spec has no entry world; validateMapSpec should have caught this');

  const adjacency = new Map(spec.worlds.map((w) => [w.key, []]));
  for (const l of spec.links) {
    if (isGuardedPortal(l)) continue;
    adjacency.get(l.from).push(l.to);
    adjacency.get(l.to).push(l.from);   // links are bidirectional; setLink mirrors
  }

  const seen = new Set([entry.key]);
  const queue = [entry.key];
  while (queue.length) {
    for (const next of adjacency.get(queue.shift()) ?? []) {
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return seen;
}

const behindAGuard = (spec) => {
  const free = reachableWithoutGuards(spec);
  return spec.worlds.filter((w) => !free.has(w.key));
};

// PRE-EXISTING violations, pinned rather than hidden (SOMET-450 → SOMET-451).
//
// Each of these five is compass-attached to a d2_* room, and every d2_* room
// sits behind the d1_end → d2_hub Fungal Line guard. So a character with no
// history can first-join one of these surface worlds and walk into The
// Underdeep without ever meeting that guard.
//
// They are listed, not excluded by narrowing this file's scope to vale-region:
// scoping the test away from the spec that fails it is how a guard gets
// disarmed. Enumerating them keeps the invariant running over p5-descent, so
// a SIXTH violation fails this test. Removing an entry as it is fixed is the
// intended direction of travel; adding one requires deciding to.
const KNOWN_UNGUARDED = new Map([
  ['p5-descent.map.json', [
    'surface_highlands_1',
    'surface_verdant_jungle_0',
    'surface_storm_coast_1',
    'surface_sunken_ruins_0',
    'surface_ashfields_1',
  ]],
]);

test('no world behind a guarded portal is a first-join target', () => {
  let specsWithGuards = 0;
  const offenders = [];

  for (const file of specFiles()) {
    const spec = readSpec(file);
    if (!spec.links.some(isGuardedPortal)) continue;
    specsWithGuards++;

    const allowed = new Set(KNOWN_UNGUARDED.get(file) ?? []);
    for (const w of behindAGuard(spec)) {
      if (w.allows_fast_travel !== true) continue;
      if (allowed.delete(w.key)) continue;          // pinned, known, ticketed
      offenders.push(`${file}: ${w.key} (${w.name})`);
    }

    // A pinned entry that no longer violates means someone fixed it and left
    // the pin behind. Say so: a stale allowance is a hole waiting to be
    // re-entered silently.
    assert.deepEqual([...allowed], [],
      `${file}: these worlds are pinned in KNOWN_UNGUARDED but no longer violate — remove them`);
  }

  assert.deepEqual(offenders, [],
    'a character with no history can first-join these worlds, which sit behind a portal guard');

  // Non-vacuity. Every assertion above is over a set this file derives itself,
  // so a spec that stopped parsing, an entry world that moved, or a `guard`
  // key that got renamed would empty those sets and pass silently.
  assert.ok(specsWithGuards >= 2,
    `expected at least 2 specs to use guarded portals, found ${specsWithGuards}`);
});

test('every guarded portal actually gates its destination', () => {
  // The back-door check. A compass link from the overworld into a dungeon
  // makes that dungeon reachable without crossing the guard, so its
  // destination stops being "behind a guard" -- which is exactly what
  // cata_farhall → spine_elite did to the vale catacombs before SOMET-447.
  //
  // Stated over the DESTINATION rather than over a room count, so it needs no
  // magic numbers and cannot be satisfied by a dungeon that shrank.
  let checked = 0;
  const ungated = [];

  for (const file of specFiles()) {
    const spec = readSpec(file);
    const free = reachableWithoutGuards(spec);
    for (const l of spec.links.filter(isGuardedPortal)) {
      checked++;
      if (free.has(l.to)) {
        ungated.push(`${file}: ${l.from} → ${l.to} is guarded by `
          + `${l.guard.creature_type}, but ${l.to} is reachable from the entry without it`);
      }
    }
  }

  assert.deepEqual(ungated, [], 'these portal guards can be walked around');
  assert.ok(checked >= 3,
    `expected at least 3 guarded portals across the shipped specs, found ${checked}`);
});

test('vale-region has one guarded entrance per dungeon', () => {
  // vale-region specifically: SOMET-446 shipped three dungeons, each with
  // exactly one way in. Pinned so that adding a second entrance to any of them
  // is a decision someone makes on purpose rather than a side effect.
  const spec = readSpec('vale-region.map.json');
  const guarded = spec.links.filter(isGuardedPortal);

  assert.deepEqual(
    guarded.map((l) => `${l.from} → ${l.to} (${l.guard.creature_type})`).sort(),
    [
      'vale_dunes → hollow_entry (Cave Line)',
      'vale_frozen → rime_hub (Rime Line)',
      'vale_mire → cata_entry (Undead Line)',
    ],
  );

  // Each destination is the ONLY entrance to its dungeon: no other guarded
  // portal lands in the same dungeon, and nothing else reaches it at all.
  const behind = behindAGuard(spec).map((w) => w.key);
  assert.equal(behind.length, 21,
    'expected 21 gated rooms (7 catacombs + 8 hollows + 6 rimevault); '
    + `found ${behind.length}: ${behind.join(', ')}`);
});
