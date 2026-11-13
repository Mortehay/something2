// "Select all matching" posts ~1600 subjects (> the app-wide 256kb JSON ceiling) to
// POST /api/admin/images/runs. Source guards, like vfx_sprite.test.js: the global parser skips that
// one path, and the route parses its own 1mb body after requireAdmin (never reachable unauthenticated).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const index = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
const routes = fs.readFileSync(path.join(__dirname, '../src/api/imageVariantRoutes.js'), 'utf8');

test('the global 256kb parser skips POST /api/admin/images/runs', () => {
  assert.match(index, /IMAGE_RUNS_PATH = '\/api\/admin\/images\/runs'/);
  assert.match(index, /req\.method === 'POST' && req\.path === IMAGE_RUNS_PATH/);
});

test('the runs route parses its own 1mb body, after requireAdmin', () => {
  assert.match(routes, /router\.post\('\/runs', express\.json\(\{ limit: '1mb' \}\)/);
  assert.ok(routes.indexOf('router.use(requireAdmin(pool))') < routes.indexOf("router.post('/runs'"));
});
