// Pure form <-> payload helpers for the Biomes admin tab. The component keeps
// the JSX; everything with a rule in it lives here so it can be unit-tested.
// Palette is edited as one comma-separated text field (it is prose fed to the
// image generator, not a checklist of catalog names).

const DEFAULT_COLOR = '#888888';

function names(v) {
  return Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()) : [];
}

export function emptyBiomeForm() {
  return {
    name: '', terrain_tiles: [], flora_types: [], creature_types: [],
    palette: '', art_style: '', exclusions: '', color: DEFAULT_COLOR,
  };
}

export function biomeToForm(row) {
  return {
    name: row?.name || '',
    terrain_tiles: names(row?.terrain_tiles),
    flora_types: names(row?.flora_types),
    creature_types: names(row?.creature_types),
    palette: names(row?.palette).join(', '),
    art_style: row?.art_style || '',
    exclusions: row?.exclusions || '',
    color: row?.color || DEFAULT_COLOR,
  };
}

// `catalogs` carries the three name catalogs (tile types, flora entity
// types, creature entity types) that terrain_tiles/flora_types/creature_types
// are each drawn from, so their orderBiomeNames() call below can order the
// payload by CATALOG order instead of checkbox click order -- see
// orderBiomeNames for why click order is dangerous here. Optional and
// defaulted to {} so existing callers/tests that don't care about ordering
// (e.g. a freshly round-tripped form with no reordering pressure) keep
// working: orderBiomeNames' own empty-catalog fallback then preserves the
// form's array order as-is.
export function biomeFormToPayload(form, catalogs = {}) {
  const { tileNames, floraNames, creatureNames } = catalogs;
  return {
    name: (form.name || '').trim(),
    terrain_tiles: orderBiomeNames(names(form.terrain_tiles), tileNames),
    flora_types: orderBiomeNames(names(form.flora_types), floraNames),
    creature_types: orderBiomeNames(names(form.creature_types), creatureNames),
    palette: names((form.palette || '').split(',')),
    art_style: form.art_style || '',
    exclusions: form.exclusions || '',
    color: form.color || DEFAULT_COLOR,
  };
}

// Orders a set of selected biome names by the biome CATALOG's own order (the
// order GET /api/biomes returns them in, ORDER BY id ASC) rather than by
// checkbox click order. worlds.biomes is order-sensitive on the backend --
// biome i owns noise band i, and PUT /api/worlds/:id detects a real change
// with an order-sensitive JSON.stringify comparison. A JS Set's iteration
// order moves an entry to the end on delete+re-add, so building the payload
// from `[...selectedSet]` makes an uncheck-then-recheck of the exact same
// biomes look like an order change and silently wipes that world's cached
// terrain. Deriving the payload from the catalog's order instead makes
// toggling idempotent: selecting the same names, in any click sequence,
// always yields the same array.
//
// An EMPTY catalog array is ambiguous: it means either "the catalog really
// has zero biomes" or "the /api/biomes query hasn't resolved yet" (useBiomes
// defaults to [] while loading -- there is no `undefined` state visible
// here). Filtering the selection against an empty catalog in either case
// would collapse a real, non-empty selection down to [], which is exactly
// the false "this world now has zero biomes" signal that trips the
// backend's order-sensitive diff and wipes the world's cached terrain --
// the same failure mode this helper exists to prevent, just triggered by a
// load-timing window instead of click order. So when the catalog can't be
// used to order/filter (empty or missing), the selection is preserved
// as-is rather than discarded; losing the ordering guarantee for one rare
// save is a far smaller harm than silently erasing the world's biomes.
// Dropping a name that is genuinely absent from a NON-empty, loaded catalog
// is still correct and unchanged.
// `catalog` entries may be either plain name strings (tile-types/entity-types
// catalogs, as consumed by BiomesAdmin) or `{ name }` records (the biome
// catalog itself, as consumed by MapsAdmin) -- both shapes are used to order
// a biome/world's own name selections against a wider catalog's own order.
export function orderBiomeNames(selected, catalog) {
  const selectedSet = selected instanceof Set ? selected : new Set(selected || []);
  const catalogArr = Array.isArray(catalog) ? catalog : [];
  if (catalogArr.length === 0) return [...selectedSet];
  return catalogArr
    .map((b) => (typeof b === 'string' ? b : b?.name))
    .filter((name) => selectedSet.has(name));
}
