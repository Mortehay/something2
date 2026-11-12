// The public address of a running dev tunnel, for emailed links (owner: "use the domain from
// Cloudflare if it is on"). Kept up to date by the tunnel recorder (services/tunnelRecorder.js),
// which reads the trusted host helper every tick; it is never taken from a request.
// Cloudflare wins when both are on; ngrok is used when it is the only one on.
let current = null;

function pickPublicTunnel(status) {
  for (const p of ['cloudflare', 'ngrok']) {
    const st = status && status[p];
    if (!st || st.state !== 'on' || typeof st.url !== 'string') continue;
    try {
      const u = new URL(st.url);
      if (u.protocol === 'https:') return u.origin;
    } catch { /* not a usable address */ }
  }
  return null;
}

function setPublicTunnels(status) { current = pickPublicTunnel(status); }
function publicTunnelOrigin() { return current; }

module.exports = { pickPublicTunnel, setPublicTunnels, publicTunnelOrigin };
