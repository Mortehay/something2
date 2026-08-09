const test = require('node:test');
const assert = require('node:assert');

// No-DB structural test, same fakePgm idiom as migration_biomes_down.test.js.
// What it guards is ORDER: the backfill UPDATE has to run while user_id still
// exists and before character_id is made NOT NULL. Getting that wrong produces
// a migration that works on an empty database and destroys a populated one --
// exactly the case a DB test on a dev box with no players would not catch.
function fakePgm() {
  const order = [];
  const rec = (op) => (...args) => order.push({ op, args });
  return {
    order,
    sql: (s) => order.push({ op: 'sql', s }),
    createTable: rec('createTable'),
    dropTable: rec('dropTable'),
    addColumns: rec('addColumns'),
    dropColumns: rec('dropColumns'),
    addConstraint: rec('addConstraint'),
    dropConstraint: rec('dropConstraint'),
    createIndex: rec('createIndex'),
    dropIndex: rec('dropIndex'),
    createExtension: rec('createExtension'),
    func: (s) => ({ __func: s }),
  };
}

const mig = require('../migrations/1714440092000_characters.js');
const TABLES = ['world_players', 'player_binds', 'player_progression', 'player_items', 'player_equipment'];

test('up creates characters before it references them', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const createIdx = pgm.order.findIndex((c) => c.op === 'createTable' && c.args[0] === 'characters');
  assert.ok(createIdx !== -1, 'must create the characters table');
  const firstAddIdx = pgm.order.findIndex((c) => c.op === 'addColumns' && TABLES.includes(c.args[0]));
  assert.ok(createIdx < firstAddIdx, 'characters must exist before any table gains character_id');
});

test('the backfill UPDATE runs before user_id is dropped, for every table', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  for (const table of TABLES) {
    const updateIdx = pgm.order.findIndex(
      (c) => c.op === 'sql' && new RegExp(`UPDATE\\s+${table}\\b`, 'i').test(c.s) && /character_id/i.test(c.s));
    const dropIdx = pgm.order.findIndex(
      (c) => c.op === 'dropColumns' && c.args[0] === table);
    assert.ok(updateIdx !== -1, `${table} must be backfilled`);
    assert.ok(dropIdx !== -1, `${table} must drop user_id`);
    assert.ok(updateIdx < dropIdx, `${table}: the backfill reads user_id, so it must run before the drop`);
  }
});

test('character_id is only made NOT NULL after the backfill', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  for (const table of TABLES) {
    const updateIdx = pgm.order.findIndex(
      (c) => c.op === 'sql' && new RegExp(`UPDATE\\s+${table}\\b`, 'i').test(c.s) && /character_id/i.test(c.s));
    const notNullIdx = pgm.order.findIndex(
      (c) => c.op === 'sql' && new RegExp(`ALTER TABLE ${table}[\\s\\S]*SET NOT NULL`, 'i').test(c.s));
    assert.ok(notNullIdx !== -1, `${table}: character_id must end up NOT NULL`);
    assert.ok(updateIdx < notNullIdx, `${table}: NOT NULL before the backfill would reject every existing row`);
  }
});

test('the backfill inserts characters pointing at Warrior', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const insert = pgm.order.find((c) => c.op === 'sql' && /INSERT INTO characters/i.test(c.s));
  assert.ok(insert, 'must insert backfilled characters');
  assert.match(insert.s, /'Warrior'/, 'backfilled characters must be Warriors, not the legacy Player type');
  assert.match(insert.s, /slot/i);
});

test('the backfill only creates characters for users that hold state', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const insert = pgm.order.find((c) => c.op === 'sql' && /INSERT INTO characters/i.test(c.s));
  // A blanket "one character per user" would hand a character to every
  // account that has never played, including throwaway test registrations.
  for (const table of ['world_players', 'player_binds', 'player_progression', 'player_items', 'player_equipment']) {
    assert.match(insert.s, new RegExp(`EXISTS[\\s\\S]*${table}`, 'i'),
      `the insert must be gated on ${table} holding a row for the user`);
  }
});

test('the slot cap is a database constraint, not a comment', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const check = pgm.order.find(
    (c) => c.op === 'addConstraint' && c.args[0] === 'characters' && /slot/i.test(JSON.stringify(c.args)));
  assert.ok(check, 'characters must carry a slot CHECK constraint');
  assert.match(JSON.stringify(check.args), /BETWEEN 1 AND 8/i);
  const unique = pgm.order.find(
    (c) => c.op === 'addConstraint' && c.args[0] === 'characters'
        && JSON.stringify(c.args).includes('user_id') && JSON.stringify(c.args).includes('slot'));
  assert.ok(unique, 'characters must carry a UNIQUE(user_id, slot) -- the CHECK alone does not cap the count');
});

test('users loses starting_loadout_granted_at only after it is copied onto characters', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const insertIdx = pgm.order.findIndex((c) => c.op === 'sql' && /INSERT INTO characters/i.test(c.s));
  const dropIdx = pgm.order.findIndex(
    (c) => c.op === 'dropColumns' && c.args[0] === 'users');
  assert.ok(dropIdx !== -1, 'the column must move off users');
  assert.ok(insertIdx < dropIdx, 'the flag must be carried onto characters before it is dropped from users');
  const insert = pgm.order[insertIdx];
  assert.match(insert.s, /starting_loadout_granted_at/,
    'the backfill must carry the flag across, or every existing player is re-granted a starter kit');
});

test('down re-keys the lowest slot back before dropping characters', () => {
  const pgm = fakePgm();
  mig.down(pgm);
  const dropIdx = pgm.order.findIndex((c) => c.op === 'dropTable' && c.args[0] === 'characters');
  assert.ok(dropIdx !== -1, 'down must drop the characters table');
  for (const table of TABLES) {
    const restoreIdx = pgm.order.findIndex(
      (c) => c.op === 'sql' && new RegExp(`UPDATE\\s+${table}\\b`, 'i').test(c.s) && /user_id/i.test(c.s));
    assert.ok(restoreIdx !== -1, `${table} must be re-keyed back to user_id`);
    assert.ok(restoreIdx < dropIdx, `${table}: the restore reads characters, so it must run before the drop`);
  }
});
