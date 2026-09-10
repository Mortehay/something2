// The description editor's three rules (SOMET-553).
//
// Pure, like artSelection.js and artProgress.js beside it, because the
// interesting failure here is not markup: it is the difference between "the
// field is empty" and "there is no description", which are the same empty
// string on screen and must never be the same thing to the code.
//
// A DRAFT OF null MEANS "NOBODY HAS TYPED". It is not the empty string, and
// collapsing the two is the bug this module exists to prevent: with `''` as
// the sentinel, a subject whose description someone had cleared to blank would
// silently fall back to showing the stored text again, and Save would be
// disabled on the one edit that most needs to go through.

// What the textarea shows: the local edit if there is one, otherwise whatever
// is stored, otherwise nothing.
export function draftText(draft, description) {
  if (draft !== null && draft !== undefined) return draft;
  return (description && description.text) || '';
}

// Which length the select shows. A description re-run at a different length is
// a different artefact rather than a correction, so the last length used is
// the honest default -- not the global default, which would quietly re-run a
// deliberately short description at medium.
export function draftLength(chosen, description, fallback = 'medium') {
  if (chosen) return chosen;
  return (description && description.length) || fallback;
}

// Is there an unsaved edit worth enabling Save for?
//
// Compares TRIMMED, because the store trims before writing: without that,
// adding a trailing space enables Save, the write stores the identical text,
// and the button stays enabled forever on a change that cannot be made.
export function isDirty(draft, description) {
  if (draft === null || draft === undefined) return false;
  return draft.trim() !== ((description && description.text) || '').trim();
}
