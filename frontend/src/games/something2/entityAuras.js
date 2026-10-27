// SOMET-604. entity_types.auras: null = never authored (the seeder may bind a
// behaviour default), [] = deliberately none (never re-bound by a reseed).
export function toggleAura(list, name) {
  const cur = Array.isArray(list) ? list : [];
  return cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name];
}
export function missingAuras(list, library) {
  if (!Array.isArray(list)) return [];
  const known = new Set((library || []).map((a) => a.name));
  return list.filter((n) => !known.has(n));
}
// Same as missingAuras, but empty while the library is still loading OR failed
// to load: an unavailable library would otherwise flag every binding and invite
// a Remove that wipes it on the next Save.
export function danglingAuras(list, library, isLoading, isError = false) {
  return isLoading || isError ? [] : missingAuras(list, library);
}
// The binding travels from the form state, never from the picker's library, so
// editing any other field (or a picker that never loaded) re-sends it as-is.
export function aurasForPayload(form) {
  return Array.isArray(form.auras) ? [...form.auras] : null;
}
