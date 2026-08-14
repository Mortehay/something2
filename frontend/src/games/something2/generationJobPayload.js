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

// SOMET-331: the same contract, for the provider selector.
//
// `choice` is what the selector holds:
//
//   ''        "Default" -- follow whatever the Settings tab has active. Sends
//             NO provider key at all, so the request body is byte-identical to
//             what it was before this feature existed.
//   'local'   pin this one generation to the local sprite-gen service, even
//             though a remote provider is active.
//   <number>  pin it to that specific provider id.
//
// The default case MUST omit the key rather than send null or "": the backend
// treats an absent key as "no request-level override" and falls through to the
// type's own choice and then to the active provider. Sending an explicit null
// would still be an override in shape, and reviewers reading the request in
// devtools could not tell "unset" from "deliberately nothing" -- which is
// exactly the reasoning behind withOptionalBiome above.
export function withOptionalProvider(body, choice) {
  if (choice === 'local') return { ...body, ai_provider_local: true };
  const id = Number(choice);
  if (choice !== '' && choice !== null && choice !== undefined && Number.isInteger(id)) {
    return { ...body, ai_provider_id: id };
  }
  return { ...body };
}
