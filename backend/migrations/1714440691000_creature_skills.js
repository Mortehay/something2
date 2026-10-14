exports.shorthands = undefined;

// SOMET-608 (S6). The creature SKILL catalog, plus the link table that binds
// skills onto a behaviour with a per-binding power_scale -- the same
// normalized-child-table shape `creature_abilities` already uses, and NOT
// `creature_behaviors.skills jsonb` as an earlier draft of the design doc
// floated. Two precedents rule that out: creature_abilities already proved
// the normalized shape for "a behaviour's repertoire", and
// 1714440681000_drop_behavior_auras.js already added-then-REVERTED a set of
// scalar columns directly on creature_behaviors for aura_effects specifically
// because a second source of truth was the bug. A link table keeps one FK,
// one CHECK-enforced power_scale range, and the same "unknown skill can't be
// bound" guarantee a jsonb array would leave unenforced.
//
// `slot` is PRIORITY order, exactly like creature_abilities.slot: selectSkill
// (authority/creatures.js) iterates a behaviour's skills in slot order and
// returns the first off-cooldown, in-range match. No backfill: zero existing
// creatures have a skill today, so this migration is additive only --
// nothing about the golden trace or any live creature changes.
exports.up = (pgm) => {
  pgm.createTable('creature_skills', {
    id: 'id',
    name: { type: 'text', notNull: true, unique: true },
    kind: { type: 'text', notNull: true },
    // 0 is a real value ("no warning at all" -- an instant slam); the spec's
    // own bound is 0..3000.
    telegraph_ms: { type: 'integer', notNull: true, default: 0 },
    cooldown_ms: { type: 'integer', notNull: true },
    // Area size (slam/nova) and cast range (how far the caster may be from
    // its target to use the skill at all) -- both 0 for a kind that has no
    // use for one (e.g. range is meaningless for a self-centred nova, which
    // always qualifies regardless of target distance).
    radius: { type: 'real', notNull: true, default: 0 },
    range: { type: 'real', notNull: true, default: 0 },
    damage_mult: { type: 'real', notNull: true, default: 1 },
    // NULL means "inherit the caster's own attack element" -- same
    // convention creature_abilities.element already uses, for the same
    // reason: a hard default here would silently strip a fire caster's
    // element off every skill that does not name its own.
    element: { type: 'text', notNull: false },
    // summon-only; NULL/1 for every other kind.
    summon_entity: { type: 'text', notNull: false },
    summon_count: { type: 'integer', notNull: true, default: 1 },
    // { telegraph, cast, impact } -> vfx_effects.name, same shape and the
    // same "unknown name is a no-op + one log" trade-off entity_types.vfx
    // already carries -- no FK, by design.
    vfx: { type: 'jsonb', notNull: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('creature_skills', 'creature_skills_kind_check',
    "CHECK (kind IN ('slam', 'nova', 'summon', 'projectile'))");
  pgm.addConstraint('creature_skills', 'creature_skills_telegraph_check',
    'CHECK (telegraph_ms BETWEEN 0 AND 3000)');
  pgm.addConstraint('creature_skills', 'creature_skills_cooldown_check',
    'CHECK (cooldown_ms > 0)');
  pgm.addConstraint('creature_skills', 'creature_skills_nonneg_check',
    'CHECK (radius >= 0 AND range >= 0 AND damage_mult >= 0)');
  pgm.addConstraint('creature_skills', 'creature_skills_summon_count_check',
    'CHECK (summon_count >= 1)');
  // Mirrors creature_abilities.element exactly (including 'arcane', widened
  // there by 1714440672000).
  pgm.addConstraint('creature_skills', 'creature_skills_element_check',
    "CHECK (element IS NULL OR element IN ('physical', 'arcane', 'fire', 'ice', 'lightning'))");

  pgm.createTable('creature_behavior_skills', {
    id: 'id',
    behavior_id: {
      type: 'integer', notNull: true, references: 'creature_behaviors', onDelete: 'CASCADE',
    },
    // RESTRICT, not CASCADE: deleting a catalog skill while a behaviour still
    // binds it should fail loudly (same "delete blocked while bound" rule
    // aura_effects already enforces), not silently unbind every creature
    // that used it.
    skill_id: {
      type: 'integer', notNull: true, references: 'creature_skills', onDelete: 'RESTRICT',
    },
    slot: { type: 'integer', notNull: true },
    power_scale: { type: 'real', notNull: true, default: 1 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('creature_behavior_skills', 'creature_behavior_skills_slot_unique',
    'UNIQUE (behavior_id, slot)');
  pgm.addConstraint('creature_behavior_skills', 'creature_behavior_skills_slot_check',
    'CHECK (slot >= 1)');
  pgm.addConstraint('creature_behavior_skills', 'creature_behavior_skills_scale_check',
    'CHECK (power_scale BETWEEN 0.1 AND 1.5)');
  pgm.createIndex('creature_behavior_skills', 'behavior_id');
  pgm.createIndex('creature_behavior_skills', 'skill_id');
};

exports.down = (pgm) => {
  pgm.dropTable('creature_behavior_skills');
  pgm.dropTable('creature_skills');
};
