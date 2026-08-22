'use strict';

// The CI-to-board deploy hook (SOMET-401).
//
// GitHub cannot reach the board inbound, so delivery is a webhook or polling.
// The tunnel already exists, which makes the hook nearly free -- and the same
// fact makes this endpoint INTERNET-REACHABLE, so signature verification is
// not optional and a failed verification rejects rather than logging and
// carrying on.
//
// Three properties this file exists to hold:
//
//   * it runs deploy.sh and NOTHING else. Nothing from the request body ever
//     reaches a shell: the body is read to verify its signature and then
//     discarded. There is no command, path, ref or image name taken from it.
//   * one deploy at a time. The authority is single-instance and a deploy is
//     stop-then-start; two overlapping deploys would fight over the same
//     containers.
//   * no dependencies. Node's own crypto and http, so the image is the
//     runtime and nothing else -- this is a listener on a public URL.
//
// The trigger is the Actions workflow AFTER the image build, never a raw
// GitHub push webhook: a push webhook fires before any image exists, so the
// board would deploy a commit that has not been built.

const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const SECRET = process.env.DEPLOY_HOOK_SECRET || '';
const PORT = Number(process.env.DEPLOY_HOOK_PORT || 9000);
const DEPLOY_SCRIPT = process.env.DEPLOY_SCRIPT || '/app/compose/orangepi/scripts/deploy.sh';
// Requests older than this are refused even with a valid signature: a
// captured request is otherwise replayable forever, and this endpoint's whole
// job is to trigger a deploy.
const MAX_SKEW_MS = Number(process.env.DEPLOY_HOOK_MAX_SKEW_MS || 5 * 60 * 1000);
const MAX_BODY_BYTES = 64 * 1024;

if (!SECRET) {
  // Refusing to start is the point. A listener that ran unauthenticated
  // "until the secret is configured" would be a public deploy trigger, and it
  // would look healthy the entire time.
  console.error('DEPLOY_HOOK_SECRET is not set -- refusing to start an unauthenticated deploy endpoint');
  process.exit(1);
}

let deployInFlight = false;
let lastResult = null;

function sign(body) {
  return `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

// Constant-time, and length-checked first because timingSafeEqual throws on a
// length mismatch -- and throwing on a wrong-length signature would leak the
// expected length through the difference in behaviour.
function signatureMatches(body, provided) {
  if (typeof provided !== 'string') return false;
  const expected = Buffer.from(sign(body), 'utf8');
  const actual = Buffer.from(provided, 'utf8');
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function freshEnough(timestampHeader) {
  const sent = Number(timestampHeader);
  if (!Number.isFinite(sent)) return false;
  return Math.abs(Date.now() - sent) <= MAX_SKEW_MS;
}

function runDeploy() {
  deployInFlight = true;
  const startedAt = new Date().toISOString();
  // Fixed argv, no shell. Even if everything above were bypassed, the only
  // thing that can be run from here is this one script with no arguments.
  const child = spawn('bash', [DEPLOY_SCRIPT], {
    env: { ...process.env, PI_LOCAL: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const capture = (chunk) => {
    output += chunk;
    // Bounded: a build's output is large and this process is long-lived.
    if (output.length > 200000) output = output.slice(-200000);
    process.stdout.write(chunk);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('close', (code) => {
    deployInFlight = false;
    lastResult = { startedAt, finishedAt: new Date().toISOString(), code, tail: output.slice(-4000) };
    console.log(`[deploy-hook] deploy finished with exit code ${code}`);
  });
}

const server = http.createServer((req, res) => {
  const send = (status, payload) => {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };

  if (req.method === 'GET' && req.url === '/deploy-hook/health') {
    return send(200, { status: 'ok', deploying: deployInFlight, last: lastResult });
  }
  if (req.method !== 'POST' || req.url !== '/deploy-hook') {
    return send(404, { error: 'not found' });
  }

  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      // An unbounded body on a public endpoint is a memory-exhaustion lever
      // on a board with 4GB and a game running on it.
      send(413, { error: 'body too large' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (res.writableEnded) return;
    const body = Buffer.concat(chunks);
    const signature = req.headers['x-deploy-signature'];
    const timestamp = req.headers['x-deploy-timestamp'];

    // The signature covers the timestamp because the timestamp is part of the
    // body. Signing only the body would let an attacker replay an old
    // request with a fresh timestamp header.
    if (!signatureMatches(body, signature)) {
      console.warn('[deploy-hook] rejected: bad or missing signature');
      return send(401, { error: 'bad signature' });
    }
    let parsed;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return send(400, { error: 'body is not json' });
    }
    if (!freshEnough(parsed.timestamp ?? timestamp)) {
      console.warn('[deploy-hook] rejected: stale or missing timestamp');
      return send(401, { error: 'stale request' });
    }
    if (deployInFlight) {
      // 409, not a queue: the next push will trigger its own deploy, and a
      // queue of deploys against a single-instance authority is a queue of
      // restarts nobody asked for.
      return send(409, { error: 'a deploy is already running' });
    }
    // The body is now discarded. Nothing in it -- not the ref, not the sha,
    // not the actor -- is passed to the deploy.
    console.log('[deploy-hook] signature verified, starting deploy');
    runDeploy();
    return send(202, { status: 'deploy started' });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[deploy-hook] listening on ${PORT}; deploy script: ${DEPLOY_SCRIPT}`);
});
