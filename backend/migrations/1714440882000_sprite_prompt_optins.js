/* eslint-disable camelcase */
// Sprite-tab prompt opt-in, made explicit so it travels with seed sync.
//
// The sprite lane follows a creature / appearance description only once that
// subject has been opted in from the Sprite tab (regenerate, prompt edit, or a
// batch prompt phase). That used to be derived from "has EVER had an
// art_prompt_descriptions row with origin = 'sprite'", but seed sync carries
// only the ACTIVE description, so an opted-in subject whose active description
// came from the art console (or that was reverted) lost its opt-in on import.
// One row per opted-in subject; never deleted by the app (opt-in never ends,
// Revert included).
//
// sync_uuid is deterministic per natural key (same recipe as the plan-3 seed
// sync tables) so two PCs that opt in the same subject agree on its identity.
// A BEFORE INSERT trigger fills it; an explicit one (seed sync) is kept.
exports.shorthands = undefined;

const UUID_OF = (alias) => `md5('s2sync:sprite_prompt_optins:' || ${alias}.subject_kind || '|' || ${alias}.subject_key)::uuid`;

exports.up = (pgm) => {
  pgm.createTable('sprite_prompt_optins', {
    subject_kind: { type: 'text', notNull: true },
    subject_key: { type: 'text', notNull: true },
    sync_uuid: { type: 'uuid', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('sprite_prompt_optins', 'sprite_prompt_optins_pkey', { primaryKey: ['subject_kind', 'subject_key'] });
  pgm.addConstraint('sprite_prompt_optins', 'sprite_prompt_optins_sync_uuid_key', { unique: ['sync_uuid'] });
  pgm.addConstraint('sprite_prompt_optins', 'sprite_prompt_optins_subject_kind_check', {
    check: "subject_kind IN ('entity', 'character_appearance', 'vfx', 'aura')",
  });
  pgm.sql(`CREATE FUNCTION sprite_prompt_optins_sync_uuid_fill() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN
      IF NEW.sync_uuid IS NULL THEN NEW.sync_uuid := ${UUID_OF('NEW')}; END IF;
      RETURN NEW;
    END
  $f$`);
  pgm.sql(`CREATE TRIGGER sprite_prompt_optins_sync_uuid_fill BEFORE INSERT ON sprite_prompt_optins
    FOR EACH ROW EXECUTE FUNCTION sprite_prompt_optins_sync_uuid_fill()`);
  // Backfill: every subject that has ever had a Sprite-tab version.
  pgm.sql(`INSERT INTO sprite_prompt_optins (subject_kind, subject_key)
    SELECT DISTINCT subject_kind, subject_key FROM art_prompt_descriptions
     WHERE origin = 'sprite' AND subject_kind IN ('entity', 'character_appearance', 'vfx', 'aura')
    ON CONFLICT DO NOTHING`);
};

exports.down = (pgm) => {
  pgm.dropTable('sprite_prompt_optins');
  pgm.sql('DROP FUNCTION IF EXISTS sprite_prompt_optins_sync_uuid_fill()');
};
