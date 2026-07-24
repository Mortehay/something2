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
      report.push({ ...base, status: 'skipped' });
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
      nextLock[resolved.name] = {
        fingerprint: fingerprint(resolved),
        atlas_key: result.atlas_key,
        job_id: jobId,
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
