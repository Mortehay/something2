import { useEffect, useState } from 'react';
import styled from 'styled-components';
import { useGameSettings, useUpdateGameSetting } from './useGameSettings.js';
import { SETTING_FIELDS, parseSettingInput } from './gameSettingsForm.js';
import PassiveNodesAdmin from './PassiveNodesAdmin.jsx';

const AdminContainer = styled.div`
  padding: 2rem; color: var(--s2-text); max-width: 1200px; margin: 0 auto;
  height: 100%; overflow-y: auto; background-color: var(--s2-surface);
`;
const Header = styled.div`display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;`;
const Section = styled.section`margin-bottom: 2rem;`;
const SectionTitle = styled.h2`font-size: 1.1rem; margin: 0 0 0.75rem 0; color: var(--s2-text-strong);`;
const Card = styled.div`
  background: var(--s2-surface-raised); border: 1px solid var(--s2-border); border-radius: 8px;
  padding: 1rem; margin-bottom: 1rem;
`;
const Row = styled.div`display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; margin: 0.4rem 0;`;
const Label = styled.span`color: var(--s2-text-muted); min-width: 220px;`;
const Input = styled.input`
  background: var(--s2-bg-sunken); color: var(--s2-text); border: 1px solid var(--s2-border-strong);
  border-radius: 4px; padding: 0.4rem; min-width: 160px;
`;
const JsonArea = styled.textarea`
  background: var(--s2-bg-sunken); color: var(--s2-text); border: 1px solid var(--s2-border-strong);
  border-radius: 4px; padding: 0.5rem; width: 100%; min-height: 140px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem;
`;
const Button = styled.button`
  background: var(--s2-accent); color: var(--s2-on-accent); border: none; border-radius: 6px;
  padding: 0.5rem 1rem; font-weight: bold; cursor: pointer;
  &:disabled { opacity: 0.5; cursor: default; }
`;
const Hint = styled.p`color: var(--s2-text-muted); font-size: 0.85rem; margin: 0.25rem 0;`;
const Err = styled.p`color: var(--s2-danger); font-size: 0.85rem; margin: 0.25rem 0;`;
const Placeholder = styled.div`
  border: 1px dashed var(--s2-border-strong); border-radius: 8px; padding: 1.25rem;
  color: var(--s2-text-dim); background: var(--s2-surface-subtle);
`;
const PageTitle = styled.h1`margin: 0;`;

// The stored value rendered as editable text. An integer shows as a plain
// number; anything structured shows as indented JSON, which is what the
// textarea round-trips through parseSettingInput.
function toInput(field, value) {
  if (value === undefined) return '';
  return field.kind === 'integer' ? String(value) : JSON.stringify(value, null, 2);
}

function SettingRow({ field, row, onSave, saving }) {
  const [draft, setDraft] = useState(() => toInput(field, row && row.value));
  const [error, setError] = useState(null);

  // The server is the source of truth: when a save (or another admin's save)
  // lands and the query refetches, the draft follows it rather than sitting on
  // a stale local edit that looks saved.
  useEffect(() => { setDraft(toInput(field, row && row.value)); }, [field, row]);

  const save = () => {
    const parsed = parseSettingInput(field.key, draft);
    if (parsed.error) { setError(parsed.error); return; }
    setError(null);
    onSave(field.key, parsed.value);
  };

  return (
    <Card>
      <Row>
        <Label>{field.label}</Label>
        {field.kind === 'integer'
          ? <Input value={draft} onChange={(e) => setDraft(e.target.value)} />
          : null}
        <Button type="button" onClick={save} disabled={saving}>Save</Button>
      </Row>
      {field.kind === 'json' && (
        <JsonArea value={draft} spellCheck={false} onChange={(e) => setDraft(e.target.value)} />
      )}
      <Hint>{field.hint}</Hint>
      {error && <Err role="alert">{error}</Err>}
    </Card>
  );
}

export default function ProgressionAdmin() {
  const { settings, isLoadingSettings, settingsError } = useGameSettings();
  const update = useUpdateGameSetting();
  const byKey = new Map(settings.map((s) => [s.key, s]));

  return (
    <AdminContainer>
      <Header>
        <PageTitle>Progression</PageTitle>
      </Header>

      <Section>
        <SectionTitle>Game settings</SectionTitle>
        <Hint>
          These take effect on the next read — no deploy. The XP curve is deliberately not here:
          changing it would re-level every character in the database, so it stays a code change
          with a migration attached.
        </Hint>
        {settingsError && <Err role="alert">{settingsError.message}</Err>}
        {isLoadingSettings && <Hint>Loading…</Hint>}
        {!isLoadingSettings && SETTING_FIELDS.map((field) => (
          <SettingRow
            key={field.key}
            field={field}
            row={byKey.get(field.key)}
            saving={update.isPending}
            onSave={(key, value) => update.mutate({ key, value })}
          />
        ))}
      </Section>

      {/* MOUNT POINT: affix catalog CRUD. Owned by group D, task T12 — the
          affix_types table does not exist yet, so this is a labelled empty
          section rather than a half-built editor. T12 replaces the
          Placeholder below and nothing else on this page. */}
      <Section id="affix-catalog-mount">
        <SectionTitle>Affix catalog</SectionTitle>
        <Placeholder>Arrives with the item-rarity slice (T12).</Placeholder>
      </Section>

      {/* MOUNT POINT: passive node browser and single-node editor (SOMET-477).
          Filled by group C, task T9. The id is kept so the section stays
          findable from a link and from the smoke test. */}
      <Section id="passive-nodes-mount">
        <SectionTitle>Passive nodes</SectionTitle>
        <PassiveNodesAdmin />
      </Section>
    </AdminContainer>
  );
}
