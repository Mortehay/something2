// Drains effect_sprite_jobs one row at a time on the GPU box (POST /api/vfx -> poll -> sheet +
// atlas -> asset store). Unlike the creature dispatcher there is no concept step and no
// cancel: a box job is one strip.
'use strict';
const crypto = require('node:crypto');
const jobs = require('./effectSpriteJobs.js');
const { boxRequestFor, readAtlas, cellOf } = require('./effectSprites.js');
const { inspectPng } = require('./vfxSprite.js');

function fmtDuration(ms) {
  if (ms % 60000 === 0) return `${ms / 60000} min`;
  return ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
}

// The renderer reads a strip as ONE row of frames. With an atlas cell the PNG height must be the
// cell height; without one, a row taller than 4x the frame width can only be a multi-row sheet.
function oneRowError({ width, height }, frames, cell) {
  if (cell) {
    return height === cell[1] ? null
      : `strip is ${width}x${height} but the atlas cell is ${cell[0]}x${cell[1]}: expected one row of frames ${cell[1]} px tall`;
  }
  const frameW = width / frames;
  return height <= frameW * 4 ? null
    : `strip is ${width}x${height} for ${frames} frames (${frameW} px wide each): taller than one row of frames`;
}

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
        // refused (422) is final; unreachable or retryable (5xx, vram_busy) goes back to the queue.
        if (!r.refused && (r.unreachable || r.retryable)) { await jobs.requeue(db, row.id); return 'stop'; }
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
      if (now() - started >= timeoutMs) { await jobs.fail(db, row.id, `timed out after ${fmtDuration(timeoutMs)}`); return undefined; }
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
    const rowError = oneRowError(info, facts.frames, cellOf(a.atlas && a.atlas.cell));
    if (rowError) { await jobs.fail(db, row.id, rowError); return undefined; }
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

  // Boot-only: rows left `running` by a dead process go back to the queue, keeping box_job_id so the
  // same box job is resumed, never paid for twice. NOT part of kick(): another live dispatcher
  // sharing the DB would have its in-flight row stolen.
  async function resumeInterrupted() {
    const { rowCount } = await db.query(
      `UPDATE effect_sprite_jobs SET status = 'queued', running_since = NULL, updated_at = now() WHERE status = 'running'`);
    return rowCount;
  }

  return { kick, resumeInterrupted, status: () => ({ running, currentId }) };
}

// Opt-in like SPRITE_RESUME_ON_BOOT: call once at boot, then kick().
async function resumeEffectsOnBoot({ dispatcher, env = process.env }) {
  if (env.EFFECT_RESUME_ON_BOOT !== 'true') return 0;
  return dispatcher.resumeInterrupted();
}

module.exports = { createEffectDispatcher, resumeEffectsOnBoot };
