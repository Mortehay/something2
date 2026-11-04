'use strict';
// Runs the board scripts and ssh on behalf of the helper. Everything it prints
// is redacted against the secrets in the repo-root .env.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const SCRIPTS = new Set(['deploy.sh', 'backup.sh', 'tunnel.sh', 'reconcile-url.sh', 'remote.sh']);
const SECRET_KEY = /PASSWORD|TOKEN|SECRET|KEY/;
const MIN_SECRET_LEN = 4;
const DEFAULT_TIMEOUT_MS = 120_000;

function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value) && value.length >= 2) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

function redact(text, secrets) {
  let out = String(text);
  for (const s of secrets || []) {
    if (s) out = out.split(s).join('***');
  }
  return out;
}

function createRunner({ root, env, spawn } = {}) {
  const repoRoot = root || path.resolve(__dirname, '../..');
  const baseEnv = env || process.env;
  const doSpawn = spawn || childProcess.spawn;
  const envFile = path.join(repoRoot, '.env');

  const dotenv = () => {
    try { return parseEnvFile(fs.readFileSync(envFile, 'utf8')); } catch { return {}; }
  };
  // Same precedence as lib.sh: the environment wins over the file.
  const merged = () => ({ ...dotenv(), ...baseEnv });

  function secrets() {
    const vals = Object.entries(dotenv())
      .filter(([k, v]) => SECRET_KEY.test(k) && v.length >= MIN_SECRET_LEN)
      .map(([, v]) => v);
    return [...new Set(vals)].sort((a, b) => b.length - a.length);
  }

  // Spawns detached (own process group) so a timeout can kill ssh grandchildren too.
  function run(cmd, args, { env: extra, timeoutMs = DEFAULT_TIMEOUT_MS, onLine } = {}) {
    return new Promise((resolve) => {
      const secs = secrets();
      let output = '';
      let pending = '';
      let timedOut = false;
      let settled = false;
      let child;
      const emit = (line) => { if (onLine) onLine(redact(line, secs)); };
      const feed = (chunk) => {
        const text = chunk.toString();
        output += text;
        pending += text;
        let i;
        while ((i = pending.indexOf('\n')) >= 0) {
          emit(pending.slice(0, i));
          pending = pending.slice(i + 1);
        }
      };
      const finish = (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (pending) emit(pending);
        resolve({ code, output: redact(output, secs), timedOut });
      };
      const killGroup = () => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      };
      const timer = setTimeout(() => { timedOut = true; killGroup(); finish(null); }, timeoutMs);
      try {
        child = doSpawn(cmd, args, {
          cwd: repoRoot,
          env: { ...process.env, ...baseEnv, REPO_ROOT: repoRoot, ...(extra || {}) },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
      } catch (e) {
        output = String(e.message);
        return finish(127);
      }
      child.stdout.on('data', feed);
      child.stderr.on('data', feed);
      child.on('error', (e) => { output += `${e.message}\n`; finish(127); });
      child.on('close', (code) => finish(code));
    });
  }

  function script(name, args = [], opts = {}) {
    if (!SCRIPTS.has(name)) return Promise.reject(new Error(`script not allowed: ${name}`));
    return run('bash', [path.join(repoRoot, 'compose', 'orangepi', 'scripts', name), ...args], opts);
  }

  function keyPath(e) {
    const k = e.ORANGEPI_SSH_KEY;
    if (!k) return null;
    if (k.startsWith('/')) return k;
    if (k.startsWith('~/')) return path.join(os.homedir(), k.slice(2));
    return path.join(repoRoot, k);
  }

  function ssh(command, { timeoutMs = 10_000 } = {}) {
    const e = merged();
    const opts = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new'];
    const key = keyPath(e);
    if (key && fs.existsSync(key)) opts.push('-i', key, '-o', 'IdentitiesOnly=yes');
    opts.push(`${e.ORANGEPI_LOGIN}@${e.ORANGEPI_ADDRESS}`, command);
    return run('ssh', opts, { timeoutMs });
  }

  function git(args, { timeoutMs = 10_000 } = {}) {
    return run('git', args, { timeoutMs });
  }

  const runner = { script, ssh, git, secrets, env: merged, root: repoRoot };
  return runner;
}

module.exports = { createRunner, redact, parseEnvFile, SCRIPTS };
