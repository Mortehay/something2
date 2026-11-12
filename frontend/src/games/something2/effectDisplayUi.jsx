// SOMET-769: the Code / Sprite display choice an effect row carries, and the per-tab
// "for all" control. Pure presentation: the caller owns the value and the mutation.
import styled from 'styled-components';
import { EFFECT_DISPLAYS } from './vfxForm.js';

// The previews and the choice under them, one column beside the card's fields.
export const PreviewStack = styled.div`display: flex; flex-direction: column; gap: 0.5rem; flex: 0 0 auto; max-width: 460px;`;

const Choice = styled.fieldset`
  border: 0; padding: 0; margin: 0;
  display: flex; gap: 0.3rem 1rem; align-items: center; flex-wrap: wrap;
  legend { color: var(--s2-text-muted); padding: 0; float: left; margin-right: 0.6rem; }
  label { color: var(--s2-text-secondary); display: inline-flex; gap: 0.3rem; align-items: center; cursor: pointer; }
`;
const Note = styled.span`color: var(--s2-text-muted); font-size: 0.85rem; flex-basis: 100%;`;
const AllBar = styled.div`display: inline-flex; gap: 0.4rem; align-items: center; flex-wrap: wrap;`;
const AllButton = styled.button`
  padding: 0.3rem 0.7rem; border-radius: 6px; border: 1px solid var(--s2-border);
  background: rgba(255, 255, 255, 0.06); color: var(--s2-text-strong); font: inherit; font-size: 0.85rem;
  cursor: pointer;
  &:disabled { opacity: 0.5; cursor: default; }
`;

export const DISPLAY_LABEL = { code: 'Code', sprite: 'Sprite' };

// What a choice means for the player, in one line.
export function displayNote(value) {
  return value === 'code'
    ? 'The game draws the code version only, whatever the player chose in Settings → Animations.'
    : 'The sheet may be used; the player\'s Settings → Animations choice decides.';
}

export function DisplayChoice({ value, onChange, name, legend = 'Display in game' }) {
  const v = value === 'code' ? 'code' : 'sprite';
  return (
    <Choice>
      <legend>{legend}</legend>
      {EFFECT_DISPLAYS.map((d) => (
        <label key={d}>
          <input type="radio" name={name} value={d} checked={v === d} onChange={() => onChange(d)} />
          {DISPLAY_LABEL[d]}
        </label>
      ))}
      <Note>{displayNote(v)}</Note>
    </Choice>
  );
}

// Two buttons that set every row of a catalog. `onSet(display)` runs after the admin confirms.
export function DisplayForAll({ onSet, pending = false, what = 'rows', count = null }) {
  const ask = (d) => {
    const n = count == null ? `every ${what}` : `all ${count} ${what}`;
    if (typeof window === 'undefined' || window.confirm(`Set ${n} to draw as ${DISPLAY_LABEL[d]}?`)) onSet(d);
  };
  return (
    <AllBar>
      <Note>Display for all:</Note>
      {EFFECT_DISPLAYS.map((d) => (
        <AllButton key={d} type="button" disabled={pending} onClick={() => ask(d)}>
          {DISPLAY_LABEL[d]} for all
        </AllButton>
      ))}
    </AllBar>
  );
}
