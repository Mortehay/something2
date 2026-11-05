'use strict';
// BoardStatus for GET /status. Never throws: an unreachable board is a result.
const FETCH_EVERY_MS = 5 * 60 * 1000;
const PROBE_MS = 7000;
// Above the 10 s curl --max-time inside tunnel.sh status, so a slow live tunnel is answered, not killed.
const TUNNEL_MS = 20000;
const HEALTH_URL = 'http://127.0.0.1:8080/api/health';
const { resolveBranches } = require('./branches');
const lastFetch = new WeakMap();

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const offTunnel = () => ({ state: 'off', url: null, verified: false, ageSeconds: null });
// tunnel.sh status failed or was killed: nothing is known, and it must not read as Stopped.
const unknownTunnel = () => ({ state: 'unknown', url: null, verified: false, ageSeconds: null });

function parseKv(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function parseTunnel(res) {
  if (!res || res.code !== 0 || res.timedOut) return unknownTunnel();
  const kv = parseKv(res.stdout);
  const age = Number(kv.age);
  // A link is shown only after /api/health answered through it.
  const verified = kv.verified === 'yes' && !!kv.url;
  const tunnel = {
    state: kv.state === 'on' ? 'on' : 'off',
    url: verified ? kv.url : null,
    verified,
    ageSeconds: kv.age !== undefined && kv.age !== '' && Number.isFinite(age) ? age : null,
  };
  // ngrok's counters, for tunnelUsage.js. Blank means not read, which is not zero.
  const reading = (v) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  if (kv.out_bytes !== undefined || kv.requests !== undefined) {
    tunnel.counters = { outBytes: reading(kv.out_bytes), requests: reading(kv.requests) };
  }
  return tunnel;
}

async function behindSource(runner, commit, source) {
  if (!commit || !source) return null;
  const r = await runner.git(['rev-list', '--count', `${commit}..origin/${source}`]);
  const n = Number(String(r.output).trim());
  return r.code === 0 && Number.isInteger(n) ? n : null;
}

async function readStatus(runner, { tunnelMs = TUNNEL_MS } = {}) {
  const env = runner.env();
  const checkedAt = new Date().toISOString();
  // Invalid or equal branch names: no names, no git calls (the Update job refuses with the sentence).
  const b = resolveBranches(env);
  const sourceBranch = b.error ? null : b.source;
  const buildBranch = b.error ? null : b.build;
  const base = { online: false, host: env.ORANGEPI_ADDRESS || null, sourceBranch, buildBranch, commit: null, behindMain: null, healthCode: null, checkedAt };
  const now = Date.now();
  let fetching = Promise.resolve();
  if (!b.error && now - (lastFetch.get(runner) || 0) >= FETCH_EVERY_MS) {
    lastFetch.set(runner, now);
    fetching = runner.git(['fetch', 'origin', sourceBranch, buildBranch], { timeoutMs: 6000 }).catch(() => {});
  }
  const appDir = env.ORANGEPI_APP_DIR || '/app';
  const remote = `printf 'commit=%s\\n' "$(git -C ${shq(appDir)} rev-parse --short=8 HEAD 2>/dev/null)"; `
    + `printf 'health=%s\\n' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 ${shq(HEALTH_URL)} 2>/dev/null || echo 000)"`;
  const probe = await runner.ssh(remote, { timeoutMs: PROBE_MS, reuse: true });
  if (probe.code !== 0) { await fetching; return { ...base, tunnels: { cloudflare: offTunnel(), ngrok: offTunnel() } }; }
  const kv = parseKv(probe.stdout);
  const commit = /^[0-9a-f]{4,40}$/.test(kv.commit || '') ? kv.commit : null;
  const health = Number(kv.health);
  const [cf, ng] = await Promise.all([
    runner.script('tunnel.sh', ['status', 'cloudflare'], { timeoutMs: tunnelMs }),
    runner.script('tunnel.sh', ['status', 'ngrok'], { timeoutMs: tunnelMs }),
    fetching,
  ]);
  return {
    ...base,
    online: true,
    commit,
    behindMain: await behindSource(runner, commit, sourceBranch),
    healthCode: Number.isFinite(health) && health > 0 ? health : null,
    tunnels: { cloudflare: parseTunnel(cf), ngrok: parseTunnel(ng) },
  };
}

module.exports = { readStatus, parseTunnel };
