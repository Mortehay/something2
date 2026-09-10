// SOMET-551. The written description that replaces the catalogue template.
//
// See the migration header for why this is separate from art_prompt_notes and
// why a re-run inserts rather than overwrites.
//
// THE ONE THING THIS MODULE MUST GET RIGHT: with no stored description, the
// composed prompt has to be byte-for-byte what it is today. Every subject in
// the catalogue depends on that, and 87 items already have art generated from
// the template -- a silent change to their prompt would make a regeneration
// produce a different image for reasons nobody could see.

const MAX_TEXT = 400;

async function getActive(db, subjectKind, subjectKey) {
  const { rows } = await db.query(
    `SELECT id, text, length, model, created_at
       FROM art_prompt_descriptions
      WHERE subject_kind = $1 AND subject_key = $2 AND active
      LIMIT 1`,
    [subjectKind, subjectKey],
  );
  return rows[0] || null;
}

// Every description ever written for a subject, newest first. The history
// records prompts built from descriptions since replaced, and a prompt nobody
// can explain afterwards is not much of a record.
async function listAll(db, subjectKind, subjectKey) {
  const { rows } = await db.query(
    `SELECT id, text, length, model, active, created_at
       FROM art_prompt_descriptions
      WHERE subject_kind = $1 AND subject_key = $2
      ORDER BY created_at DESC, id DESC`,
    [subjectKind, subjectKey],
  );
  return rows;
}

// Replace the active description, keeping the old one readable.
//
// Deactivate-then-insert in ONE transaction. The partial unique index allows
// only one active row per subject, so doing this in two statements without a
// transaction leaves a window where a concurrent re-run inserts first and this
// one fails -- or worse, where a crash between them leaves a subject with NO
// active description and silently back on the template.
async function replace(db, subjectKind, subjectKey, { text, length = null, model = null }) {
  const body = String(text == null ? '' : text).trim().slice(0, MAX_TEXT);
  if (!body) return null;

  const client = db.connect ? await db.connect() : null;
  const run = client || db;
  try {
    if (client) await run.query('BEGIN');
    await run.query(
      `UPDATE art_prompt_descriptions SET active = false
        WHERE subject_kind = $1 AND subject_key = $2 AND active`,
      [subjectKind, subjectKey],
    );
    const { rows } = await run.query(
      `INSERT INTO art_prompt_descriptions (subject_kind, subject_key, text, length, model)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, text, length, model, active, created_at`,
      [subjectKind, subjectKey, body, length, model],
    );
    if (client) await run.query('COMMIT');
    return rows[0];
  } catch (err) {
    if (client) await run.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    if (client) client.release();
  }
}

// Drop back to the catalogue template for this subject.
async function clear(db, subjectKind, subjectKey) {
  const { rows } = await db.query(
    `UPDATE art_prompt_descriptions SET active = false
      WHERE subject_kind = $1 AND subject_key = $2 AND active
      RETURNING id`,
    [subjectKind, subjectKey],
  );
  return rows.length > 0;
}

// The subject phrase to build a prompt from: the written description when one
// exists, otherwise the catalogue's own. Returns the model too, so the history
// can record WHO wrote the prompt it is storing.
async function subjectPhrase(db, subjectKind, subjectKey, fallback) {
  const active = await getActive(db, subjectKind, subjectKey);
  if (!active) return { phrase: fallback, promptModel: null };
  return { phrase: active.text, promptModel: active.model || 'human' };
}

module.exports = {
  getActive, listAll, replace, clear, subjectPhrase, MAX_TEXT,
};
