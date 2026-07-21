const test = require('node:test');
const assert = require('node:assert');

require('./helpers/auth.js');
const request = require('supertest');

const { app } = require('../src/index.js');

// Walk Express's REAL router stack — never a hand-maintained list, which drifts
// and lets an unguarded route slip through ("guard defends a copy").
function routerStack() {
  const router = app._router || app.router;
  assert.ok(router && router.stack, 'could not locate the Express router stack');
  return router.stack;
}

function mutatingLayers() {
  const out = [];
  for (const layer of routerStack()) {
    if (!layer.route) continue;
    const path = layer.route.path;
    for (const m of Object.keys(layer.route.methods)) {
      if (['post', 'put', 'delete'].includes(m)
          && path.startsWith('/api') && !path.startsWith('/api/auth')) {
        out.push({ label: `${m.toUpperCase()} ${path}`, layer });
      }
    }
  }
  return out;
}

// A route is guarded if some layer in its own handler chain carries the marker
// property set by requireAdmin/requireAuth (see auth/middleware.js).
function isGuarded(layer) {
  return layer.route.stack.some((h) => h.handle && (h.handle.isAdminGuard || h.handle.isAuthGuard));
}

test('every mutating /api route (except auth) is guarded by requireAdmin/requireAuth', () => {
  const routes = mutatingLayers();
  // A walk that matches zero routes would pass vacuously — assert the real
  // surface first (~17 mutating admin routes).
  assert.ok(
    routes.length >= 15,
    `expected the full mutating surface (~17), found ${routes.length} — a zero/low match proves nothing`,
  );
  const unguarded = routes.filter((r) => !isGuarded(r.layer)).map((r) => r.label);
  assert.deepEqual(unguarded, [], `unguarded mutating routes: ${unguarded.join(', ')}`);
});

test('GET /api/dev-token returns 404 (the takeover primitive is gone)', async () => {
  const res = await request(app).get('/api/dev-token?user_id=1');
  assert.equal(res.status, 404);
});
