// The prompt contract for an ISOLATED OBJECT, shared by every generator that
// draws one: entity textures, and the catalog art for items, skills and
// passive labels (SOMET-535/540).
//
// It lives in services rather than in scripts/ because services now need it
// too, and a service reaching up into a CLI script is the wrong direction.
// scripts/generate-entity-textures.js re-exports both names, so nothing that
// imported them from there had to change.

// The backdrop colour every entity is drawn against, and the one the cutout
// step keys out. Magenta rather than white, which is what sprite-gen asks for
// locally: white is a terrible chroma key here because the catalog is full of
// pale subjects -- ice boulders, bone, snow-covered rock, marble -- and keying
// white punches holes straight through them. Nothing in this catalog is
// naturally magenta.
//
// Changing this string means changing tools/cutout-entity-textures.py's
// expectation with it; they are one contract in two files.
const BACKDROP = 'flat solid magenta background';

// The backdrop for a provider that does its OWN cutout (request_template
// "cutout": true), where nothing downstream chroma-keys a colour.
//
// WHY THIS EXISTS -- measured 2026-09-04, and it invalidated a whole canary
// batch. "flat solid magenta background" does not merely describe the backdrop:
// SDXL bleeds it into the SUBJECT. Across 8 generated subjects spanning four
// kinds, 62-100% of every subject's saturated pixels came back magenta -- an
// archer, a medallion, a mushroom, a crossbow and two weapon skills, all the
// same colour. One came back as an empty magenta frame. Structurally perfect
// (single object, cleanly cut out, healthy transparency) and unusable, which is
// the "five trees" failure this epic keeps meeting.
//
// Same subjects, same seeds, backdrop wording as the only variable:
//
//   magenta   99 / 80 / 100 / 100 / 100 %   magenta pixels
//   white     39 / 19 /  12 /  45 /  99 %
//   none      43 / 32 /   4 /  19 /  n/a (one 422)
//
// White is safe HERE, though it would not be for chroma keying: the objection
// to white -- "it punches holes straight through pale subjects" -- is an
// objection to KEYING it. A provider doing real background removal has no such
// problem, and a pale grey helm came back intact. Keep magenta for the path
// that genuinely keys a colour.
const CUTOUT_BACKDROP = 'flat solid white background';

// Mirrors sprite-gen/app/prompts.py build_object_prompt in intent, not in
// wording. Two deliberate departures, both measured on this provider:
//
//   * "isolated on a solid white background" became the magenta backdrop
//     above, for the keying reason.
//   * "single ... object" alone was not enough -- SDXL with a pixel-art LoRA
//     answers a bare subject with a TILESET of that subject (a forest for one
//     pine tree). "one single" plus "centered" plus "nothing else in frame"
//     is what stops it, and the provider's negative prompt names the failure
//     modes as well.
function buildObjectPrompt(base, { backdrop = BACKDROP } = {}) {
  // "only X and nothing else" leads, and that word order is doing work. Asked
  // for "a single pine tree" this model returns a FOREST, and asked for an
  // object on a background it returns the object as framed art on a card --
  // it has been trained on asset sheets and gallery images, so the default
  // reading of any subject is "a picture of that subject". Naming the
  // exclusions first, before any styling, is what stops it.
  return `only ${base} and nothing else, one single object, centered, `
    + `${backdrop}, no frame, no border, no picture frame, no card, `
    + 'no ground, no floor, no shadow, no scenery, no other objects, '
    + 'pixel art RPG game asset, isometric 3/4 top-down view, crisp clean pixels, '
    + 'limited palette, sharp outline, cut out on a plain flat background';
}

module.exports = { BACKDROP, CUTOUT_BACKDROP, buildObjectPrompt };
