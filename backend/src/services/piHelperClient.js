// SOMET-718. Client for the host-side pi helper (tools/pi-helper).
const { createHelperClient } = require('./helperClient.js');

const HINT = 'Run make pi-helper on this PC';

const client = createHelperClient({
  socketEnv: 'PI_HELPER_SOCKET',
  urlEnv: 'PI_HELPER_URL',
  tokenEnv: 'PI_HELPER_TOKEN_FILE',
  defaultSocket: '/app/run/pi-helper.sock',
  defaultTokenFile: '/app/run/pi-helper.token',
  tokenHeader: 'X-Pi-Helper-Token',
  label: 'pi helper',
  timeoutMs: 150000, // the seed preview is slow
  acceptNull: true, // GET /job answers null when there is no job
});

module.exports = { ...client, HINT };
