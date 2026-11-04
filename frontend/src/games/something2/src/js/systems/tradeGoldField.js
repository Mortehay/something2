// The trade window's gold field as a pure text reducer. Game owns the focus flag
// and the text; every key goes through here while the field has focus, so a digit
// typed into it never reaches a hotkey. The server stays the authority on the
// amount (it answers `invalid gold` / `not enough gold`).

// 15 digits stay below Number.MAX_SAFE_INTEGER, so the commit is always an exact integer.
export const GOLD_MAX_DIGITS = 15;

export function goldFromText(text) {
  const digits = String(text == null ? "" : text).replace(/\D/g, "");
  if (digits === "") return 0;
  const n = Number(digits.slice(0, GOLD_MAX_DIGITS));
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function collapse(text) {
  return text.replace(/^0+(?=\d)/, "");
}

// -> { text, commit: number|null, blur: boolean }
export function reduceGoldField(text, key) {
  const cur = String(text == null ? "" : text);
  if (key === "Enter") return { text: cur, commit: goldFromText(cur), blur: true };
  if (key === "Escape") return { text: cur, commit: null, blur: true };
  if (key === "Backspace") return { text: cur.slice(0, -1), commit: null, blur: false };
  if (typeof key === "string" && /^[0-9]$/.test(key)) {
    if (cur.length >= GOLD_MAX_DIGITS) return { text: cur, commit: null, blur: false };
    return { text: collapse(cur + key), commit: null, blur: false };
  }
  return { text: cur, commit: null, blur: false };
}
