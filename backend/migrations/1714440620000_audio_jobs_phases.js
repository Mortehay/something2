exports.shorthands = undefined;

// Audio batch in phases (plan 2026-10-03, Task 2). The drain writes every
// pending prompt with the box's text model first, then switches the box to
// each audio model and generates -- the GPU holds one model at a time, so
// interleaving the two made them evict each other. These are columns, not a
// new state: `state` and its CHECK stay as they are, and a job moves between
// the two phases while 'queued'.
//   needs_prompt  the prompt phase must write this slot's prompt first.
//                 Computed at enqueue (force_prompt, or no request prompt and
//                 no non-empty active audio_prompts row); cleared once written.
//   force_prompt  write a new prompt even over an existing (hand-written)
//                 one; the old row stays in audio_prompts history.
//   prompt_only   "Write with model": the job is done once its prompt is
//                 written, and never reaches the audio phase.
// And two inputs the slot card's synchronous calls sent that a queued job
// could not carry, so the card's Generate and Write with model can go
// through the queue:
//   variants      sfx only: how many variants to ask the box for (1-5).
//                 NULL = the pack default; a job with any other count is
//                 claimed and sent on its own, never inside a pack.
//   hint          the admin's hint for the prompt writer (capped at 200
//                 characters by the route, as writeSlotPrompt caps it).
exports.up = (pgm) => {
  pgm.addColumns('audio_jobs', {
    needs_prompt: { type: 'boolean', notNull: true, default: false },
    force_prompt: { type: 'boolean', notNull: true, default: false },
    prompt_only: { type: 'boolean', notNull: true, default: false },
    variants: { type: 'integer', check: 'variants BETWEEN 1 AND 5' },
    hint: { type: 'text' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('audio_jobs', ['needs_prompt', 'force_prompt', 'prompt_only', 'variants', 'hint']);
};
