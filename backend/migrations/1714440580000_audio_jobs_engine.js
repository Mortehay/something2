exports.shorthands = undefined;

// Game audio slice 3 (spec §2 "Dispatcher", Task 4). An sfx job's engine
// ('realistic' | 'retro') is what splits sfx into its two drain groups
// (sfx_realistic, sfx_retro) and is sent per item in the sfx-pack request.
// slice 2's audio_jobs had drain_group but no column to carry the engine
// itself; `style` holds nothing for sfx. Nullable: music/ambience jobs have
// no engine.
exports.up = (pgm) => {
  pgm.addColumn('audio_jobs', {
    engine: { type: 'text', check: "engine IN ('realistic', 'retro')" },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('audio_jobs', 'engine');
};
