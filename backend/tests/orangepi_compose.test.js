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

// Slices a single `handle ... { ... }` block out of the Caddyfile so an
// assertion can be scoped to what's INSIDE that block, not merely "appears
// somewhere after the header". A lazy `[\s\S]*?` between a header and a
// directive only proves ordering -- by mutation-testing proof, a Caddyfile
// that sends every `handle` block's traffic to a bogus upstream still
// satisfies "reverse_proxy backend:3101 appears somewhere after handle
// /api/* {" as long as SOME later block still mentions it. Same technique as
// the cloudflared service-block slice below: find the header, then find the
// closing brace at the block's own indent level (a single tab, here -- see
// the Caddyfile itself), and assert only against what's between them.
function extractHandleBlock(text, headerPattern) {
  const headerMatch = headerPattern.exec(text);
  assert.ok(headerMatch, `expected to find a block header matching ${headerPattern}`);
  const bodyStart = headerMatch.index + headerMatch[0].length;
  const closeMatch = /\n\t\}/.exec(text.slice(bodyStart));
  assert.ok(closeMatch, `expected a closing brace for the block starting at ${headerPattern}`);
  return text.slice(bodyStart, bodyStart + closeMatch.index);
}

test('caddy proxies both backend surfaces to one upstream', () => {
  const text = read(CADDYFILE);
  // handle blocks are crucial: they match paths before applying directives,
  // so reverse_proxy sees the original path. Without handle blocks, try_files
  // would rewrite every path to /index.html BEFORE reverse_proxy evaluates.
  const apiBlock = extractHandleBlock(text, /handle \/api\/\* \{/);
  assert.match(apiBlock, /reverse_proxy backend:3101/);
  // The authority websocket is attached to the SAME http server as the REST
  // API (backend/src/authority/server.js), so it is the same upstream.
  const authorityBlock = extractHandleBlock(text, /handle \/authority\* \{/);
  assert.match(authorityBlock, /reverse_proxy backend:3101/);
});

test('caddy serves the SPA with a history fallback', () => {
  const text = read(CADDYFILE);
  // The default handle block (no path matcher) catches unmatched paths and
  // serves the SPA. Within a handle block, try_files sees only matching paths.
  const spaBlock = extractHandleBlock(text, /handle \{/);
  assert.match(spaBlock, /root \* \/srv/);
  // react-router owns client-side routes; without this, a hard reload on any
  // route other than / returns 404.
  assert.match(spaBlock, /try_files \{path\} \/index\.html/);
  assert.match(spaBlock, /file_server/);
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
  // Tightened (deferred-6/M4): the loop above only catches the exact
  // short-form strings it lists, so it misses the long-form `type: bind`
  // mount syntax and partial mounts like `./backend/src:/app/src`. Any bind
  // target under /app at all reintroduces a source mount regardless of
  // source path or short/long form, so also assert on the target side.
  assert.ok(!/:\/app\b/.test(text), 'no volume may bind-mount anything to a path under /app');
});

test('postgres data lives outside the app directory', () => {
  const text = read(COMPOSE);
  // Provisioning empties the app dir; data under it would be destroyed on
  // every re-provision, and would present as corruption rather than as
  // operator error. It must be REQUIRED (`:?`), not merely present with a
  // default (`:-`): a default path inside the app directory would still
  // match a looser assertion here while defeating the invariant this test
  // exists to guard -- only `:?` forces an operator to choose a real path
  // outside the app directory before the stack will start.
  assert.match(text, /\$\{ORANGEPI_DATA_DIR:\?[^}]*\}\/pgdata:\/var\/lib\/postgresql\/data/);
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
  // Tightened (deferred-6/M4): the check above only rules out `replicas:`,
  // not a second service that runs the same backend image under another
  // name. Assert the service is declared exactly once.
  const backendDeclarations = text.match(/\n {2}backend:\n/g) || [];
  assert.equal(
    backendDeclarations.length,
    1,
    `expected exactly one "backend:" service declaration, found ${backendDeclarations.length}`
  );
});

test('the caddy upstream resolves to a declared backend service on its declared port', () => {
  // I6: nothing else ties these files together. All correct today, but
  // invisible to a per-task review split across tickets -- the Caddyfile's
  // `backend:3101` upstream, the compose service actually named `backend`,
  // and that service's PORT env var could each be edited independently and
  // silently drift apart.
  const caddyText = read(CADDYFILE);
  const composeText = read(COMPOSE);

  const upstreamMatch = /reverse_proxy ([\w.-]+):(\d+)/.exec(caddyText);
  assert.ok(upstreamMatch, 'expected to find a reverse_proxy upstream in the Caddyfile');
  const [, upstreamHost, upstreamPort] = upstreamMatch;

  const serviceIdx = composeText.indexOf(`\n  ${upstreamHost}:\n`);
  assert.ok(
    serviceIdx !== -1,
    `Caddyfile upstream host "${upstreamHost}" is not a service declared in ${COMPOSE}`
  );
  const serviceRest = composeText.slice(serviceIdx + 1);
  const serviceEnd = serviceRest.search(/\n {2}\S/);
  const serviceBlock = serviceEnd === -1 ? serviceRest : serviceRest.slice(0, serviceEnd);
  assert.match(
    serviceBlock,
    new RegExp(`PORT=${upstreamPort}\\b`),
    `service "${upstreamHost}" does not declare PORT=${upstreamPort} to match the Caddyfile upstream`
  );
});

test('the frontend image copies the Caddyfile to where the caddy base image reads it', () => {
  // I6, other half: caddy:2-alpine reads /etc/caddy/Caddyfile by default with
  // no CMD override in frontend.Dockerfile, so the COPY destination is load
  // bearing -- a typo here would build successfully and serve nothing but
  // Caddy's default page.
  const dockerfileText = read(path.join(ORANGEPI, 'frontend.Dockerfile'));
  assert.match(
    dockerfileText,
    /COPY compose\/orangepi\/caddy\/Caddyfile \/etc\/caddy\/Caddyfile/,
    'frontend.Dockerfile must copy the Caddyfile to /etc/caddy/Caddyfile'
  );
});
