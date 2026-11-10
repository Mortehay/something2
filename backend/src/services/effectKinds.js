// The effect subject kinds the Sprite tab draws, and where each one's sprite lives: the table, its
// key column, the sprite columns an approve writes, and the box kind when the subject kind fixes it
// (vfx: null, derived from each row's shape). Every table / key / column choice by
// subject_kind goes through here. Pure data, no I/O.
'use strict';

const LOOPING_SPRITE_COLS = Object.freeze(['sprite_image', 'sprite_frames', 'sprite_additive', 'sprite_fps']);

const EFFECT_KINDS = Object.freeze({
  vfx: Object.freeze({
    table: 'vfx_effects', keyCol: 'name', updatedAt: false, boxKind: null,
    spriteCols: Object.freeze([...LOOPING_SPRITE_COLS, 'sprite_loop', 'sprite_stretch']),
  }),
  aura: Object.freeze({ table: 'aura_effects', keyCol: 'name', updatedAt: true, boxKind: 'aura', spriteCols: LOOPING_SPRITE_COLS }),
  buff: Object.freeze({ table: 'buff_visuals', keyCol: 'skill_id', updatedAt: true, boxKind: 'aura', spriteCols: LOOPING_SPRITE_COLS }),
});

const kindOf = (subjectKind) => (Object.prototype.hasOwnProperty.call(EFFECT_KINDS, subjectKind) ? EFFECT_KINDS[subjectKind] : null);

// An always-looping sheet (aura, buff): no sprite_loop / sprite_stretch columns.
const alwaysLoops = (subjectKind) => {
  const k = kindOf(subjectKind);
  return k != null && !k.spriteCols.includes('sprite_loop');
};

module.exports = { EFFECT_KINDS, kindOf, alwaysLoops };
