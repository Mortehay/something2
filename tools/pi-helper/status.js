'use strict';
// BoardStatus for GET /status. Never throws: an unreachable board is a result.
const FETCH_EVERY_MS = 5 * 60 * 1000;
const PROBE_MS = 7000;
const TUNNEL_MS = 7000;
const HEALTH_URL = 'http://127.0.0.1:8080/api/health';
const lastFetch = new WeakMap();

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const offTunnel = () => ({ state: 'off', url: null, verified: false, ageSeconds: null });

function parseKv(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function parseTunnel(res) {
  if (!res || res.code !== 0) return offTunnel();
  const kv = parseKv(res.output);
  const age = Number(kv.age);
  return {
    state: kv.state === 'on' ? 'on' : 'off',
    url: kv.url || null,
    verified: kv.verified === 'yes',
    ageSeconds: kv.age !== undefined && kv.age !== '' && Number.isFinite(age) ? age : null,
  };
}

async function behindMain(runner, commit) {
  if (!commit) return null;
  const r = await runner.git(['rev-list', '--count', `${commit}..origin/main`]);
  const n = Number(String(r.output).trim());
  return r.code === 0 && Number.isInteger(n) ? n : null;
}

async function readStatus(runner) {
  const env = runner.env();
  const checkedAt = new Date().toISOString();
  const base = { online: false, host: env.ORANGEPI_ADDRESS || null, commit: null, behindMain: null, healthCode: null, checkedAt };
  const now = Date.now();
  let fetching = Promise.resolve();
  if (now - (lastFetch.get(runner) || 0) >= FETCH_EVERY_MS) {
    lastFetch.set(runner, now);
    fetching = runner.git(['fetch', 'origin', 'main', 'orangepi'], { timeoutMs: 6000 }).catch(() => {});
  }
  const appDir = env.ORANGEPI_APP_DIR || '/app';
  const remote = `printf 'commit=%s\\n' "$(git -C ${shq(appDir)} rev-parse --short=8 HEAD 2>/dev/null)"; `
    + `printf 'health=%s\\n' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 ${shq(HEALTH_URL)} 2>/dev/null || echo 000)"`;
  const probe = await runner.ssh(remote, { timeoutMs: PROBE_MS });
  if (probe.code !== 0) { await fetching; return { ...base, tunnels: { cloudflare: offTunnel(), ngrok: offTunnel() } }; }
  const kv = parseKv(probe.output);
  const commit = /^[0-9a-f]{4,40}$/.test(kv.commit || '') ? kv.commit : null;
  const health = Number(kv.health);
  const [cf, ng] = await Promise.all([
    runner.script('tunnel.sh', ['status', 'cloudflare'], { timeoutMs: TUNNEL_MS }),
    runner.script('tunnel.sh', ['status', 'ngrok'], { timeoutMs: TUNNEL_MS }),
    fetching,
  ]);
  return {
    ...base,
    online: true,
    commit,
    behindMain: await behindMain(runner, commit),
    healthCode: Number.isFinite(health) && health > 0 ? health : null,
    tunnels: { cloudflare: parseTunnel(cf), ngrok: parseTunnel(ng) },
  };
}

module.exports = { readStatus, parseTunnel };
