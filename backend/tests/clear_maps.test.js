const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { CASCADES } = require('../scripts/clear-maps.js');

// No database needed: this pins CASCADES (the list clear-maps.js prints in
// its confirmation prompt) against every table that migrations actually
// wire with `ON DELETE CASCADE` back to `worlds`. It's the valuable half of
// Task 7's review finding -- if a future migration adds a cascading table
// and nobody updates CASCADES, the confirmation prompt would silently
// understate the damage a `make clear-maps` / `make reseed-map` does. This
// test would catch that at CI time instead of at "oops, I didn't expect
// that table to empty out too".
//
// Scanned as text, not executed/imported as migrations -- migrations need a
// live Postgres to run, and this must not need one.

function tablesWithWorldsCascade() {
  const dir = path.resolve(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  const tables = new Set();

  // Matches a single flat column-definition object containing both
  // `references: 'worlds'` and `onDelete: 'CASCADE'`, in either order and
  // across multiple lines (pgm.createTable column defs in this repo are
  // never nested, so `[^{}]*` safely stops at the enclosing braces).
  const fkRe = /\{[^{}]*references:\s*'worlds'[^{}]*onDelete:\s*'CASCADE'[^{}]*\}/g;
  const tableRe = /pgm\.createTable\(\s*'([a-zA-Z_]+)'/g;

  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');

    const tablePositions = [];
    let tm;
    tableRe.lastIndex = 0;
    while ((tm = tableRe.exec(text))) tablePositions.push({ index: tm.index, name: tm[1] });

    let fm;
    fkRe.lastIndex = 0;
    while ((fm = fkRe.exec(text))) {
      // Attribute the FK to the nearest preceding pgm.createTable(...) call
      // in the same file -- the column def textually follows its owning
      // createTable's name.
      let owner = null;
      for (const tp of tablePositions) {
        if (tp.index <= fm.index) owner = tp.name;
        else break;
      }
      if (owner) tables.add(owner);
    }
  }
  return tables;
}

test('every table with an ON DELETE CASCADE FK to worlds is named in CASCADES', () => {
  const found = tablesWithWorldsCascade();

  // Sanity check on the scanner itself: if this list drifts, something about
  // the migrations (or the regex) changed in a way worth looking at directly,
  // not just silently trusting the set. character_visited_worlds joined in
  // SOMET-263 and world_chests in SOMET-244 -- this test is what caught, both
  // times, that CASCADES had not been told. The second time it caught it
  // across a MERGE: the chests branch added the table, this branch owns the
  // list, and the two never touch the same line so git merged them cleanly.
  // Third time: `waypoints` in SOMET-292 -- and that one drags
  // character_waypoints down with it in turn, which is player progress rather
  // than map data. Fourth: `creature_respawns` in SOMET-309 (SOMET-340), found
  // on main rather than on the branch that added it -- the check does not care
  // which branch introduces a cascading table, only that CASCADES was told.
  //
  // This stays an exact deepEqual rather than "CASCADES covers everything
  // found". A subset check would go green for a new cascading table the moment
  // someone added it to CASCADES without reading it, and green forever after
  // if they never did -- while the whole point is that a NEW row in this set
  // is a decision about what an irreversible delete destroys, and has to be
  // looked at by a person once.
  assert.deepEqual(
    [...found].sort(),
    ['character_visited_worlds', 'creature_respawns', 'map_links', 'merchant_stock',
     'player_binds', 'villages', 'waypoints', 'world_chests', 'world_chunks',
     'world_creatures', 'world_items', 'world_players'].sort(),
  );

  for (const table of found) {
    const covered = CASCADES.some((entry) => entry === table || entry.startsWith(`${table} `) || entry.startsWith(`${table}(`));
    assert.ok(covered, `CASCADES is missing "${table}", which migrations cascade-delete from worlds`);
  }
});

test('merchant_stock is covered deliberately, not by accident', () => {
  // merchant_stock (1714440032000_merchant_stock.js) actually cascades from
  // worlds TWO ways: a direct `world_id -> worlds ON DELETE CASCADE` FK, and
  // indirectly via `village_id -> villages ON DELETE CASCADE` (villages
  // itself cascades from worlds). Either FK alone would already empty
  // merchant_stock when its world is deleted, so this is redundant by
  // design, not a gap -- but it's exactly the kind of table someone
  // reviewing "does clear-maps mention everything a village drags down"
  // could miss if they only followed the villages->merchant_stock path and
  // assumed the direct FK was the only route. Documented here so a future
  // schema change to either FK gets noticed against this assertion instead
  // of silently narrowing what CASCADES actually covers.
  assert.ok(CASCADES.includes('merchant_stock'), 'merchant_stock must be named explicitly in CASCADES');
});
