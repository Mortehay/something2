// Shared styled pieces for the Seed / Export tab (page, popup, preview).
import { useEffect } from 'react';
import styled from 'styled-components';

export const Btn = styled.button`
  background: ${p => (p.$primary ? 'var(--s2-btn-primary)' : 'var(--s2-surface-raised)')};
  color: ${p => (p.$primary ? 'var(--s2-on-accent)' : 'var(--s2-text)')};
  border: 1px solid ${p => (p.$primary ? 'var(--s2-btn-primary)' : 'var(--s2-border-strong)')};
  border-radius: 6px; padding: 0.35rem 0.8rem; font-size: 1.4rem; cursor: pointer;
  &:disabled { background: var(--s2-disabled-bg); color: var(--s2-text-dim); border-color: var(--s2-border); cursor: not-allowed; }
`;

const TONES = {
  ok: 'var(--s2-success)', warn: 'var(--s2-warning)', info: 'var(--s2-accent)', bad: 'var(--s2-danger)',
};
export const Badge = styled.span`
  display: inline-block; padding: 1px 9px; border-radius: 999px; font-size: 1.2rem; font-weight: 600;
  border: 1px solid ${p => TONES[p.$tone] || 'var(--s2-border)'};
  color: ${p => TONES[p.$tone] || 'var(--s2-text)'};
  background: transparent;
  cursor: ${p => (p.onClick ? 'pointer' : 'default')};
`;

export const Muted = styled.span`color: var(--s2-text-muted); font-size: 1.2rem;`;

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

// The backdrop's click handler: none when a stray click would throw away work
// (the seed preview holds the admin's decisions).
export const backdropClick = (onClose, closeOnBackdrop = true) => (closeOnBackdrop ? onClose : undefined);

// Backdrop + dialog: Escape closes it; a backdrop click too unless
// closeOnBackdrop is false.
export function Modal({ onClose, $w, label, children, closeOnBackdrop = true }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <Backdrop onClick={backdropClick(onClose, closeOnBackdrop)}>
      <Dialog role="dialog" aria-modal="true" aria-label={label} $w={$w} onClick={(e) => e.stopPropagation()}>
        {children}
      </Dialog>
    </Backdrop>
  );
}

export const RESTART_NOTE = 'running game still uses old data';
export const PC_LABEL_HINT = 'Set SEED_PC_LABEL in .env so exports say which PC they came from';

// Status column header; while a seed waits for a backend restart it says the
// running game has not picked the seeded data up yet.
export function StatusHead({ restartRequired }) {
  return (
    <>Status{restartRequired && <> <Muted>· {RESTART_NOTE}</Muted></>}</>
  );
}

// Shown while this PC has no SEED_PC_LABEL (exports then say 'unnamed-pc').
export function PcLabelHint({ meta }) {
  if (!meta || meta.pcLabelSet !== false) return null;
  return <p><Muted>{PC_LABEL_HINT}</Muted></p>;
}
