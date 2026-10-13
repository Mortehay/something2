const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  findWorldLocation, findLinkInSpecs, findWaypointInSpecs, findChestInSpecs, findVillageInSpecs,
  writeSpecFieldChange,
} = require('../src/services/specFileLocator.js');

// Same minimal valid fixture shape as mapSpec_pointArt.test.js's base() --
// one entry world "A" (portal, standalone waypoint, village, chest) linked by
// a portal to world "B". Kept deliberately close to that file's fixture so a
// failure here that is really about spec shape (not about the locator) is
// recognisable against a fixture these tests already trust elsewhere.
function baseSpec() {
  return {
    name: 't', topology: 'grid',
    worlds: [
      {
        key: 'a', name: 'A', grid: [0, 0], seed: 1, width: 40, height: 40, chunk_size: 8,
        biomes: ['meadow'], is_entry: true, entry_spawn: { x: 1250, y: 1150 },
        waypoints: [{ x: 2050, y: 2050, name: 'Stone A' }],
        village: {
          key: 'v1', min_row: 10, min_col: 10, width: 6, height: 4, gate_edge: 'S',
          spawn_x: 1250, spawn_y: 1150,
        },
        chest: { x: 3050, y: 3050, level: 2, guard_creature_type: 'Wolf' },
      },
      { key: 'b', name: 'B', seed: 2, width: 40, height: 40, chunk_size: 8, biomes: ['meadow'] },
    ],
    links: [{ kind: 'portal', from: 'a', to: 'b', from_x: 550, from_y: 1550, to_x: 550, to_y: 550 }],
  };
}

const CATALOGS = {
  pointArtTypes: new Map([
    ['stone_gate', 'portal'], ['waypoint_stone', 'waypoint'],
    ['merchant_post', 'merchant'], ['chest_vault', 'chest_vault'], ['pine_tree', undefined],
  ]),
};

