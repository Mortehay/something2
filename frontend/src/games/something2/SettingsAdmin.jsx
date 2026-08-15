import { useState } from 'react';
import styled from 'styled-components';
import { HiOutlinePlus, HiOutlineTrash, HiOutlineArrowPath, HiOutlineBolt } from 'react-icons/hi2';
import {
  useAiProviders, useCreateProvider, useUpdateProvider, useDeleteProvider,
  useActivateProvider, useRefreshModels, useTestProvider,
} from './useAiProviders.js';
import {
  emptyProviderForm, providerToForm, providerFormToPayload, validateProviderForm,
  parseTemplate, templateWarning, PLACEHOLDERS,
} from './providerForm.js';

const AdminContainer = styled.div`
  padding: 2rem; color: var(--s2-text); max-width: 1200px; margin: 0 auto;
  height: 100%; overflow-y: auto; background-color: var(--s2-surface);
`;
const Header = styled.div`display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;`;
const Button = styled.button`
  background: ${p => p.$bg || 'var(--s2-accent)'}; color: var(--s2-on-accent); border: none; border-radius: 6px;
  padding: 0.5rem 1rem; font-weight: bold; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
  &:disabled { opacity: 0.5; cursor: default; }
`;
const Card = styled.div`
  background: var(--s2-surface-raised); border: 1px solid var(--s2-border); border-radius: 8px;
  padding: 1rem; margin-bottom: 1rem;
`;
const Row = styled.div`display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; margin: 0.4rem 0;`;
const Input = styled.input`
  background: var(--s2-bg-sunken); color: var(--s2-text); border: 1px solid var(--s2-border-strong);
  border-radius: 4px; padding: 0.4rem; min-width: 220px;
`;
const Select = styled.select`
  background: var(--s2-bg-sunken); color: var(--s2-text); border: 1px solid var(--s2-border-strong);
  border-radius: 4px; padding: 0.4rem; min-width: 220px;
`;
const TemplateArea = styled.textarea`
  background: var(--s2-bg-sunken); color: var(--s2-text); border: 1px solid var(--s2-border-strong);
  border-radius: 4px; padding: 0.5rem; width: 100%; min-height: 200px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem;
`;
const Label = styled.span`color: var(--s2-text-muted); min-width: 150px;`;
const Hint = styled.p`color: var(--s2-text-muted); font-size: 0.85rem; margin: 0.25rem 0;`;
const ErrorText = styled.p`color: var(--s2-danger, #e5484d); font-size: 0.85rem; margin: 0.25rem 0;`;
const WarnText = styled.p`color: var(--s2-warning, #d9822b); font-size: 0.85rem; margin: 0.25rem 0;`;
const Badge = styled.span`
  background: var(--s2-accent); color: var(--s2-on-accent); border-radius: 999px;
  padding: 0.1rem 0.6rem; font-size: 0.75rem; font-weight: bold;
`;

