import { useAiProviders } from './useAiProviders.js';

// SOMET-342: the PERSISTENT pin, as a field in a type's own edit form.
//
// Deliberately not the same control as ProviderChoice, and deliberately not in
// the generation panel. ProviderChoice is a per-job choice: pick a service,
// generate one image, it is forgotten. This one changes what the type does
// from now on, and it saves with the rest of the form. Making one dropdown
// mean both -- "generate this one with X" and "permanently change this type's
// default" -- is the conflation SOMET-331 refused, and it is why this ticket
// exists at all.
//
// The two look similar on screen on purpose: same options, same vocabulary.
// What differs is where they live and when they take effect, which the helper
// text under each one says out loud.

const selectStyle = {
  background: 'var(--s2-bg)',
  border: '1px solid var(--s2-accent-tint-strong)',
  color: 'var(--s2-text-strong)',
  padding: '0.6rem',
  borderRadius: 8,
  fontSize: '1.2rem',
  width: '100%',
};

// Form value <-> the two columns. The form holds a single string because a
// <select> has one value; the API takes a mode and an id, and the pair must
// never disagree (see backend providerPin.js).
//
// '' is Default, 'local' is the local service, anything else is a provider id.
export function pinToSelectValue(mode, id) {
  if (mode === 'local') return 'local';
  if (mode === 'provider' && id != null) return String(id);
  return '';
}

export function selectValueToPin(value) {
  if (value === 'local') return { ai_provider_mode: 'local', ai_provider_id: null };
  if (value === '') return { ai_provider_mode: 'default', ai_provider_id: null };
  return { ai_provider_mode: 'provider', ai_provider_id: Number(value) };
}

export function ProviderPinField({ value, onChange }) {
  const { providers, activeProvider, isLoadingProviders } = useAiProviders();

  // Same rule as ProviderChoice: with nothing registered, every option would
  // mean the same thing, so the field does not appear.
  if (!isLoadingProviders && providers.length === 0) return null;

  const enabled = providers.filter((p) => p.enabled !== false);

  // A pin can point at a provider that has since been disabled, or at one
  // deleted while this form was open (the column is ON DELETE SET NULL, so the
  // row would already read as Default -- but an open form still holds the old
  // id). Show it rather than silently snapping the select back to Default,
  // which would look like the pin was never saved.
  const pinnedMissing = value !== '' && value !== 'local'
    && !enabled.some((p) => String(p.id) === value);
  const pinnedName = providers.find((p) => String(p.id) === value)?.name;

  const defaultLabel = activeProvider
    ? `Default (currently ${activeProvider.name})`
    : 'Default (local sprite-gen)';

  return (
    <div style={{ marginBottom: '0.75rem' }}>
      <label style={{ display: 'block', fontSize: '1.1rem', color: 'var(--s2-accent)', marginBottom: '0.25rem' }}>
        Generation service
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={isLoadingProviders}
        style={selectStyle}
      >
        <option value="">{defaultLabel}</option>
        <option value="local">Local sprite-gen</option>
        {enabled.map((p) => (
          <option key={p.id} value={String(p.id)}>{p.name}</option>
        ))}
        {pinnedMissing && (
          <option value={value}>{pinnedName ? `${pinnedName} (disabled)` : 'Unavailable provider'}</option>
        )}
      </select>
      <div style={{ fontSize: '1rem', opacity: 0.6, marginTop: '0.25rem' }}>
        Saved with this type: every generation for it uses this service unless the
        generation panel overrides it for one job.
      </div>
    </div>
  );
}
