import { useState } from 'react';
import styled from 'styled-components';

const Text = styled.span`display: block; max-width: 28rem; white-space: normal;`;
const Tag = styled.span`
  display: inline-block; margin-right: 0.35rem; border-radius: 999px; padding: 0 0.4rem;
  color: var(--s2-text-muted); background: var(--s2-bg-sunken); font-size: 0.7rem;
`;
const Actions = styled.span`display: flex; gap: 0.35rem; flex-wrap: wrap; margin-top: 0.25rem;`;
const Small = styled.button`
  border: 1px solid var(--s2-border-strong); border-radius: 4px; padding: 0.1rem 0.45rem; cursor: pointer;
  color: var(--s2-text); background: var(--s2-bg-sunken); font-size: 0.75rem;
  &:disabled { opacity: 0.5; cursor: default; }
`;
const Editor = styled.textarea`
  width: 100%; min-width: 220px; min-height: 3.2rem; padding: 0.3rem; color: var(--s2-text);
  background: var(--s2-bg-sunken); border: 1px solid var(--s2-border-strong); border-radius: 4px; font: inherit;
`;

// Who wrote the prompt this row draws from. A description the art console wrote
// (origin null) is in use because the subject opted in from the Sprite tab once.
export function promptSourceTag(subject) {
  if (subject.sprite_prompt_source === 'description') {
    return subject.sprite_prompt_origin === 'sprite'
      ? { label: 'Sprite tab', title: 'Written on the Sprite tab' }
      : { label: 'art console', title: 'The active description was written in the art console' };
  }
  if (subject.sprite_prompt_source === 'template') return { label: 'template', title: 'The catalog prompt' };
  return null;
}

// The table's Prompt cell. Regenerate and Edit only for subjects with a prompt
// lane (creatures, hero appearances, effects -- not props); Revert only when a
// description is in use.
export function SpritePromptCell({ subject, pending = false, onRegenerate, onSave, onRevert }) {
  const text = subject.sprite_prompt || subject.prompt || subject.name;
  const [draft, setDraft] = useState(null);
  const tag = promptSourceTag(subject);
  const lane = Boolean(subject.prompt_kind);
  if (draft !== null) {
    return (
      <>
        <Editor aria-label={`Prompt for ${subject.name}`} maxLength={1000} value={draft} onChange={(e) => setDraft(e.target.value)} />
        <Actions>
          <Small type="button" disabled={pending || !draft.trim()} onClick={() => { onSave?.(draft.trim()); setDraft(null); }}>Save</Small>
          <Small type="button" onClick={() => setDraft(null)}>Cancel</Small>
        </Actions>
      </>
    );
  }
  return (
    <>
      <Text title={text}>{tag && <Tag title={tag.title}>{tag.label}</Tag>}{text}</Text>
      {lane && (
        <Actions>
          <Small type="button" disabled={pending} aria-busy={pending} onClick={() => onRegenerate?.()}>
            {pending ? 'Regenerating…' : 'Regenerate prompt'}
          </Small>
          <Small type="button" disabled={pending} onClick={() => setDraft(text)}>Edit</Small>
          {subject.sprite_prompt_source === 'description' && (
            <Small type="button" disabled={pending} onClick={() => onRevert?.()}>Revert</Small>
          )}
        </Actions>
      )}
    </>
  );
}

export default SpritePromptCell;
