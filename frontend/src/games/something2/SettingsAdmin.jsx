import { useState } from 'react';
import styled from 'styled-components';
import { HiOutlinePlus, HiOutlineTrash, HiOutlineArrowPath, HiOutlineBolt } from 'react-icons/hi2';
import {
  useAiProviders, useCreateProvider, useUpdateProvider, useDeleteProvider,
  useActivateProvider, useRefreshModels, useTestProvider,
} from './useAiProviders.js';
import { useAiProviderTemplates } from './useAiProviderTemplates.js';
import {
  providerToForm, providerFormToPayload, validateProviderForm,
  emptyProviderForm, applyTemplate, templatesForKind, KINDS, GAME_USES,
} from './providerForm.js';
import {
  Button, QuietButton, Card, Row, Input, Label, Hint, ErrorText, WarnText, Badge,
  KindFields, KindPicker, AdapterField,
} from './ProviderKindFields.jsx';
import ProviderTemplatesSection from './ProviderTemplatesSection.jsx';
import AdminLoading from './AdminLoading.jsx';

const AdminContainer = styled.div`
  padding: 2rem; color: var(--s2-text); max-width: 1200px; margin: 0 auto;
  height: 100%; overflow-y: auto; background-color: var(--s2-surface);
`;
const Header = styled.div`display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;`;

const kindLabel = (modality) => (KINDS.find(k => k.value === modality) || KINDS[0]).label;

