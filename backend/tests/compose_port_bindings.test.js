const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// F-039 (SOMET-219): compose/develop/docker-compose.yml published db/redis with bare
// "HOST:CONTAINER" port mappings. Docker Compose binds a bare mapping to
// 0.0.0.0, so Postgres (15432) and Redis (16379) were reachable from any
// device on the LAN, not just the host — confirmed live via `ss -tlnp` and a
// successful `psql` connection from outside the container using the literal
// credentials tracked in this same file. Local dev only, but the fix is a
// one-line bind-IP change with no downside: loopback still reaches these
// ports (localhost:15432 etc., which backend/package.json's migrate script
// and this test suite's own DB connection both use), so there is no reason
// to leave them on 0.0.0.0.
//
// This test reads the compose YAML as text rather than parsing it (no YAML
// parser is a project dependency) and asserts the db/redis port mappings are
// bound to 127.0.0.1 explicitly, not left bare.

const COMPOSE_PATH = path.join(__dirname, '..', '..', 'compose', 'develop', 'docker-compose.yml');

function serviceBlock(text, serviceName) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^  ${serviceName}:\\s*$`).test(l));
  assert.ok(start !== -1, `service '${serviceName}' not found in ${COMPOSE_PATH}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    // Next top-level service (or the trailing `volumes:` block) starts a new
    // 2-space-indented, non-blank line.
    if (/^  \S/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

function portMappings(block) {
  const out = [];
  const portsIdx = block.split('\n').findIndex((l) => /^\s*ports:\s*$/.test(l));
  if (portsIdx === -1) return out;
  const lines = block.split('\n');
  for (let i = portsIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s*-\s*"([^"]+)"/);
    if (!m) break; // end of the ports list
    out.push(m[1]);
  }
  return out;
}

test('db, redis, and minio publish ports bound to 127.0.0.1, not the LAN-wide 0.0.0.0 default', () => {
  const text = fs.readFileSync(COMPOSE_PATH, 'utf8');

  for (const service of ['db', 'redis', 'minio']) {
    const block = serviceBlock(text, service);
    const mappings = portMappings(block);
    assert.ok(mappings.length > 0, `service '${service}' has no port mappings to check`);
    for (const mapping of mappings) {
      assert.ok(
        mapping.startsWith('127.0.0.1:'),
        `service '${service}' publishes "${mapping}" without a 127.0.0.1 bind IP — ` +
          `Docker Compose defaults bare "HOST:CONTAINER" mappings to 0.0.0.0, ` +
          `exposing it to the whole LAN (F-039 / SOMET-219)`
      );
    }
  }
});
