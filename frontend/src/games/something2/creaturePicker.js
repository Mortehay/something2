// Search behind the Maps tab's creature-type picker (SOMET-554). Pure for the
// same reason as mapListView.js: frontend vitest is node-env with no DOM, so
// anything left inside MapsAdmin.jsx cannot be tested.
//
// Why a search box replaced a checkbox grid: the catalog holds 293 creature
// types, and every bounded world on the dev database allows between 1 and 6 of
// them. Rendering 293 checkboxes per card to express a choice of at most 6 cost
// ~29,300 DOM nodes across the tab and made the selection itself unreadable.

// A two-letter query can match a hundred types. Showing all of them turns the
// results area back into the wall of controls this replaced, so the list is
// capped and the caller is told the true total -- an admin who sees
// "20 of 96 shown" knows to type more, whereas a silently truncated list would
// let them conclude a type does not exist.
export const DEFAULT_LIMIT = 20;

export function matchCreatureTypes(types, query, { exclude, limit = DEFAULT_LIMIT } = {}) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return { shown: [], total: 0 };

  // `exclude` is the current selection -- a Set in the component, but accept any
  // iterable so a caller with an array does not silently get zero exclusions
  // (a Set's `.has` on an array is undefined, which would throw).
  const taken = exclude instanceof Set ? exclude : new Set(exclude || []);

  const matched = (types || []).filter((t) => {
    const name = t?.name;
    if (typeof name !== 'string') return false;
    if (taken.has(name)) return false;
    return name.toLowerCase().includes(q);
  });

  return { shown: matched.slice(0, limit), total: matched.length };
}
