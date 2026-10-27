exports.shorthands = undefined;

// Optional prompt-first phase for image batches. A forced job writes a fresh
// art_prompt_descriptions row through the GPU text provider before it becomes
// eligible for image generation. Keeping the flag on the durable job makes the
// choice survive backend and GPU-box restarts.
exports.up = (pgm) => {
  pgm.addColumns('art_jobs', {
    needs_prompt: { type: 'boolean', notNull: true, default: false },
    force_prompt: { type: 'boolean', notNull: true, default: false },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('art_jobs', ['needs_prompt', 'force_prompt']);
};
