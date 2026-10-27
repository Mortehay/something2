// The per-kind field blocks of an AI provider form, shared by ProviderCard
// (SettingsAdmin.jsx) and the Templates section's editor, so a template is
// edited with exactly the fields a provider of its kind has. Every rule lives
// in providerForm.js; this file only lays the fields out.
import { useState } from 'react';
import styled from 'styled-components';
import {
  PLACEHOLDERS, parseTemplate, templateWarning, modelOptions, spriteModelOptions,
  editCapabilityOptions, editSettings, withEditSetting, ADAPTER_OPTIONS, AUDIO_GROUPS, KINDS,
} from './providerForm.js';

export const Button = styled.button`
  background: ${p => p.$bg || 'var(--s2-accent)'}; color: var(--s2-on-accent); border: none; border-radius: 6px;
  padding: 0.5rem 1rem; font-weight: bold; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
  &:disabled { opacity: 0.5; cursor: default; }
`;
// For buttons on a raised surface: on-accent text would vanish on it in light mode.
export const QuietButton = styled(Button)`
  background: var(--s2-surface-raised); color: var(--s2-text); border: 1px solid var(--s2-border-strong);
`;
export const Card = styled.div`
  background: var(--s2-surface-raised); border: 1px solid var(--s2-border); border-radius: 8px;
  padding: 1rem; margin-bottom: 1rem;
`;
export const Row = styled.div`display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; margin: 0.4rem 0;`;
export const Input = styled.input`
  background: var(--s2-bg-sunken); color: var(--s2-text); border: 1px solid var(--s2-border-strong);
  border-radius: 4px; padding: 0.4rem; min-width: 220px;
`;
export const Select = styled.select`
  background: var(--s2-bg-sunken); color: var(--s2-text); border: 1px solid var(--s2-border-strong);
  border-radius: 4px; padding: 0.4rem; min-width: 220px;
`;
const TemplateArea = styled.textarea`
  background: var(--s2-bg-sunken); color: var(--s2-text); border: 1px solid var(--s2-border-strong);
  border-radius: 4px; padding: 0.5rem; width: 100%; min-height: 200px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem;
`;
export const Label = styled.span`color: var(--s2-text-muted); min-width: 150px;`;
export const Hint = styled.p`color: var(--s2-text-muted); font-size: 0.85rem; margin: 0.25rem 0;`;
export const ErrorText = styled.p`color: var(--s2-danger, #e5484d); font-size: 0.85rem; margin: 0.25rem 0;`;
export const WarnText = styled.p`color: var(--s2-warning, #d9822b); font-size: 0.85rem; margin: 0.25rem 0;`;
export const Badge = styled.span`
  background: ${p => p.$bg || 'var(--s2-accent)'}; color: ${p => (p.$bg ? 'var(--s2-text)' : 'var(--s2-on-accent)')};
  border: 1px solid var(--s2-border); border-radius: 999px;
  padding: 0.1rem 0.6rem; font-size: 0.75rem; font-weight: bold;
`;
const Advanced = styled.details`
  margin: 0.4rem 0;
  & > summary { color: var(--s2-text-muted); cursor: pointer; font-size: 0.85rem; }
`;

const OTHER = '__other__';

// A model <select> from discovered options, plus "Other…" for a value the
// provider does not list. A saved unlisted value is already in `options`
// (modelOptions keeps it), so it shows selected on reopen; "Other…" is only
// for typing a new one. With nothing discovered yet it is a plain text input.
export function ModelPicker({ value, options, onChange, blankLabel, placeholder, ariaLabel }) {
  const [other, setOther] = useState(false);
  if (options.length === 0) {
    return (
      <Input
        aria-label={ariaLabel}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder || 'refresh to list models, or type one'}
      />
    );
  }
  const hasBlank = options.some((o) => o.value === '');
  return (
    <>
      <Select
        aria-label={ariaLabel}
        value={other ? OTHER : value}
        onChange={e => {
          if (e.target.value === OTHER) { setOther(true); return; }
          setOther(false);
          onChange(e.target.value);
        }}
      >
        {!hasBlank && blankLabel && <option value="">{blankLabel}</option>}
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        <option value={OTHER}>Other…</option>
      </Select>
      {other && (
        <Input
          aria-label={ariaLabel ? `${ariaLabel} (other)` : undefined}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="type a model id"
          autoFocus
        />
      )}
    </>
  );
}

