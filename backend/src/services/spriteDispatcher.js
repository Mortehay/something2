const defaultQueue = require('./spriteJobQueue.js');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createDispatcher({
  db,
  queue = defaultQueue,
  spriteGen,
  pollMs = 1000,
  timeoutMs = 30 * 60 * 1000,
}) {
  let run = null;

  async function poll(jobId) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      // eslint-disable-next-line no-await-in-loop
      const job = await spriteGen.getJob(jobId);
      if (job && (job.status === 'done' || job.status === 'error')) return job;
      // eslint-disable-next-line no-await-in-loop
      await wait(pollMs);
    }
    throw new Error(`sprite job ${jobId} timed out`);
  }

  async function execute(row) {
    const generation = await spriteGen.postGenerate({
      creature: row.creature,
      base_prompt: row.base_prompt,
      kind: row.generation_kind,
      seed: Number(row.seed),
      frames: row.frames,
    });

    const recipe = generation.recipe || {};
    await queue.attach(db, row.id, {
      jobId: generation.job_id,
      backend: recipe.backend || row.backend,
      frames: recipe.frames || row.frames,
    });
    const job = await poll(generation.job_id);
    if (job.status === 'error') throw new Error(job.error || 'sprite generation failed');
    await queue.complete(db, row.id, job.result || {});
  }

  async function drain(current) {
    try {
      while (!current.stopping) {
        // eslint-disable-next-line no-await-in-loop
        const row = await queue.claim(db);
        if (!row) break;
        current.current = { id: row.id, entity_type_id: row.entity_type_id, creature: row.creature };
        try {
          // eslint-disable-next-line no-await-in-loop
          await execute(row);
          current.completed += 1;
        } catch (err) {
          // eslint-disable-next-line no-await-in-loop
          await queue.fail(db, row.id, err);
          current.failed += 1;
        }
      }
    } finally {
      current.running = false;
      current.current = null;
      current.finished_at = new Date().toISOString();
    }
  }

  function start() {
    if (run && run.running) {
      const err = new Error('a sprite batch is already running');
      err.code = 'ALREADY_RUNNING';
      throw err;
    }
    run = {
      running: true,
      stopping: false,
      completed: 0,
      failed: 0,
      current: null,
      started_at: new Date().toISOString(),
      finished_at: null,
    };
    return drain(run);
  }

  function stop() {
    if (!run || !run.running) return false;
    run.stopping = true;
    return true;
  }

  function status() {
    return run ? { ...run, current: run.current ? { ...run.current } : null } : null;
  }

  return { start, stop, status };
}

module.exports = { createDispatcher };
