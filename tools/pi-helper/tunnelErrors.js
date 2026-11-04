'use strict';
// Owner-facing sentences for the `error=<code>` lines tunnel.sh prints.
const KNOWN = {
  ERR_NGROK_334: 'ngrok is already running somewhere else on this account. It allows one agent on this domain, so stop `make tunnel` on the laptop and press Start again.',
  ERR_NGROK_313: "ngrok's free plan cannot choose a domain, so the configured domain was refused. Remove the domain setting or upgrade the ngrok plan.",
  no_token: 'NGROK_AUTHTOKEN is not set in .env on this machine.',
  not_answering: 'The tunnel started, but the game did not answer through it, so no link is shown.',
  env_write_failed: "Could not update the board's .env, so nothing was changed.",
  no_url: 'The tunnel started, but did not report an address.',
};

function explainTunnelError(code) {
  const c = String(code || '').trim();
  if (Object.prototype.hasOwnProperty.call(KNOWN, c)) return KNOWN[c];
  return `The tunnel failed to start (${c || 'unknown'}).`;
}

module.exports = { explainTunnelError };
