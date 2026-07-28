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

export function biomeFormToPayload(form) {
  return {
    name: (form.name || '').trim(),
    terrain_tiles: names(form.terrain_tiles),
    flora_types: names(form.flora_types),
    creature_types: names(form.creature_types),
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
export function orderBiomeNames(selected, catalog) {
  const selectedSet = selected instanceof Set ? selected : new Set(selected || []);
  return (catalog || []).map((b) => b.name).filter((name) => selectedSet.has(name));
}
