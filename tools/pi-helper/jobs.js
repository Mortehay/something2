'use strict';
// One long action at a time, polled by the tab. A step function is
// `async ({ step, log }) => void`; a throw fails the job at that step.
const LOG_CAP = 16 * 1024;
const ABORTED_MESSAGE = 'The helper was stopped during this action.';

class BusyError extends Error {
  constructor(kind) {
    super(`Another action is already running (${kind}). Wait for it to finish.`);
    this.code = 'busy';
  }
}

// steps: [{ name, run }] . step(detail) sets the detail of the step that is running.
function createJobs({ onDone, now = () => new Date().toISOString() } = {}) {
  let job = null;
  let running = false;
  let aborted = false;
  let seq = 0;

  const snapshot = () => (job ? { ...job, steps: job.steps.map((s) => ({ ...s })) } : null);

  function appendLog(line) {
    job.log = (job.log + String(line) + '\n');
    if (job.log.length > LOG_CAP) job.log = job.log.slice(-LOG_CAP);
  }

  async function execute(steps, mine) {
    for (const s of mine.steps) s.state = 'pending';
    let i = 0;
    try {
      for (; i < steps.length; i += 1) {
        const rec = mine.steps[i];
        rec.state = 'running';
        await steps[i].run({
          step: (detail) => { rec.detail = String(detail); },
          log: appendLog,
          setTarget: (sha) => { mine.targetSha = String(sha); },
          setCiUrl: (url) => { mine.ciUrl = String(url); },
        });
        rec.state = 'ok';
        if (aborted) throw new Error(ABORTED_MESSAGE);
      }
      mine.state = 'ok';
    } catch (e) {
      if (mine.steps[i]) mine.steps[i].state = 'failed';
      if (mine.steps[i] && !mine.steps[i].detail) mine.steps[i].detail = aborted ? ABORTED_MESSAGE : String(e.message);
      mine.state = 'failed';
      mine.error = aborted ? ABORTED_MESSAGE : String(e && e.message ? e.message : e);
    }
    if (aborted && mine.state === 'ok') { mine.state = 'failed'; mine.error = ABORTED_MESSAGE; }
    mine.finishedAt = now();
    running = false;
    if (onDone) { try { await onDone(snapshot()); } catch { /* best effort */ } }
  }

  function start(kind, steps) {
    if (running) throw new BusyError(job.kind);
    running = true;
    seq += 1;
    job = {
      id: `${Date.now().toString(36)}-${seq}`, kind, state: 'running', startedAt: now(), finishedAt: null,
      steps: steps.map((s) => ({ name: s.name, state: 'pending', detail: null })),
      log: '', error: null, targetSha: null, ciUrl: null,
    };
    const mine = job;
    // Steps run on the next tick so the caller gets the 'running' job back first.
    setImmediate(() => { execute(steps, mine); });
    return snapshot();
  }

  return {
    start,
    current: snapshot,
    isRunning: () => running,
    // The drain path: the runner's abort() kills children, the script returns, and the job ends failed.
    abort: () => { aborted = true; },
  };
}

module.exports = { createJobs, BusyError, LOG_CAP, ABORTED_MESSAGE };
