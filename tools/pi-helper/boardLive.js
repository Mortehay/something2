'use strict';
// The game's live data on the board (players, bosses, counters, summon). The backend serves it from an
// internal listener bound to 127.0.0.1 inside its container, and this is the only way in: a short fixed
// node script through `remote.sh backend`. Its arguments are a method, a path from the fixed list here
// and, for a summon, base64 JSON, so a boss or world name never reaches a shell as text.
//
// An older board image has no listener. That is a normal answer here ("no_listener"), never an error:
// the tab says to press Update.
const { BadRequest } = require('../helper-core/helperServer');

const FETCH_SCRIPT = "const[m,p,b]=process.argv.slice(1);const port=process.env.BOARD_INTERNAL_PORT;"
  + "if(!port)process.exit(3);"
  + "fetch('http://127.0.0.1:'+port+p,{method:m,headers:{'content-type':'application/json'},"
  + "body:b?Buffer.from(b,'base64'):undefined,signal:AbortSignal.timeout(6000)})"
  + ".then(async(r)=>{console.log(JSON.stringify({status:r.status,body:await r.json()}))})"
  + ".catch(()=>process.exit(3));";
const NO_LISTENER_EXIT = 3;
const READ_TIMEOUT_MS = 12_000;
const SUMMON_TIMEOUT_MS = 20_000;
// Two open tabs (or a tab and its refetch) share one read; a poll is 15 s.
const CACHE_MS = 5000;
const MAX_NAME = 120;

const NO_LISTENER_TEXT = 'The board is running an older game version with no live data. Press Update.';
const UNREACHABLE_TEXT = 'The board did not answer, so there is no live data right now.';

function parseJsonLine(text) {
  const lines = String(text || '').trim().split('\n');
  try { return JSON.parse(lines[lines.length - 1]); } catch { return null; }
}

// Same rule as the backend's proxy and the listener: exactly these fields.
function parseSummonRequest(body) {
  const fail = () => { throw new BadRequest('A summon needs an owner, a boss name and a world.'); };
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail();
  if (Object.keys(body).sort().join() !== 'name,owner,world') fail();
  const { owner, name, world } = body;
  const text = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_NAME;
  if ((owner !== 'world' && owner !== 'dungeon') || !text(name) || !text(world)) fail();
  return { owner, name, world };
}

function createBoardLive({ runner, now = Date.now, cacheMs = CACHE_MS } = {}) {
  // -> { ok: true, status, body } | { ok: false, reason: 'no_listener' | 'unreachable' }
  async function ask(method, route, body, timeoutMs = READ_TIMEOUT_MS) {
    const args = ['backend', 'node', '-e', FETCH_SCRIPT, method, route];
    if (body !== undefined) args.push(Buffer.from(JSON.stringify(body)).toString('base64'));
    let r;
    try { r = await runner.script('remote.sh', args, { timeoutMs }); } catch { return { ok: false, reason: 'unreachable' }; }
    if (r.code === NO_LISTENER_EXIT) return { ok: false, reason: 'no_listener' };
    if (r.code !== 0 || r.timedOut) return { ok: false, reason: 'unreachable' };
    const parsed = parseJsonLine(r.stdout);
    if (!parsed || !Number.isInteger(parsed.status)) return { ok: false, reason: 'unreachable' };
    return { ok: true, status: parsed.status, body: parsed.body };
  }

  const unavailable = (reason) => ({
    available: false, reason, message: reason === 'no_listener' ? NO_LISTENER_TEXT : UNREACHABLE_TEXT,
  });

  const cached = new Map(); // route -> { at, value, inflight }
  function read(route) {
    const slot = cached.get(route) || {};
    cached.set(route, slot);
    if (slot.inflight) return slot.inflight;
    if (slot.value && now() - slot.at < cacheMs) return Promise.resolve(slot.value);
    slot.inflight = ask('GET', route).then((r) => {
      slot.value = r.ok && r.status === 200 ? { available: true, ...r.body } : unavailable(r.ok ? 'unreachable' : r.reason);
      slot.at = now();
      return slot.value;
    }).finally(() => { slot.inflight = null; });
    return slot.inflight;
  }

  // For the sampler: { online, mobKills, pvpKills } or null. Never throws.
  async function counters() {
    const r = await ask('GET', '/counters');
    if (!r.ok || r.status !== 200 || !r.body) return null;
    const { online, mobKills, pvpKills } = r.body;
    return [online, mobKills, pvpKills].every(Number.isFinite) ? { online, mobKills, pvpKills } : null;
  }

  // One step: a refusal from the board fails the job with its sentence, so the tab and the history say why.
  function summonJob(req) {
    return [{
      name: `Summon ${req.name}`,
      run: async ({ step, log }) => {
        const r = await ask('POST', '/bosses/summon', req, SUMMON_TIMEOUT_MS);
        cached.clear();
        if (!r.ok) throw new Error(r.reason === 'no_listener' ? NO_LISTENER_TEXT : UNREACHABLE_TEXT);
        const message = (r.body && r.body.message) || `The board answered ${r.status}.`;
        log(message);
        if (r.status !== 200 || !r.body || !r.body.ok) throw new Error(message);
        step(message);
      },
    }];
  }

  return {
    ask, counters, summonJob,
    players: () => read('/players'),
    bosses: () => read('/bosses'),
    invalidate: () => cached.clear(),
  };
}

module.exports = { createBoardLive, parseSummonRequest, FETCH_SCRIPT, NO_LISTENER_TEXT, NO_LISTENER_EXIT };
