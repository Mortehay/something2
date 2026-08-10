import { useState } from 'react';
import styled from 'styled-components';
import { usePlayableClasses, useCreateCharacter, useDeleteCharacter } from './useCharacters.js';
import { canCreate, slotsUsed } from './characterSession.js';

// The character list and create form, rendered in place of the game canvas
// until a character is chosen. Deliberately thin: every rule worth testing
// (slot arithmetic, stale-id resolution) lives in characterSession.js, because
// vitest runs in a node environment here and this file cannot be rendered in a
// test at all.

const Panel = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  overflow-y: auto;
  background: var(--s2-surface, var(--color-grey-50));
`;

const Card = styled.div`
  width: 100%;
  max-width: 46rem;
  background: var(--color-grey-0);
  border: 1px solid var(--color-grey-200);
  border-radius: 8px;
  padding: 2.4rem;

  h2 { font-size: 2rem; margin-bottom: 0.4rem; }
  p.sub { color: var(--color-grey-500); margin-bottom: 1.6rem; }
`;

const List = styled.ul`
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
  margin-bottom: 1.6rem;
`;

const Row = styled.li`
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 1.2rem;
  align-items: center;
  padding: 1rem 1.2rem;
  border: 1px solid var(--color-grey-200);
  border-radius: 6px;

  .name { font-weight: 600; }
  .meta { color: var(--color-grey-500); font-size: 1.3rem; }
`;

const Button = styled.button`
  padding: 0.6rem 1.4rem;
  border-radius: 6px;
  border: 1px solid var(--color-grey-300);
  background: var(--color-grey-0);
  cursor: pointer;
  &:disabled { opacity: 0.5; cursor: not-allowed; }
`;

const PrimaryButton = styled(Button)`
  background: var(--color-brand-600, #4f46e5);
  border-color: transparent;
  color: #fff;
`;

const DangerButton = styled(Button)`
  color: var(--color-red-700, #b91c1c);
`;

const Form = styled.form`
  display: flex;
  flex-direction: column;
  gap: 1rem;
  border-top: 1px solid var(--color-grey-200);
  padding-top: 1.6rem;

  input[type="text"] {
    padding: 0.8rem 1rem;
    border: 1px solid var(--color-grey-300);
    border-radius: 6px;
    background: var(--color-grey-0);
    color: var(--color-grey-700);
  }
  fieldset { border: 0; display: flex; gap: 1.6rem; flex-wrap: wrap; }
  label { display: flex; gap: 0.5rem; align-items: center; }
  .why { color: var(--color-grey-500); font-size: 1.3rem; }
`;

export default function CharacterSelect({ characters, maxCharacters, onPlay }) {
  const { classes } = usePlayableClasses();
  const createCharacter = useCreateCharacter();
  const deleteCharacter = useDeleteCharacter();
  const [name, setName] = useState('');
  const [entityTypeId, setEntityTypeId] = useState(null);

  const list = Array.isArray(characters) ? characters : [];
  const cap = maxCharacters;
  // canCreate is false while the count or the cap is unknown, so the control
  // is never enabled before we can honour it.
  const roomLeft = cap != null && canCreate(characters, cap);
  const chosenClass = entityTypeId ?? (classes && classes.length ? classes[0].id : null);

  function submit(e) {
    e.preventDefault();
    if (!roomLeft || chosenClass == null) return;
    createCharacter.mutate({ name, entityTypeId: chosenClass }, {
      onSuccess: () => setName(''),
    });
  }

  function remove(character) {
    // Typed confirmation would be friendlier, but a native confirm keeps this
    // component free of modal state it would otherwise be the only owner of.
    const ok = globalThis.confirm?.(
      `Delete ${character.name} permanently? Their level, inventory and position are lost.`);
    if (ok) deleteCharacter.mutate(character.id);
  }

  return (
    <Panel>
      <Card>
        <h2>Choose a character</h2>
        <p className="sub">
          {cap == null ? 'Loading…' : `${slotsUsed(characters)} of ${cap} slots used`}
        </p>

        <List>
          {list.map((c) => (
            <Row key={c.id}>
              <div>
                <div className="name">{c.name}</div>
                <div className="meta">
                  Level {c.level} {c.className}
                  {c.lastWorldName ? ` — last seen in ${c.lastWorldName}` : ' — has not played yet'}
                </div>
              </div>
              <PrimaryButton type="button" onClick={() => onPlay(c.id)}>Play</PrimaryButton>
              <DangerButton
                type="button"
                onClick={() => remove(c)}
                disabled={deleteCharacter.isPending}
              >
                Delete
              </DangerButton>
            </Row>
          ))}
        </List>

        <Form onSubmit={submit}>
          <label htmlFor="new-character-name">New character</label>
          <input
            id="new-character-name"
            type="text"
            value={name}
            maxLength={32}
            placeholder="Name"
            onChange={(e) => setName(e.target.value)}
            disabled={!roomLeft}
          />
          <fieldset disabled={!roomLeft}>
            <legend className="why">Class</legend>
            {(classes || []).map((cls) => (
              <label key={cls.id}>
                <input
                  type="radio"
                  name="character-class"
                  value={cls.id}
                  checked={chosenClass === cls.id}
                  onChange={() => setEntityTypeId(cls.id)}
                />
                {cls.name} <span className="why">({cls.hp} hp)</span>
              </label>
            ))}
          </fieldset>
          <PrimaryButton
            type="submit"
            disabled={!roomLeft || !name.trim() || createCharacter.isPending}
          >
            Create character
          </PrimaryButton>
          {cap != null && !roomLeft && (
            <p className="why">
              All {cap} slots are in use. Delete a character to free one.
            </p>
          )}
        </Form>
      </Card>
    </Panel>
  );
}
