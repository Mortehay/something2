/* eslint-disable camelcase */

// SOMET-551. A written description of a subject, replacing the template.
//
// WHY. catalogSubjects builds a subject's prompt from its name:
// `a ${deslug(name)}, a fantasy ${category}`. That produced "a darts, a fantasy
// weapon" and SDXL drew a DARTBOARD. Measured on 2026-09-06, a written
// description fixes the class of failure outright -- "Crushing Blow, a Warrior
// melee ability" drew a full warrior sprite, and "heavy war axe with a chipped
// blade" drew a usable icon.
//
// SEPARATE FROM art_prompt_notes, and the distinction is load-bearing. A
// DESCRIPTION is the base: what the thing IS. A NOTE is a correction layered on
// top: what the model got wrong last time. Merging them would lose the property
// that makes a correction survive re-authoring the base -- "no grey shadow"
// stays true no matter how the subject is described.
//
// A RE-RUN INSERTS AND DEACTIVATES, it does not overwrite. Same rule as
// art_prompt_notes and for the same reason: art_generations records the prompt
// that produced an image, and a description that was in force then must stay
// readable, or the history holds a prompt nobody can explain.
//
// `length` and `model` are recorded because they are the two things that make
// a description reproducible-ish and comparable. Neither is derivable later:
// the local model is pinned by nothing but an env var, and a re-run at a
// different length is a different artefact rather than a correction.

exports.up = (pgm) => {
  pgm.createTable('art_prompt_descriptions', {
    id: { type: 'bigserial', primaryKey: true },
    subject_kind: { type: 'text', notNull: true },
    subject_key: { type: 'text', notNull: true },
    text: { type: 'text', notNull: true },
    // 'short' | 'medium' | 'long' -- text rather than an enum so a new budget
    // is a constant in subjectDescriber, not a migration.
    length: { type: 'text' },
    // Which model wrote it. Null for a human-written one, which is the
    // difference worth being able to see.
    model: { type: 'text' },
    active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // The access pattern is "the active description for this subject", run on
  // every dispatch of that subject.
  pgm.createIndex('art_prompt_descriptions', ['subject_kind', 'subject_key'], {
    name: 'art_prompt_descriptions_subject_idx',
    where: 'active',
  });

  // At most one active description per subject. Enforced by the DATABASE
  // rather than by the insert-then-deactivate code path, because two
  // concurrent re-runs would otherwise leave two actives and the prompt would
  // depend on which row came back first.
  pgm.createIndex('art_prompt_descriptions', ['subject_kind', 'subject_key'], {
    name: 'art_prompt_descriptions_one_active',
    unique: true,
    where: 'active',
  });

  // SOMET-547 records which IMAGE model ran but had nowhere to record which
  // model wrote the PROMPT. Once descriptions are machine-written that gap
  // makes the history unable to explain its own prompts, so it closes here
  // rather than later.
  pgm.addColumn('art_generations', {
    prompt_model: {
      type: 'text',
      comment: 'The model that wrote the subject description, if one did.',
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('art_generations', 'prompt_model');
  pgm.dropTable('art_prompt_descriptions');
};
