// Never the hostname: in compose that is a random container id, which says
// nothing about which PC an export came from.
const UNNAMED_PC = 'unnamed-pc';

function pcLabel() {
  return process.env.SEED_PC_LABEL || UNNAMED_PC;
}

const pcLabelSet = () => Boolean(process.env.SEED_PC_LABEL);

async function schemaVersion(db) {
  const { rows } = await db.query('SELECT max(name) AS v FROM pgmigrations');
  return rows[0].v || '';
}

async function startRun(db, groupId, action) {
  const { rows } = await db.query(
    `INSERT INTO seed_export_runs (group_id, action, status, pc_label)
     VALUES ($1, $2, 'running', $3) RETURNING id`,
    [groupId, action, pcLabel()],
  );
  return rows[0].id;
}

async function finishRun(db, runId, { status, summary = {}, error = null }) {
  await db.query(
    `UPDATE seed_export_runs SET status = $2, summary = $3, error = $4, finished_at = now() WHERE id = $1`,
    [runId, status, JSON.stringify(summary || {}), error],
  );
}

async function lastRuns(db) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (group_id, action) * FROM seed_export_runs
      WHERE status = 'ok' ORDER BY group_id, action, started_at DESC, id DESC`,
  );
  const out = {};
  const { GROUPS } = require('./registry.js');
  for (const g of GROUPS) out[g.id] = { export: null, seed: null };
  for (const r of rows) {
    if (!out[r.group_id]) out[r.group_id] = { export: null, seed: null };
    out[r.group_id][r.action] = r;
  }
  return out;
}

async function recentRuns(db, { limit = 50, groupId } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM seed_export_runs WHERE ($2::text IS NULL OR group_id = $2)
      ORDER BY started_at DESC, id DESC LIMIT $1`,
    [limit, groupId || null],
  );
  return rows;
}

module.exports = { UNNAMED_PC, pcLabel, pcLabelSet, schemaVersion, startRun, finishRun, lastRuns, recentRuns };
