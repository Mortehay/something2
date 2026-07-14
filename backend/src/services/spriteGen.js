const BASE = () => process.env.SPRITE_GEN_URL || 'http://sprite-gen:8100';

async function postGenerate(body) {
  const res = await fetch(`${BASE()}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`sprite-gen /generate ${res.status}`);
  return res.json();
}

async function getJob(jobId) {
  const res = await fetch(`${BASE()}/jobs/${jobId}`);
  if (!res.ok) throw new Error(`sprite-gen /jobs ${res.status}`);
  return res.json();
}

module.exports = { postGenerate, getJob };
