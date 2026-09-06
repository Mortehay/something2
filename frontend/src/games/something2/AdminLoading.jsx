import styled, { keyframes } from 'styled-components';

// SOMET-557. One loading indicator for every admin tab. Before this the 13
// pages each rolled their own: seven early-returned bare text, six rendered an
// inline string, and the wording alone had three different spellings of
// "Loading…" -- with no animation anywhere, so a slow fetch was
// indistinguishable from a page that had simply stopped.
//
// NOT `ui/Spinner.jsx`, which is unused and stays that way for the rest of the
// app: it is coloured with --color-brand-600, a fixed indigo declared outside
// both theme blocks in GlobalStyles.js. Every admin surface is built on the
// theme-aware --s2-* tokens (--s2-accent resolves to #2563eb in light and
// #4a9eff in dark), so borrowing that component would paint one off-palette
// element on all 13 pages and quietly opt them out of the light/dark work. Its
// 6.4rem body and 4.8rem margin are also sized for a full-page takeover rather
// than the inline panels most of these pages need.

const rotate = keyframes`to { transform: rotate(1turn); }`;

// currentColor throughout, so the ring inherits whatever colour the wrapper
// sets and there is exactly one place to change it.
const Ring = styled.span`
  display: inline-block;
  width: ${p => p.$size || 22}px;
  height: ${p => p.$size || 22}px;
  border: 2px solid currentColor;
  /* One transparent quadrant is what makes the rotation legible -- a full ring
     spins invisibly. */
  border-top-color: transparent;
  border-radius: 50%;
  animation: ${rotate} 0.7s linear infinite;

  /* Respect a reduced-motion preference: keep the ring as a static "busy" mark
     rather than removing the only indicator that anything is happening. */
  @media (prefers-reduced-motion: reduce) {
    animation-duration: 2.4s;
  }
`;

const Wrap = styled.div`
  display: flex;
  align-items: center;
  justify-content: ${p => (p.$inline ? 'flex-start' : 'center')};
  gap: 0.6rem;
  color: var(--s2-accent);
  padding: ${p => (p.$inline ? '0.5rem 0' : '2.5rem 1rem')};
`;

const Label = styled.span`
  color: var(--s2-text-muted);
  font-size: 0.9em;
`;

/**
 * @param label   text beside the spinner; omit for a bare indicator.
 * @param inline  true to sit in a row of content, false (default) to centre
 *                itself in the space a not-yet-loaded page would occupy.
 * @param size    ring diameter in px.
 */
function AdminLoading({ label = 'Loading…', inline = false, size }) {
  return (
    // role=status + aria-live announces the state change to a screen reader,
    // which a bare styled div never did. aria-hidden on the ring keeps the
    // decorative element from being announced separately from the label.
    <Wrap $inline={inline} role="status" aria-live="polite">
      <Ring $size={size} aria-hidden="true" />
      {label && <Label>{label}</Label>}
    </Wrap>
  );
}

export default AdminLoading;