// `provider` null = a new, unsaved provider pre-filled with `initialForm`
// (the kind + template the admin picked in the Add flow).
function ProviderCard({ provider, isOnlyActive, initialForm, onCreated, onSaveAsTemplate }) {
  const [form, setForm] = useState(() => (provider ? providerToForm(provider) : initialForm));
  const create = useCreateProvider();
  const update = useUpdateProvider();
  const del = useDeleteProvider();
  const activate = useActivateProvider();
  const refresh = useRefreshModels();
  const test = useTestProvider();
  const isNew = !provider;
  const isAudio = form.modality === 'audio';
  const isText = form.modality === 'text';
  const isSprite = form.modality === 'sprite';
  const isEdit = form.modality === 'image_edit';
  // The raw styles/cues an audio provider's Refresh returned. Not the same
  // as models_cache (which the backend flattens into plain strings, with
  // cues prefixed "cue:") -- this keeps the labels and cue engine/entity
  // metadata Refresh's response carries, for display only.
  const [audioDiscovery, setAudioDiscovery] = useState(null);
  // null = the Save-as-template name input is closed.
  const [templateName, setTemplateName] = useState(null);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  // Editing the token field is what makes the difference between "left it
  // alone" (omit the key, keep the stored token) and "cleared it" (send "",
  // delete the stored token). See providerForm.js.
  const setToken = (v) => setForm(f => ({ ...f, auth_token: v, token_touched: true }));

  const validation = validateProviderForm(form);
  const models = provider?.models_cache || [];
  const discoveryCache = provider?.discovery_cache || null;
  const unsupported = discoveryCache?.unsupported || [];
  // Text providers from the Ollama / OpenAI-compatible templates speak
  // chat-completions, not the box's /api/text.
  const chatText = isText && (form.adapter === 'ollama' || form.adapter === 'openai_compatible');

  const save = () => {
    if (validation) return;
    const body = providerFormToPayload(form);
    if (isNew) create.mutate({ body }, { onSuccess: () => onCreated?.() });
    else update.mutate({ id: provider.id, body });
    setForm(f => ({ ...f, token_touched: false, auth_token: '' }));
  };

  const saveTemplate = () => {
    const name = (templateName || '').trim();
    if (!name) return;
    onSaveAsTemplate(provider.id, name).then(() => setTemplateName(null), () => {});
  };

  return (
    <Card>
      <Row>
        <Label>Name</Label>
        <Input value={form.name} onChange={e => set('name', e.target.value)} placeholder="desktop GPU box" />
        <Badge $bg="var(--s2-surface-raised)">{kindLabel(form.modality).toUpperCase()}</Badge>
        {provider?.is_active && <Badge>ACTIVE</Badge>}
        {provider && !provider.enabled && <span style={{ color: 'var(--s2-text-muted)' }}>disabled</span>}
      </Row>
      {!GAME_USES[form.modality] && <WarnText>Not used by the game yet.</WarnText>}
      {!isNew && <Hint style={{ marginTop: 0 }}>Kind is fixed after creation.</Hint>}

      <Row>
        <Label>Base URL</Label>
        <Input
          value={form.base_url}
          onChange={e => set('base_url', e.target.value)}
          placeholder={form.modality === 'image' ? 'http://192.168.1.20:7860/sdapi/v1/txt2img' : 'http://<box>:8001'}
          style={{ minWidth: 380 }}
        />
      </Row>
      <Hint>{form.modality === 'image'
        ? 'The full URL that generates an image. Model discovery uses the models path below.'
        : chatText
          ? 'The server origin, e.g. http://localhost:11434 for Ollama.'
          : isSprite
            ? 'The GPU box origin, e.g. http://<box>:8001. Sprite sheets and their concept art are generated here.'
            : 'The GPU box origin, e.g. http://<box>:8001.'}</Hint>

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
      <Hint>
        Leave the header name blank and the token goes out as
        {' '}<code>Authorization: Bearer &lt;token&gt;</code>. Name a header and the token is sent
        under it exactly as typed.
      </Hint>
      {form.has_token && !form.token_touched && (
        <Hint>A token is stored. Leave the field untouched to keep it; clear it and save to remove it.</Hint>
      )}

      {isAudio ? (
        <Hint>
          Talks to the box's /api/audio endpoints. Refresh lists its styles and cues, and the gateway's
          audio models for each drain group below. A blank group lets the box decide.
        </Hint>
      ) : isSprite ? (
        <Hint>
          Generates sprite sheets on the Sprite Generation page (jobs and concept art on the box).
          Concept model: the image each sheet is built from. Box default picks the box's Qwen-Image
          model (never SDXL); Refresh models lists what the box offers. The sheet itself is always
          drawn by the box's Qwen-Image-Edit. Test connection checks the key and the action catalog.
        </Hint>
      ) : chatText ? (
        <Hint>
          Writes audio and art prompts through a chat-completions API; the model below is sent with
          every request. Refresh lists the models the server has.
        </Hint>
      ) : isText ? (
        <Hint>
          Writes audio prompts. The base URL must be the GPU box's /api/text server (the audio box):
          any other server answers 4xx, which is treated as our bug, so there is no CPU fallback.
          To use the local CPU fallback instead, leave Text providers inactive.
          Refresh lists its models; the audio drain switches the box's gateway to the one picked here.
        </Hint>
      ) : isEdit ? (
        <Hint>
          Edits an existing image on the box (/api/edit). Capability is the default LoRA; Base model
          uses none. Steps and CFG go into every request.
        </Hint>
      ) : null}

      <KindFields form={form} set={set} models={models} discoveryCache={discoveryCache} />

      {!isNew && (
        <Row>
          <QuietButton
            onClick={() => refresh.mutate({ id: provider.id }, {
              // Audio's response carries styles/cues alongside the flattened
              // `models` list the query cache stores -- captured here rather
              // than reconstructed from models_cache, whose "cue:" prefix
              // convention would have to be un-done to get the label/engines
              // back.
              onSuccess: (data) => {
                if (data.ok && isAudio) setAudioDiscovery({ styles: data.styles || [], cues: data.cues || [] });
              },
            })}
            disabled={refresh.isPending}
          >
            <HiOutlineArrowPath /> {refresh.isPending ? 'Refreshing…' : (isAudio ? 'Refresh styles' : 'Refresh models')}
          </QuietButton>
          <QuietButton onClick={() => test.mutate({ id: provider.id })} disabled={test.isPending}>
            {test.isPending ? 'Testing…' : 'Test connection'}
          </QuietButton>
        </Row>
      )}
      {isNew && <Hint>Create the provider first; Refresh and Test then list its models.</Hint>}
      {provider?.models_fetched_at && (
        <Hint>{models.length} {isAudio ? 'style/cue' : 'model'}(s) cached at {new Date(provider.models_fetched_at).toLocaleString()}</Hint>
      )}
      {isAudio && (audioDiscovery || models.length > 0) && (
        // Labels from this session's Refresh when there is one; otherwise the
        // raw values from models_cache, so the list survives a page reload.
        // Styles and cues are chosen per subject, not here.
        <Hint>
          Styles: {(audioDiscovery
            ? audioDiscovery.styles.map(s => s.label || s.value)
            : models.filter(m => !m.startsWith('cue:'))).join(', ') || '—'}
          <br />
          Cues: {(audioDiscovery
            ? audioDiscovery.cues.map(c => c.label || c.value)
            : models.filter(m => m.startsWith('cue:')).map(m => m.slice(4))).join(', ') || '—'}
        </Hint>
      )}
      {unsupported.length > 0 && (
        <Hint>
          Available on the provider, not used by the game:{' '}
          {unsupported.map(u => `${u.label || u.id} (${u.kind})`).join(', ')}
        </Hint>
      )}

      <AdapterField form={form} set={set} />

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
          <QuietButton onClick={() => activate.mutate({ id: provider.id })}>
            <HiOutlineBolt /> Make active
          </QuietButton>
        )}
        {!isNew && templateName === null && (
          <QuietButton onClick={() => setTemplateName(`${provider.name} template`)}>Save as template</QuietButton>
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
      {templateName !== null && (
        <Row>
          <Label>Template name</Label>
          <Input aria-label="Template name" value={templateName} onChange={e => setTemplateName(e.target.value)} autoFocus />
          <Button onClick={saveTemplate} disabled={!templateName.trim()}>Save template</Button>
          <QuietButton onClick={() => setTemplateName(null)}>Cancel</QuietButton>
        </Row>
      )}
    </Card>
  );
}

