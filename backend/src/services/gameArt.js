// The icon index the GAME reads (SOMET-598).
//
// Generated icons for skills and passive labels live in catalog_art; item
// icons live in item_types.icon. The Art console reads both through admin-only
// routes, so until this existed the game had no way to learn a single key and
// drew emoji, plain circles and initials over 700 finished images.
//
// This is only the POINTER index -- object-store keys, never bytes. The images
// themselves still load from the public /api/assets/* route, one at a time and
// only when a surface actually asks for one (see the client's systems/gameArt.js).
//
// Shape: { skill: { <skill id>: {image, v} }, passive_label: { <label>: ... },
//          item: { <item type id>: ... } }
// `v` is a cache-busting version (catalog_art.updated_at) or null: item_types
// has no updated_at, and seeded item keys are stable, so a FORCE re-seed of an
// item icon can take up to /api/assets' max-age (300 s) to show.

const GAME_ART_KINDS = ['skill', 'passive_label'];

// A row with a blank key is "no art", not an entry pointing at nothing -- the
// client would otherwise request /api/assets/ and log a 404 per surface.
function hasKey(image) {
  return typeof image === 'string' && image.trim() !== '';
}

function versionOf(updatedAt) {
  if (updatedAt == null) return null;
  const d = updatedAt instanceof Date ? updatedAt : new Date(updatedAt);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function buildGameArtIndex(artRows, itemRows) {
  const index = { skill: {}, passive_label: {}, item: {} };
  for (const r of artRows || []) {
    if (!GAME_ART_KINDS.includes(r.subject_kind) || !hasKey(r.image)) continue;
    index[r.subject_kind][r.subject_key] = { image: r.image, v: versionOf(r.updated_at) };
  }
  for (const r of itemRows || []) {
    if (!hasKey(r.icon)) continue;
    index.item[r.id] = { image: r.icon, v: null };
  }
  return index;
}

async function loadGameArtIndex(pool) {
  const [art, items] = await Promise.all([
    pool.query(
      `SELECT subject_kind, subject_key, image, updated_at
       FROM catalog_art WHERE subject_kind = ANY($1::text[])`,
      [GAME_ART_KINDS],
    ),
    pool.query(`SELECT id, icon FROM item_types`),
  ]);
  return buildGameArtIndex(art.rows, items.rows);
}

module.exports = { buildGameArtIndex, loadGameArtIndex, GAME_ART_KINDS };
