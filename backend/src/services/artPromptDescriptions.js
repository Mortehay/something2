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
    `SELECT id, text, length, model, source_prompt, created_at
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
    `SELECT id, text, length, model, source_prompt, active, created_at
       FROM art_prompt_descriptions
      WHERE subject_kind = $1 AND subject_key = $2
      ORDER BY created_at DESC, id DESC`,
    [subjectKind, subjectKey],
  );
  return rows;
}

// Every subject of a kind that currently HAS an active description, keyed by
// subject_key. One query instead of one per subject: the batch pass in
// scripts/describe-subjects.js asks this about ~1000 subjects at a time, and
// asking per subject is what makes a resumable pass take longer to decide what
// to skip than to do the work.
async function listActive(db, subjectKind) {
  const { rows } = await db.query(
    `SELECT subject_key, id, text, length, model, source_prompt, created_at
       FROM art_prompt_descriptions
      WHERE subject_kind = $1 AND active`,
    [subjectKind],
  );
  return new Map(rows.map((r) => [r.subject_key, r]));
}

// Replace the active description, keeping the old one readable.
//
// Deactivate-then-insert in ONE transaction. The partial unique index allows
// only one active row per subject, so doing this in two statements without a
// transaction leaves a window where a concurrent re-run inserts first and this
// one fails -- or worse, where a crash between them leaves a subject with NO
// active description and silently back on the template.
async function replace(
  db, subjectKind, subjectKey, { text, length = null, model = null, sourcePrompt = null },
) {
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
      `INSERT INTO art_prompt_descriptions
         (subject_kind, subject_key, text, length, model, source_prompt)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, text, length, model, source_prompt, active, created_at`,
      [subjectKind, subjectKey, body, length, model, sourcePrompt || null],
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

// SOMET-552. Is this description still describing the subject the catalogue
// describes? `current` is the catalogue's own phrase for the subject right now.
//
// NULL source_prompt is FRESH, not stale. Rows written before the column
// existed cannot answer the question, and answering "stale" for them would
// flag every description in the database on the day this shipped -- a warning
// that fires on everything is read as noise and then ignored, which costs the
// real cases.
function isStale(description, current) {
  if (!description || !description.source_prompt || !current) return false;
  return description.source_prompt.trim() !== String(current).trim();
}

// The subject phrase to build a prompt from: the written description when one
// exists, otherwise the catalogue's own. Returns the model too, so the history
// can record WHO wrote the prompt it is storing, and whether the description
// still matches the catalogue it was written from.
//
// A STALE DESCRIPTION IS STILL RETURNED -- see the migration header for why
// dropping it would be the more damaging half of the same mistake.
async function subjectPhrase(db, subjectKind, subjectKey, fallback) {
  const active = await getActive(db, subjectKind, subjectKey);
  if (!active) return { phrase: fallback, promptModel: null, stale: false };
  return {
    phrase: active.text,
    promptModel: active.model || 'human',
    stale: isStale(active, fallback),
  };
}

// Has anything that FEEDS THE PROMPT changed for this subject since `since`?
//
// WHY THIS EXISTS. artFailures classifies a cutout failure as not-retryable
// because the seed is derived from the subject, so a plain retry regenerates a
// byte-identical image. That reasoning is exactly right, and it holds only
// while THE PROMPT IS UNCHANGED -- a caveat SOMET-544 recorded as a known
// limitation. Descriptions make it actively wrong: rewrite a subject's
// description and the retry produces a DIFFERENT image, so refusing it makes
// the operator use "retry with a new seed" for a reason that no longer applies
// and lose the reproducible seed for nothing.
//
// Reads BOTH tables on purpose. "The recipe" is the description plus the
// notes; either changing is enough to make a retry meaningful, and asking only
// one of them would refuse a retry the other had already justified.
async function recipeChangedSince(db, subjectKind, subjectKey, since) {
  if (!since) return false;
  const { rows } = await db.query(
    `SELECT
       EXISTS (SELECT 1 FROM art_prompt_descriptions
                WHERE subject_kind = $1 AND subject_key = $2 AND created_at > $3)
       OR
       EXISTS (SELECT 1 FROM art_prompt_notes
                WHERE subject_kind = $1 AND subject_key = $2 AND created_at > $3)
       AS changed`,
    [subjectKind, subjectKey, since],
  );
  return Boolean(rows[0] && rows[0].changed);
}

module.exports = {
  getActive, listAll, listActive, replace, clear, subjectPhrase,
  recipeChangedSince, isStale, MAX_TEXT,
};
