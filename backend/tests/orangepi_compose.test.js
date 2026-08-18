const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// SOMET-423. Today a single tunnel is enough only because the vite DEV SERVER
// proxies /api and /authority through to backend:3101
// (frontend/vite.config.js). A production static bundle has no such proxy, so
// that routing has to be reproduced by Caddy -- and if it is not, the page
// loads and the game is simply unplayable, which is a much worse failure than
// a page that does not load at all.

const ORANGEPI = path.join(__dirname, '..', '..', 'compose', 'orangepi');
const CADDYFILE = path.join(ORANGEPI, 'caddy', 'Caddyfile');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

test('caddy proxies both backend surfaces to one upstream', () => {
  const text = read(CADDYFILE);
  // handle blocks are crucial: they match paths before applying directives,
  // so reverse_proxy sees the original path. Without handle blocks, try_files
  // would rewrite every path to /index.html BEFORE reverse_proxy evaluates.
  assert.match(text, /handle \/api\/\* \{[\s\S]*?reverse_proxy backend:3101/);
  // The authority websocket is attached to the SAME http server as the REST
  // API (backend/src/authority/server.js), so it is the same upstream.
  assert.match(text, /handle \/authority\* \{[\s\S]*?reverse_proxy backend:3101/);
});

test('caddy serves the SPA with a history fallback', () => {
  const text = read(CADDYFILE);
  // The default handle block (no path matcher) catches unmatched paths and
  // serves the SPA. Within a handle block, try_files sees only matching paths.
  assert.match(text, /handle \{[\s\S]*?root \* \/srv/);
  // react-router owns client-side routes; without this, a hard reload on any
  // route other than / returns 404.
  assert.match(text, /handle \{[\s\S]*?try_files \{path\} \/index\.html/);
  assert.match(text, /handle \{[\s\S]*?file_server/);
});

const COMPOSE = path.join(ORANGEPI, 'docker-compose.yml');

test('production composition excludes the development-only services', () => {
  const text = read(COMPOSE);
  // Redis has no reference anywhere in backend/src -- it belonged to the
  // frozen Go engine. sprite-gen is a multi-GB CPU Stable Diffusion image
  // that no small board will run.
  for (const service of ['redis:', 'game-engine:', 'sprite-gen:']) {
    assert.ok(
      !text.includes(`\n  ${service}`),
      `${service} must not be in the production composition`
    );
  }
});

test('production composition bind-mounts no application source', () => {
  const text = read(COMPOSE);
  // The container IS the service here. A source bind mount would silently
  // reintroduce the development stack's behaviour.
  for (const mount of ['./backend:/app', './frontend:/app', './engine:/app']) {
    assert.ok(!text.includes(mount), `source bind mount ${mount} defeats the production image`);
  }
});

test('postgres data lives outside the app directory', () => {
  const text = read(COMPOSE);
  // Provisioning empties the app dir; data under it would be destroyed on
  // every re-provision, and would present as corruption rather than as
  // operator error.
  assert.match(text, /\$\{ORANGEPI_DATA_DIR[^}]*\}\/pgdata:\/var\/lib\/postgresql\/data/);
});

test('the tunnel never opens as a side effect of starting the stack', () => {
  const text = read(COMPOSE);
  // Same rule the development stack applies to ngrok: `up` must never
  // publish the game to the internet without being asked.
  const idx = text.indexOf('\n  cloudflared:');
  assert.ok(idx !== -1, 'cloudflared service must exist');
  // Slice past the leading newline, then cut at the next 2-space-indented
  // service so the assertion runs against this block and no other.
  const rest = text.slice(idx + 1);
  const end = rest.search(/\n {2}\S/);
  const block = end === -1 ? rest : rest.slice(0, end);
  assert.match(block, /profiles: \["tunnel"\]/);
});

test('exactly one backend instance is configured', () => {
  const text = read(COMPOSE);
  // The authority holds an in-memory tick loop per live world; two instances
  // would disagree about the same world.
  assert.ok(!/replicas:/.test(text), 'no replica count may be set');
});
