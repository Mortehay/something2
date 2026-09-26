// World point kinds (SOMET-577). A "world point" is a fixed tile the sim
// already knows about -- a portal tile in map_links, a waypoint row, a
// village post, a chest -- and this catalog is what lets one carry an image
// or sprite. Read by THREE consumers that must never disagree:
//   - migrations/1714440547000_world_point_kinds.js seeds POINT_KINDS once
//   - scripts/seed-catalogs.js upserts POINT_TYPES and fills kind defaults
//   - tests/map_spec_fixtures.test.js validates `art:` names in the real
//     specs against POINT_TYPES, the same way it validates creature names
//     against seeds/data/entityTypes.js
//
// One placeholder row per kind, with NO art: render_mode 'rect' so the
// renderer keeps drawing today's shape until an admin approves an image
// (agents cannot generate images -- see memory "sprites epic"). spawn_tiles
// MUST stay [] -- loadDecorationDefs treats any non-empty list as "scatter
// me across the map".
const { styleEntityPrompt } = require('./spritePrompt.js');

const POINT_KINDS = [
  'portal', 'waypoint', 'merchant', 'bank', 'gem_merchant', 'skill_merchant',
  'chest_vault', 'chest_field',
];

// The four posts that hang off ONE villages row (fetchVillages derives the
// last three from merchant_x/merchant_y). Order matters nowhere; the column
// mapping does.
const VILLAGE_POST_KINDS = ['merchant', 'bank', 'gem_merchant', 'skill_merchant'];

function villageArtColumn(kind) {
  if (!VILLAGE_POST_KINDS.includes(kind)) throw new Error(`${kind} is not a village post kind`);
  return `${kind}_entity_type_id`;
}

function pointType(name, point_kind, color, display_width, display_height, subject) {
  return {
    name, point_kind, color, display_width, display_height,
    is_creature: false, walkable: true, render_mode: 'rect', spawn_tiles: [], chance: 0,
    prompt: styleEntityPrompt(subject),
  };
}

const POINT_TYPES = [
  pointType('portal',              'portal',         '#f472b6', 110, 130, 'a glowing swirling magical stone portal archway'),
  pointType('waypoint_stone',      'waypoint',       '#7dd3fc',  70,  90, 'an ancient carved waystone with glowing blue runes'),
  pointType('merchant_post',       'merchant',       '#c084fc',  80, 100, 'a wooden market stall with a striped awning and goods on the counter'),
  pointType('bank_post',           'bank',           '#c084fc',  80, 100, 'a sturdy iron-bound strongbox on a stone pedestal'),
  pointType('gem_merchant_post',   'gem_merchant',   '#c084fc',  80, 100, 'a jeweller\'s stall with a velvet tray of glowing gems'),
  pointType('skill_merchant_post', 'skill_merchant', '#c084fc',  80, 100, 'a scholar\'s lectern stacked with open spellbooks and scrolls'),
  pointType('chest_vault',         'chest_vault',    '#e0b64e',  70,  60, 'an ornate gilded treasure chest with heavy iron bands'),
  pointType('chest_field',         'chest_field',    '#8a8f98',  60,  50, 'a small weathered wooden chest half sunk in grass'),
];

module.exports = { POINT_KINDS, POINT_TYPES, VILLAGE_POST_KINDS, villageArtColumn };
