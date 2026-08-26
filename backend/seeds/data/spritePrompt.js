// The one definition of how an entity's prompt is styled.
//
// WHY IT LIVES HERE and not in the generation script: a prompt in the catalog
// should say what it will actually draw. When the styling was applied on the
// way out, every prompt in the admin UI read as a bare subject ("a mossy grey
// boulder") with no mention of pixel art or a transparent background, so
// nobody reading the catalog could tell what it produced -- and editing one in
// the UI silently dropped the part that made it work.
//
// THE WORDING IS MEASURED, and short on purpose. Each clause earns its place:
//
//   "pixel art"                     the style the whole game is drawn in
//   "single object"                 without it the model returns a TILESET of
//                                   the subject -- one pine tree becomes a
//                                   forest
//   "solid transparent background"  the service's own convention for an
//                                   isolated subject, and what makes the
//                                   backdrop flat enough for the cutout to key
//
// WHAT IS DELIBERATELY ABSENT, because it was tried and measured worse:
//
//   "isometric RPG game asset"  A/B tested on the same subject and seed. The
//                               prompt without it drew a clean isolated tree;
//                               the prompt with it drew a framed grey card
//                               with a tree on it, 94% of the frame opaque.
//                               The model reads "game asset" as "a picture of
//                               a game asset".
//   "no pot", "no person", ...  naming an exclusion ADDS it. "no pot, no
//                               planter" produced potted plants and "no
//                               person" produced a person; diffusion attends
//                               to the nouns, not the negation in front.
//
// Tile prompts are styled differently (seeds/data/tileTypes.js) because tiles
// are ground that fills a diamond, not a silhouette standing on one.
const ENTITY_STYLE = 'single object, solid transparent background';

// `pixel art` leads because the style applies to the whole image; the subject
// follows; the framing closes. Idempotent: a prompt that already carries the
// styling is returned unchanged, so re-running a backfill or re-seeding cannot
// stack it up.
function styleEntityPrompt(subject) {
  const base = String(subject || '').trim().replace(/,\s*$/, '');
  if (!base) return '';
  if (base.startsWith('pixel art,') && base.includes(ENTITY_STYLE)) return base;
  return `pixel art, ${base}, ${ENTITY_STYLE}`;
}

// The subject alone, for a UI that wants to show or edit just that.
function entitySubject(prompt) {
  const m = /^pixel art,\s*(.*?),\s*single object, solid transparent background$/.exec(
    String(prompt || '').trim(),
  );
  return m ? m[1] : String(prompt || '').trim();
}

module.exports = { ENTITY_STYLE, styleEntityPrompt, entitySubject };
