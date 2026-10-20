// SOMET-644 Task 6. The model behind the Generated Worlds tab's local
// fallback: when the GPU box cannot be reached, the admin generates a region
// on this PC with the backend's JS port of the box's rules generator
// (POST /api/world-gen/local/preview and /save). Pure, so it is testable
// without a DOM.

export const LOCAL_BANNER =
  'GPU box unreachable — generate locally (rules only: no LLM biome choice, no preview image)';

// The WorldGenError codes that mean "there is no box to talk to". An auth
// failure is NOT one: the box answered, the token is wrong, and generating
// locally would hide a fixable setup problem.
const BOX_DOWN = new Set(['unreachable', 'not_configured']);
export const isBoxDown = (err) => Boolean(err && BOX_DOWN.has(err.code));

// Numbers as numbers; anything that does not parse is sent as typed, so the
// server's 400 names the field instead of a silent default replacing it.
// `theme` is dropped: there is no LLM locally.
const asNumber = (v) => {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').trim();
  if (s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : v;
};
export function localRequestBody(form) {
  return {
    name: String(form.name ?? '').trim(),
    worlds: asNumber(form.worlds),
    target_per_screen: asNumber(form.target_per_screen),
    size: asNumber(form.size),
    chunk_size: asNumber(form.chunk_size),
    biome_cell: asNumber(form.biome_cell),
  };
}

// The generator's report, with problems and caveats kept apart: problems gate
// `ok`, caveats never do.
export function reportVerdict(report) {
  if (!report) return { ok: false, problems: [], caveats: [], totals: null };
  return {
    ok: report.ok === true,
    problems: Array.isArray(report.problems) ? report.problems : [],
    caveats: Array.isArray(report.caveats) ? report.caveats : [],
    totals: report.totals || null,
  };
}

// What a save error means for the UI: a 409 (`exists`) asks the admin to
// confirm the overwrite; anything else -- including the 409s `synced` and
// `authored`, which no overwrite can get past -- is a failure to show.
export function saveOutcome(err) {
  if (!err) return null;
  return err.code === 'exists' ? 'confirm_overwrite' : 'failed';
}

// Whether the local fallback is shown. LATCHED: once shown it stays shown --
// a focus refetch that clears the list error (the box blipped back) must not
// unmount a preview the admin is about to save. Only a reload or the explicit
// "Back to GPU box" action releases it.
//
// `dismissed` is what makes Back work. Back releases the latch and refetches,
// but react-query keeps the OLD list error until that refetch settles, so
// without it the stale error would reopen (and re-latch) the fallback on the
// very next render. While dismissed, the list-error trigger is suppressed;
// the caller clears `dismissed` when the refetch settles, so a refetch that
// still fails with a box-down error shows the fallback again, and one that
// succeeds leaves it closed.
export function showLocalFallback(latched, {
  regionsError = null, createDown = false, dismissed = false,
} = {}) {
  if (latched || createDown) return true;
  return !dismissed && isBoxDown(regionsError);
}
