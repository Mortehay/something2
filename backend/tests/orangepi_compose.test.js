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
  assert.match(text, /reverse_proxy \/api\/\* backend:3101/);
  // The authority websocket is attached to the SAME http server as the REST
  // API (backend/src/authority/server.js), so it is the same upstream.
  assert.match(text, /reverse_proxy \/authority\* backend:3101/);
});

test('caddy serves the SPA with a history fallback', () => {
  const text = read(CADDYFILE);
  assert.match(text, /root \* \/srv/);
  // react-router owns client-side routes; without this, a hard reload on any
  // route other than / returns 404.
  assert.match(text, /try_files \{path\} \/index\.html/);
  assert.match(text, /file_server/);
});
