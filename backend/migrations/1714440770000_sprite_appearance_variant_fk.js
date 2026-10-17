exports.shorthands = undefined;

// SOMET-629 rework: 1714440750000 gave sprite_sets.appearance_variant only a
// 1-5 CHECK, so a variant job could name an (entity, variant) pair with no
// character_appearances row -- approve would then UPDATE zero rows and mark
// the job approved anyway. The composite FK makes the pair real. A NULL
// variant (a plain entity job) is not checked, per MATCH SIMPLE. No ON DELETE
// action: character_appearances rows are never deleted while characters can
// still reference them (characters_appearance_fk is the same shape).
exports.up = (pgm) => {
  pgm.addConstraint('sprite_sets', 'sprite_sets_appearance_fk', {
    foreignKeys: {
      columns: ['entity_type_id', 'appearance_variant'],
      references: 'character_appearances(entity_type_id, variant)',
    },
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint('sprite_sets', 'sprite_sets_appearance_fk');
};
