/* eslint-disable camelcase */

// Attack VFX slice D (SOMET-161): entity_types.vfx, and creature bindings.
//
// Deliberately deferred out of slice A, whose plan says the column "is
// pointless until something reads it". Slice D is what reads it: creature
// contact damage now stamps the same attack descriptor a player swing does
// (creatures.js's two _attackCd sites), so a wolf bite is an animated attack
// rather than an invisible HP drain.
//
// Same jsonb-with-no-FK trade-off item_types.vfx already made, and the same
// two mitigations: an unresolved name degrades to the kind default rather than
// throwing, and the admin screen (slice E) binds via a dropdown.

// Creature name -> bindings. Only the moments a creature can actually produce:
// contact damage is an attack and an impact. No `miss` -- a creature stamps
// its descriptor only once the hit has landed (see stampCreatureAttack), so a
// creature whiff is not an event that exists.
const CREATURE_VFX = {
  // Fast biters: a light, quick slash reads like teeth rather than a sword.
  Wolf: { attack: 'slash_light', impact: 'spark_hit' },
  Rat: { attack: 'slash_light', impact: 'spark_hit' },
  Bat: { attack: 'slash_light', impact: 'spark_hit' },
  Spider: { attack: 'slash_light', impact: 'spark_hit' },
  // Heavy hitters: the wide, slower arc.
  Bear: { attack: 'slash_heavy', impact: 'spark_hit' },
  Troll: { attack: 'slash_heavy', impact: 'spark_hit' },
  Ogre: { attack: 'slash_heavy', impact: 'spark_hit' },
  Golem: { attack: 'slash_heavy', impact: 'spark_hit' },
  // Elemental creatures tint their own impact rather than relying on the
  // effective-element tint, because creature contact damage is always
  // 'physical' at the damage site -- the colour has to come from the binding.
  'Fire Elemental': { attack: 'slash_heavy', impact: 'spark_fire' },
  'Ice Elemental': { attack: 'slash_heavy', impact: 'spark_ice' },
};

exports.up = (pgm) => {
  pgm.addColumn('entity_types', { vfx: { type: 'jsonb' } });

  for (const [name, bindings] of Object.entries(CREATURE_VFX)) {
    // Only touches rows that exist. A catalog without a given creature simply
    // gets no binding, and that creature falls to the `creature` kind default
    // -- visible, just not authored.
    pgm.sql(`
      UPDATE entity_types
         SET vfx = COALESCE(vfx, '{}'::jsonb) || '${JSON.stringify(bindings)}'::jsonb
       WHERE name = '${name.replace(/'/g, "''")}'
    `);
  }
};

exports.down = (pgm) => {
  pgm.dropColumn('entity_types', 'vfx');
};

module.exports.CREATURE_VFX = CREATURE_VFX;
