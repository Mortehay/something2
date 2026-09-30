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
