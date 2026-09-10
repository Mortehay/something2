// SOMET-558. Whether a prompt correction RESHAPES the subject or EXCLUDES
// something from it, because the two must reach the image model by opposite
// routes.
//
// Every note has until now been appended to the POSITIVE prompt. That is right
// for "throwing darts, not a dartboard", which describes what the subject is.
// It is actively wrong for an exclusion: CLIP has no reliable negation, so
// "no grey shadow" conditions *shadow* IN, and the correction makes the next
// image worse than no correction at all. Measured today on item/arrow, where
// an operator wrote "you drawn a rocket" and the word rocket went straight
// into the positive prompt.
//
// The provider request already carries a negative_prompt -- the template's
// literal list of framing and scenery terms -- and that is where an exclusion
// belongs.
//
// DEFAULT 'reshape', so every existing note keeps its current routing exactly.
// The two notes in this database that are really exclusions ("no grey shadow")
// are NOT migrated: deciding that from the text would be guesswork, and a
// silent reclassification would change what those subjects generate for a
// reason nobody could see afterwards. The operator re-enters them.
exports.up = (pgm) => {
  pgm.addColumn('art_prompt_notes', {
    kind: {
      type: 'text',
      notNull: true,
      default: 'reshape',
      comment: "'reshape' joins the positive prompt; 'avoid' joins negative_prompt.",
    },
  });
  pgm.addConstraint('art_prompt_notes', 'art_prompt_notes_kind_check',
    "CHECK (kind IN ('reshape', 'avoid'))");
};

exports.down = (pgm) => {
  pgm.dropConstraint('art_prompt_notes', 'art_prompt_notes_kind_check');
  pgm.dropColumn('art_prompt_notes', 'kind');
};
