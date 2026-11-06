// SOMET-676. SIGTERM/SIGINT -> stop accepting, persist everything (awaited), end the
// pool, exit 0. Extracted from index.js so a test can drive it with fakes and a fake
// `exit` instead of killing the test process.
//
//   - a hang exits non-zero after `timeoutMs` (compose sends SIGKILL at 10 s);
//   - a second signal during the drain exits immediately;
//   - nodemon restarts the child with SIGUSR2 by default and, with no handler for it,
//     the child dies on the spot with nothing saved. So SIGUSR2 drains too, and the
//     exit that follows is what nodemon waits for before it respawns.
function installShutdownDrain({
  server, drain, endPool, timeoutMs = 8000, exit = process.exit,
  proc = process, log = console, signals = ['SIGTERM', 'SIGINT', 'SIGUSR2'],
}) {
  let started = false;
  let handlers = [];

  async function run(signal) {
    if (started) { log.error(`shutdown: second ${signal}, exiting now`); exit(1); return; }
    started = true;
    log.log(`shutdown: ${signal}, draining`);
    const timer = setTimeout(() => { log.error('shutdown: drain timed out'); exit(1); }, timeoutMs);
    timer.unref();
    let code = 0;
    try {
      // New HTTP requests are refused as soon as close() is called; keep-alive
      // sockets are dropped so close() can finish.
      const closed = new Promise((resolve) => { server.close(() => resolve()); });
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
      const stats = await drain();
      log.log(`shutdown: saved ${stats.players} player(s) across ${stats.worlds} world(s), ${stats.failed} failure(s)`);
      if (stats.failed) code = 1;
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await closed;
      await endPool();
    } catch (err) {
      log.error('shutdown: drain failed:', err);
      code = 1;
    }
    clearTimeout(timer);
    exit(code);
  }

  for (const signal of signals) {
    const h = () => { run(signal); };
    handlers.push([signal, h]);
    proc.on(signal, h);
  }
  return { uninstall() { for (const [sig, h] of handlers) proc.off(sig, h); handlers = []; } };
}

module.exports = { installShutdownDrain };
