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
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
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
  // Scoped to the SERVING services (SOMET-401). The rule is that nothing
  // which serves the game may have source bind-mounted -- for those, the
  // container IS the service. The deploy-hook is not a serving container: it
  // drives docker compose ON the board, so it must see the board's clone, and
  // at the SAME path the host sees it, because the host daemon resolves the
  // bind-mount paths in the compose file it is handed. Mounting the clone
  // somewhere else would leave the CLI and the daemon disagreeing about what
  // `.` means. Asserted per service rather than over the whole file, so this
  // keeps its full strength where it matters.
  for (const service of ['caddy', 'backend', 'db', 'cloudflared']) {
    const block = extractServiceBlock(text, service);
    assert.ok(
      !/:\/app\b/.test(block),
      `${service} serves the game and must not bind-mount anything under /app`
    );
  }
});

// Slices one service's block out of the compose file: from its two-space
// header to the next two-space header (or end of file).
function extractServiceBlock(text, service) {
  const start = new RegExp(`^  ${service}:$`, 'm').exec(text);
  assert.ok(start, `expected a ${service} service`);
  const rest = text.slice(start.index + start[0].length);
  const next = /^  [a-z][a-z0-9-]*:$/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

test('the deploy hook is opt-in and cannot run unauthenticated', () => {
  const text = read(COMPOSE);
  const block = extractServiceBlock(text, 'deploy-hook');
  // An internet-reachable deploy trigger must be something you turn on
  // deliberately, never something that appears because you started the stack
  // -- the same rule the tunnel itself follows.
  assert.match(block, /profiles: \["hook"\]/);
  // Passed through with an empty default ON PURPOSE: compose interpolates
  // every service whatever profile is active, so `${VAR:?...}` here would
  // stop the whole stack -- game included -- on a board with no hook
  // configured. The refusal lives in server.js, which exits rather than
  // starting an unauthenticated endpoint.
  assert.match(block, /DEPLOY_HOOK_SECRET=\$\{DEPLOY_HOOK_SECRET:-\}/);
  assert.match(block, /PI_LOCAL=1/, 'the hook runs the same deploy.sh an operator runs');
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

// SOMET-439. Two environment lines, and the whole of SOMET-437 is inert
// without them: the backend only resolves a real client address when the
// deployment tells it what is in front.
//
// Asserted against the backend service's ENVIRONMENT LINES, not its raw text,
// for two reasons. Scoping to the service block alone would still pass if a
// later edit moved the lines onto db or cloudflared, where they do nothing;
// and matching raw text would let a COMMENT mentioning the variable satisfy
// the guard — which is not hypothetical, the first version of this test
// failed against the explanatory comment three lines above the real setting.
function envLinesOf(text, service) {
  return extractServiceBlock(text, service)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '));
}

test('the backend is told what proxies sit in front of it', () => {
  const env = envLinesOf(read(COMPOSE), 'backend');
  assert.ok(
    env.includes('- TRUST_PROXY=${TRUST_PROXY:-2}'),
    'backend must trust exactly the two hops in front of it (cloudflared -> caddy); '
    + `without a hop count every player shares one rate-limit bucket. Saw: ${env.join(' | ')}`,
  );
  assert.ok(
    env.includes('- TRUST_CF_CONNECTING_IP=${TRUST_CF_CONNECTING_IP:-1}'),
    'behind Cloudflare the unforgeable client address is CF-Connecting-IP; '
    + 'X-Forwarded-For alone is client-supplied',
  );
  // The value that must never be SET (a comment explaining why it is refused
  // is fine): it would trust a header any client can write, turning both
  // limiters into something anyone can walk past by rotating one.
  assert.ok(
    !env.some((l) => /^- TRUST_PROXY=(true|\$\{TRUST_PROXY:-true\})$/.test(l)),
    'TRUST_PROXY must never be blanket-true',
  );
});

test('ngrok is opt-in, pinned to an exact version, and publishes no port', () => {
  const text = read(COMPOSE);
  const idx = text.indexOf('\n  ngrok:');
  assert.ok(idx !== -1, 'ngrok service must exist');
  const rest = text.slice(idx + 1);
  const end = rest.search(/\n {2}\S/);
  const block = end === -1 ? rest : rest.slice(0, end);
  assert.match(block, /profiles: \["ngrok"\]/);
  // An exact version, not latest or a bare major: with restart: unless-stopped
  // a floating tag could change versions unattended on a reboot.
  assert.match(block, /image: ngrok\/ngrok:\d+\.\d+\.\d+(-[a-z]+)?\n/);
  // No url flag (the account's assigned domain is used); upstream is Caddy by
  // name, so nothing needs a host port.
  assert.match(block, /command: http caddy:80 --log=stdout\n/);
  assert.doesNotMatch(block, /^\s+ports:/m);
});

test('the deploy hook keeps the data dir read-only but can write the locks dir', () => {
  const text = read(path.join(ORANGEPI, 'docker-compose.yml'));
  const block = text.slice(text.indexOf('\n  deploy-hook:'));
  const mounts = block.split('\n').filter((l) => /^\s+- .*ORANGEPI_DATA_DIR/.test(l));
  const data = mounts.find((l) => /:ro\s*$/.test(l));
  assert.ok(data, 'the data dir mount must stay :ro (it holds .env)');
  const locks = mounts.find((l) => l.includes('/locks'));
  assert.ok(locks, 'the locks subdirectory must be mounted');
  assert.ok(!/:ro\s*$/.test(locks), 'the locks mount must be read-write');
  const m = /- (\$\{ORANGEPI_DATA_DIR[^}]*\}\/locks):(\$\{ORANGEPI_DATA_DIR[^}]*\}\/locks)\s*$/.exec(locks);
  assert.ok(m && m[1] === m[2], 'locks must be mounted at the same path on both sides');
  assert.ok(mounts.indexOf(locks) > mounts.indexOf(data), 'locks must be listed after the read-only mount');
});

test('BOARD_TAB_ENABLED is set in the dev compose and never in the board compose', () => {
  const dev = read(path.join(__dirname, '..', '..', 'compose', 'develop', 'docker-compose.yml'));
  assert.match(dev, /- BOARD_TAB_ENABLED=\$\{BOARD_TAB_ENABLED:-1\}/);
  assert.ok(!read(path.join(ORANGEPI, 'docker-compose.yml')).includes('BOARD_TAB_ENABLED'));
});

// SOMET-722. Testers must see real art and hear real sound, so the board runs
// its own object storage. These pin the properties that make that safe.
const withoutComments = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

test('rustfs is part of the default stack, pinned to an exact release, and publishes no port', () => {
  const block = withoutComments(extractServiceBlock(read(COMPOSE), 'rustfs'));
  assert.doesNotMatch(block, /^\s+profiles:/m, 'object storage is not opt-in: art and audio need it');
  // An exact release, not latest and not a floating tag.
  assert.match(block, /^\s+image: rustfs\/rustfs:1\.0\.4$/m);
  assert.doesNotMatch(block, /:latest/);
  // Reached only by name from the backend; nothing on the board's LAN or loopback.
  assert.doesNotMatch(block, /^\s+ports:/m);
  assert.doesNotMatch(block, /^\s+expose:/m);
  assert.match(block, /restart: unless-stopped/);
  assert.match(block, /test: \["CMD", "curl", "-fsS", "http:\/\/127\.0\.0\.1:9000\/health"\]/);
  assert.doesNotMatch(read(COMPOSE), /pgsty/, 'the third-party MinIO fork is gone');
  assert.doesNotMatch(read(COMPOSE), /^  minio:/m);
});

test('rustfs data is a named volume, not a bind mount, so uid 10001 can write it', () => {
  const text = read(COMPOSE);
  const block = withoutComments(extractServiceBlock(text, 'rustfs'));
  assert.match(block, /^\s+- rustfs_data:\/data$/m);
  // A host directory owned by another user makes the image die with "Permission denied (os error 13)".
  assert.doesNotMatch(block, /ORANGEPI_DATA_DIR/);
  assert.doesNotMatch(block, /:\/app\b/);
  assert.match(withoutComments(text), /^volumes:\n {2}rustfs_data:\s*$/m, 'the volume is declared');
});

test('rustfs takes its credentials from the same names the backend reads', () => {
  const text = read(COMPOSE);
  const rustfs = envLinesOf(text, 'rustfs');
  assert.ok(rustfs.includes('- RUSTFS_ACCESS_KEY=${MINIO_ACCESS_KEY:-minioadmin}'), rustfs.join(' | '));
  // `:-` and not `:?` ON PURPOSE. Compose interpolates the whole file for every command, so a required
  // marker here would make `tunnel.sh`, `remote.sh compose ...` and the first deploy fail on a board that
  // was provisioned before this key existed. An empty value is still safe: rustfs exits ("must not be
  // empty") instead of coming up with a default. Both variables must always be passed, because with no
  // credentials at all it starts on its built-in default.
  assert.ok(rustfs.includes('- RUSTFS_SECRET_KEY=${MINIO_ROOT_PASSWORD:-}'), rustfs.join(' | '));
  assert.ok(!rustfs.some((l) => /minioadmin\}?$/.test(l) && /SECRET/.test(l)), 'no literal default password');
  assert.ok(rustfs.includes('- RUSTFS_CONSOLE_ENABLE=false'), 'the console is off');
  const backend = envLinesOf(text, 'backend');
  assert.ok(backend.includes('- MINIO_ENDPOINT=${MINIO_ENDPOINT:-rustfs:9000}'));
  assert.ok(backend.includes('- MINIO_ACCESS_KEY=${MINIO_ACCESS_KEY:-minioadmin}'));
  assert.ok(backend.includes('- MINIO_SECRET_KEY=${MINIO_ROOT_PASSWORD:-minioadmin}'));
  assert.doesNotMatch(text, /not configured yet/i);
});

