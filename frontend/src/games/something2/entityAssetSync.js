// The rule that stops an open Edit Entity form from undoing an approval.
//
// Approving a generated image or animation rewrites render_mode + image (and
// clears sprite) SERVER-SIDE while the form is open. The form was populated
// from the row as it looked when the modal opened, so without pulling those
// two fields back in, pressing Save Changes afterwards writes the pre-approval
// values over the approval -- the entity silently reverts, usually to a
// coloured rectangle, and both requests answer 200 so nothing reports it.
//
// This lived inline in EntityTypesAdmin's effect, where nothing could test it:
// vitest runs in a node environment here with no DOM, so a component effect is
// unreachable from the suite. Deleting it left all 1590 tests green -- measured,
// not assumed. It is the only thing preventing that data loss, and the tile
// editor shipped the same bug for real, so it gets a seam and a test.
//
// Returns `prev` UNCHANGED (same reference) when nothing differs. That is not a
// micro-optimisation: this runs in an effect that calls setFormData, and
// returning a fresh object every time would re-render, re-run the effect and
// loop.
export function syncApprovedAsset(prev, live) {
  if (!prev || !live) return prev;
  // The server's own defaults for "no override": an entity with no image
  // renders as a coloured rect, and the form holds '' rather than null.
  const render_mode = live.render_mode || 'rect';
  const image = live.image || '';
  if (prev.render_mode === render_mode && prev.image === image) return prev;
  return { ...prev, render_mode, image };
}
