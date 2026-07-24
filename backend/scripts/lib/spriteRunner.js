const { resolveEntity, fingerprint, shouldSkip } = require('./spriteManifest.js');

async function runGeneration({ entities, defaults, lock, client, token, nameToId, force, dryRun, poll = {} }) {
  const report = [];
  const nextLock = { ...lock };

  for (const raw of entities) {
    const resolved = resolveEntity(defaults, raw);
    const entityTypeId = Object.prototype.hasOwnProperty.call(nameToId, resolved.name)
      ? nameToId[resolved.name] : null;
    const base = { name: resolved.name, kind: resolved.kind, entityTypeId };

    if (shouldSkip(resolved, lock, force)) {
      const priorLock = lock[resolved.name] || {};
      const skipRow = { ...base, status: 'skipped' };
      if (priorLock.atlas_key && priorLock.manifest_key && priorLock.job_id) {
        skipRow.atlasKey = priorLock.atlas_key;
        skipRow.manifestKey = priorLock.manifest_key;
        skipRow.jobId = priorLock.job_id;
      }
      report.push(skipRow);
      continue;
    }
    if (dryRun) {
      report.push({ ...base, status: 'planned' });
      continue;
    }

    try {
      const { jobId, route } = await client.startJob(token, {
        kind: resolved.kind, name: resolved.name, prompt: resolved.prompt,
        seed: resolved.seed, frames: resolved.frames, backend: resolved.backend,
      });
      const job = await client.pollJob(token, route, jobId, poll);
      if (job.status === 'error') {
        report.push({ ...base, status: 'failed', jobId, error: job.error || 'unknown error' });
        continue;
      }
      const result = job.result || {};
      if (!result.atlas_key || !result.manifest_key) {
        report.push({
          ...base, status: 'failed', jobId,
          error: 'job done but result missing atlas_key/manifest_key',
        });
        continue;
      }
      nextLock[resolved.name] = {
        fingerprint: fingerprint(resolved),
        atlas_key: result.atlas_key,
        job_id: jobId,
        manifest_key: result.manifest_key,
      };
      report.push({
        ...base, status: 'generated', jobId,
        atlasKey: result.atlas_key, manifestKey: result.manifest_key,
      });
    } catch (err) {
      report.push({ ...base, status: 'failed', error: err.message });
    }
  }

  return { report, lock: nextLock };
}

module.exports = { runGeneration };
