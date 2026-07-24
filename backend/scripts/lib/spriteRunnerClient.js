const ROUTE_FOR_KIND = { creature: 'sprite-jobs', object: 'entity-jobs' };

function createClient({ baseUrl, fetch = globalThis.fetch, sleep = defaultSleep, now = Date.now }) {
  const url = (p) => `${baseUrl}${p}`;

  async function login(username, password) {
    const res = await fetch(url('/api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new Error(`login failed (${res.status})`);
    const body = await res.json();
    return body.token;
  }

  async function listEntityTypes(token) {
    const res = await fetch(url('/api/entity-types'), { headers: auth(token) });
    if (!res.ok) throw new Error(`listEntityTypes failed (${res.status})`);
    return res.json();
  }

  async function startJob(token, { kind, name, prompt, seed, frames, backend }) {
    const route = ROUTE_FOR_KIND[kind];
    if (!route) throw new Error(`unsupported kind '${kind}'`);
    const res = await fetch(url(`/api/${route}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(token) },
      body: JSON.stringify({ entity_type: name, base_prompt: prompt, seed, frames, backend }),
    });
    if (!res.ok) throw new Error(`startJob(${name}) failed (${res.status})`);
    const body = await res.json();
    return { jobId: body.job_id, route };
  }

  async function pollJob(token, route, jobId, { intervalMs = 5000, timeoutMs = 30 * 60 * 1000 } = {}) {
    const start = now();
    for (;;) {
      const res = await fetch(url(`/api/${route}/${jobId}`), { headers: auth(token) });
      if (!res.ok) throw new Error(`pollJob(${jobId}) failed (${res.status})`);
      const job = await res.json();
      if (job.status === 'done' || job.status === 'error') return job;
      if (now() - start > timeoutMs) throw new Error(`pollJob(${jobId}) timed out after ${timeoutMs}ms`);
      await sleep(intervalMs);
    }
  }

  return { login, listEntityTypes, startJob, pollJob };
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { createClient };
