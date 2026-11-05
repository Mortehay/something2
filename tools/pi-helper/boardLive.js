'use strict';
// The game's live data on the board (players, bosses, summon). The backend serves it from an internal
// listener bound to 127.0.0.1 inside its container, and this is the only way in.
//
// Reads run `docker exec ... wget` over the shared ssh connection, only when a request asks. The summon
// is the one thing that boots node, through `remote.sh backend`: its body travels as base64 JSON, so a
// boss or world name never reaches a shell as text.
//
// An older board image has no listener, which is a normal answer here ("no_listener"), never an error,
// and the tab says to press Update. Exit 3 means exactly that: BOARD_INTERNAL_PORT is not set in the
// container. Every other failure is something else and must not tell anyone to update.
const { BadRequest } = require('../helper-core/helperServer');

// The compose project is `something2-orangepi` (compose/orangepi/docker-compose.yml).
const BACKEND_CONTAINER = 'something2-orangepi-backend-1';
const NO_LISTENER_EXIT = 3;
const REFUSED_EXIT = 4; // nothing reached the listener
const UNKNOWN_EXIT = 5; // a timeout or a broken reply: the request may have landed
const READ_ROUTES = ['/players', '/bosses'];
const READ_TIMEOUT_MS = 12_000;

// Single quotes: the container's shell expands the port, not the board's.
function readCommand(route) {
  if (!READ_ROUTES.includes(route)) throw new Error('Unknown live route.');
  return `timeout 8 docker exec ${BACKEND_CONTAINER} sh -c '[ -n "$BOARD_INTERNAL_PORT" ] || exit ${NO_LISTENER_EXIT}; `
    + `exec wget -qO- -T6 "http://127.0.0.1:$BOARD_INTERNAL_PORT${route}"'`;
}

// argv: the abort time in ms, then the base64 JSON body.
const SUMMON_SCRIPT = "const[ms,b]=process.argv.slice(1);const port=process.env.BOARD_INTERNAL_PORT;"
  + `if(!port)process.exit(${NO_LISTENER_EXIT});`
  + "fetch('http://127.0.0.1:'+port+'/bosses/summon',{method:'POST',headers:{'content-type':'application/json'},"
  + "body:Buffer.from(b,'base64'),signal:AbortSignal.timeout(Number(ms))})"
  + ".then(async(r)=>{console.log(JSON.stringify({status:r.status,body:await r.json()}))})"
  + `.catch((e)=>process.exit(e&&e.cause&&e.cause.code==='ECONNREFUSED'?${REFUSED_EXIT}:${UNKNOWN_EXIT}));`;
const SUMMON_ABORT_MS = 15_000;
// The script's own abort comes first, so a slow board is told apart from a dead ssh.
const SUMMON_TIMEOUT_MS = 20_000;
// Two open tabs (or a tab and its refetch) share one read; a poll is 15 s.
const CACHE_MS = 5000;
const MAX_NAME = 120;

const NO_LISTENER_TEXT = 'The board is running an older game version with no live data. Press Update.';
const UNREACHABLE_TEXT = 'The board did not answer, so there is no live data right now.';
const SUMMON_UNREACHABLE_TEXT = 'The board did not answer. Nothing was summoned.';
const OUTCOME_UNKNOWN_TEXT = 'Outcome unknown: check the boss list before trying again.';

function parseJsonLine(text) {
  const lines = String(text || '').trim().split('\n');
  try { return JSON.parse(lines[lines.length - 1]); } catch { return null; }
}

// Same rule as the backend's proxy and the listener: exactly these fields.
function parseSummonRequest(body) {
  const fail = () => { throw new BadRequest('A summon needs an owner, a boss name, a world and what it replaces.'); };
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail();
  if (Object.keys(body).sort().join() !== 'name,owner,replaces,world') fail();
  const { owner, name, world, replaces } = body;
  const text = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_NAME;
  if ((owner !== 'world' && owner !== 'dungeon') || !text(name) || !text(world) || !(replaces === null || text(replaces))) fail();
  return { owner, name, world, replaces };
}

