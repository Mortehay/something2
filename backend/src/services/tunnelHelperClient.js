// Tunnels tab: client for the host-side tunnel helper (tools/tunnel-helper). The backend
// container has no docker access; it asks the helper over a unix socket (default) or TCP
// (TUNNEL_HELPER_URL, for Docker Desktop) with a shared-secret token the helper regenerates at
// every start, so the token is read on every call.
const { createHelperClient } = require('./helperClient.js');

const HINT = 'Run make tunnel-helper on this PC';

const { call, HelperUnavailable } = createHelperClient({
  socketEnv: 'TUNNEL_HELPER_SOCKET',
  urlEnv: 'TUNNEL_HELPER_URL',
  tokenEnv: 'TUNNEL_HELPER_TOKEN_FILE',
  defaultSocket: '/app/run/tunnel-helper.sock',
  defaultTokenFile: '/app/run/tunnel-helper.token',
  tokenHeader: 'X-Tunnel-Helper-Token',
  label: 'tunnel helper',
  timeoutMs: 60000,
});

// A non-200 answer to a read (503 docker_unavailable, 400, 500) means the recorder cannot
// trust what it would read: treat it like an unreachable helper.
async function read(route) {
  const r = await call('GET', route);
  if (r.status !== 200) {
    const why = r.body && (r.body.error || r.body.code);
    throw new HelperUnavailable(`tunnel helper answered ${r.status}${why ? `: ${String(why).slice(0, 120)}` : ''}`);
  }
  return r.body;
}

// The shape tunnelRecorder.syncOnce expects of `helper`.
const helper = {
  status: () => read('/status'),
  events: (since) => read(`/events?since=${Math.max(0, Math.floor(Number(since) || 0))}`),
};

module.exports = { call, HelperUnavailable, HINT, helper };
