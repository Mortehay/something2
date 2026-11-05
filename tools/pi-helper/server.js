'use strict';
// Host-side Orange Pi helper: the Pi tab's powers live here, not in the backend
// container. Socket/token/drain plumbing is tools/helper-core/helperServer.js.
const path = require('node:path');
const { createHelperServer, serve, BadRequest } = require('../helper-core/helperServer');
const { createRunner, redact } = require('./boardRunner');
const { readStatus } = require('./status');
const { createSampler } = require('./sampler');
const { createStatusCache, TTL_MS } = require('./statusCache');
const { createActionHistory } = require('./actionHistory');
const { createReleases } = require('./releases');
const { createJobs, BusyError } = require('./jobs');
const { updateJob, execTools } = require('./updateJob');
const { listInvites, mintInvites, revokeInvite, InviteFailed } = require('./invites');
const { tunnelJob, restartJob, seedJob, mapsJob, readSeedPreview, BoardOffline, TUNNEL_NAMES } = require('./boardJobs');
const { createBoardLive, parseSummonRequest } = require('./boardLive');

// A running deploy gets 30 s on stop, then its child is killed.
const DRAIN_CAP_MS = 30_000;

// POST routes that start a job answer 202; the symbol keeps the marker out of the JSON body.
const ACCEPTED = Symbol('accepted');
const accepted = (job) => ({ ...job, [ACCEPTED]: true });

// No such history entry (or an id that is not one).
class HistoryNotFound extends Error {}

