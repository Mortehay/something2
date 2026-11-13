// Game-facing payload helpers over imageVariants: look up the serve map and
// swap catalog art keys for their web copies. A failing lookup never fails the
// endpoint -- it is logged and the originals are served.
const assetStore = require('./assetStore');
const imageVariants = require('./imageVariants.js');

const { webArt } = imageVariants;

async function serveMap(pool) {
  try {
    return await imageVariants.getServeMap(pool, assetStore);
  } catch (err) {
    console.error('web art serve map failed; serving originals:', err);
    return new Map();
  }
}

const wantsWeb = (req) => !!req && !!req.query && req.query.art === 'web';

// name -> def maps (tile / entity types).
function webArtMap(map, defs) {
  if (!map.size) return defs;
  const out = {};
  for (const [k, v] of Object.entries(defs)) out[k] = webArt(map, v);
  return out;
}

module.exports = { serveMap, wantsWeb, webArtMap, webArt };
