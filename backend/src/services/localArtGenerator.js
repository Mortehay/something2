const remote = require('./remoteImageProvider.js');
const spriteGenClient = require('./spriteGen.js');

// SOMET-535 rework. The art queue's LOCAL backend: an art_jobs row whose
// backend is 'local' is drawn by the sprite-gen service rather than by a
// registered ai_providers row.
//
// Same client the interactive local path uses (spriteGen.js postGenerate +
// getJob), and the same reporting contract as remote.runGeneration -- it
// writes the outcome into remoteImageProvider's in-memory registry entry -- so
// artDispatcher.runOne reads one shape whichever backend drew the image and
// the guards, history and catalog write after it stay a single path.

// Stands in for a provider row. `id: null` is the point: catalog_art and
// art_generations record provider_id from it, and a locally drawn image must
// never be attributed to a remote provider.
const LOCAL_PROVIDER = Object.freeze({
  id: null, name: 'local sprite-gen', model: 'sprite-gen', local: true,
});

const POLL_MS = () => parseInt(process.env.LOCAL_ART_POLL_MS || '1000', 10);
// sprite-gen runs one job at a time on its own worker, and on CPU a single
// image is about a minute. Generous, so a backlog from the interactive path
// queued ahead of us does not read as a failure; bounded, so a wedged service
// cannot hang the drain forever.
const TIMEOUT_MS = () => parseInt(process.env.LOCAL_ART_TIMEOUT_MS || '1800000', 10);

// The subject becomes a storage path segment on the sprite-gen side
// (<prefix>/<name>/<job_id>/static.png), so it is reduced to a safe slug.
function slug(s) {
  return String(s || 'subject').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80) || 'subject';
}

async function runGeneration(registryId, provider, req, deps = {}) {
  const sg = deps.spriteGen || spriteGenClient;
  const pollMs = deps.pollMs != null ? deps.pollMs : POLL_MS();
  const timeoutMs = deps.timeoutMs != null ? deps.timeoutMs : TIMEOUT_MS();
  // No size: sprite-gen picks its own per kind and refuses anything above 512,
  // so the remote path's 1024 object ask must not reach it. No negative
  // either -- sprite-gen's request has no such field.
  const body = {
    creature: slug(req.subject),
    base_prompt: req.prompt,
    kind: req.kind === 'tile' ? 'tile' : 'object',
    seed: req.seed,
    frames: 1,
  };
  // `prompt` mirrors base_prompt on the recorded body because the generation
  // history reads the composed prompt from `.prompt` -- without it every
  // local attempt was recorded with no prompt at all (found in the live probe).
  remote.setJob(registryId, { status: 'running', sentBody: { ...body, prompt: body.base_prompt } });
  try {
    const started = await sg.postGenerate(body);
    const jobId = started && started.job_id;
    if (!jobId) throw new Error('sprite-gen /generate returned no job_id');
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const doc = await sg.getJob(jobId);
      if (doc && doc.status === 'done') {
        remote.setJob(registryId, {
          status: 'done', progress: { done: 1, total: 1 }, result: doc.result || null,
        });
        return;
      }
      if (doc && doc.status === 'error') {
        throw new Error(doc.error || 'no reason given');
      }
      if (Date.now() >= deadline) {
        throw new Error(`job ${jobId} did not finish within ${timeoutMs}ms`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, pollMs); });
    }
  } catch (err) {
    remote.setJob(registryId, {
      status: 'error',
      error: `local sprite-gen: ${err && err.message ? err.message : err}`,
    });
  }
}

module.exports = { LOCAL_PROVIDER, runGeneration, slug };
