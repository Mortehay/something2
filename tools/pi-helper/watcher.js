'use strict';
// SOMET-738. The timer that repairs the published page and the CI hook runs its own pinned copy of the
// scripts, on purpose: a timer that pulled and ran new code by itself would be a bigger promise. That copy
// once sat 2.5 months behind, could not read an ngrok address, and did nothing without a word. So the tab
// compares the scripts that decide what it does with the ones this helper runs. A commit count would warn
// about every unrelated change.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPTS_DIR = path.join('compose', 'orangepi', 'scripts');
const WATCHED_SCRIPTS = ['reconcile-url.sh', 'lib.sh', 'publish-url.sh', 'hook-register.sh'];
const UNIT_NAME = 'something2-pi-reconcile.service';

function defaultUnitFile() {
  const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(config, 'systemd', 'user', UNIT_NAME);
}

function hashOf(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

function readWatcher({ root, unitFile = defaultUnitFile() } = {}) {
  let unit;
  try { unit = fs.readFileSync(unitFile, 'utf8'); } catch { return { installed: false, stale: false, files: [] }; }
  const dir = (/^WorkingDirectory=(.+)$/m.exec(unit) || [])[1];
  if (!dir) return { installed: true, stale: true, files: [] };
  const files = WATCHED_SCRIPTS.filter((name) => {
    const theirs = hashOf(path.join(dir, SCRIPTS_DIR, name));
    return theirs === null || theirs !== hashOf(path.join(root, SCRIPTS_DIR, name));
  });
  return { installed: true, stale: files.length > 0, files };
}

module.exports = { readWatcher, WATCHED_SCRIPTS };