test('the backend does not wait for rustfs, and caddy never routes to it', () => {
  const backend = withoutComments(extractServiceBlock(read(COMPOSE), 'backend'));
  // Object storage is used lazily (assetStore.getClient), so the game must boot without it.
  assert.doesNotMatch(backend, /depends_on:[\s\S]*rustfs/);
  assert.doesNotMatch(withoutComments(read(CADDYFILE)), /rustfs|minio|:9001/i);
});

test('a compose command works on a board whose .env has no MINIO_ROOT_PASSWORD yet', (t) => {
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  if (spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status !== 0) { t.skip('docker compose is not installed'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-compose-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, `POSTGRES_PASSWORD=p\nJWT_SECRET=j\nORANGEPI_DATA_DIR=${dir}\n`);
  const r = spawnSync('docker', ['compose', '--project-directory', path.join(ORANGEPI, '..', '..'), '--env-file', envFile,
    '-f', COMPOSE, 'config', '--quiet'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
});

test('every service caps its container logs through one shared anchor (SOMET-722)', () => {
  const text = read(COMPOSE);
  assert.match(text, /^x-logging: &default-logging\n  driver: json-file\n  options:\n    max-size: 10m\n    max-file: "3"\n/m);
  const section = text.slice(text.indexOf('\nservices:'), text.indexOf('\nvolumes:'));
  const services = [...section.matchAll(/^  ([a-z][a-z0-9-]*):$/gm)].map((m) => m[1]);
  assert.ok(services.length >= 7, `found ${services.join(',')}`);
  for (const name of services) {
    assert.match(withoutComments(extractServiceBlock(text, name)), /^    logging: \*default-logging$/m, `${name} has no log limit`);
  }
});
