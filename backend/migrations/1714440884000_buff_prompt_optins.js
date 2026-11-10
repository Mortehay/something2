/* eslint-disable camelcase */
// Buff auras get Sprite-tab prompts like the other effects: a Sprite-tab write (regenerate / save)
// records an opt-in row, so sprite_prompt_optins.subject_kind must accept 'buff'.
exports.shorthands = undefined;

const KINDS_WITH_BUFF = "subject_kind IN ('entity', 'character_appearance', 'vfx', 'aura', 'buff')";
const KINDS_BEFORE = "subject_kind IN ('entity', 'character_appearance', 'vfx', 'aura')";

exports.up = (pgm) => {
  pgm.dropConstraint('sprite_prompt_optins', 'sprite_prompt_optins_subject_kind_check');
  pgm.addConstraint('sprite_prompt_optins', 'sprite_prompt_optins_subject_kind_check', { check: KINDS_WITH_BUFF });
};

exports.down = (pgm) => {
  pgm.sql("DELETE FROM sprite_prompt_optins WHERE subject_kind = 'buff'");
  pgm.dropConstraint('sprite_prompt_optins', 'sprite_prompt_optins_subject_kind_check');
  pgm.addConstraint('sprite_prompt_optins', 'sprite_prompt_optins_subject_kind_check', { check: KINDS_BEFORE });
};
