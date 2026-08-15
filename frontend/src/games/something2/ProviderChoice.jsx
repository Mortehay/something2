import { useAiProviders } from './useAiProviders.js';

// SOMET-331: the generation-service selector shared by the tile and entity
// panels. One component rather than two copies of the same <select>, because
// the two panels have historically drifted and this control has a subtle
// contract (see generationJobPayload.withOptionalProvider).
//
// The "Default" option names the currently active provider, so the admin can
// see what will actually happen without opening the Settings tab.

const selectStyle = {
  background: 'var(--s2-bg)',
  border: '1px solid var(--s2-accent-tint-strong)',
  color: 'var(--s2-text-strong)',
  padding: '0.6rem',
  borderRadius: 8,
  fontSize: '1.2rem',
};


// Whether a generation with this selector value will run on the LOCAL
// sprite-gen service. Mirrors the backend's resolveGenerationTarget for the
// two levels the panel can see (request choice, then active provider).
//
// This exists because the local service's health must only gate work that
// will actually run locally. Disabling Generate because the local container
// is down, while a healthy remote provider is active, defeats the entire
// point of registering one -- and that is exactly what shipped until a
// browser pass caught it.
export function willUseLocal(choice, activeProvider) {
  if (choice === 'local') return true;
  if (choice) return false;              // an explicit provider id
  return !activeProvider;                // "Default": local only if none active
}

// Hook form, for panels that do not already have the provider list.
export function useWillUseLocal(choice) {
  const { activeProvider } = useAiProviders();
  return willUseLocal(choice, activeProvider);
}

export function ProviderChoice({ value, onChange }) {
  const { providers, activeProvider, isLoadingProviders } = useAiProviders();

  // Nothing registered: render nothing at all. An admin who has never opened
  // the Settings tab should not gain a control whose every option means the
  // same thing.
  if (!isLoadingProviders && providers.length === 0) return null;

  const enabled = providers.filter((p) => p.enabled !== false);
  const defaultLabel = activeProvider
    ? `Default (${activeProvider.name})`
    : 'Default (local sprite-gen)';

  return (
    <div style={{ marginBottom: '0.75rem' }}>
      <label style={{ display: 'block', fontSize: '1.1rem', color: 'var(--s2-accent)', marginBottom: '0.25rem' }}>
        Generate with
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
      </select>
      <div style={{ fontSize: '1rem', opacity: 0.6, marginTop: '0.25rem' }}>
        Which service draws this image. "Default" follows the active provider in AI Providers settings.
      </div>
    </div>
  );
}

// A remote provider CAN produce animation now (SOMET-346): the other machine
// draws the whole sheet and this side cuts it using the grid configured on the
// provider. The only thing worth saying is when that grid is missing, because
// then an animated request will come back as an unusable sheet.
export function ProviderAnimationNote({ provider }) {
  const { activeProvider, providers } = useAiProviders();
  if (providers.length === 0) return null;

  const chosen = provider === ''
    ? activeProvider
    : (provider === 'local' ? null : providers.find((p) => String(p.id) === provider));
  if (!chosen) return null;                       // local sprite-gen: nothing to say
  if (chosen.sheet_layout) return null;           // configured, nothing to warn about

  return (
    <div style={{ fontSize: '1rem', opacity: 0.75, marginBottom: '0.75rem', color: 'var(--s2-warning, #d9822b)' }}>
      “{chosen.name}” has no sprite-sheet layout configured, so “Generate animation” will
      return a sheet this side cannot cut. Set the layout and grid in AI Providers settings.
    </div>
  );
}
