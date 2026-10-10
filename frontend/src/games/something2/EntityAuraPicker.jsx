import { toggleAura, danglingAuras } from './entityAuras.js';

// SOMET-604: checkbox picker over the aura library. Self-contained so the
// Entities form only wires value/onChange.
export default function EntityAuraPicker({ value, library, isLoading, onChange }) {
  const dangling = danglingAuras(value, library, isLoading);
  return (
    <div>
      <label>
        Auras{' '}
        <small style={{ color: 'var(--s2-text-muted)' }}>
          — from the Aura Effects tab; none checked = no aura
        </small>
      </label>
      {isLoading && <small style={{ display: 'block' }}>Loading auras…</small>}
      {library.map((a) => (
        <label key={a.id} style={{ display: 'inline-flex', gap: 4, marginRight: 12 }}>
          <input
            type="checkbox"
            checked={(value || []).includes(a.name)}
            onChange={() => onChange(a.name)}
          />
          {a.name} <small>({a.target_side}, r {a.radius})</small>
        </label>
      ))}
      {dangling.map((n) => (
        <p key={n} role="alert" style={{ color: 'var(--s2-danger)' }}>
          Bound to "{n}", which is not in the library — it does nothing.{' '}
          <button type="button" onClick={() => onChange(n)}>Remove</button>
        </p>
      ))}
    </div>
  );
}

export { toggleAura };
