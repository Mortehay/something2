import styled from 'styled-components';
import { startErrorMessage } from './artSelection.js';

// SOMET-535 rework 3. A refused Start that the Blocked panel does not cover.
// Its own component so the render itself is testable in vitest's node
// environment (renderToStaticMarkup) without mounting the whole console.
const Box = styled.section`
  border: 1px solid var(--s2-danger); border-radius: 6px; padding: 0.5rem 0.75rem; margin: 0.5rem 0;
  display: flex; gap: 0.75rem; align-items: center; justify-content: space-between;
`;
const Msg = styled.p`color: var(--s2-danger); font-size: 0.85rem; margin: 0;`;
const Dismiss = styled.button`
  background: var(--s2-btn-grey); color: var(--s2-on-accent); border: none; border-radius: 6px;
  padding: 0.4rem 0.9rem; font-weight: bold; cursor: pointer; font-size: 0.85rem; flex: none;
`;

export default function ArtStartError({ error, onDismiss }) {
  const message = startErrorMessage(error);
  if (!message) return null;
  return (
    <Box role="alert">
      <Msg>Not started: {message}</Msg>
      <Dismiss type="button" onClick={onDismiss}>Dismiss</Dismiss>
    </Box>
  );
}