// Step 1 of Add provider / New template: one button per kind.
export function KindPicker({ onPick }) {
  return (
    <Row>
      {KINDS.map(k => (
        <QuietButton key={k.value} onClick={() => onPick(k.value)}>{k.label}</QuietButton>
      ))}
    </Row>
  );
}

// The adapter, tucked away: the template the provider came from already set it.
export function AdapterField({ form, set }) {
  return (
    <Advanced>
      <summary>Advanced</summary>
      <Row>
        <Label>Adapter</Label>
        <Select aria-label="Adapter" value={form.adapter} onChange={e => set('adapter', e.target.value)}>
          {ADAPTER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
      </Row>
      <Hint>Selects how Refresh and Test talk to the provider. Usually set by the template.</Hint>
    </Advanced>
  );
}

function ImageFields({ form, set, models }) {
  const parseError = parseTemplate(form.request_template).error;
  const warning = templateWarning(form.request_template);
  return (
    <>
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
          <Select aria-label="Model" value={form.model} onChange={e => set('model', e.target.value)}>
            <option value="">— none —</option>
            {models.map(m => <option key={m} value={m}>{m}</option>)}
            {form.model && !models.includes(form.model) && <option value={form.model}>{form.model}</option>}
          </Select>
        ) : (
          <Input aria-label="Model" value={form.model} onChange={e => set('model', e.target.value)} placeholder="refresh to list models" />
        )}
      </Row>
    </>
  );
}

function ImageEditFields({ form, set, discoveryCache }) {
  const settings = editSettings(form.request_template);
  const setSetting = (k, v) => set('request_template', withEditSetting(form.request_template, k, v));
  const parseError = (form.request_template || '').trim() ? parseTemplate(form.request_template).error : null;
  return (
    <>
      <Row>
        <Label>Capability</Label>
        <ModelPicker
          ariaLabel="Capability"
          value={form.model}
          options={editCapabilityOptions(discoveryCache, form.model)}
          onChange={v => set('model', v)}
        />
      </Row>
      <Row>
        <Label>Steps</Label>
        <Input type="number" min="1" style={{ minWidth: 90 }} aria-label="Steps"
          value={settings.steps} onChange={e => setSetting('steps', e.target.value)} placeholder="box default" />
        <Label style={{ minWidth: 0 }}>CFG</Label>
        <Input type="number" step="0.1" style={{ minWidth: 90 }} aria-label="CFG"
          value={settings.cfg_scale} onChange={e => setSetting('cfg_scale', e.target.value)} placeholder="box default" />
      </Row>
      {parseError && <ErrorText>Request template {parseError}</ErrorText>}
    </>
  );
}

function AudioGroupFields({ form, set, discoveryCache }) {
  const byGroup = form.models_by_group || {};
  const setGroup = (g, v) => set('models_by_group', { ...byGroup, [g]: v });
  return AUDIO_GROUPS.map(g => (
    <Row key={g}>
      <Label>{g}</Label>
      <ModelPicker
        ariaLabel={`Model for ${g}`}
        value={byGroup[g] || ''}
        options={modelOptions(discoveryCache, 'audio', byGroup[g] || '')}
        onChange={v => setGroup(g, v)}
        blankLabel="— not set (box decides) —"
        placeholder="audio:… — refresh to list, or type one"
      />
    </Row>
  ));
}

// The fields only this kind has. `models` is the row's flat models_cache
// (image and sprite dropdowns); `discoveryCache` is its kind-aware
// discovery_cache (text, audio, image_edit). Both are empty for a template.
export function KindFields({ form, set, models = [], discoveryCache = null }) {
  switch (form.modality) {
    case 'text':
      return (
        <Row>
          <Label>Model</Label>
          <ModelPicker
            ariaLabel="Model"
            value={form.model}
            options={modelOptions(discoveryCache, 'text', form.model)}
            onChange={v => set('model', v)}
            blankLabel="— pick a model —"
          />
        </Row>
      );
    case 'audio':
      return <AudioGroupFields form={form} set={set} discoveryCache={discoveryCache} />;
    case 'image_edit':
      return <ImageEditFields form={form} set={set} discoveryCache={discoveryCache} />;
    case 'sprite':
      // The CONCEPT model; the sheet builder's model is fixed by the box.
      return (
        <Row>
          <Label>Concept model</Label>
          <Select aria-label="Concept model" value={form.model} onChange={e => set('model', e.target.value)}>
            {spriteModelOptions(models, form.model).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </Row>
      );
    default:
      return <ImageFields form={form} set={set} models={models} />;
  }
}
