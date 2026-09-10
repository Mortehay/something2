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

// SOMET-555. The walk above only ever covered post/put/delete, and that is
// exactly how six world READ routes shipped with no guard at all -- including
// GET /api/world-graph, which handed every world and every map link to an
// unauthenticated caller while GET /api/worlds was carefully projecting the
// same data per player. A read that leaks is still a leak; enumerate GETs too.
//
// The route list stays derived from the live Express stack (same reason as
// above: a hand-maintained list drifts). Only the DECISIONS are written down --
// each entry below is a route someone deliberately left open, with why. A new
// unguarded GET fails this test until it is either guarded or added here on
// purpose, which is the whole point.
const PUBLIC_GETS = {
  '/api/health': 'liveness probe; must answer before anything is authenticated',

  // Game content definitions. The canvas renders from these and fetches them
  // around the login boundary, so they are open by design rather than oversight.
  '/api/map/config': 'catalog the client renders from',
  '/api/map/tiles': 'catalog the client renders from',
  '/api/entity-types': 'catalog the client renders from',
  '/api/item-types': 'catalog the client renders from',
  '/api/weapon-catalogs': 'catalog the client renders from',
  '/api/vfx-effects': 'catalog the client renders from',
  '/api/tile-types': 'catalog the client renders from',
  '/api/creature-behaviors': 'catalog the client renders from',
  '/api/biomes': 'catalog the client renders from',

  // Art pipeline status + asset bytes.
  '/api/sprite-capability': 'reports whether image generation is available',
  '/api/sprite-jobs/:jobId': 'job status polled by the art console',
  '/api/entity-jobs/:jobId': 'job status polled by the art console',
  '/api/tile-jobs/:jobId': 'job status polled by the art console',
  '/api/assets/*': 'serves generated image bytes; guarding these would gate every sprite',

  // SOMET-555 deferred three canvas reads pending a perf decision; SOMET-559
  // measured it and guarded two of them. /chunk and /preview are now behind
  // playerGuard and are pinned as such below -- do not re-add them here.
  //
  // /overview stays open ON PURPOSE, and it is the one route where the cost
  // objection was real. A warm /overview is served entirely from
  // worldOverviewCache and touches the database ZERO times; adding the guard's
  // `SELECT token_version, role FROM users` turns a no-query route into a
  // one-query route and roughly doubles it (measured: 5.03ms -> ~9.8ms, versus
  // +15% on /chunk, which already issues ~7 queries per request). This is also
  // the minimap path with the documented 429/retry-storm history. Closing it
  // needs either acceptance of that latency or a short-TTL token_version cache,
  // and the latter weakens revocation, so it is a product decision rather than
  // a cleanup. What it exposes is terrain for a world id; actually travelling
  // there is separately authorised server-side (SOMET-266).
  '/api/worlds/:id/overview': 'OPEN BY DECISION (SOMET-559): zero-query cached path; guarding doubles it',
};

function readLayers() {
  const out = [];
  for (const layer of routerStack()) {
    if (!layer.route) continue;
    const path = layer.route.path;
    if (!layer.route.methods.get) continue;
    if (!String(path).startsWith('/api') || String(path).startsWith('/api/auth')) continue;
    out.push({ label: `GET ${path}`, path, layer });
  }
  return out;
}

test('every /api GET is guarded, or is an explicitly recorded public route', () => {
  const routes = readLayers();
  // Same vacuity guard as the mutating walk: a stack that matched nothing would
  // make the assertion below pass while proving nothing.
  assert.ok(routes.length >= 30,
    `expected the full GET surface, found ${routes.length} -- a low match proves nothing`);

  const undeclared = routes
    .filter((r) => !isGuarded(r.layer) && !(r.path in PUBLIC_GETS))
    .map((r) => r.label);

  assert.deepEqual(undeclared, [],
    'unguarded GET routes that are not declared public: ' + undeclared.join(', ')
    + ' -- add a guard, or add the path to PUBLIC_GETS with the reason it is open.');
});

test('PUBLIC_GETS does not accumulate entries for routes that are gone or now guarded', () => {
  // Without this the allowlist rots: a route that later gains a guard, or is
  // deleted, would leave an entry behind that silently pre-authorises the next
  // route to reuse that path.
  const byPath = new Map(readLayers().map((r) => [r.path, r]));
  const stale = Object.keys(PUBLIC_GETS).filter((p) => {
    const r = byPath.get(p);
    return !r || isGuarded(r.layer);
  });
  assert.deepEqual(stale, [],
    `PUBLIC_GETS entries no longer needed (route removed or now guarded): ${stale.join(', ')}`);
});

test('the world reads fixed by SOMET-555 and SOMET-559 are guarded, not merely allowlisted', () => {
  // Pins the actual fix. If someone "fixes" a future failure by moving one of
  // these into PUBLIC_GETS, this fails and says so.
  const byPath = new Map(readLayers().map((r) => [r.path, r]));
  const fixed = [
    '/api/world-graph',          // SOMET-555
    '/api/worlds/:id/links',     // SOMET-555
    '/api/worlds/:id/villages',  // SOMET-555
    '/api/worlds/:id/chunk',     // SOMET-559
    '/api/worlds/:id/preview',   // SOMET-559
  ];
  for (const p of fixed) {
    const r = byPath.get(p);
    assert.ok(r, `${p} disappeared from the router`);
    assert.ok(isGuarded(r.layer), `${p} must be guarded, not public`);
    assert.ok(!(p in PUBLIC_GETS), `${p} must not be in PUBLIC_GETS`);
  }
});

test('/chunk admits a plain player, not just an admin', () => {
  // The guard choice is load-bearing, and the two guards are interchangeable
  // to every test above -- isGuarded() accepts either. If someone swaps
  // playerGuard for adminGuard here (copying the SOMET-555 routes next door),
  // every auth test still passes while ordinary players stop being able to
  // stream terrain, i.e. the game breaks for everyone but admins.
  const byPath = new Map(readLayers().map((r) => [r.path, r]));
  for (const p of ['/api/worlds/:id/chunk', '/api/worlds/:id/preview']) {
    const layer = byPath.get(p).layer;
    const guards = layer.route.stack.filter((s) => s.handle.isAuthGuard);
    assert.equal(guards.length, 1, `${p} should carry exactly one auth guard`);
    assert.ok(!guards[0].handle.isAdminGuard,
      `${p} must use playerGuard, not adminGuard -- every signed-in player streams chunks`);
  }
});

test('GET /api/dev-token returns 404 (the takeover primitive is gone)', async () => {
  const res = await request(app).get('/api/dev-token?user_id=1');
  assert.equal(res.status, 404);
});
