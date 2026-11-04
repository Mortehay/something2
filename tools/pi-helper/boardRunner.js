'use strict';
// Runs the board scripts and ssh on behalf of the helper. Everything it prints
// is redacted against the secrets in the repo-root .env.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const SCRIPTS = new Set(['deploy.sh', 'backup.sh', 'tunnel.sh', 'reconcile-url.sh', 'remote.sh']);
const SECRET_KEY = /PASSWORD|TOKEN|SECRET|KEY/;
// A path and a well-known default are not secrets, and redacting them mangles output.
const NOT_SECRET = new Set(['ORANGEPI_SSH_KEY', 'MINIO_ACCESS_KEY']);
const MIN_SECRET_LEN = 8;
// A timed out or aborted process group gets TERM first so deploy.sh's EXIT trap can release its lock.
const KILL_GRACE_MS = 5000;
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

function signalGroup(child, sig) {
  try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } }
}

const groupAlive = (child) => { try { process.kill(-child.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// TERM the group now; SIGKILL it after graceMs if anything in it is still alive. Resolves once the
// group has really gone (after the KILL at the latest, bounded to ~graceMs + 1 s).
async function stopGroup(child, graceMs) {
  signalGroup(child, 'SIGTERM');
  const until = Date.now() + graceMs;
  while (groupAlive(child) && Date.now() < until) await sleepMs(25);
  if (groupAlive(child)) {
    signalGroup(child, 'SIGKILL');
    const killUntil = Date.now() + 1000;
    while (groupAlive(child) && Date.now() < killUntil) await sleepMs(25);
  }
}

function createRunner({ root, env, spawn, controlDir: controlDirOpt, killGraceMs = KILL_GRACE_MS } = {}) {
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
      .filter(([k, v]) => SECRET_KEY.test(k) && !NOT_SECRET.has(k) && v.length >= MIN_SECRET_LEN)
      .map(([, v]) => v);
    return [...new Set(vals)].sort((a, b) => b.length - a.length);
  }

  const children = new Set();
  // A child leaves `children` only when its group is gone or was SIGKILLed, so busyCount() stays
  // above 0 through the grace period. One stop per child, shared by a timeout and abort().
  const stopping = new Map();
  function stop(child) {
    if (!stopping.has(child)) {
      stopping.set(child, stopGroup(child, killGraceMs).finally(() => { stopping.delete(child); children.delete(child); }));
    }
    return stopping.get(child);
  }

  // Spawns detached (own process group) so a timeout can kill ssh grandchildren too.
  function run(cmd, args, { env: extra, timeoutMs = DEFAULT_TIMEOUT_MS, onLine } = {}) {
    return new Promise((resolve) => {
      const secs = secrets();
      let output = '';
      let out = '';
      let err = '';
      let pending = '';
      let timedOut = false;
      let settled = false;
      let child;
      const emit = (line) => { if (onLine) onLine(redact(line, secs)); };
      const feed = (chunk, which) => {
        if (settled) return; // nothing is emitted after the run has resolved
        const text = chunk.toString();
        output += text;
        if (which === 'err') err += text; else out += text;
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
        if (child && !stopping.has(child)) children.delete(child);
        if (pending) { emit(pending); pending = ''; }
        resolve({ code, output: redact(output, secs), stdout: redact(out, secs), stderr: redact(err, secs), timedOut });
      };
      const timer = setTimeout(() => { timedOut = true; stop(child); finish(null); }, timeoutMs);
      try {
        child = doSpawn(cmd, args, {
          cwd: repoRoot,
          env: { ...process.env, ...baseEnv, REPO_ROOT: repoRoot, ...(extra || {}) },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
      } catch (e) {
        output = String(e.message);
        err = output;
        return finish(127);
      }
      children.add(child);
      child.stdout.on('data', (c) => feed(c, 'out'));
      child.stderr.on('data', (c) => feed(c, 'err'));
      child.on('error', (e) => { output += `${e.message}\n`; err += `${e.message}\n`; finish(127); });
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

  // The control socket lives in a short private directory, not the run dir: %C hashes to 40
  // chars, ssh adds a ~17 char temp suffix while binding, and a unix socket path tops out at 107.
  let control; // undefined = not resolved yet, null = reuse off, string = directory
  function controlDir() {
    if (control !== undefined) return control;
    control = null;
    const why = (m) => console.error(`pi-helper: ssh connection reuse is off: ${m}`);
    try {
      let dir = controlDirOpt;
      if (!dir) {
        const xdg = baseEnv.XDG_RUNTIME_DIR;
        let useXdg = false;
        if (xdg) { try { fs.accessSync(xdg, fs.constants.W_OK); useXdg = true; } catch { /* not writable */ } }
        dir = useXdg ? path.join(xdg, 's2-pi') : `/tmp/s2-pi-${process.getuid()}`;
      }
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) return why(`${dir} is not a plain directory`), control;
      if (st.uid !== process.getuid()) return why(`${dir} is owned by another user`), control;
      if (st.mode & 0o077) return why(`${dir} is group or other accessible (mode ${(st.mode & 0o777).toString(8)})`), control;
      if (Buffer.byteLength(path.join(dir, '%C')) - 2 + 40 + 17 > 107) return why(`${dir} is too long for a unix socket`), control;
      control = dir;
    } catch (e) { why(e.message); }
    return control;
  }
  const controlOpts = (dir) => ['-o', 'ControlMaster=auto', '-o', 'ControlPersist=60', '-o', `ControlPath=${path.join(dir, '%C')}`];

  // reuse: true shares one ssh connection (ControlMaster) so a 15 s sampler does not pay a handshake each time.
  // Keepalives stop a dead master hanging a call; a timed out or 255 call closes the master so the next one reconnects.
  async function ssh(command, { timeoutMs = 10_000, reuse = false } = {}) {
    const e = merged();
    if (!e.ORANGEPI_LOGIN || !e.ORANGEPI_ADDRESS) {
      const msg = 'ORANGEPI_LOGIN and ORANGEPI_ADDRESS must both be set (in .env or the environment) before the board can be reached.';
      return { code: 78, output: msg, stdout: '', stderr: msg, timedOut: false };
    }
    const opts = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new'];
    const key = keyPath(e);
    if (key && fs.existsSync(key)) opts.push('-i', key, '-o', 'IdentitiesOnly=yes');
    const dir = reuse ? controlDir() : null;
    if (dir) opts.push(...controlOpts(dir), '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2');
    opts.push(`${e.ORANGEPI_LOGIN}@${e.ORANGEPI_ADDRESS}`, command);
    const res = await run('ssh', opts, { timeoutMs });
    if (dir && (res.timedOut || res.code === 255)) await closeMaster();
    return res;
  }

  // Best effort, bounded to 3 s, one at a time: ask the shared master to exit. Never rejects.
  let closing = null;
  function closeMaster() {
    if (closing) return closing;
    const e = merged();
    const dir = controlDir();
    if (!dir || !e.ORANGEPI_LOGIN || !e.ORANGEPI_ADDRESS) return Promise.resolve();
    closing = run('ssh', [...controlOpts(dir), '-O', 'exit', `${e.ORANGEPI_LOGIN}@${e.ORANGEPI_ADDRESS}`], { timeoutMs: 3000 })
      .catch(() => {})
      .then(() => { closing = null; });
    return closing;
  }

  function git(args, { timeoutMs = 10_000 } = {}) {
    return run('git', args, { timeoutMs });
  }

  // Live children, for the helper's drain: busyCount() holds a stop open, abort() ends it.
  const busyCount = () => children.size;
  // Resolves when no child remains: at most ~killGraceMs + 1 s.
  function abort() {
    return Promise.all([...children].map((c) => stop(c))).then(() => {});
  }

  const runner = { script, ssh, closeMaster, git, secrets, env: merged, root: repoRoot, busyCount, abort };
  return runner;
}

module.exports = { createRunner, redact, parseEnvFile, SCRIPTS };
