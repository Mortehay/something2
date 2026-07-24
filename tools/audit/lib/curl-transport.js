'use strict';

const { execFile } = require('node:child_process');

// Cloudflare fingerprints the HTTP client (TLS/HTTP2 handshake characteristics),
// not the User-Agent header and not request rate. A decisive experiment proved
// this: an identical POST issued by real `curl` succeeded (201) at the same
// instant an identical POST from Node's `fetch` was blocked (403 HTML block
// page) — same machine, same key, same body. Node cannot spoof curl's TLS
// fingerprint from userland, so writes are shelled out to a real curl binary.
// Reads happen to pass through Node's fetch too, which is what makes the
// failure look intermittent rather than structural — see plane.js.
//
// SECURITY: the API key travels as a `header = "X-API-Key: ..."` line inside
// a curl config file written to curl's stdin (`--config -`), never as a
// command-line argument. Anything in argv is visible to any local user via
// `ps`; stdin is not. Do not change this to pass the key via `-H` or `-d`.

const STATUS_MARKER = '\n__PLANE_AUDIT_CURL_STATUS__:';

// `--silent` suppresses curl's own progress/error chatter, which is exactly
// what makes a hung connection dangerous here: with no timeout, a stalled
// TCP handshake or a server that accepts the connection but never responds
// blocks the whole sync indefinitely with zero output on stdout or stderr —
// indistinguishable from the process simply being slow. These bound both
// failure modes (can't connect vs. connected but silent) and are
// deliberately generous, since a real 403/429 retry-with-backoff cycle (see
// plane.js) already accounts for Cloudflare being slow, not just wrong.
// Overridable per-transport (e.g. a test that wants to assert on the exact
// value) via createCurlTransport's options.
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;
const DEFAULT_MAX_TIME_SECONDS = 30;

function escapeConfigValue(value) {
  // curl's config-file quoting: inside a double-quoted value, `\` and `"`
  // must be backslash-escaped, and a *literal* control character (a real
  // newline/tab byte, as opposed to the two-character sequence `\n`) is not
  // valid inside a quoted value at all — it must be written as curl's own
  // `\n`/`\r`/`\t` escape. JSON.stringify() never emits raw control
  // characters (they come out as the two-character `\n` etc. already), so in
  // practice only our own STATUS_MARKER hits the last three replacements —
  // but headers/URLs get the same defensive treatment.
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function buildConfig({ url, method, headers, body }) {
  const lines = [
    // Disable URL globbing so literal `{}[]` in a URL (e.g. an issue id)
    // is never misinterpreted as a curl range/list expression.
    'globoff',
    `url = "${escapeConfigValue(url)}"`,
    `request = "${escapeConfigValue(method)}"`,
  ];
  for (const [name, value] of Object.entries(headers || {})) {
    lines.push(`header = "${escapeConfigValue(`${name}: ${value}`)}"`);
  }
  if (body !== undefined) {
    // data-raw: sent byte-for-byte, no @-file interpretation.
    lines.push(`data-raw = "${escapeConfigValue(body)}"`);
  }
  // Appended to stdout after the response body so a single process
  // invocation yields both the body and the status code, without needing a
  // temp file. Curl does not follow redirects (-L is never passed), so a 3xx
  // response body/status is what we act on — not whatever a redirect target
  // returns.
  lines.push(`write-out = "${escapeConfigValue(STATUS_MARKER)}%{http_code}"`);
  return `${lines.join('\n')}\n`;
}

// Default process runner: spawns the real `curl` binary. Tests inject a fake
// runner instead so the suite never spawns a process.
function defaultRunner({ command, args, input }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(
        command,
        args,
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== 'number') {
            // Spawn-level failure (e.g. ENOENT — curl is not installed),
            // distinct from curl running and exiting non-zero.
            resolve({ spawnError: error, code: null, stdout: '', stderr: stderr || '' });
            return;
          }
          resolve({ spawnError: null, code: error ? error.code : 0, stdout, stderr });
        }
      );
    } catch (error) {
      resolve({ spawnError: error, code: null, stdout: '', stderr: '' });
      return;
    }
    if (!child || !child.stdin) {
      resolve({ spawnError: new Error('curl transport: child process has no stdin'), code: null, stdout: '', stderr: '' });
      return;
    }
    // If curl already died (e.g. ENOENT), writing to a dead stdin would throw
    // an unhandled EPIPE — swallow it, the execFile callback above already
    // reports the real failure.
    child.stdin.on('error', () => {});
    child.stdin.write(input);
    child.stdin.end();
  });
}

// Returns a fetch-like function: (url, { method, headers, body }) =>
// Promise<{ ok, status, text() }>. Matches the subset of the `fetch` surface
// that PlaneClient#request already relies on, so it drops straight into the
// `fetchImpl` constructor option.
function createCurlTransport({
  runner = defaultRunner,
  curlPath = 'curl',
  connectTimeoutSeconds = DEFAULT_CONNECT_TIMEOUT_SECONDS,
  maxTimeSeconds = DEFAULT_MAX_TIME_SECONDS,
} = {}) {
  return async function curlFetch(url, { method = 'GET', headers = {}, body } = {}) {
    const input = buildConfig({ url, method, headers, body });
    const args = [
      '--silent',
      '--show-error',
      '--connect-timeout',
      String(connectTimeoutSeconds),
      '--max-time',
      String(maxTimeSeconds),
      '--config',
      '-',
    ];

    const result = await runner({ command: curlPath, args, input });

    if (result.spawnError) {
      const err = new Error(
        `curl transport failed to launch ("${curlPath}"): ${result.spawnError.message}`
      );
      err.curlSpawnError = true;
      err.cause = result.spawnError;
      throw err;
    }

    if (result.code !== 0) {
      const stderr = String(result.stderr || '').trim();
      const err = new Error(
        `curl exited with status ${result.code} for ${method} ${url}` +
          (stderr ? `: ${stderr}` : ' (no stderr output)')
      );
      err.curlExitCode = result.code;
      throw err;
    }

    const stdout = result.stdout || '';
    const markerIndex = stdout.lastIndexOf(STATUS_MARKER);
    if (markerIndex === -1) {
      throw new Error(
        `curl transport: response for ${method} ${url} was missing the expected status marker ` +
          '(curl ran but --write-out output was not found in stdout)'
      );
    }

    const text = stdout.slice(0, markerIndex);
    const status = Number(stdout.slice(markerIndex + STATUS_MARKER.length).trim());

    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
    };
  };
}

module.exports = {
  createCurlTransport,
  buildConfig,
  escapeConfigValue,
  STATUS_MARKER,
  DEFAULT_CONNECT_TIMEOUT_SECONDS,
  DEFAULT_MAX_TIME_SECONDS,
};
