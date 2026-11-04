'use strict';
// Scratch-root fixtures: a fake repo root with .env, stub scripts and stub ssh/git on PATH.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function scratch(t, { envText = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-helper-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'compose/orangepi/scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, '.env'), envText);
  const bin = path.join(root, 'bin');
  const env = { PATH: `${bin}:${process.env.PATH}`, ORANGEPI_LOGIN: 'tester', ORANGEPI_ADDRESS: '203.0.113.9', ORANGEPI_APP_DIR: '/app' };
  return {
    root, env, bin,
    script: (name, body) => fs.writeFileSync(path.join(root, 'compose/orangepi/scripts', name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 }),
    stub: (name, body) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 }),
  };
}
module.exports = { scratch };
