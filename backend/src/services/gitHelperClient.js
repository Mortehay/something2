// SOMET-642. Client for the host-side git helper (tools/git-helper). The
// backend container has no git and never holds the push key; it asks the
// helper over a unix socket (default) or TCP (GIT_HELPER_URL, for Docker
// Desktop) with a shared-secret token the helper regenerates at every start,
// so the token is read on every call.
const { createHelperClient } = require('./helperClient.js');
const { pcLabel } = require('./seedSync/runs.js');

const HINT = 'Run make git-helper on this PC';

const { call, HelperUnavailable } = createHelperClient({
  socketEnv: 'GIT_HELPER_SOCKET',
  urlEnv: 'GIT_HELPER_URL',
  tokenEnv: 'GIT_HELPER_TOKEN_FILE',
  defaultSocket: '/app/run/git-helper.sock',
  defaultTokenFile: '/app/run/git-helper.token',
  tokenHeader: 'X-Git-Helper-Token',
  label: 'git helper',
  timeoutMs: 130000, // the helper's overall op deadline is 120 s
});

// "seed export: <groups> from <pc>", groups from the changed
// backend/seeds/sync/<group>.json paths.
function suggestCommitMessage(seedsDirty) {
  const groups = [];
  for (const p of Array.isArray(seedsDirty) ? seedsDirty : []) {
    const m = /^backend\/seeds\/sync\/([^/]+)\.json$/.exec(String(p));
    if (m && !groups.includes(m[1])) groups.push(m[1]);
  }
  return `seed export: ${groups.length ? groups.join(', ') : 'seeds'} from ${pcLabel()}`;
}

module.exports = { call, HelperUnavailable, suggestCommitMessage, HINT };
