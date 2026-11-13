'use strict';
// Which catalog columns hold game images, and the shrink preset of each kind.
// Built from the seed registry's art group, so an art column added there is
// listed by the Images tab without a change here (it gets a generic kind).

const { getGroup } = require('./seedSync/registry.js');
const { GAME_ART_KINDS } = require('./gameArt.js');

// Effect strips: one row of equal frames, frame count in the row's sprite_frames.
const STRIP_TABLES = new Set(['vfx_effects', 'aura_effects', 'buff_visuals', 'status_visuals']);
// Tables in the art group that are not game images (the web copies themselves).
const NOT_GAME_ART = new Set(['image_variants']);
const TABLE_KIND = {
  entity_types: 'entity',
  tile_types: 'tile',
  character_appearances: 'appearance',
  item_types: 'item',
  catalog_art: 'art', // expanded per row to art:<subject_kind> (listImages)
};

function kindOf(table, column, assetType) {
  if (STRIP_TABLES.has(table) && column === 'sprite_image') return `effect:${table}`;
  const base = TABLE_KIND[table] || table;
  return assetType === 'sprite' ? `${base}_sheet` : base;
}

function imageColumns() {
  const out = [];
  for (const spec of getGroup('art').tables) {
    if (NOT_GAME_ART.has(spec.table)) continue;
    for (const [column, a] of Object.entries(spec.assets || {})) {
      if (a.type !== 'image' && a.type !== 'sprite') continue;
      out.push({
        table: spec.table,
        column,
        assetType: a.type,
        strip: STRIP_TABLES.has(spec.table) && column === 'sprite_image',
        kind: kindOf(spec.table, column, a.type),
      });
    }
  }
  return out;
}

const QUALITY = 85;
const MAX_EDGE = { entity: 256, tile: 256, appearance: 384, item: 128 };
const GENERIC_MAX_EDGE = 256;

function isSheetKind(kind) {
  return kind.endsWith('_sheet') || kind.startsWith('effect:');
}

// Sheets and strips: scale 1.0 (format only). Single images: longest edge.
function defaultParams(kind) {
  if (isSheetKind(kind)) return { scale: 1, quality: QUALITY };
  if (kind.startsWith('art:')) {
    return { maxEdge: GAME_ART_KINDS.includes(kind.slice(4)) ? 128 : 256, quality: QUALITY };
  }
  return { maxEdge: MAX_EDGE[kind] || GENERIC_MAX_EDGE, quality: QUALITY };
}

module.exports = { imageColumns, defaultParams, isSheetKind };
