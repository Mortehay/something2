exports.shorthands = undefined;

// Game audio slice 3 final fix (SOMET-592, I1). The box's `cached` flag only
// says the box served a file from ITS cache -- a cache shared by every
// database that talks to the box -- not that this database already holds
// that file. The only honest duplicate test is the bytes themselves, so each
// clip records the sha1 of its stored object. Nullable: rows stored before
// this migration are hashed on demand (from the asset store) when a dedupe
// check needs them.
exports.up = (pgm) => {
  pgm.addColumn('audio_clips', { sha1: { type: 'text' } });
};

exports.down = (pgm) => {
  pgm.dropColumn('audio_clips', 'sha1');
};
