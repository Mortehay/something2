// The Templates section of Settings -> AI providers: the presets the Add
// provider flow starts from. Built-in rows are editable too; `builtin` only
// says where a row came from. A template never holds a token, so the editor
// has no token field.
import { useState } from 'react';
import { HiOutlinePlus } from 'react-icons/hi2';
import {
  KINDS, ADAPTER_OPTIONS, emptyProviderForm, templateToForm, templateToPayload,
  duplicateTemplatePayload, parseTemplate,
} from './providerForm.js';
import {
  Button, QuietButton, Card, Row, Input, Label, Hint, ErrorText, Badge,
  KindFields, KindPicker, AdapterField,
} from './ProviderKindFields.jsx';
import AdminLoading from './AdminLoading.jsx';

const adapterLabel = (a) => (ADAPTER_OPTIONS.find(o => o.value === (a || '')) || ADAPTER_OPTIONS[0]).label;

// Name is required; an image template must parse (a broken one would be
// silently dropped from `defaults` by templateToPayload).
function templateFormError(form) {
  if (!(form.name || '').trim()) return 'Name is required';
  if ((form.modality === 'image' || form.modality === 'image_edit') && (form.request_template || '').trim()) {
    const { error } = parseTemplate(form.request_template);
    if (error) return `Request template ${error}`;
  }
  return null;
}

function TemplateEditor({ initialForm, pending, onSave, onCancel }) {
  const [form, setForm] = useState(initialForm);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const error = templateFormError(form);
  return (
    <Card>
      <Row>
        <Label>Name</Label>
        <Input aria-label="Template name" value={form.name} onChange={e => set('name', e.target.value)} />
        <Badge $bg="var(--s2-surface-raised)">{(KINDS.find(k => k.value === form.modality) || KINDS[0]).label.toUpperCase()}</Badge>
      </Row>
      <Row>
        <Label>Description</Label>
        <Input value={form.description || ''} onChange={e => set('description', e.target.value)} style={{ minWidth: 380 }} />
      </Row>
      <Row>
        <Label>Base URL</Label>
        <Input value={form.base_url} onChange={e => set('base_url', e.target.value)} placeholder="blank = the admin fills it in" style={{ minWidth: 380 }} />
      </Row>
      <Row>
        <Label>Auth header</Label>
        <Input value={form.auth_header_name} onChange={e => set('auth_header_name', e.target.value)} placeholder="Authorization (optional)" />
      </Row>
      <KindFields form={form} set={set} />
      <AdapterField form={form} set={set} />
      <Hint>Blank fields are left out, so applying the template keeps the form's own value.</Hint>
      {error && <ErrorText>{error}</ErrorText>}
      <Row>
        <Button onClick={() => onSave(templateToPayload(form))} disabled={Boolean(error) || pending}>Save template</Button>
        <QuietButton onClick={onCancel}>Cancel</QuietButton>
      </Row>
    </Card>
  );
}

export default function ProviderTemplatesSection({ templates, isLoadingTemplates, create, update, remove }) {
  // null | { id } (editing a row) | { kind: null } (picking a kind) | { kind } (new)
  const [editing, setEditing] = useState(null);
  const close = () => setEditing(null);

  return (
    <section>
      <Row style={{ justifyContent: 'space-between', marginTop: '2rem' }}>
        <h3 style={{ margin: 0 }}>Templates</h3>
        <QuietButton onClick={() => setEditing(e => (e && !e.id ? null : { kind: null }))}>
          <HiOutlinePlus /> {editing && !editing.id ? 'Cancel' : 'New template'}
        </QuietButton>
      </Row>
      <Hint>Presets for Add provider. They never hold a token.</Hint>

      {editing && !editing.id && !editing.kind && (
        <Card><KindPicker onPick={kind => setEditing({ kind })} /></Card>
      )}
      {editing && !editing.id && editing.kind && (
        <TemplateEditor
          initialForm={{ ...emptyProviderForm(editing.kind), description: '' }}
          pending={create.isPending}
          onSave={body => create.mutate({ body }, { onSuccess: close })}
          onCancel={close}
        />
      )}

      {isLoadingTemplates ? (
        <AdminLoading label="Loading templates…" inline size={16} />
      ) : KINDS.map(kind => {
        const rows = templates.filter(t => t.modality === kind.value);
        if (rows.length === 0) return null;
        return (
          <div key={kind.value}>
            <h4 style={{ margin: '1rem 0 0.4rem' }}>{kind.label}</h4>
            {rows.map(t => (editing?.id === t.id ? (
              <TemplateEditor
                key={t.id}
                initialForm={templateToForm(t)}
                pending={update.isPending}
                onSave={body => update.mutate({ id: t.id, body }, { onSuccess: close })}
                onCancel={close}
              />
            ) : (
              <Card key={t.id} data-template={t.name}>
                <Row>
                  <strong>{t.name}</strong>
                  {t.builtin && <Badge $bg="var(--s2-surface-raised)">BUILT-IN</Badge>}
                  <span style={{ color: 'var(--s2-text-muted)' }}>{adapterLabel(t.adapter)}</span>
                </Row>
                {t.description && <Hint>{t.description}</Hint>}
                <Row>
                  <QuietButton onClick={() => setEditing({ id: t.id })}>Edit</QuietButton>
                  <QuietButton onClick={() => create.mutate({ body: duplicateTemplatePayload(t) })} disabled={create.isPending}>
                    Duplicate
                  </QuietButton>
                  <Button
                    $bg="var(--s2-danger, #e5484d)"
                    onClick={() => window.confirm(`Delete template "${t.name}"?`) && remove.mutate({ id: t.id })}
                  >
                    Delete
                  </Button>
                </Row>
              </Card>
            )))}
          </div>
        );
      })}
    </section>
  );
}
