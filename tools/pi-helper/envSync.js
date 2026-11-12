'use strict';
// .env sync (email accounts, Task 15): which keys of this PC's .env the board's .env has, and copying chosen ones over.
// This is how the mail settings (SMTP_*) reach the board.
//
// Values never leave the two machines' files except on the one path that has to carry them: a value being copied
// goes to `env-sync.sh write KEY` on the runner's stdin (never argv), and from there over ssh's stdin into the
// board-side writer. Comparison is by sha256: the board hashes its own values (env-sync.sh hashes) and only
// `KEY <hex>` lines come back. Neither a value nor a hash is ever put in a response, an error or a log line: the
// results carry key names and statuses only, and an error carries a key name, an exit code and a scrubbed tail.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { BadRequest } = require('../helper-core/helperServer');
const { BoardOffline } = require('./boardJobs');
const { BusyError } = require('./jobs');
const { parseEnvFile, redact } = require('./boardRunner');

// Board-specific: these say where the board's own database, cache and public address are, or how it runs. A copy
// from the PC would point the board at the PC's services or replace its secrets, so they are never written.
// The deploy hook's secret and git settings are the board's own too: a PC git credential never goes to the board.
const LOCKED_KEYS = ['DATABASE_URL', 'TEST_DATABASE_URL', 'REDIS_URL', 'CORS_ORIGINS', 'PUBLIC_URL', 'APP_URL', 'JWT_SECRET', 'TRUST_PROXY', 'REGISTRATION_MODE', 'MIGRATE_ON_BOOT', 'BOARD_TAB_ENABLED',
  'DEPLOY_HOOK_SECRET', 'ALLOW_LOCALHOST_API_URL', 'GIT_REPOSITORY'];
const LOCKED_PREFIXES = ['POSTGRES_', 'MINIO_', 'ORANGEPI_', 'BOARD_', 'PI_', 'GIT_', 'COMPOSE_'];
// The same pattern env-sync.sh enforces before it writes anything.
const KEY_RE = /^[A-Z][A-Z0-9_]*$/;
const HASH_LINE = /^([A-Za-z_][A-Za-z0-9_]*) ([0-9a-f]{64})$/;
const HEX64 = /[0-9a-f]{64}/gi;
const MAX_KEYS = 200;
const HASHES_MS = 30_000;
const WRITE_MS = 30_000;
// Local values at least this long are scrubbed from an error tail, beside the value being written.
const SCRUB_MIN = 6;

class EnvSyncFailed extends Error {}

// A key the writer refuses (not KEY-shaped) cannot be copied either, so it shows as locked.
const isLocked = (key) => !KEY_RE.test(key) || LOCKED_KEYS.includes(key) || LOCKED_PREFIXES.some((p) => key.startsWith(p));

const unreachable = (r) => r.timedOut || r.code === 255 || r.code === 78 || r.code === 127;
const sha256 = (v) => crypto.createHash('sha256').update(v, 'utf8').digest('hex');

// The repo-root .env, parsed by the same reader the runner and lib.sh use (trim, `export `, one quote layer).
function readLocalEnv(rootDir) {
  let text;
  try { text = fs.readFileSync(path.join(rootDir, '.env'), 'utf8'); } catch { return new Map(); }
  return new Map(Object.entries(parseEnvFile(text)));
}

// The last few stderr lines with every value we know and anything hash-shaped removed. env-sync.sh never prints a
// value; this is for a board that misbehaves.
function scrub(text, values, runner) {
  const secrets = [...values.filter((v) => v && v.length >= SCRUB_MIN), ...(runner.secrets ? runner.secrets() : [])]
    .sort((a, b) => b.length - a.length);
  return redact(String(text || ''), secrets).replace(HEX64, '***')
    .trim().split('\n').filter(Boolean).slice(-3).join(' | ');
}

async function envStatus(runner, rootDir) {
  const local = readLocalEnv(rootDir);
  const r = await runner.script('env-sync.sh', ['hashes'], { timeoutMs: HASHES_MS });
  if (unreachable(r)) throw new BoardOffline("The board could not be reached to read its .env.");
  if (r.code !== 0) {
    const why = scrub(r.stderr, [...local.values()], runner);
    throw new EnvSyncFailed(`Reading the board's .env failed (exit ${r.code})${why ? `: ${why}` : ''}`);
  }
  const board = new Map();
  for (const line of String(r.stdout).split('\n')) {
    const m = HASH_LINE.exec(line.trim());
    if (m) board.set(m[1], m[2]);
  }
  const keys = [...new Set([...local.keys(), ...board.keys()])].sort();
  return {
    keys: keys.map((key) => {
      let status;
      if (!local.has(key)) status = 'board_only';
      else if (!board.has(key)) status = 'not_passed';
      else status = board.get(key) === sha256(local.get(key)) ? 'passed' : 'different';
      return { key, status, locked: isLocked(key) };
    }),
  };
}

function validateKeys(keys) {
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_KEYS) throw new BadRequest(`keys must be a list of 1 to ${MAX_KEYS} .env key names.`);
  if (!keys.every((k) => typeof k === 'string' && KEY_RE.test(k))) throw new BadRequest('Each key must be an .env key name: capital letters, digits and _ , starting with a letter.');
  return [...new Set(keys)];
}

// One copy at a time in this process (two would race on the board's .env rename). Taken before the first await, so
// the server's "no copy while a job runs" check and jobs.start's "no job while a copy runs" (busyWith) cannot interleave.
let inFlight = false;
const copyInFlight = () => inFlight;

async function copyEnvKeys(runner, rootDir, keys) {
  const wanted = validateKeys(keys);
  if (inFlight) throw new BusyError('.env copy');
  inFlight = true;
  try {
    return await copyLocked(runner, rootDir, wanted);
  } finally {
    inFlight = false;
  }
}

async function copyLocked(runner, rootDir, wanted) {
  const local = readLocalEnv(rootDir);
  const written = [];
  const skipped = [];
  const before = () => (written.length ? ` Written before that: ${written.join(', ')}.` : '');
  for (const key of wanted) {
    if (isLocked(key)) { skipped.push({ key, reason: 'locked' }); continue; }
    if (!local.has(key)) { skipped.push({ key, reason: 'not_local' }); continue; }
    const value = local.get(key);
    if (value === '') { skipped.push({ key, reason: 'empty' }); continue; }
    // stdin only. The script reads exactly one line.
    const r = await runner.script('env-sync.sh', ['write', key], { input: `${value}\n`, timeoutMs: WRITE_MS });
    if (unreachable(r)) throw new BoardOffline(`The board could not be reached to write ${key}.${before()}`);
    if (r.code !== 0) {
      const why = scrub(r.stderr, [value, ...local.values()], runner);
      throw new EnvSyncFailed(`Writing ${key} into the board's .env failed (exit ${r.code})${why ? `: ${why}` : ''}.${before()}`);
    }
    written.push(key);
  }
  return { written, skipped };
}

module.exports = { LOCKED_KEYS, LOCKED_PREFIXES, KEY_RE, isLocked, readLocalEnv, envStatus, copyEnvKeys, copyInFlight, EnvSyncFailed };