function createBoardLive({ runner, now = Date.now, cacheMs = CACHE_MS } = {}) {
  const unavailable = (reason) => ({
    available: false, reason, message: reason === 'no_listener' ? NO_LISTENER_TEXT : UNREACHABLE_TEXT,
  });

  // -> { available: true, ...body } | { available: false, reason, message }. Never throws.
  async function fetchRead(route) {
    let r;
    try { r = await runner.ssh(readCommand(route), { reuse: true, timeoutMs: READ_TIMEOUT_MS }); } catch { return unavailable('unreachable'); }
    if (!r.timedOut && r.code === NO_LISTENER_EXIT) return unavailable('no_listener');
    if (r.timedOut || r.code !== 0) return unavailable('unreachable');
    const body = parseJsonLine(r.stdout);
    return body && typeof body === 'object' ? { available: true, ...body } : unavailable('unreachable');
  }

  const cached = new Map(); // route -> { at, value, inflight }
  function read(route) {
    const slot = cached.get(route) || {};
    cached.set(route, slot);
    if (slot.inflight) return slot.inflight;
    if (slot.value && now() - slot.at < cacheMs) return Promise.resolve(slot.value);
    slot.inflight = fetchRead(route).then((value) => {
      slot.value = value;
      slot.at = now();
      return value;
    }).finally(() => { slot.inflight = null; });
    return slot.inflight;
  }

  // -> { ok: true, status, body } or { ok: false, text } where text says what the owner can conclude.
  // Past the point the request may have left, nothing may claim it failed: a landed summon is still a summon.
  async function postSummon(req) {
    const b64 = Buffer.from(JSON.stringify(req)).toString('base64');
    const args = ['backend', 'node', '-e', SUMMON_SCRIPT, String(SUMMON_ABORT_MS), b64];
    let r;
    try { r = await runner.script('remote.sh', args, { timeoutMs: SUMMON_TIMEOUT_MS }); } catch { return { ok: false, text: SUMMON_UNREACHABLE_TEXT }; }
    if (r.timedOut || r.code === UNKNOWN_EXIT || r.code === 255) return { ok: false, text: OUTCOME_UNKNOWN_TEXT };
    if (r.code === NO_LISTENER_EXIT) return { ok: false, text: NO_LISTENER_TEXT };
    if (r.code !== 0) return { ok: false, text: SUMMON_UNREACHABLE_TEXT };
    const parsed = parseJsonLine(r.stdout);
    if (!parsed || !Number.isInteger(parsed.status)) return { ok: false, text: OUTCOME_UNKNOWN_TEXT };
    return { ok: true, status: parsed.status, body: parsed.body };
  }

  // One step: a refusal from the board fails the job with its sentence, so the tab and the history say why.
  function summonJob(req) {
    return [{
      name: `Summon ${req.name}`,
      run: async ({ step, log }) => {
        const r = await postSummon(req);
        cached.clear();
        if (!r.ok) throw new Error(r.text);
        const message = (r.body && r.body.message) || `The board answered ${r.status}.`;
        log(message);
        if (r.status !== 200 || !r.body || !r.body.ok) throw new Error(message);
        step(message);
      },
    }];
  }

  return {
    summonJob,
    players: () => read('/players'),
    bosses: () => read('/bosses'),
    invalidate: () => cached.clear(),
  };
}

module.exports = {
  createBoardLive, parseSummonRequest, readCommand, BACKEND_CONTAINER, SUMMON_SCRIPT, SUMMON_ABORT_MS, SUMMON_TIMEOUT_MS,
  NO_LISTENER_TEXT, NO_LISTENER_EXIT, REFUSED_EXIT, UNKNOWN_EXIT, UNREACHABLE_TEXT, SUMMON_UNREACHABLE_TEXT, OUTCOME_UNKNOWN_TEXT,
};
