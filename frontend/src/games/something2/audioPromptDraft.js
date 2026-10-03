// Pure rules for the audio slot card's prompt editor (spec 2026-09-30 §9).
// Draft semantics are artDescriptionDraft.js's: null = nobody typed, '' =
// cleared on purpose.
import { draftText } from './artDescriptionDraft.js';

export function provenanceText(active) {
  if (!active) return 'no stored prompt';
  if (active.model) return `written by ${active.model} (${active.via === 'fallback' ? 'CPU fallback' : 'GPU box'})`;
  return active.text ? 'edited by hand' : 'cleared by hand — generation ignores it';
}

// What Generate sends for style/prompt. Nothing when the fields show the
// stored prompt -- the server reads it itself (one source of truth). An
// SFX slot never sends them: its stored text travels as the box's `entity`,
// resolved server-side. An UNSAVED sfx edit must be saved first; the card
// disables Generate while an sfx draft is dirty.
export function generatePromptFields({
  isSfx, styleDraft, textDraft, active,
}) {
  if (isSfx) return {};
  const style = draftText(styleDraft, active ? { text: active.style || '' } : null);
  const text = draftText(textDraft, active);
  if (active && style === (active.style || '') && text === (active.text || '')) return {};
  if (!active && !style && !text) return {};
  return { style: style || undefined, prompt: text || undefined };
}

// The slot card's "Prompt history (N)" list (plan 2026-10-03 Task 4).
// `history` is GET /admin/prompts' inactive rows, already newest first
// (audioPrompts.listForSubject orders by created_at DESC); it is re-sorted
// here anyway so the list never depends on that ORDER BY. The author is the
// model that wrote the row, or "hand" for a row nobody's model wrote (via
// null).
export function historyRows(prompt) {
  const rows = (prompt && Array.isArray(prompt.history)) ? prompt.history : [];
  return [...rows]
    .sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0)
      || Number(b.id) - Number(a.id))
    .map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      author: r.via == null ? 'hand' : (r.model || r.via),
      style: r.style || '',
      text: r.text || '',
    }));
}

// What Restore saves: the old row's text and style as a NEW active version,
// guarded by the CURRENT active id -- if someone saved meanwhile, the PUT
// answers 409 and nothing is overwritten. History itself is never edited.
export function restoreVars(slot, row, active) {
  return {
    slot, style: row.style || null, text: row.text, expectActiveId: active ? active.id : null,
  };
}