// GET /history -> { entries } (summaries, newest first); GET /history/:id -> the entry with its log.
// redact(text) hides secrets a script printed into a log.
function historyRoutes(history, redactText = (t) => t) {
  return {
    'GET /history': () => ({ entries: history.list() }),
    'GET /history/:id': (_body, ctx) => {
      let id = null;
      try { id = decodeURIComponent(ctx.params.id); } catch { /* malformed escape */ }
      if (id === null || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new BadRequest('That is not an action id.');
      const entry = history.get(id);
      if (!entry) throw new HistoryNotFound('No such action in the history.');
      const r = (v) => (typeof v === 'string' ? redactText(v) : v);
      return { ...entry, log: r(entry.log), error: r(entry.error), steps: entry.steps.map((st) => ({ ...st, detail: r(st.detail) })) };
    },
  };
}

// GET /releases -> { source: 'board' | 'laptop', releases } newest first.
const releasesRoutes = (releases) => ({ 'GET /releases': () => releases.list() });

// An unexpected failure reading the seed preview. Classified so the owner sees the reason
// instead of a generic helper error.
class PreviewFailed extends Error {}

// Invite codes (SOMET-734): quick one-shot calls into the board, no job and no history entry.
const inviteRoutes = (runner) => ({
  'GET /invites': () => listInvites(runner),
  'POST /invites/mint': (body) => mintInvites(runner, body),
  'POST /invites/revoke': (body) => revokeInvite(runner, body),
});

// The game's live data. Read only when a request asks: the tab polls these while it is open, and
// nothing here runs otherwise. A summon is an ordinary job, so busy rules and the history apply.
function liveRoutes({ live, jobs }) {
  return {
    'GET /players': () => live.players(),
    'GET /bosses': () => live.bosses(),
    'POST /bosses/summon': (body) => accepted(jobs.start('summon', live.summonJob(parseSummonRequest(body)))),
  };
}

// The job routes. Factories stay free of HTTP; this only maps requests to them.
function jobRoutes({ runner, jobs, tools, releases }) {
  const begin = (kind, steps) => accepted(jobs.start(kind, steps));
  const routes = {
    'GET /job': () => jobs.current(),
    'GET /seed/preview': async () => {
      try { return await readSeedPreview(runner); } catch (e) {
      if (e instanceof BoardOffline) throw e;
        throw new PreviewFailed(String(e && e.message));
      }
    },
    'POST /seed/apply': () => begin('seed', seedJob(runner)),
    'POST /restart': () => begin('restart', restartJob(runner)),
    'POST /maps/apply': () => begin('maps', mapsJob(runner)),
    // git and gh are built on the first update, so a stub runner in other tests never needs them.
    'POST /update': () => {
      const t = tools || execTools({ root: runner.root, secrets: () => runner.secrets() });
      return begin('update', updateJob({ runner, git: t.git, gh: t.gh, releases }));
    },
  };
  for (const name of TUNNEL_NAMES) {
    for (const action of ['start', 'stop']) {
      routes[`POST /tunnel/${name}/${action}`] = () => begin('tunnel', tunnelJob(runner, name, action));
    }
  }
  return routes;
}

// routes: { 'GET /status': async (body, ctx) => json }. busy()/abort() let job code hold
// the drain open and kill its children when the cap hits. secrets() redacts a 500's message.
function createServer({ root, runDir, routes = {}, drainMs, busy, abort, secrets, onListening, onDrain, afterDrain } = {}) {
  const repoRoot = root || process.env.PI_HELPER_ROOT || path.resolve(__dirname, '../..');
  const helper = createHelperServer({
    name: 'Pi helper',
    dir: runDir || process.env.PI_HELPER_RUN_DIR || path.join(repoRoot, 'backend', 'run'),
    sockName: 'pi-helper.sock',
    tokenName: 'pi-helper.token',
    tokenHeader: 'X-Pi-Helper-Token',
    routes,
    busy,
    abort,
    drainCap: drainMs || (process.env.PI_HELPER_DRAIN_MS ? Number(process.env.PI_HELPER_DRAIN_MS) : DRAIN_CAP_MS),
    redact: (text) => redact(text, secrets ? secrets() : []),
    classifyError: (e) => {
      if (e instanceof HistoryNotFound) return { status: 404, error: 'not_found', message: e.message };
      if (e instanceof BusyError) return { status: 409, error: 'busy', message: e.message };
      if (e instanceof BoardOffline) return { status: 503, error: 'board_offline', message: e.message };
      if (e instanceof InviteFailed) return { status: 502, error: 'invites_failed', message: redact(e.message, secrets ? secrets() : []) };
      if (e instanceof PreviewFailed) return { status: 502, error: 'preview_failed', message: redact(e.message, secrets ? secrets() : []) };
      return null;
    },
    resultStatus: (out) => (out && out[ACCEPTED] ? 202 : 200),
    stopTarget: 'make pi-helper-stop',
    dirEnv: 'PI_HELPER_RUN_DIR',
  });
  if (!onListening && !onDrain && !afterDrain) return helper;
  // Lifecycle hooks, all best effort: onListening once bound, onDrain before the drain
  // begins (stop timers), afterDrain once work has ended (close the shared ssh master).
  const hook = async (fn) => { if (fn) { try { await fn(); } catch { /* best effort */ } } };
  return {
    ...helper,
    start: async () => {
      const live = await helper.start();
      await hook(onListening);
      return {
        ...live,
        drain: async () => {
          await hook(onDrain);
          const clean = await live.drain();
          await hook(afterDrain);
          return clean;
        },
      };
    },
  };
}

// GET /metrics?range=15m|1h|6h|24h|7d|30d -> { bucketMs, samples }. Any other range is a 400.
function metricsRoute(sampler) {
  return (_body, ctx) => {
    const range = new URL(ctx.url, 'http://helper').searchParams.get('range');
    const r = sampler.query(range);
    if (!r) throw new BadRequest('range must be 15m, 1h, 6h, 24h, 7d or 30d.');
    return { bucketMs: r.bucketMs, samples: r.samples };
  };
}

if (require.main === module) {
  const root = process.env.PI_HELPER_ROOT || path.resolve(__dirname, '../..');
  const runDir = process.env.PI_HELPER_RUN_DIR || path.join(root, 'backend', 'run');
  const runner = createRunner({ root });
  // The sampler reads tunnel URLs from the latest status. The status is cached for 60 s (statusCache.js):
  // polls never run tunnel.sh, only the 60 s timer and the end of a job do.
  let latestStatus = null;
  let sampler = null;
  const tools = execTools({ root, secrets: () => runner.secrets() });
  const releases = createReleases({ runner, git: tools.git, file: path.join(runDir, 'pi-releases.jsonl') });
  let jobs = null;
  releases.setBusy(() => Boolean(jobs && jobs.isRunning()));
  const cache = createStatusCache({
    // Each refresh also lets the releases catch up: a deploy the CI hook made, a board copy that missed a write.
    read: () => readStatus(runner).then((st) => { latestStatus = st; if (st.online) releases.sync().catch(() => {}); return st; }),
    latestSample: () => (sampler ? sampler.latest() : null),
  });
  const live = createBoardLive({ runner });
  sampler = createSampler({
    runner, file: path.join(runDir, 'pi-metrics.jsonl'), getTunnels: () => (latestStatus && latestStatus.tunnels) || {}, readCounters: () => live.counters(),
  });
  const statusTimer = setInterval(() => { cache.refreshIfOlder(TTL_MS - 5000).catch(() => {}); }, 60_000);
  statusTimer.unref();
  const history = createActionHistory({ file: path.join(runDir, 'pi-actions.jsonl') });
  // After any job it is kept in the history, and the cache is dropped and re-read, so a tunnel link or health change shows at once.
  jobs = createJobs({ onDone: (job) => { history.add(job); return cache.onJobDone(); } });
  serve('pi-helper', createServer({
    root,
    runDir,
    routes: {
      'GET /status': async () => ({ ...(await cache.get()), version: releases.currentVersion() }),
      'GET /metrics': metricsRoute(sampler),
      ...historyRoutes(history, (t) => redact(t, runner.secrets())),
      ...releasesRoutes(releases),
      ...inviteRoutes(runner),
      ...jobRoutes({ runner, jobs, tools, releases }),
      ...liveRoutes({ live, jobs }),
    },
    onListening: () => sampler.start(),
    onDrain: () => { sampler.stop(); clearInterval(statusTimer); },
    afterDrain: () => runner.closeMaster(),
    busy: () => runner.busyCount() > 0 || jobs.isRunning(),
    abort: () => { jobs.abort(); return runner.abort(); },
    secrets: () => runner.secrets(),
  }));
}

module.exports = { createServer, metricsRoute, jobRoutes, inviteRoutes, historyRoutes, releasesRoutes, liveRoutes };
