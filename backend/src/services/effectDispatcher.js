// Drains effect_sprite_jobs one row at a time on the GPU box (POST /api/vfx -> poll -> sheet +
// atlas -> asset store). Unlike the creature dispatcher there is no concept step and no
// cancel: a box job is one strip.
'use strict';
const crypto = require('node:crypto');
const jobs = require('./effectSpriteJobs.js');
const { boxRequestFor, readAtlas } = require('./effectSprites.js');
const { inspectPng } = require('./vfxSprite.js');

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createEffectDispatcher({ db, box, loadProvider, store, pollMs = 3000, timeoutMs = 15 * 60 * 1000, sleep = realSleep, now = Date.now }) {
  let running = false;
  let currentId = null;

  // Returns 'stop' when the box is unreachable (row requeued), else undefined.
  async function runRow(provider, row) {
    let boxJobId = row.box_job_id;
    if (!boxJobId) {
      const r = await box.createVfxJob(provider, boxRequestFor(row));
      if (!r.ok) {
        if (r.unreachable) { await jobs.requeue(db, row.id); return 'stop'; }
        await jobs.fail(db, row.id, r.error || 'GPU box refused the job');
        return undefined;
      }
      boxJobId = r.boxJobId;
      await jobs.setBoxJob(db, row.id, boxJobId);
    }
    const started = now();
    for (;;) {
      const r = await box.getSheetJob(provider, boxJobId);
      if (!r.ok) {
        if (r.unreachable) { await jobs.requeue(db, row.id); return 'stop'; }
        if (!r.retryable) { await jobs.fail(db, row.id, r.error); return undefined; }
      } else {
        const st = r.job.status;
        if (st === 'running') await jobs.markSeenRunning(db, row.id);
        else if (st === 'missing') { await jobs.fail(db, row.id, 'GPU box lost the job'); return undefined; }
        else if (st === 'failed') { await jobs.fail(db, row.id, r.job.error || 'GPU box failed the job'); return undefined; }
        else if (st === 'cancelled') { await jobs.fail(db, row.id, r.job.error || 'GPU box cancelled the job'); return undefined; }
        else if (st === 'done') return finish(provider, row, boxJobId);
      }
      if (now() - started >= timeoutMs) { await jobs.fail(db, row.id, 'timed out after 15 min'); return undefined; }
      await sleep(pollMs);
    }
  }

  async function finish(provider, row, boxJobId) {
    const s = await box.fetchSheet(provider, boxJobId);
    if (!s.ok) return unreachableOrFail(row, s);
    const a = await box.fetchAtlas(provider, boxJobId);
    if (!a.ok) return unreachableOrFail(row, a);
    const info = inspectPng(s.png);
    if (info.error) { await jobs.fail(db, row.id, info.error); return undefined; }
    const facts = readAtlas(a.atlas, { kind: row.kind, frames: row.frames, blend: row.blend });
    if (!facts.frames || info.width % facts.frames !== 0) {
      await jobs.fail(db, row.id, `strip width ${info.width} does not divide into ${facts.frames} frames`);
      return undefined;
    }
    const imageKey = `vfx/${crypto.randomUUID()}.png`;
    await store.putObject(imageKey, s.png, 'image/png');
    await jobs.markDone(db, row.id, { imageKey, atlas: a.atlas });
    return undefined;
  }

  async function unreachableOrFail(row, r) {
    if (r.unreachable) { await jobs.requeue(db, row.id); return 'stop'; }
    await jobs.fail(db, row.id, r.error);
    return undefined;
  }

  async function kick() {
    if (running) return;
    running = true;
    try {
      const provider = await loadProvider(db);
      if (!provider) return;
      // A row left `running` by a restart goes back to the queue, keeping its box_job_id so the
      // same box job is resumed, never paid for twice.
      await db.query(`UPDATE effect_sprite_jobs SET status = 'queued', running_since = NULL, updated_at = now() WHERE status = 'running'`);
      for (;;) {
        const row = await jobs.claimNext(db);
        if (!row) break;
        currentId = row.id;
        let stop;
        try {
          stop = await runRow(provider, row);
        } catch (err) {
          await jobs.fail(db, row.id, err && err.message ? err.message : String(err));
        }
        currentId = null;
        if (stop === 'stop') break;
      }
    } finally {
      currentId = null;
      running = false;
    }
  }

  return { kick, status: () => ({ running, currentId }) };
}

module.exports = { createEffectDispatcher };
