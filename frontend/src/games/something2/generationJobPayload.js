// Pure payload helper shared by TileTypesAdmin's and EntityTypesAdmin's texture/
// animation generation panels (D2/SOMET post-verify). Both post to a
// startGenerationJob-backed route (backend/src/index.js) that composes an
// OPTIONAL biome's palette/art-style/exclusions into the base prompt when the
// request body carries a `biome` key. The selector in each panel defaults to
// "— none —", and that case must send NO `biome` key at all (not `biome: ""`
// or `biome: null`) so today's behaviour is preserved byte-for-byte when no
// biome is chosen.
export function withOptionalBiome(body, biomeName) {
  return biomeName ? { ...body, biome: biomeName } : { ...body };
}