// Add provider: pick a kind, then a template of that kind (or Blank), then the
// pre-filled card. `step` is {kind:null} (pick a kind), {kind} (pick a
// template) or {kind, form} (the card).
function AddProviderFlow({ templates, onDone }) {
  const [step, setStep] = useState({ kind: null });
  if (step.form) {
    return <ProviderCard provider={null} initialForm={step.form} onCreated={onDone} />;
  }
  if (!step.kind) {
    return (
      <Card>
        <Hint style={{ marginTop: 0 }}>What kind of provider?</Hint>
        <KindPicker onPick={kind => setStep({ kind })} />
      </Card>
    );
  }
  const blank = emptyProviderForm(step.kind);
  const choices = templatesForKind(templates, step.kind);
  return (
    <Card>
      <Hint style={{ marginTop: 0 }}>{kindLabel(step.kind)} provider — start from a template:</Hint>
      <Row>
        {choices.map(t => (
          <QuietButton key={t.id} title={t.description || undefined}
            onClick={() => setStep({ kind: step.kind, form: applyTemplate(blank, t) })}>
            {t.name}
          </QuietButton>
        ))}
        <QuietButton onClick={() => setStep({ kind: step.kind, form: blank })}>Blank</QuietButton>
      </Row>
      <Row>
        <QuietButton onClick={() => setStep({ kind: null })}>← Back</QuietButton>
      </Row>
    </Card>
  );
}

export default function SettingsAdmin() {
  const { providers, isLoadingProviders, activeProvider } = useAiProviders();
  const templatesApi = useAiProviderTemplates();
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
        Register an AI service running on another machine: image, image edit, text, audio or sprite
        sheets. The active image provider becomes the default for tile and entity image generation;
        individual types can override it. With no active image provider, generation uses the local
        sprite-gen service exactly as before.
      </Hint>
      <Hint>
        The other machine creates the image or sprite; this side only sends the request, waits, and
        stores what comes back. For animation it must return one ready-made sprite sheet — set the
        sheet layout and grid on the provider so this side knows how to cut it.
      </Hint>
      {!isLoadingProviders && !activeProvider && providers.length > 0 && (
        <WarnText>No provider is active — generation is using the local sprite-gen service.</WarnText>
      )}

      {adding && <AddProviderFlow templates={templatesApi.templates} onDone={() => setAdding(false)} />}

      {isLoadingProviders ? (
        <AdminLoading label="Loading AI providers…" inline size={16} />
      ) : providers.length === 0 ? (
        <Hint>No providers registered yet.</Hint>
      ) : (
        providers.map(p => (
          <ProviderCard
            key={p.id} provider={p} isOnlyActive={p.is_active}
            onSaveAsTemplate={templatesApi.saveProviderAsTemplate}
          />
        ))
      )}

      <ProviderTemplatesSection {...templatesApi} />
    </AdminContainer>
  );
}
