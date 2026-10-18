// Shared styled pieces for the Seed / Export tab (page, popup, preview).
import styled from 'styled-components';

export const Btn = styled.button`
  background: ${p => (p.$primary ? 'var(--s2-btn-primary)' : 'var(--s2-surface-raised)')};
  color: ${p => (p.$primary ? 'var(--s2-on-accent)' : 'var(--s2-text)')};
  border: 1px solid ${p => (p.$primary ? 'var(--s2-btn-primary)' : 'var(--s2-border-strong)')};
  border-radius: 6px; padding: 0.35rem 0.8rem; font-size: 0.85rem; cursor: pointer;
  &:disabled { background: var(--s2-disabled-bg); color: var(--s2-text-dim); border-color: var(--s2-border); cursor: not-allowed; }
`;

const TONES = {
  ok: 'var(--s2-success)', warn: 'var(--s2-warning)', info: 'var(--s2-accent)', bad: 'var(--s2-danger)',
};
export const Badge = styled.span`
  display: inline-block; padding: 1px 9px; border-radius: 999px; font-size: 0.75rem; font-weight: 600;
  border: 1px solid ${p => TONES[p.$tone] || 'var(--s2-border)'};
  color: ${p => TONES[p.$tone] || 'var(--s2-text)'};
  background: transparent;
  cursor: ${p => (p.onClick ? 'pointer' : 'default')};
`;

export const Muted = styled.span`color: var(--s2-text-muted); font-size: 0.8rem;`;

export const Backdrop = styled.div`
  position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 50;
  display: flex; align-items: center; justify-content: center; padding: 1rem;
`;
export const Dialog = styled.div`
  background: var(--s2-surface); color: var(--s2-text); border: 1px solid var(--s2-border-strong);
  border-radius: 10px; padding: 1rem 1.2rem; width: ${p => p.$w || '560px'}; max-width: 100%;
  max-height: 90vh; overflow-y: auto; box-shadow: 0 8px 24px rgba(0,0,0,0.35);
`;

export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
