/* eslint-disable camelcase */
// Status visuals: how a timed status on a character draws, one row per (status_key, variant).
// Amber stance (characters arriving on a map are sealed in amber) has ten variants, drawn by the
// GPU box through the effect-sprite pipeline: effect_sprite_jobs and sprite_prompt_optins gain the
// 'status' subject kind so the Sprite tab can draw and prompt them.
//
// The effect pipeline addresses a subject by ONE key column, so subject_key is the row's
// `<status_key>_<variant>` (amber_stance_3), generated and unique. The seed is frozen:
// ('amber_stance', 1..10) with no sprite yet.
exports.shorthands = undefined;

const JOB_KINDS = "CHECK (subject_kind IN ('vfx','aura','buff','status'))";
const JOB_KINDS_BEFORE = "CHECK (subject_kind IN ('vfx','aura','buff'))";
const OPTIN_KINDS = "CHECK (subject_kind IN ('entity', 'character_appearance', 'vfx', 'aura', 'buff', 'status'))";
const OPTIN_KINDS_BEFORE = "CHECK (subject_kind IN ('entity', 'character_appearance', 'vfx', 'aura', 'buff'))";

exports.up = (pgm) => {
  pgm.sql(`CREATE TABLE status_visuals (
    status_key text NOT NULL,
    variant integer NOT NULL,
    subject_key text GENERATED ALWAYS AS (status_key || '_' || variant) STORED UNIQUE,
    sprite_image text,
    sprite_frames integer NOT NULL DEFAULT 1,
    sprite_additive boolean NOT NULL DEFAULT false,
    sprite_fps real,
    sync_uuid uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (status_key, variant)
  )`);
  // sync_uuid is deterministic per natural key (the plan-3 seed-sync recipe, key parts joined with '|'),
  // so every database agrees on the seeded rows' identity and the checked-in seed files match them.
  pgm.sql(`INSERT INTO status_visuals (status_key, variant, sync_uuid)
    SELECT 'amber_stance', v, md5('s2sync:status_visuals:amber_stance|' || v)::uuid FROM generate_series(1, 10) v`);

  pgm.dropConstraint('effect_sprite_jobs', 'effect_sprite_jobs_subject_kind_check');
  pgm.addConstraint('effect_sprite_jobs', 'effect_sprite_jobs_subject_kind_check', JOB_KINDS);
  pgm.dropConstraint('sprite_prompt_optins', 'sprite_prompt_optins_subject_kind_check');
  pgm.addConstraint('sprite_prompt_optins', 'sprite_prompt_optins_subject_kind_check', OPTIN_KINDS);
};

exports.down = (pgm) => {
  pgm.sql("DELETE FROM sprite_prompt_optins WHERE subject_kind = 'status'");
  pgm.dropConstraint('sprite_prompt_optins', 'sprite_prompt_optins_subject_kind_check');
  pgm.addConstraint('sprite_prompt_optins', 'sprite_prompt_optins_subject_kind_check', OPTIN_KINDS_BEFORE);
  pgm.sql("DELETE FROM effect_sprite_jobs WHERE subject_kind = 'status'");
  pgm.dropConstraint('effect_sprite_jobs', 'effect_sprite_jobs_subject_kind_check');
  pgm.addConstraint('effect_sprite_jobs', 'effect_sprite_jobs_subject_kind_check', JOB_KINDS_BEFORE);
  pgm.dropTable('status_visuals');
};