function ProviderCard({ provider, isOnlyActive }) {
  const [form, setForm] = useState(() => providerToForm(provider));
  const create = useCreateProvider();
  const update = useUpdateProvider();
  const del = useDeleteProvider();
  const activate = useActivateProvider();
  const refresh = useRefreshModels();
  const test = useTestProvider();
  const isNew = !provider;

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  // Editing the token field is what makes the difference between "left it
  // alone" (omit the key, keep the stored token) and "cleared it" (send "",
  // delete the stored token). See providerForm.js.
  const setToken = (v) => setForm(f => ({ ...f, auth_token: v, token_touched: true }));

  const parseError = parseTemplate(form.request_template).error;
  const warning = templateWarning(form.request_template);
  const validation = validateProviderForm(form);
  const models = provider?.models_cache || [];

  const save = () => {
    if (validation) return;
    const body = providerFormToPayload(form);
    if (isNew) create.mutate({ body });
    else update.mutate({ id: provider.id, body });
    setForm(f => ({ ...f, token_touched: false, auth_token: '' }));
  };

  return (
    <Card>
      <Row>
        <Label>Name</Label>
        <Input value={form.name} onChange={e => set('name', e.target.value)} placeholder="desktop GPU box" />
        {provider?.is_active && <Badge>ACTIVE</Badge>}
        {provider && !provider.enabled && <span style={{ color: 'var(--s2-text-muted)' }}>disabled</span>}
      </Row>

      <Row>
        <Label>Base URL</Label>
        <Input
          value={form.base_url}
          onChange={e => set('base_url', e.target.value)}
          placeholder="http://192.168.1.20:7860/sdapi/v1/txt2img"
          style={{ minWidth: 380 }}
        />
      </Row>
      <Hint>The full URL that generates an image. Model discovery uses the models path below.</Hint>

      <Row>
        <Label>Auth header</Label>
        <Input
          value={form.auth_header_name}
          onChange={e => set('auth_header_name', e.target.value)}
          placeholder="Authorization (optional)"
        />
        <Input
          type="password"
          value={form.auth_token}
          onChange={e => setToken(e.target.value)}
          placeholder={form.has_token && !form.token_touched ? '•••••• stored — leave blank to keep' : 'token (optional)'}
        />
      </Row>
      {form.has_token && !form.token_touched && (
        <Hint>A token is stored. Leave the field untouched to keep it; clear it and save to remove it.</Hint>
      )}

      <Row>
        <Label>Request template</Label>
      </Row>
      <TemplateArea
        value={form.request_template}
        onChange={e => set('request_template', e.target.value)}
        spellCheck={false}
      />
      <Hint>Placeholders: {PLACEHOLDERS.join('  ')} — only the prompt comes from the entity or tile.</Hint>
      {parseError && <ErrorText>Template {parseError}</ErrorText>}
      {!parseError && warning && <WarnText>{warning}</WarnText>}

      <Row>
        <Label>Models path</Label>
        <Input value={form.models_path} onChange={e => set('models_path', e.target.value)} placeholder="/sdapi/v1/sd-models" />
        <Label>Models pointer</Label>
        <Input value={form.models_pointer} onChange={e => set('models_pointer', e.target.value)} placeholder="$[*].model_name" />
      </Row>

      <Row>
        <Label>Image pointer</Label>
        <Input
          value={form.response_image_pointer}
          onChange={e => set('response_image_pointer', e.target.value)}
          placeholder="images[0] — blank if the response IS the image"
          style={{ minWidth: 320 }}
        />
      </Row>

      <Row>
        <Label>Sprite sheet</Label>
        <Select value={form.sheet_layout} onChange={e => set('sheet_layout', e.target.value)}>
          <option value="">Single image (no animation)</option>
          <option value="flat">Flat grid — frames "0","1",… (tiles, objects)</option>
          <option value="directional">Directional — one row per facing (creatures)</option>
        </Select>
      </Row>
      {form.sheet_layout && (
        <>
          <Row>
            <Label>Grid</Label>
            <Input
              type="number" min="1" style={{ minWidth: 90 }}
              value={form.sheet_columns} onChange={e => set('sheet_columns', e.target.value)}
              placeholder="columns"
            />
            <Input
              type="number" min="1" style={{ minWidth: 90 }}
              value={form.sheet_rows} onChange={e => set('sheet_rows', e.target.value)}
              placeholder="rows"
            />
            {form.sheet_layout === 'directional' && (
              <Input
                value={form.sheet_directions}
                onChange={e => set('sheet_directions', e.target.value)}
                placeholder="S,SW,W,NW,N,NE,E,SE (row order)"
                style={{ minWidth: 300 }}
              />
            )}
          </Row>
          <Hint>
            The other machine returns the whole sheet; this only says how to cut it. Blank columns
            uses the requested frame count; blank rows uses 1 (or one per direction). The image must
            divide evenly into the grid or the job fails rather than cropping wrongly.
          </Hint>
        </>
      )}

      <Row>
        <Label>Model</Label>
        {models.length > 0 ? (
          <Select value={form.model} onChange={e => set('model', e.target.value)}>
            <option value="">— none —</option>
            {models.map(m => <option key={m} value={m}>{m}</option>)}
          </Select>
        ) : (
          <Input value={form.model} onChange={e => set('model', e.target.value)} placeholder="refresh to list models" />
        )}
        {!isNew && (
          <Button
            $bg="var(--s2-surface-raised)"
            onClick={() => refresh.mutate({ id: provider.id })}
            disabled={refresh.isPending}
          >
            <HiOutlineArrowPath /> {refresh.isPending ? 'Refreshing…' : 'Refresh models'}
          </Button>
        )}
        {!isNew && (
          <Button $bg="var(--s2-surface-raised)" onClick={() => test.mutate({ id: provider.id })} disabled={test.isPending}>
            {test.isPending ? 'Testing…' : 'Test connection'}
          </Button>
        )}
      </Row>
      {provider?.models_fetched_at && (
        <Hint>{models.length} model(s) cached at {new Date(provider.models_fetched_at).toLocaleString()}</Hint>
      )}

      <Row>
        <label style={{ color: 'var(--s2-text-secondary)' }}>
          <input type="checkbox" checked={form.enabled} onChange={e => set('enabled', e.target.checked)} /> Enabled
        </label>
      </Row>

      {validation && <ErrorText>{validation}</ErrorText>}

      <Row>
        <Button onClick={save} disabled={Boolean(validation) || create.isPending || update.isPending}>
          {isNew ? 'Create provider' : 'Save'}
        </Button>
        {!isNew && !provider.is_active && (
          <Button $bg="var(--s2-surface-raised)" onClick={() => activate.mutate({ id: provider.id })}>
            <HiOutlineBolt /> Make active
          </Button>
        )}
        {!isNew && (
          <Button
            $bg="var(--s2-danger, #e5484d)"
            onClick={() => del.mutate({ id: provider.id })}
            title={isOnlyActive ? 'Deleting the active provider falls generation back to local sprite-gen' : undefined}
          >
            <HiOutlineTrash /> Delete
          </Button>
        )}
      </Row>
    </Card>
  );
}

export default function SettingsAdmin() {
  const { providers, isLoadingProviders, activeProvider } = useAiProviders();
  const [adding, setAdding] = useState(false);

  return (
    <AdminContainer>
      <Header>
        <h2 style={{ margin: 0 }}>AI Providers</h2>
        <Button onClick={() => setAdding(a => !a)}>
          <HiOutlinePlus /> {adding ? 'Cancel' : 'Add provider'}
        </Button>
      </Header>

      <Hint>
        Register an image-generation service running on another machine. The active provider becomes the
        default for tile and entity image generation; individual types can override it. With no active
        provider, generation uses the local sprite-gen service exactly as before.
      </Hint>
      <Hint>
        The other machine creates the image or sprite; this side only sends the request, waits, and
        stores what comes back. For animation it must return one ready-made sprite sheet — set the
        sheet layout and grid on the provider so this side knows how to cut it.
      </Hint>
      {!isLoadingProviders && !activeProvider && providers.length > 0 && (
        <WarnText>No provider is active — generation is using the local sprite-gen service.</WarnText>
      )}

      {adding && <ProviderCard provider={null} />}

      {isLoadingProviders ? (
        <Hint>Loading…</Hint>
      ) : providers.length === 0 ? (
        <Hint>No providers registered yet.</Hint>
      ) : (
        providers.map(p => (
          <ProviderCard key={p.id} provider={p} isOnlyActive={p.is_active} />
        ))
      )}
    </AdminContainer>
  );
}