// A scratch directory per test, holding one or more .map.json files. Never
// the real backend/seeds/maps/ -- that is the whole point of the `dir`
// parameter every locator function takes.
function tmpSpecDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specFileLocator-test-'));
  return dir;
}
function writeSpecFile(dir, name, spec) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(spec, null, 2)}\n`);
  return file;
}

test('findWorldLocation finds a unique world by name', () => {
  const dir = tmpSpecDir();
  const file = writeSpecFile(dir, 'one.map.json', baseSpec());
  const loc = findWorldLocation('A', dir);
  assert.ok(loc);
  assert.strictEqual(loc.filePath, file);
  assert.strictEqual(loc.world.key, 'a');
  assert.strictEqual(loc.worldIndex, 0);
});

test('findWorldLocation refuses a world present in zero spec files', () => {
  const dir = tmpSpecDir();
  writeSpecFile(dir, 'one.map.json', baseSpec());
  assert.strictEqual(findWorldLocation('Nonexistent', dir), null);
});

test('findWorldLocation refuses a world present in more than one spec file', () => {
  const dir = tmpSpecDir();
  writeSpecFile(dir, 'one.map.json', baseSpec());
  // A second file that happens to declare a world of the same NAME (a
  // different spec's key is irrelevant -- worlds.name is what this module
  // matches on, and the DB treats it as globally unique, so two files
  // claiming the same name is already a misconfigured pair of specs).
  const dup = baseSpec();
  dup.worlds[0].key = 'dup-a';
  writeSpecFile(dir, 'two.map.json', dup);
  assert.strictEqual(findWorldLocation('A', dir), null);
});

test('findLinkInSpecs finds a portal link from the departure side, targeting the `art` field', () => {
  const dir = tmpSpecDir();
  writeSpecFile(dir, 'one.map.json', baseSpec());
  const loc = findLinkInSpecs('A', { from_x: 550, from_y: 1550 }, dir);
  assert.ok(loc);
  assert.deepStrictEqual(loc.path, ['links', 0]);
  assert.deepStrictEqual(loc.fieldPath, ['art']);
  assert.strictEqual(loc.side, 'departure');
});

test('findLinkInSpecs finds the SAME link from the mirrored arrival side, targeting the `to_art` field', () => {
  const dir = tmpSpecDir();
  writeSpecFile(dir, 'one.map.json', baseSpec());
  // World B's own row is the mirror: from_world_id=B, from_x/from_y = the
  // link's to_x/to_y. setPortalLink writes this as a second map_links row,
  // and an admin could have selected either one on the graph. SOMET-586: the
  // arrival side now writes its OWN field (`to_art`), not the departure's
  // `art`.
  const loc = findLinkInSpecs('B', { from_x: 550, from_y: 550 }, dir);
  assert.ok(loc);
  assert.deepStrictEqual(loc.path, ['links', 0]);
  assert.deepStrictEqual(loc.fieldPath, ['to_art']);
  assert.strictEqual(loc.side, 'arrival');
});

test('findLinkInSpecs refuses a tile with no matching portal', () => {
  const dir = tmpSpecDir();
  writeSpecFile(dir, 'one.map.json', baseSpec());
  assert.strictEqual(findLinkInSpecs('A', { from_x: 1, from_y: 1 }, dir), null);
});

test('findLinkInSpecs refuses when the world itself is ambiguous', () => {
  const dir = tmpSpecDir();
  writeSpecFile(dir, 'one.map.json', baseSpec());
  const dup = baseSpec();
  dup.worlds[0].key = 'dup-a';
  writeSpecFile(dir, 'two.map.json', dup);
  assert.strictEqual(findLinkInSpecs('A', { from_x: 550, from_y: 1550 }, dir), null);
});

test('findWaypointInSpecs finds the standalone waypoints[] entry', () => {
  const dir = tmpSpecDir();
  writeSpecFile(dir, 'one.map.json', baseSpec());
  const loc = findWaypointInSpecs('A', dir);
  assert.ok(loc);
  assert.deepStrictEqual(loc.path, ['worlds', 0, 'waypoints', 0]);
  assert.deepStrictEqual(loc.fieldPath, ['art']);
});

test('findWaypointInSpecs finds a portal-flagged waypoint instead, when that is the authoring route', () => {
  const dir = tmpSpecDir();
  const spec = baseSpec();
  delete spec.worlds[0].waypoints; // one waypoint per world -- can't have both routes
  spec.links[0].is_waypoint = true;
  spec.links[0].waypoint_name = 'Gate A';
  writeSpecFile(dir, 'one.map.json', spec);
  const loc = findWaypointInSpecs('A', dir);
  assert.ok(loc);
  assert.deepStrictEqual(loc.path, ['links', 0]);
  assert.deepStrictEqual(loc.fieldPath, ['waypoint_art']);
});

test('findWaypointInSpecs refuses a world with no waypoint at all', () => {
  const dir = tmpSpecDir();
  writeSpecFile(dir, 'one.map.json', baseSpec());
  assert.strictEqual(findWaypointInSpecs('B', dir), null);
});

test('findChestInSpecs finds the one-per-world chest by world name alone', () => {
  const dir = tmpSpecDir();
  writeSpecFile(dir, 'one.map.json', baseSpec());
  const loc = findChestInSpecs('A', dir);
  assert.ok(loc);
  assert.deepStrictEqual(loc.path, ['worlds', 0, 'chest']);
});

test('findChestInSpecs refuses a world with no chest', () => {
  const dir = tmpSpecDir();
  writeSpecFile(dir, 'one.map.json', baseSpec());
  assert.strictEqual(findChestInSpecs('B', dir), null);
});

test('findVillageInSpecs matches the singular village object by spec_key', () => {
  const dir = tmpSpecDir();
  writeSpecFile(dir, 'one.map.json', baseSpec());
  const loc = findVillageInSpecs('A', 'v1', dir);
  assert.ok(loc);
  assert.deepStrictEqual(loc.path, ['worlds', 0, 'village']);
});

test('findVillageInSpecs matches the plural villages[] array by spec_key', () => {
  const dir = tmpSpecDir();
  const spec = baseSpec();
  const v = spec.worlds[0].village;
  delete spec.worlds[0].village;
  spec.worlds[0].villages = [v, { ...v, key: 'v2', min_row: 20 }];
  writeSpecFile(dir, 'one.map.json', spec);
  const loc = findVillageInSpecs('A', 'v2', dir);
  assert.ok(loc);
  assert.deepStrictEqual(loc.path, ['worlds', 0, 'villages', 1]);
});

test('findVillageInSpecs refuses a null spec_key (a village with no spec entry) rather than guessing', () => {
  const dir = tmpSpecDir();
  writeSpecFile(dir, 'one.map.json', baseSpec());
  assert.strictEqual(findVillageInSpecs('A', null, dir), null);
});

test('findVillageInSpecs refuses an unknown spec_key', () => {
  const dir = tmpSpecDir();
  writeSpecFile(dir, 'one.map.json', baseSpec());
  assert.strictEqual(findVillageInSpecs('A', 'no-such-key', dir), null);
});

test('writeSpecFieldChange sets, then clears, a portal art field, writing the file both times', () => {
  const dir = tmpSpecDir();
  const file = writeSpecFile(dir, 'one.map.json', baseSpec());
  const loc = findLinkInSpecs('A', { from_x: 550, from_y: 1550 }, dir);

  const set = writeSpecFieldChange(loc, 'stone_gate', CATALOGS);
  assert.strictEqual(set.ok, true);
  const afterSet = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(afterSet.links[0].art, 'stone_gate');

  const cleared = writeSpecFieldChange(loc, null, CATALOGS);
  assert.strictEqual(cleared.ok, true);
  const afterClear = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual('art' in afterClear.links[0], false, 'clearing deletes the key rather than nulling it');
});

test('writeSpecFieldChange writes a nested village post field via extraFieldPath', () => {
  const dir = tmpSpecDir();
  const file = writeSpecFile(dir, 'one.map.json', baseSpec());
  const loc = findVillageInSpecs('A', 'v1', dir);
  const res = writeSpecFieldChange(loc, 'merchant_post', CATALOGS, ['merchant']);
  assert.strictEqual(res.ok, true);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(after.worlds[0].village.art.merchant, 'merchant_post');
});

test('writeSpecFieldChange ABORTS and writes nothing when the result would be invalid', () => {
  const dir = tmpSpecDir();
  const file = writeSpecFile(dir, 'one.map.json', baseSpec());
  const before = fs.readFileSync(file, 'utf8');
  const loc = findLinkInSpecs('A', { from_x: 550, from_y: 1550 }, dir);

  // "pine_tree" is a real catalog entry, but of the wrong point_kind for a
  // portal (its kind is `undefined` in CATALOGS) -- validateMapSpec's
  // checkArt rejects this, so the write must never happen.
  const res = writeSpecFieldChange(loc, 'pine_tree', CATALOGS);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.status, 400);
  assert.match(res.error, /not an entity type of point kind "portal"/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'the file on disk must be byte-identical to before the attempt');
});

test('writeSpecFieldChange sets the arrival side (to_art) independently of the departure art', () => {
  const dir = tmpSpecDir();
  const spec = baseSpec();
  spec.links[0].art = 'stone_gate';
  // A second portal-kind catalog entry, distinct from the departure's art,
  // so this exercises a genuine independent write, not the collapse branch
  // covered by the dedicated test below.
  const catalogs = {
    pointArtTypes: new Map([...CATALOGS.pointArtTypes, ['dungeon_door', 'portal']]),
  };
  const file = writeSpecFile(dir, 'one.map.json', spec);
  const loc = findLinkInSpecs('B', { from_x: 550, from_y: 550 }, dir); // arrival side
  assert.strictEqual(loc.side, 'arrival');

  const res = writeSpecFieldChange(loc, 'dungeon_door', catalogs);
  assert.strictEqual(res.ok, true);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(after.links[0].art, 'stone_gate', 'the departure field is untouched');
  assert.strictEqual(after.links[0].to_art, 'dungeon_door');
});

test('writeSpecFieldChange adds a to_art key when the link had none and the arrival side is set to a DIFFERENT art than departure', () => {
  const dir = tmpSpecDir();
  const spec = baseSpec();
  spec.links[0].art = 'stone_gate';
  // A second portal-kind catalog entry distinct from 'stone_gate'.
  const catalogs = {
    pointArtTypes: new Map([...CATALOGS.pointArtTypes, ['dungeon_door', 'portal']]),
  };
  const file = writeSpecFile(dir, 'one.map.json', spec);
  const loc = findLinkInSpecs('B', { from_x: 550, from_y: 550 }, dir);
  assert.strictEqual(loc.side, 'arrival');

  const res = writeSpecFieldChange(loc, 'dungeon_door', catalogs, [], 'art');
  assert.strictEqual(res.ok, true);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(after.links[0].art, 'stone_gate');
  assert.strictEqual(after.links[0].to_art, 'dungeon_door', 'to_art is added as its own key');
});

test('writeSpecFieldChange DELETES the to_art key (rather than writing a redundant duplicate) when the arrival side is set back to match departure', () => {
  const dir = tmpSpecDir();
  const spec = baseSpec();
  spec.links[0].art = 'stone_gate';
  spec.links[0].to_art = 'dungeon_door'; // previously overridden
  const catalogs = {
    pointArtTypes: new Map([...CATALOGS.pointArtTypes, ['dungeon_door', 'portal']]),
  };
  const file = writeSpecFile(dir, 'one.map.json', spec);
  const loc = findLinkInSpecs('B', { from_x: 550, from_y: 550 }, dir);
  assert.strictEqual(loc.side, 'arrival');

  // Setting to_art BACK to 'stone_gate' -- the same name the departure `art`
  // field already carries -- must collapse to deleting the key, not writing
  // an explicit (and now redundant) duplicate.
  const res = writeSpecFieldChange(loc, 'stone_gate', catalogs, [], 'art');
  assert.strictEqual(res.ok, true);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(after.links[0].art, 'stone_gate');
  assert.strictEqual('to_art' in after.links[0], false, 'to_art is deleted, not set to a redundant duplicate');
});

test('writeSpecFieldChange leaves the departure art field alone when siblingFallbackKey is not passed for it', () => {
  const dir = tmpSpecDir();
  const spec = baseSpec();
  spec.links[0].art = 'stone_gate';
  const file = writeSpecFile(dir, 'one.map.json', spec);
  const loc = findLinkInSpecs('A', { from_x: 550, from_y: 1550 }, dir); // departure side
  assert.strictEqual(loc.side, 'departure');

  // The route never passes siblingFallbackKey for a departure write -- this
  // pins that setting `art` to its own current value is a plain (harmless)
  // overwrite, not a delete, since departure has no sibling to collapse
  // against.
  const res = writeSpecFieldChange(loc, 'stone_gate', CATALOGS);
  assert.strictEqual(res.ok, true);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(after.links[0].art, 'stone_gate');
});

test('writeSpecFieldChange refuses (does not write) if the file changed shape since the path was located', () => {
  const dir = tmpSpecDir();
  const file = writeSpecFile(dir, 'one.map.json', baseSpec());
  const loc = findLinkInSpecs('A', { from_x: 550, from_y: 1550 }, dir);

  // Simulate a concurrent writer that removed the links array entirely
  // between the locate and the write.
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  spec.links = [];
  fs.writeFileSync(file, `${JSON.stringify(spec, null, 2)}\n`);
  const before = fs.readFileSync(file, 'utf8');

  const res = writeSpecFieldChange(loc, 'stone_gate', CATALOGS);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.status, 409);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'no write on a concurrent-change refusal');
});
