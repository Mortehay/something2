/* eslint-disable camelcase */

// Attack VFX slice B (SOMET-159): the full shape vocabulary in DATA.
//
// Slice A shipped the table, one effect ('sweep_arc') and one binding. This
// adds the rest of the library and binds all 22 weapons, so every weapon reads
// as itself rather than as "some melee thing".
//
// NO SCHEMA CHANGE. Slice A deliberately CHECK-constrained `shape` to the full
// enum ('arc','line','ring','burst','bolt') even though it only drew arcs, so
// widening the vocabulary is inserts and updates only. The particle_* columns
// are still slice C's.
//
// WHY SO FEW ROWS FOR SO MANY WEAPONS: `follows_weapon` effects take their
// geometry from the weapon itself, and the weapons genuinely differ -- reach
// runs 70..200 and arc_width 0.5..2.0. A knife (70 / 0.5) and a halberd
// (190 / 1.8) sharing `slash_light` still draw visibly different swings. One
// row per weapon would be 22 rows to maintain that mostly say the same thing.

// [name, shape, color, width, duration_ms, ease, fade, follows_weapon]
const EFFECTS = [
  // --- kind-level defaults. These are the fallback targets in
  // authority/vfx.js's KIND_DEFAULTS, and they exist so a weapon added later
  // with NO binding renders plain-but-visible. Invisible would look exactly
  // like the bug this epic was filed to fix.
  ['generic_slash', 'arc', '#d8d8e0', 2, 180, 'out', true, true],
  ['generic_bolt', 'bolt', '#cfd8ff', 3, 220, 'linear', true, true],
  // The whiff is deliberately faint, fast and NOT following the weapon: a miss
  // should read as "the swing happened and touched nothing", not as a second
  // kind of hit. Short reach keeps it close to the body.
  ['generic_whiff', 'arc', '#8a8a99', 1, 140, 'out', true, false],

  // --- melee families
  ['slash_light', 'arc', '#eaeaf2', 2, 150, 'out', true, true],
  ['slash_heavy', 'arc', '#ffd9a0', 3, 260, 'out', true, true],
  ['thrust', 'line', '#e6e6ef', 3, 170, 'out', true, true],

  // --- projectile families. Bound now, drawn when slice D replaces the 6px
  // dot with trails; the binding is the data that slice reads.
  ['shot_arrow', 'bolt', '#e8e2c8', 2, 240, 'linear', true, true],
  ['shot_stone', 'bolt', '#b9b9b9', 2, 200, 'linear', true, true],
  ['bolt_arcane', 'bolt', '#c08cff', 3, 260, 'linear', true, true],
  ['bolt_fire', 'bolt', '#ff9a4d', 3, 260, 'linear', true, true],
  ['bolt_ice', 'bolt', '#8fdcff', 3, 260, 'linear', true, true],
  ['bolt_storm', 'bolt', '#ffe66b', 3, 220, 'linear', true, true],
];

// weapon name -> bindings. Every one of the 22 weapons in the catalog appears
// here exactly once; a test asserts that, so a weapon added later without a
// binding is visible as a gap rather than silently falling to the default.
//
// `miss` is bound on melee only: a projectile weapon cannot whiff at the
// moment of firing -- the shot leaves regardless and its hit is resolved later
// in flight -- so binding one would be dead data.
const BINDINGS = {
  // light and fast
  knife: { attack: 'slash_light', miss: 'generic_whiff' },
  dagger: { attack: 'slash_light', miss: 'generic_whiff' },
  stick: { attack: 'slash_light', miss: 'generic_whiff' },
  club: { attack: 'slash_light', miss: 'generic_whiff' },
  // mid weight
  'short sword': { attack: 'sweep_arc', miss: 'generic_whiff' },
  'long sword': { attack: 'sweep_arc', miss: 'generic_whiff' },
  'mid club': { attack: 'sweep_arc', miss: 'generic_whiff' },
  // heavy, wide
  halberd: { attack: 'slash_heavy', miss: 'generic_whiff' },
  scythe: { attack: 'slash_heavy', miss: 'generic_whiff' },
  'two-handed sword': { attack: 'slash_heavy', miss: 'generic_whiff' },
  'morning star': { attack: 'slash_heavy', miss: 'generic_whiff' },
  // the one true thrust: reach 200 with arc_width 0.5 is a spear, not a swing,
  // and the `line` shape is what makes it read that way.
  pike: { attack: 'thrust', miss: 'generic_whiff' },

  // projectiles: `trail` is what slice D consumes.
  bow: { attack: 'shot_arrow', trail: 'shot_arrow' },
  arbalest: { attack: 'shot_arrow', trail: 'shot_arrow' },
  sling: { attack: 'shot_stone', trail: 'shot_stone' },
  darts: { attack: 'shot_stone', trail: 'shot_stone' },
  'apprentice staff': { attack: 'bolt_arcane', trail: 'bolt_arcane' },
  'archmage staff': { attack: 'bolt_arcane', trail: 'bolt_arcane' },
  'magic-bolt': { attack: 'bolt_arcane', trail: 'bolt_arcane' },
  'flame staff': { attack: 'bolt_fire', trail: 'bolt_fire' },
  'frost staff': { attack: 'bolt_ice', trail: 'bolt_ice' },
  'storm staff': { attack: 'bolt_storm', trail: 'bolt_storm' },
};

exports.up = (pgm) => {
  for (const [name, shape, color, width, duration_ms, ease, fade, follows_weapon] of EFFECTS) {
    // ON CONFLICT so a re-run (or a database that already has a hand-authored
    // row of the same name) is a no-op rather than a unique violation.
    pgm.sql(`
      INSERT INTO vfx_effects (name, shape, color, width, duration_ms, ease, fade, follows_weapon)
      VALUES ('${name}', '${shape}', '${color}', ${width}, ${duration_ms},
              '${ease}', ${fade}, ${follows_weapon})
      ON CONFLICT (name) DO NOTHING
    `);
  }

  // Bindings are written with jsonb concatenation rather than assignment, so a
  // weapon that already carries an unrelated moment (slice A bound `attack` on
  // every melee weapon) keeps it and simply has these keys overlaid.
  for (const [weapon, bindings] of Object.entries(BINDINGS)) {
    pgm.sql(`
      UPDATE item_types
         SET vfx = COALESCE(vfx, '{}'::jsonb) || '${JSON.stringify(bindings)}'::jsonb
       WHERE name = '${weapon.replace(/'/g, "''")}' AND category = 'weapon'
    `);
  }
};

exports.down = (pgm) => {
  // Strip only the keys this migration set, then drop the rows it added.
  // Deliberately NOT `SET vfx = NULL`: slice A's own binding lives in the same
  // column, and down() must not take it with us.
  for (const [weapon, bindings] of Object.entries(BINDINGS)) {
    const keys = Object.keys(bindings).map((k) => `'${k}'`).join(', ');
    pgm.sql(`
      UPDATE item_types SET vfx = vfx - ARRAY[${keys}]
       WHERE name = '${weapon.replace(/'/g, "''")}' AND category = 'weapon' AND vfx IS NOT NULL
    `);
  }
  const names = EFFECTS.map(([n]) => `'${n}'`).join(', ');
  pgm.sql(`DELETE FROM vfx_effects WHERE name IN (${names})`);
};

module.exports.EFFECTS = EFFECTS;
module.exports.BINDINGS = BINDINGS;
