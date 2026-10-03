exports.shorthands = undefined;

// 1714440620000 added needs_prompt with DEFAULT false, so every job already in
// the queue when it ran was left false -- and the drain sends a false job
// straight to the audio phase, where music/ambience with no prompt fails
// "no prompt" (found live 2026-10-04: 1,697 stale queued jobs on dev). This
// applies enqueue's own rule to every job not yet done: needs a prompt when it
// carries no style and no prompt of its own and the slot has no non-empty
// active prompt. force_prompt was also false for those rows, so it adds nothing.
// Exported so a test can run it against real rows.
const BACKFILL_SQL = `
  UPDATE audio_jobs j SET needs_prompt = true, updated_at = now()
   WHERE j.state <> 'done' AND NOT j.needs_prompt AND NOT j.prompt_only
     AND j.style IS NULL AND j.prompt IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM audio_prompts p
        WHERE p.active AND p.text <> ''
          AND p.subject_kind = j.subject_kind AND p.subject_key = j.subject_key AND p.slot = j.slot)`;

exports.BACKFILL_SQL = BACKFILL_SQL;

exports.up = (pgm) => {
  pgm.sql(BACKFILL_SQL);
};

// Nothing to undo: needs_prompt only decides which phase writes the prompt,
// and the drain clears it once the prompt exists.
exports.down = () => {};
