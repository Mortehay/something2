const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { GROUPS } = require('../src/services/seedSync/registry.js');
const { validateDoc } = require('../src/services/seedSync/diffGroup.js');

// Every registered group's checked-in file must pass the validation a seed run applies. A new
// table in a group (or a new slice of the art group) without its file entry refuses the whole
// group on every other PC ("missing table ...").
const DIR = path.join(__dirname, '../seeds/sync');

// Adapter groups (maps) keep their own file format and validate in their adapter.
for (const group of GROUPS.filter((g) => !g.adapter)) {
  test(`checked-in seeds/sync/${group.id}.json validates against the registry`, () => {
    const file = path.join(DIR, `${group.id}.json`);
    assert.ok(fs.existsSync(file), `${group.id}.json is checked in`);
    validateDoc(JSON.parse(fs.readFileSync(file, 'utf8')), group);
  });
}
