// Interface language. The English text IS the key: `t("Inventory")` returns the
// Ukrainian entry for "Inventory" when the language is "uk", and the same English
// string otherwise (also when an entry is missing, so an untranslated string shows
// English instead of a blank). That keeps every call site readable and lets the
// canvas panels, the React UI and server-supplied names (quest titles, item names)
// share one mechanism.
//
//   t("Gold")                              -> "Золото"
//   t("Progress {done}/{total}", {done,total})
//   tn(3, ["{n} point", "{n} points"])     -> plural-aware, see tn()
//
// Language lives in localStorage and defaults to the browser's, falling back to
// English. The canvas redraws every frame, so a switch shows up immediately; React
// components re-render through useLang().
import { UK } from "./uk/index.js";
import { translatePattern } from "./patterns.js";

export const LANGS = [
  { code: "en", label: "English" },
  { code: "uk", label: "Українська" },
];
const DICTS = { uk: UK };
const LS_KEY = "something2.lang";

function storage() {
  try { return typeof localStorage !== "undefined" ? localStorage : null; } catch { return null; }
}

function detect() {
  const s = storage();
  let saved = null;
  try { saved = s && s.getItem(LS_KEY); } catch { /* blocked */ }
  if (saved && LANGS.some((l) => l.code === saved)) return saved;
  const nav = typeof navigator !== "undefined" && navigator.language ? String(navigator.language).toLowerCase() : "";
  return nav.startsWith("uk") ? "uk" : "en";
}

let lang = detect();
const listeners = new Set();

export function getLang() { return lang; }

export function setLang(next) {
  if (!LANGS.some((l) => l.code === next) || next === lang) return;
  lang = next;
  const s = storage();
  try { if (s) s.setItem(LS_KEY, next); } catch { /* blocked: just not persisted */ }
  for (const fn of [...listeners]) { try { fn(next); } catch { /* a bad listener must not break the others */ } }
}

export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function fill(text, params) {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, k) => (params[k] === undefined || params[k] === null ? m : String(params[k])));
}

// Translate an English string. Unknown strings and non-strings come back unchanged.
export function t(en, params) {
  if (typeof en !== "string") return en;
  const d = DICTS[lang];
  if (d && Object.prototype.hasOwnProperty.call(d, en)) return fill(d[en], params);
  // Names built from templates at runtime ("Sinew (STR)", "X Waypoint") that are not
  // listed one by one.
  if (d && !params) {
    const p = translatePattern(en);
    if (p) return p;
  }
  return fill(en, params);
}

// Plural form index for a count. English: one / other. Ukrainian: one (1, 21, ...),
// few (2-4, 22-24, ...), many (everything else).
export function pluralIndex(n, forLang = lang) {
  const a = Math.abs(Math.trunc(Number(n) || 0));
  if (forLang === "uk") {
    const m10 = a % 10;
    const m100 = a % 100;
    if (m10 === 1 && m100 !== 11) return 0;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 1;
    return 2;
  }
  return a === 1 ? 0 : 1;
}

// tn(count, [english-one, english-other]) -- the dictionary holds
// [one, few, many] under the English "one" string for Ukrainian:
//   UK["{n} point"] = ["{n} пункт", "{n} пункти", "{n} пунктів"]
export function tn(count, forms, params = {}) {
  const en = forms[pluralIndex(count, "en")] || forms[0];
  const d = DICTS[lang];
  const entry = d && Object.prototype.hasOwnProperty.call(d, forms[0]) ? d[forms[0]] : null;
  const text = Array.isArray(entry) ? (entry[pluralIndex(count, lang)] || entry[entry.length - 1]) : en;
  return fill(text, { n: count, ...params });
}

// For tests: is there a Ukrainian entry for this English string?
export function hasTranslation(en) {
  return Object.prototype.hasOwnProperty.call(UK, en);
}
