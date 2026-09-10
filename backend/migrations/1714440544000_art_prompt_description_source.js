/* eslint-disable camelcase */

// SOMET-552. Record WHAT THE CATALOGUE SAID when a description was written.
//
// THE RISK THIS CLOSES, quoted from the plan that scheduled it:
// "A stored description is a second source of truth. If a catalogue row is
// renamed, its description goes stale silently. No mechanism proposed here --
// worth deciding before slice 3 writes 530 of them." Slice 3 is the run that
// writes those 530, so it is decided here.
//
// THE EXPOSURE IS NOT UNIFORM, which is what makes one nullable column enough.
// A description is keyed by (subject_kind, subject_key), so it goes stale only
// where the KEY survives a change to the prompt inputs:
//
//   item           key = item_types.name        a rename CHANGES THE KEY, so the
//                                               description is orphaned, not
//                                               stale -- the subject silently
//                                               drops back to the template.
//                                               category/element can still move
//                                               under a fixed key.
//   skill          key = skills.id (authored)   nameEn, class and type can ALL
//                                               change under a stable key. This
//                                               is the real case, and it is 300
//                                               of the 530.
//   passive_label  key = the label text         the key IS the text; any edit
//                                               makes a new subject.
//   tile, entity   key = name                   the `prompt` column is editable
//                                               while the name is fixed.
//
// SO: store the basePrompt the description was authored from, and compare it
// with the catalogue's current one at read time. Equal is fresh; different is
// stale; NULL (every row written before this migration) is unknowable and
// treated as fresh, because guessing "stale" would flag all of them.
//
// A STALE DESCRIPTION IS STILL USED. That is the decision, and the reverse was
// tempting: ignore it and fall back to the template. But a description is a
// deliberate artefact -- authored by a model on purpose, or typed by a person
// in slice 4's editor -- and dropping it because someone edited a category
// would silently revert art direction nobody asked to revert. That is the same
// failure as using a stale one, only in the direction that loses work rather
// than the direction that is visible. Marked-and-used means the operator sees
// it, in the console and in `describe-subjects --stale`, and re-runs the ones
// that matter.

exports.up = (pgm) => {
  pgm.addColumn('art_prompt_descriptions', {
    source_prompt: {
      type: 'text',
      comment: "The catalogue's own subject phrase when this description was "
        + 'written. Differs from the current one => the description is stale.',
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('art_prompt_descriptions', 'source_prompt');
};
