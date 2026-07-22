const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

test('map_links migration exposes up and down', () => {
  const mig = require(path.join(__dirname, '..', 'migrations', '1714440028000_create_map_links.js'));
  assert.equal(typeof mig.up, 'function');
  assert.equal(typeof mig.down, 'function');
});
