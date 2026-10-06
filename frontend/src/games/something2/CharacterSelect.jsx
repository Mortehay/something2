import { useState } from 'react';
import styled from 'styled-components';
import { usePlayableClasses, useCreateCharacter, useDeleteCharacter } from './useCharacters.js';
import { canCreate, slotsUsed } from './characterSession.js';
import { describeClass } from './classIdentity.js';
import { assetUrl } from './useTileSprites.js';

// The character list and create form, rendered in place of the game canvas
// until a character is chosen. Deliberately thin: every rule worth testing
// (slot arithmetic, stale-id resolution) lives in characterSession.js, because
// vitest runs in a node environment here and this file cannot be rendered in a
// test at all.

const Panel = styled.div`
  position: absolute;
  inset: 0;
  /* Above every layer GameView paints (its world picker tops out at 100, the
     minimap modal at 200) and below GameShell's help button (300) and backdrop
     (400), so Help stays reachable from the gate. Without this the world picker
     rendered ON TOP of the picker and covered the Play buttons outright -- the
     gate was visible and unusable. */
  z-index: 250;
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
  grid-template-columns: 4.8rem 1fr auto auto;
  gap: 1.2rem;
  align-items: center;
  padding: 1rem 1.2rem;
  border: 1px solid var(--color-grey-200);
  border-radius: 6px;

  .name { font-weight: 600; }
  .meta { color: var(--color-grey-500); font-size: 1.3rem; }
`;

const Portrait = styled.div`
  width: 4.8rem;
  height: 4.8rem;
  border-radius: 6px;
  overflow: hidden;
  display: grid;
  place-items: center;
  background: ${(p) => p.$color || 'var(--color-grey-100)'};
  color: #fff;
  font-weight: 700;

  img { width: 100%; height: 100%; object-fit: contain; image-rendering: pixelated; }
`;

const AppearanceGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 0.6rem;
`;

const AppearanceButton = styled.button`
  min-height: 6.4rem;
  border: 2px solid ${(p) => p.$selected ? 'var(--color-brand-600)' : 'var(--color-grey-200)'};
  border-radius: 6px;
  background: ${(p) => p.$color || 'var(--color-grey-100)'};
  color: #fff;
  cursor: pointer;
  overflow: hidden;
  position: relative;

  img { width: 100%; height: 5.6rem; object-fit: contain; image-rendering: pixelated; }
  span { position: absolute; right: 0.4rem; bottom: 0.2rem; font-size: 1.1rem; text-shadow: 0 1px 2px #000; }
  &:focus-visible { outline: 2px solid var(--color-brand-600); outline-offset: 2px; }
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
  /* SOMET-471: six classes, each with a main stat and an identity line, no
     longer fit the wrapping row three bare names did -- the lines interleaved
     and it stopped being obvious which line belonged to which radio. One class
     per row instead. */
  fieldset { border: 0; display: grid; grid-template-columns: 1fr; gap: 0.8rem; }
  label { display: grid; grid-template-columns: auto 1fr; gap: 0.6rem; align-items: baseline; }
  .pick { display: flex; flex-direction: column; gap: 0.2rem; }
  .why { color: var(--color-grey-500); font-size: 1.3rem; }
`;

export default function CharacterSelect({ characters, maxCharacters, onPlay }) {
  const { classes } = usePlayableClasses();
  const createCharacter = useCreateCharacter();
  const deleteCharacter = useDeleteCharacter();
  const [name, setName] = useState('');
  const [entityTypeId, setEntityTypeId] = useState(null);
  const [appearanceVariant, setAppearanceVariant] = useState(1);

  const list = Array.isArray(characters) ? characters : [];
  const cap = maxCharacters;
  // canCreate is false while the count or the cap is unknown, so the control
  // is never enabled before we can honour it.
  const roomLeft = cap != null && canCreate(characters, cap);
  const chosenClass = entityTypeId ?? (classes && classes.length ? classes[0].id : null);
  const chosenClassDef = (classes || []).find((cls) => cls.id === chosenClass) || null;

  function submit(e) {
    e.preventDefault();
    if (!roomLeft || chosenClass == null) return;
    createCharacter.mutate({ name, entityTypeId: chosenClass, appearanceVariant }, {
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
              <Portrait $color={(classes || []).find((x) => x.name === c.className)?.color}>
                {c.appearance?.image
                  ? <img src={assetUrl(c.appearance.image)} alt="" />
                  : c.className?.slice(0, 1)}
              </Portrait>
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
                  onChange={() => { setEntityTypeId(cls.id); setAppearanceVariant(1); }}
                />
                {/* SOMET-486: these are the class's real base pools, straight
                    off the same entity_types columns the authority derives a
                    joining character's maxHp/maxMana from. They were decoration
                    until 486 -- the game handed every class 100/100. Mana is
                    shown as well as HP now that it actually differs.

                    SOMET-471 adds the main stat and the one-line identity.
                    Both come from classIdentity.js rather than from literals
                    here, because vitest runs in a node environment and this
                    component cannot be rendered in a test at all -- the same
                    reason characterSession.js exists. The list itself is
                    whatever the server says is playable, so the demoted Ranger
                    drops out without this file naming it. */}
                <span className="pick">
                  <span>
                    {cls.image && <img src={assetUrl(cls.image)} alt="" width="32" height="32" />}
                    {cls.name}{' '}
                    <span className="why">({cls.hp} hp / {cls.mana} mana)</span>
                  </span>
                  <span className="why">{describeClass(cls)}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {chosenClassDef && (
            <fieldset disabled={!roomLeft}>
              <legend className="why">Appearance</legend>
              <AppearanceGrid>
                {(chosenClassDef.appearances || []).map((appearance) => (
                  <AppearanceButton
                    key={appearance.variant}
                    type="button"
                    $selected={appearanceVariant === appearance.variant}
                    $color={chosenClassDef.color}
                    aria-label={`${chosenClassDef.name} ${appearance.label}`}
                    aria-pressed={appearanceVariant === appearance.variant}
                    onClick={() => setAppearanceVariant(appearance.variant)}
                  >
                    {appearance.image && <img src={assetUrl(appearance.image)} alt="" />}
                    <span>{appearance.variant}</span>
                  </AppearanceButton>
                ))}
              </AppearanceGrid>
            </fieldset>
          )}
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
