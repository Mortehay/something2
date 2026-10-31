// Player-facing display preferences, kept in localStorage. Pure helpers (the
// storage object is injected) so the rules are testable under vitest's node
// environment.
export const UI_PREFS_KEY = "s2-ui-prefs";

// minHealText: the largest heal that is still treated as passive regeneration
// and shown with NO floating number (0 = show every heal, 9999 = never show).
export const HEAL_TEXT_CHOICES = Object.freeze([
  { value: 0, label: "Show every heal" },
  { value: 5, label: "Hide up to 5 HP (default)" },
  { value: 15, label: "Hide up to 15 HP" },
  { value: 9999, label: "Never show heal numbers" },
]);

// Width in canvas pixels of the quest tracker card.
export const TRACKER_WIDTHS = Object.freeze([
  { value: 240, label: "Narrow" },
  { value: 300, label: "Normal (default)" },
  { value: 360, label: "Wide" },
]);

export const DEFAULT_UI_PREFS = Object.freeze({
  showLocationBanner: true,
  minHealText: 5,
  trackerWidth: 300,
});

const pick = (choices, value, fallback) => (choices.some((c) => c.value === value) ? value : fallback);

// Anything unknown or malformed falls back to the default, field by field, so a
// half-written or hand-edited value can never break the HUD.
export function normalizeUiPrefs(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    showLocationBanner: typeof r.showLocationBanner === "boolean" ? r.showLocationBanner : DEFAULT_UI_PREFS.showLocationBanner,
    minHealText: pick(HEAL_TEXT_CHOICES, r.minHealText, DEFAULT_UI_PREFS.minHealText),
    trackerWidth: pick(TRACKER_WIDTHS, r.trackerWidth, DEFAULT_UI_PREFS.trackerWidth),
  };
}

export function loadUiPrefs(storage = (typeof localStorage !== "undefined" ? localStorage : null)) {
  try {
    const text = storage && storage.getItem(UI_PREFS_KEY);
    return normalizeUiPrefs(text ? JSON.parse(text) : null);
  } catch {
    return normalizeUiPrefs(null);
  }
}

export function saveUiPrefs(prefs, storage = (typeof localStorage !== "undefined" ? localStorage : null)) {
  try {
    if (storage) storage.setItem(UI_PREFS_KEY, JSON.stringify(normalizeUiPrefs(prefs)));
  } catch {
    // storage blocked: the preference lives for this session only
  }
}

export function sameUiPrefs(a, b) {
  return !!a && !!b && a.showLocationBanner === b.showLocationBanner
    && a.minHealText === b.minHealText && a.trackerWidth === b.trackerWidth;
}
