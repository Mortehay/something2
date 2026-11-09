// The pure rules behind the in-game Settings panel (GameSettings.jsx): which saved preference to push
// to the game, how a pressed key becomes a binding, and what a new binding displaces. Plain
// functions so they are testable in the node vitest env (the panel itself is not renderable there).

// ---- preferences the SERVER owns but the player chose --------------------------------------------

// A three-way saved preference: true / false once the player has chosen, null before (follow the
// game's default). Stored as '1' / '0'.
export function readChoice(storage, key) {
  try {
    const v = storage ? storage.getItem(key) : null;
    return v === "1" ? true : v === "0" ? false : null;
  } catch {
    return null;
  }
}

export function writeChoice(storage, key, on) {
  try {
    if (storage) storage.setItem(key, on ? "1" : "0");
  } catch {
    // storage blocked: the choice lives for this session only
  }
}

// What to send to the game right now so its auto-loot matches what the player chose, or null for
// "nothing to do". The server starts every character in every world with auto-loot OFF (it is a
// per-world player flag, not saved), so a switch to another location -- a fresh join -- used to turn
// it off. The panel owns the choice and re-applies it whenever the game reports a different value.
//   snapshot  Game#getSettingsSnapshot() ({ autoLoot, ... }) or null while no world is up
//   wanted    the saved choice (true / false / null)
export function autoLootToApply(snapshot, wanted) {
  if (!snapshot || typeof wanted !== "boolean") return null;
  return snapshot.autoLoot === wanted ? null : wanted;
}

// ---- key capture -----------------------------------------------------------------------------------

// Keys that are only a modifier (or an input-method artefact): pressing one while the panel waits
// for a binding must not become the binding -- Shift is the sprint key, and a Ctrl pressed on the
// way to something else is not a choice.
const IGNORED_KEYS = new Set([
  "shift", "control", "alt", "altgraph", "meta", "os", "capslock", "numlock", "scrolllock",
  "dead", "process", "unidentified", "compose", "fn", "fnlock", "hyper", "super",
]);

// A pressed key as a binding string, or null to keep waiting. Letters and digits are taken from the
// PHYSICAL key (event.code), not the character it produced: with a Ukrainian layout active, the key
// labelled I yields "ш", and a binding of "ш" would silently stop working the moment the player
// switched layouts. Everything else is what the key reads (arrows, punctuation, function keys).
export function keyFromEvent(e) {
  if (!e) return null;
  const raw = String(e.key == null ? "" : e.key).toLowerCase();
  if (IGNORED_KEYS.has(raw)) return null;
  const code = typeof e.code === "string" ? e.code : "";
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (raw === " " || raw === "spacebar") return "space";
  return raw === "" ? null : raw;
}

// A mouse button as a binding string (the panel's own mouse capture).
export function mouseBinding(button) {
  const map = { 0: "mouse1", 1: "mouse3", 2: "mouse2", 3: "mouse4", 4: "mouse5" };
  return map[button] || `mouse${Number(button) + 1}`;
}

const LMB_NAMES = new Set(["mouse1", "lmb", "left", "left click"]);
export function isLeftMouse(bound) {
  return LMB_NAMES.has(String(bound == null ? "" : bound).toLowerCase().trim());
}

const norm = (b) => String(b == null ? "" : b).toLowerCase().trim();

// Put `bound` on `action`. Returns { binds, displaced, refused }:
//   * the left mouse button is the attack / interact button and is refused for EVERY action (it used
//     to be refused only for the hotbar slots, so binding it to, say, Pick Up made every attack
//     click pick things up);
//   * a key another action already uses is taken from that action (left unbound) and reported in
//     `displaced`, instead of two actions silently answering the same key.
// `binds` is a new object; the input is never mutated.
export function assignKeybind(binds, action, bound) {
  const key = norm(bound);
  if (!key) return { binds: { ...binds }, displaced: [], refused: "empty" };
  if (isLeftMouse(key)) return { binds: { ...binds }, displaced: [], refused: "lmb" };
  const next = { ...binds };
  const displaced = [];
  for (const [other, current] of Object.entries(next)) {
    if (other !== action && norm(current) === key) {
      next[other] = "";
      displaced.push(other);
    }
  }
  next[action] = key;
  return { binds: next, displaced, refused: null };
}

// Every action that has a default binding must be editable in the panel; returns the ones missing from
// its list (an action the player cannot rebind is a bug: it fights with whatever they bind next).
export function unlistedActions(defaults, definitions) {
  const listed = new Set((definitions || []).map((d) => d.key));
  return Object.keys(defaults || {}).filter((k) => !listed.has(k));
}
