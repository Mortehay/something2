// Keyboard model for a WAI-ARIA menu button, as a pure decision function.
//
// `role="menu"` is a PROMISE to assistive tech: it tells a screen-reader user
// that arrows cycle the items, Escape closes and returns focus to the trigger,
// and Tab leaves entirely. Claiming the role without honouring it is worse than
// using no role at all, because the user is told to expect behaviour that isn't
// there. HeaderMenu claimed it and honoured none of it.
//
// Extracted from the component because vitest here runs in a plain node
// environment: nothing renders, so the only way to test this rule is to keep it
// free of the DOM. The component maps the returned action onto focus() calls.
//
// `focusedIndex` is the index of the currently focused item, or -1 when focus is
// still on the trigger while the menu is open.
export function menuKeyAction({ key, open, focusedIndex, itemCount }) {
  if (itemCount <= 0) {
    // An empty menu can still be dismissed -- never trap the user inside it.
    return open && (key === "Escape" || key === "Tab")
      ? { type: key === "Escape" ? "close" : "dismiss" }
      : null;
  }

  if (!open) {
    // From the closed trigger both arrows open the menu; ArrowDown lands on the
    // first item and ArrowUp on the last, per the menu button pattern.
    if (key === "ArrowDown") return { type: "open", index: 0 };
    if (key === "ArrowUp") return { type: "open", index: itemCount - 1 };
    return null;
  }

  // `close` returns focus to the trigger (the user asked to back out).
  // `dismiss` closes without stealing focus, so Tab moves on naturally.
  if (key === "Escape") return { type: "close" };
  if (key === "Tab") return { type: "dismiss" };

  // Focus still on the trigger: enter the list from whichever end was asked for
  // rather than treating -1 as a real position and wrapping off the wrong edge.
  if (focusedIndex < 0) {
    if (key === "ArrowDown") return { type: "focus", index: 0 };
    if (key === "ArrowUp") return { type: "focus", index: itemCount - 1 };
    return null;
  }

  if (key === "ArrowDown") return { type: "focus", index: (focusedIndex + 1) % itemCount };
  if (key === "ArrowUp") return { type: "focus", index: (focusedIndex - 1 + itemCount) % itemCount };
  if (key === "Home") return { type: "focus", index: 0 };
  if (key === "End") return { type: "focus", index: itemCount - 1 };
  return null;
}
