import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ArtStartError from '../ArtStartError.jsx';
import { startErrorMessage } from '../artSelection.js';

// SOMET-535 rework 3. A Start the server REFUSES without a blocked list -- a
// Local start against a queue holding connector jobs, or an empty queue --
// rendered nothing at all: the message was printed only inside the
// "blocked.total > 0" panel, which a plain 400 never opens. Asserted on the
// RENDERED MARKUP, because the defect was a render the page never produced.

// The exact shape useStartArtBatch throws: an Error with a `blocked` array.
function startError(message, blocked = []) {
  const err = new Error(message);
  err.blocked = blocked;
  return err;
}

const MIXED = 'provider_id is required -- the queue holds 1 connector job(s); only a queue of local jobs can start without one';
const EMPTY = 'nothing is queued -- queue subjects first';

describe('ArtStartError renders a refused start that has no blocked list', () => {
  for (const msg of [MIXED, EMPTY]) {
    it(`shows "${msg.slice(0, 30)}…" as an alert`, () => {
      const html = renderToStaticMarkup(h(ArtStartError, { error: startError(msg), onDismiss: () => {} }));
      expect(html).toContain('role="alert"');
      expect(html).toContain(msg);
      expect(html).toContain('Dismiss');
    });
  }

  it('renders nothing with no error', () => {
    expect(renderToStaticMarkup(h(ArtStartError, { error: null, onDismiss: () => {} }))).toBe('');
  });

  it('renders nothing for a size refusal -- the Blocked panel owns that one', () => {
    const err = startError('PROVIDER_TOO_SMALL', [{ kind: 'skill', provider_id: 3, count: 2 }]);
    expect(renderToStaticMarkup(h(ArtStartError, { error: err, onDismiss: () => {} }))).toBe('');
  });
});

describe('startErrorMessage', () => {
  it('passes a plain refusal through verbatim', () => {
    expect(startErrorMessage(startError(EMPTY))).toBe(EMPTY);
    // an Error with no `blocked` field at all (e.g. the 409 path) is plain too
    expect(startErrorMessage(new Error('A batch is already running'))).toBe('A batch is already running');
  });
  it('is null for no error and for a refusal with blocked groups', () => {
    expect(startErrorMessage(null)).toBe(null);
    expect(startErrorMessage(undefined)).toBe(null);
    expect(startErrorMessage(startError('x', [{ kind: 'item', count: 1 }]))).toBe(null);
  });
  it('falls back to a generic line when the message is empty', () => {
    expect(startErrorMessage(startError(''))).toBe('Failed to start the batch');
  });
});
