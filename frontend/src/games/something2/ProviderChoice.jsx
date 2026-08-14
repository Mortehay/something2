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

// A remote provider answers one request with one image, so it cannot produce
// the multi-frame directional atlas the "Generate animation" button asks for.
// Saying so here is cheaper than letting the admin click it and read a job
// error thirty seconds later.
export function ProviderAnimationNote({ provider }) {
  const { activeProvider, providers } = useAiProviders();
  if (providers.length === 0) return null;

  const usingRemote = provider === ''
    ? Boolean(activeProvider)
    : provider !== 'local';
  if (!usingRemote) return null;

  return (
    <div style={{ fontSize: '1rem', opacity: 0.75, marginBottom: '0.75rem', color: 'var(--s2-warning, #d9822b)' }}>
      Remote providers return a single image. Use “Local sprite-gen” for animation.
    </div>
  );
}
