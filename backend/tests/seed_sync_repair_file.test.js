const test = require('node:test');
const assert = require('node:assert');
const { getGroup } = require('../src/services/seedSync/registry.js');
const { repairDoc } = require('../src/services/seedSync/repairFile.js');
const { validateDoc } = require('../src/services/seedSync/diffGroup.js');
const { SyncFileError } = require('../src/services/seedSync/errors.js');

const items = getGroup('items');
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';

function itemsDoc() {
  return {
    header: { group: 'items', row_counts: { affix_types: 1, item_types: 1 } },
    tables: {
      affix_types: [{ sync_uuid: U1, key: 'cursed' }],
      item_types: [{ sync_uuid: U2, name: 'Sword' }, { sync_uuid: U3, name: 'Shield' }],
    },
  };
}

test('repairDoc: a hand-added row behind a stale row_counts is fixed and the doc then validates', () => {
  const doc = itemsDoc();
  assert.throws(() => validateDoc(doc, items), /row_counts.item_types 1 but 2 rows/);
  const fixes = repairDoc(doc, items);
  assert.deepStrictEqual(fixes, ['header row_counts.item_types 1 -> 2']);
  assert.deepStrictEqual(doc.header.row_counts, { affix_types: 1, item_types: 2 });
  validateDoc(doc, items);
});

test('repairDoc: missing / upper-case sync_uuids, missing and unknown row_counts entries', () => {
  const doc = itemsDoc();
  doc.tables.item_types[0].sync_uuid = `  ${U2.toUpperCase()} `;
  delete doc.tables.item_types[1].sync_uuid;
  doc.header.row_counts = { affix_types: 1, ghosts: 3 };
  const fixes = repairDoc(doc, items);
  assert.strictEqual(doc.tables.item_types[0].sync_uuid, U2);
  assert.match(doc.tables.item_types[1].sync_uuid, /^[0-9a-f-]{36}$/);
  assert.deepStrictEqual(doc.header.row_counts, { affix_types: 1, item_types: 2 });
  assert.strictEqual(fixes.length, 4);
  validateDoc(doc, items);
});

test('repairDoc: a valid doc needs no fix', () => {
  const doc = itemsDoc();
  doc.header.row_counts.item_types = 2;
  assert.deepStrictEqual(repairDoc(doc, items), []);
});

test('repairDoc refuses what needs a choice: duplicate key, duplicate uuid, missing table, wrong group', () => {
  const cases = [
    (d) => { d.tables.item_types[1].name = 'Sword'; },
    (d) => { d.tables.item_types[1].sync_uuid = U2; },
    (d) => { delete d.tables.affix_types; },
    (d) => { d.header.group = 'quests'; },
  ];
  for (const mutate of cases) {
    const doc = itemsDoc();
    mutate(doc);
    const before = JSON.stringify(doc.tables);
    assert.throws(() => repairDoc(doc, items), (e) => e instanceof SyncFileError);
    if (doc.header.group === 'quests') assert.strictEqual(JSON.stringify(doc.tables), before);
  }
});
